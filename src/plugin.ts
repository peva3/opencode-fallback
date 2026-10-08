import { resolve } from "node:path"
import { Plugin } from "@opencode/plugin"
import { applyOverrides, loadConfig, parseModel } from "./config"
import { createLogger } from "./log"

type Context = Plugin.Context

// ── Types ────────────────────────────────────────────────────────────────────

type SessionInfo = Awaited<ReturnType<Context["session"]["get"]>>
type SessionMessages = Awaited<ReturnType<Context["session"]["context"]>>
type SessionMessage = SessionMessages[number]
type UserMessage = Extract<SessionMessage, { type: "user" }>
type AssistantMessage = Extract<SessionMessage, { type: "assistant" }>
type AssistantContent = AssistantMessage["content"][number]
type ModelRef = NonNullable<SessionInfo["model"]>

type EventSource = ReturnType<Context["event"]["subscribe"]>
type PluginEvent = EventSource extends AsyncIterable<infer T> ? T : never

type RetryKind = "rate-limit" | "disconnect"

interface SessionState {
  // Rate limit fallback state
  fallbackActive: boolean
  cooldownEndTime: number

  // Disconnect resume state
  resumeAttempts: number
  resumeActive: boolean
  originalModel: ModelRef | null
  // Timestamp (Date.now()) of the moment the plugin took over a retry.
  // Retry events closer than the grace window belong to the attempt we are
  // already recovering and are ignored.
  pluginAbortedAt: number

  // Ralph loop state
  loopActive: boolean
}

// ── Tuning ───────────────────────────────────────────────────────────────────

/** Ignore retry events arriving within this window after we took over. */
const ABORT_GRACE_MS = 5000
/** Let the failed run settle before interrupting and re-prompting. */
const RECOVERY_DELAY_MS = 300
/** Pause between the interrupt and reading the session context. */
const INTERRUPT_SETTLE_MS = 200
/** Cap on how much provider error payload is used for pattern matching. */
const MAX_ERROR_TEXT = 4000

// ── Helpers ──────────────────────────────────────────────────────────────────

const sessionStates = new Map<string, SessionState>()

function createDefaultSessionState(): SessionState {
  return {
    fallbackActive: false,
    cooldownEndTime: 0,
    resumeAttempts: 0,
    resumeActive: false,
    originalModel: null,
    pluginAbortedAt: 0,
    loopActive: false,
  }
}

function getSessionState(sessionID: string): SessionState {
  let state = sessionStates.get(sessionID)
  if (!state) {
    state = createDefaultSessionState()
    sessionStates.set(sessionID, state)
  }
  return state
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function truncate(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + "..." : text
}

function isUserMessage(message: SessionMessage): message is UserMessage {
  return message.type === "user"
}

function isAssistantMessage(message: SessionMessage): message is AssistantMessage {
  return message.type === "assistant"
}

function isTextContent(content: AssistantContent): content is Extract<AssistantContent, { type: "text" }> {
  return content.type === "text"
}

/**
 * Creates a case-insensitive substring matcher (suitable for multi-word phrases
 * like "rate limit" that don't need word-boundary protection).
 */
function createSubstringMatcher(patterns: string[]) {
  return (message: string): boolean => {
    const lower = message.toLowerCase()
    return patterns.some((pattern) => lower.includes(pattern.toLowerCase()))
  }
}

/**
 * Creates a case-insensitive word-boundary matcher using regex \b.
 * This prevents false positives from patterns like "eof" matching "thereof"
 * or "502" matching inside longer numbers. Patterns that look like HTTP
 * status codes (pure digits) are matched with \b on both sides.
 */
function createWordBoundaryMatcher(patterns: string[]) {
  const regexes = patterns.map((pattern) => {
    // Escape regex special characters in the pattern
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(`\\b${escaped}\\b`, "i")
  })
  return (message: string): boolean => {
    return regexes.some((regex) => regex.test(message))
  }
}

/**
 * Extract all text content from an assistant message's parts.
 * Returns the concatenated text, or null if no text was found.
 */
function extractPartialContent(message: AssistantMessage): string | null {
  const textParts = message.content.filter(isTextContent).map((part) => part.text)

  if (textParts.length === 0) return null

  const content = textParts.join("")
  // Only consider it partial content if there's something meaningful
  return content.trim().length > 0 ? content : null
}

/**
 * Build the continuation prompt by injecting partial content into the template.
 * If the partial content exceeds maxLength, only the tail is kept (preceded by
 * a "[...truncated]" marker) so the model can find its place without the
 * conversation history ballooning.
 */
function buildContinuationPrompt(template: string, partialContent: string, maxLength: number): string {
  let content = partialContent
  if (content.length > maxLength) {
    content = "[...truncated]\n" + content.slice(-maxLength)
  }
  return template.replace("{{partial_content}}", content)
}

/**
 * Rebuild the prompt attachments of a stored user message.
 * Inline attachments are re-emitted as data URIs so they can be re-sent.
 */
function toPromptFiles(files: UserMessage["files"]) {
  if (!files || files.length === 0) return undefined
  return files.map((file) => ({
    uri: file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
    name: file.name,
    description: file.description,
    mention: file.mention,
  }))
}

/**
 * V1 re-sent the original user message after reverting the session. V2 does not
 * expose `revert` to plugins, so the same request is re-sent as a new message.
 */
function toPromptPayload(message: UserMessage) {
  return {
    text: message.text,
    files: toPromptFiles(message.files),
    agents: message.agents?.map((agent) => ({ name: agent.name, mention: agent.mention })),
    skills: message.skills?.map((skill) => ({ id: skill.id, mention: skill.mention })),
  }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export const plugin = Plugin.define({
  id: "opencode-fallback",
  async setup(ctx) {
    const loaded = loadConfig()
    // Plugin options from opencode.json(c) win over fallback.json.
    const config = applyOverrides(loaded.config, ctx.options)
    const logger = createLogger(config.logging)

    if (loaded.createdDefaultConfig) {
      await logger.info("Created default config file on first run", {
        path: loaded.createdDefaultConfig,
      })
    }

    const isRateLimitMessage = createSubstringMatcher(config.rateLimitPatterns)
    const isDisconnectMessage = createWordBoundaryMatcher(config.disconnectPatterns)
    const fallbackModel = parseModel(config.fallbackModel)

    await logger.info("Plugin initialized", {
      enabled: config.enabled,
      fallbackModel: config.fallbackModel,
      location: String(ctx.location.directory),
      options: ctx.options,
      rateLimitPatterns: config.rateLimitPatterns,
      disconnectPatterns: config.disconnectPatterns,
      resumeWithSameModel: config.resumeWithSameModel,
      maxResumeAttempts: config.maxResumeAttempts,
      cooldownMs: config.cooldownMs,
      loopEnabled: config.loopEnabled,
      loopStartPhrase: config.loopStartPhrase,
      loopStopPhrase: config.loopStopPhrase,
    })

    if (!config.enabled) {
      await logger.info("Plugin disabled via config")
      return
    }

    // ── Location guard ─────────────────────────────────────────────────────
    // Plugin instances are loaded per location and hooks/events are broadcast
    // to all of them. Recoveries must only run in the instance that owns the
    // session, otherwise one failure would trigger one recovery per location.

    async function isOwnSession(sessionID: string): Promise<boolean> {
      try {
        const info = await ctx.session.get({ sessionID })
        const own = resolve(String(ctx.location.directory))
        const theirs = info.location?.directory ? resolve(String(info.location.directory)) : own
        return own === theirs
      } catch (err) {
        await logger.info("Could not resolve session location", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        return false
      }
    }

    // ── Rate Limit Recovery ────────────────────────────────────────────────
    // OpenCode's own retry loop for the rate-limited model has been disabled
    // (decision = no retry). Move the session to the fallback model and re-send
    // the original request.

    async function handleRateLimitRecovery(sessionID: string, retryMessage: string) {
      const state = getSessionState(sessionID)

      if (state.fallbackActive && Date.now() < state.cooldownEndTime) {
        await logger.info("Skipping rate-limit fallback, cooldown active", {
          sessionID,
          cooldownRemaining: state.cooldownEndTime - Date.now(),
        })
        return
      }

      await logger.info("Rate limit detected, switching to fallback model", {
        sessionID,
        message: truncate(retryMessage),
        fallbackModel: config.fallbackModel,
      })

      state.fallbackActive = true
      state.cooldownEndTime = Date.now() + config.cooldownMs
      state.pluginAbortedAt = Date.now()

      try {
        await ctx.session.interrupt({ sessionID, resume: false }).catch((err: unknown) => {
          // The failed run is usually already settled, which is not an error.
          return logger.info("Interrupt returned an error, continuing", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        await sleep(INTERRUPT_SETTLE_MS)

        const messages = await ctx.session.context({ sessionID })
        if (!messages || messages.length === 0) {
          await logger.error("No messages found in session", { sessionID })
          return
        }

        const lastUserMessage = [...messages].reverse().find(isUserMessage)
        if (!lastUserMessage) {
          await logger.error("No user message found in session", { sessionID })
          return
        }

        // V2 prompts do not accept a model, so the session model is switched
        // first. Unlike V1 (which scoped the fallback model to a single
        // re-sent message) the session then stays on the fallback model until
        // it is switched back manually or a new session is created.
        await ctx.session.switchModel({
          sessionID,
          model: { providerID: fallbackModel.providerID, id: fallbackModel.modelID },
        })

        await ctx.session.prompt({ sessionID, ...toPromptPayload(lastUserMessage) })

        await logger.info("Rate-limit fallback prompt sent successfully", {
          sessionID,
          model: fallbackModel,
          messageId: lastUserMessage.id,
          totalMessages: messages.length,
        })
      } catch (err) {
        await logger.error("Failed to send rate-limit fallback prompt", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        // Restore the ability to retry on the next failure.
        state.fallbackActive = false
        state.cooldownEndTime = 0
      }
    }

    // ── Disconnect Resume Recovery ─────────────────────────────────────────
    // Capture partial assistant response, then send a continuation prompt that
    // includes the partial content so the model picks up where it left off.

    async function handleDisconnectRecovery(sessionID: string, retryMessage: string) {
      const state = getSessionState(sessionID)

      // Guard: max resume attempts
      if (state.resumeAttempts >= config.maxResumeAttempts) {
        await logger.warn("Max resume attempts reached, giving up", {
          sessionID,
          attempts: state.resumeAttempts,
          maxAttempts: config.maxResumeAttempts,
        })
        return
      }

      // Guard: if we're already actively resuming, don't stack
      if (state.resumeActive) {
        await logger.info("Resume already in progress, skipping", { sessionID })
        return
      }

      await logger.info("Disconnect detected, attempting to resume", {
        sessionID,
        message: truncate(retryMessage),
        attempt: state.resumeAttempts + 1,
        maxAttempts: config.maxResumeAttempts,
      })

      state.resumeActive = true
      state.resumeAttempts += 1
      state.pluginAbortedAt = Date.now()

      try {
        // Exponential backoff: 2s, 4s, 8s for attempts 1, 2, 3
        const backoffMs = Math.min(2000 * Math.pow(2, state.resumeAttempts - 1), 30000)
        if (state.resumeAttempts > 1) {
          await logger.info("Applying exponential backoff before retry", {
            sessionID,
            attempt: state.resumeAttempts,
            backoffMs,
          })
          await sleep(backoffMs)
        }

        // 1. Interrupt the current retry loop
        await ctx.session.interrupt({ sessionID, resume: false }).catch((err: unknown) => {
          return logger.info("Interrupt returned an error, continuing", {
            sessionID,
            error: err instanceof Error ? err.message : String(err),
          })
        })
        await sleep(INTERRUPT_SETTLE_MS)

        // 2. Fetch messages to find partial assistant response
        const messages = await ctx.session.context({ sessionID })
        if (!messages || messages.length === 0) {
          await logger.error("No messages found in session", { sessionID })
          return
        }

        // 3. Find the last assistant message (the interrupted one) and last user message
        const reversedMessages = [...messages].reverse()
        const lastAssistantMessage = reversedMessages.find(isAssistantMessage)
        const lastUserMessage = reversedMessages.find(isUserMessage)

        if (!lastUserMessage) {
          await logger.error("No user message found in session", { sessionID })
          return
        }

        // 4. Extract partial content from the interrupted assistant response
        const partialContent = lastAssistantMessage ? extractPartialContent(lastAssistantMessage) : null

        // 5. Capture the original model that was responding
        if (lastAssistantMessage?.model && !state.originalModel) {
          state.originalModel = lastAssistantMessage.model
        }

        await logger.info("Partial content captured", {
          sessionID,
          hasPartialContent: !!partialContent,
          partialContentLength: partialContent?.length ?? 0,
          originalModel: state.originalModel
            ? String(state.originalModel.providerID) + "/" + String(state.originalModel.id)
            : null,
        })

        // NOTE: V1 reverted the session to the last user message here, which
        // removed the incomplete assistant response. The V2 plugin API does not
        // expose revert, so the interrupted message stays in the transcript and
        // the continuation prompt is appended after it.

        // 6. Determine which model to use.
        // First attempt: try the same model (it was a disconnect, not a model
        // issue). Subsequent attempts: escalate to fallback model.
        let modelToUse: ModelRef
        if (config.resumeWithSameModel && state.originalModel && state.resumeAttempts <= 1) {
          modelToUse = state.originalModel
          await logger.info("Retrying with same model", {
            sessionID,
            model: String(modelToUse.providerID) + "/" + String(modelToUse.id),
          })
        } else {
          modelToUse = { providerID: fallbackModel.providerID, id: fallbackModel.modelID }
          await logger.info("Escalating to fallback model", {
            sessionID,
            model: String(modelToUse.providerID) + "/" + String(modelToUse.id),
          })
        }

        await ctx.session.switchModel({ sessionID, model: modelToUse })

        // 7. Build and send the prompt
        if (partialContent) {
          // We have partial content: send a continuation prompt
          const continuationText = buildContinuationPrompt(
            config.continuationPromptTemplate,
            partialContent,
            config.maxPartialContentLength
          )

          await logger.info("Sending continuation prompt with partial content", {
            sessionID,
            partialContentLength: partialContent.length,
          })

          await ctx.session.prompt({ sessionID, text: continuationText })
        } else {
          // No partial content captured: fall back to re-sending the original
          // user message
          const promptPayload = toPromptPayload(lastUserMessage)
          if (!promptPayload.text && !promptPayload.files?.length) {
            await logger.error("No valid parts to re-send", { sessionID })
            return
          }

          await logger.info("No partial content, re-sending original user message", {
            sessionID,
          })

          await ctx.session.prompt({ sessionID, ...promptPayload })
        }

        await logger.info("Disconnect recovery prompt sent successfully", {
          sessionID,
          attempt: state.resumeAttempts,
          usedContinuation: !!partialContent,
        })
      } catch (err) {
        await logger.error("Failed to send disconnect recovery prompt", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
          attempt: state.resumeAttempts,
        })
      } finally {
        state.resumeActive = false
      }
    }

    // ── Recovery scheduling ────────────────────────────────────────────────

    function scheduleRecovery(kind: RetryKind, sessionID: string, message: string) {
      setTimeout(() => {
        void (async () => {
          try {
            if (!(await isOwnSession(sessionID))) {
              await logger.info("Skipping recovery owned by another location", { sessionID, kind })
              return
            }
            if (kind === "rate-limit") {
              await handleRateLimitRecovery(sessionID, message)
            } else {
              await handleDisconnectRecovery(sessionID, message)
            }
          } catch (err) {
            await logger.error("Recovery failed", {
              sessionID,
              kind,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        })()
      }, RECOVERY_DELAY_MS)
    }

    // ── Retry hook (rate limit / disconnect detection) ─────────────────────
    // OpenCode V2 publishes no `session.status` events to plugins, so
    // detection moved from the event stream to the retry hook, which also
    // carries a structured provider error.

    const retryRegistration = await ctx.session.hook("retry", (event) => {
      const error = event.error
      const haystack = truncate(
        [error.type, error.message, error.status ? String(error.status) : "", error.response?.body ?? ""]
          .filter(Boolean)
          .join(" "),
        MAX_ERROR_TEXT
      )
      const state = getSessionState(event.sessionID)
      const now = Date.now()

      if (state.pluginAbortedAt > 0 && now - state.pluginAbortedAt < ABORT_GRACE_MS) {
        void logger.info("Ignoring retry event inside abort grace window", {
          sessionID: event.sessionID,
          attempt: event.attempt,
          elapsed: now - state.pluginAbortedAt,
        })
        return
      }

      // Check disconnect patterns first (more specific recovery)
      if (isDisconnectMessage(haystack)) {
        if (state.resumeActive) {
          void logger.info("Resume already in progress, leaving retry policy untouched", {
            sessionID: event.sessionID,
          })
          return
        }
        if (state.resumeAttempts >= config.maxResumeAttempts) {
          void logger.warn("Max resume attempts reached, leaving retry policy untouched", {
            sessionID: event.sessionID,
            attempts: state.resumeAttempts,
          })
          return
        }

        state.pluginAbortedAt = now
        void logger.info("Disconnect detected in retry hook", {
          sessionID: event.sessionID,
          attempt: event.attempt,
          message: truncate(haystack),
        })
        event.decision = { retry: false }
        scheduleRecovery("disconnect", event.sessionID, haystack)
        return
      }

      // Then check rate limit patterns
      if (isRateLimitMessage(haystack)) {
        if (state.fallbackActive && now < state.cooldownEndTime) {
          void logger.info("Rate-limit cooldown active, leaving retry policy untouched", {
            sessionID: event.sessionID,
            cooldownRemaining: state.cooldownEndTime - now,
          })
          return
        }

        state.pluginAbortedAt = now
        void logger.info("Rate limit detected in retry hook", {
          sessionID: event.sessionID,
          attempt: event.attempt,
          message: truncate(haystack),
        })
        event.decision = { retry: false }
        scheduleRecovery("rate-limit", event.sessionID, haystack)
        return
      }

      // Unknown retry reason -- log but don't act, OpenCode keeps its policy.
      void logger.info("Retry detected but no matching pattern", {
        sessionID: event.sessionID,
        attempt: event.attempt,
        message: truncate(haystack),
      })
    })

    // ── Ralph loop ─────────────────────────────────────────────────────────

    const loopStartLower = config.loopStartPhrase.toLowerCase()
    const loopStopLower = config.loopStopPhrase.toLowerCase()

    /**
     * Check the last user message in a session for loop control phrases.
     * Returns "start" if the start phrase is found, "stop" if the stop phrase is
     * found, or null if neither is found. Stop takes priority over start.
     */
    async function checkLoopPhrase(sessionID: string): Promise<"start" | "stop" | null> {
      if (!config.loopEnabled) return null

      try {
        const messages = await ctx.session.context({ sessionID })
        if (!messages || messages.length === 0) return null

        const lastUserMessage = [...messages].reverse().find(isUserMessage)
        if (!lastUserMessage) return null

        const text = lastUserMessage.text.toLowerCase()

        await logger.info("Last user message text for loop check", {
          sessionID,
          text: truncate(text, 100),
        })

        // Stop takes priority: if user says both (unlikely), stop wins
        if (text.includes(loopStopLower)) return "stop"
        if (text.includes(loopStartLower)) return "start"
        return null
      } catch (err) {
        await logger.error("Error in checkLoopPhrase", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    }

    /**
     * A turn finished. Reset recovered state and drive the Ralph loop.
     * Only successful completions count: a failed turn must not restart the
     * loop, otherwise a broken provider would spin the loop forever.
     */
    async function handleTurnCompleted(sessionID: string) {
      const state = getSessionState(sessionID)

      // Reset rate-limit cooldown if expired
      if (state.fallbackActive && Date.now() >= state.cooldownEndTime) {
        state.fallbackActive = false
        await logger.info("Rate-limit cooldown expired, fallback reset", { sessionID })
      }

      // Reset disconnect resume state on successful completion
      if (state.resumeAttempts > 0 && !state.resumeActive) {
        await logger.info("Session completed after disconnect recovery, resetting resume state", {
          sessionID,
          totalAttempts: state.resumeAttempts,
        })
        state.resumeAttempts = 0
        state.originalModel = null
        state.pluginAbortedAt = 0
      }

      if (!config.loopEnabled) return

      const loopAction = await checkLoopPhrase(sessionID)

      if (loopAction === "start") {
        state.loopActive = true
        await logger.info("Ralph loop activated for session", { sessionID })
        // Don't loop on the activation message itself -- wait for the next
        // completed turn
        return
      }

      if (loopAction === "stop") {
        state.loopActive = false
        await logger.info("Ralph loop deactivated for session", { sessionID })
        return
      }

      if (!state.loopActive) return

      try {
        await ctx.session.prompt({ sessionID, text: config.loopPrompt })
        await logger.info("Ralph loop prompt sent successfully", { sessionID })
      } catch (err) {
        await logger.error("Failed to send Ralph loop prompt", {
          sessionID,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    // ── Event handler ──────────────────────────────────────────────────────

    async function handleEvent(event: PluginEvent) {
      // V2 sends no `session.status` events to plugins: "session idle" is
      // derived from execution lifecycle events instead.
      if (event.type === "session.execution.succeeded") {
        if (!(await isOwnSession(event.data.sessionID))) return
        await handleTurnCompleted(event.data.sessionID)
        return
      }

      if (event.type === "session.deleted") {
        sessionStates.delete(event.data.sessionID)
        await logger.info("Session cleaned up", { sessionID: event.data.sessionID })
      }
    }

    const controller = new AbortController()

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            await handleEvent(event)
          } catch (err) {
            await logger.error("Failed to handle event", {
              type: event.type,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } catch (err) {
        // Aborting the subscription during shutdown is expected.
        if (controller.signal.aborted) return
        await logger.error("Event subscription stopped", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    })()

    await logger.info("Plugin ready", {
      location: String(ctx.location.directory),
    })

    return async () => {
      controller.abort()
      await retryRegistration.dispose()
    }
  },
})
