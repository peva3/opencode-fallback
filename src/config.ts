import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface FallbackModelObject {
  providerID: string
  modelID: string
}

export type FallbackModel = string | FallbackModelObject

export interface FallbackConfig {
  enabled: boolean
  fallbackModel: FallbackModel
  cooldownMs: number
  logging: boolean

  // Rate limit recovery (original behavior)
  rateLimitPatterns: string[]

  // Disconnect/stream-error recovery (new behavior)
  disconnectPatterns: string[]
  resumeWithSameModel: boolean
  maxResumeAttempts: number
  continuationPromptTemplate: string
  /** Max characters of partial content to include in the continuation prompt.
   *  If the partial exceeds this, only the last N characters are kept so the
   *  model can find its place without bloating the conversation. Default: 12000 (~3k tokens). */
  maxPartialContentLength: number

  // Ralph loop: auto-continue mode
  /** Master toggle for the loop feature. When true, users can activate per-session loops. */
  loopEnabled: boolean
  /** Phrase that, when included in a user message, activates the loop for that session. */
  loopStartPhrase: string
  /** Phrase that, when included in a user message, deactivates the loop for that session. */
  loopStopPhrase: string
  /** The prompt text sent to keep the model working when the loop fires. */
  loopPrompt: string
}

// Keep old name as alias for backwards compatibility
export type RateLimitFallbackConfig = FallbackConfig

interface RawConfig {
  enabled?: boolean
  fallbackModel?: FallbackModel
  cooldownMs?: number
  logging?: boolean
  rateLimitPatterns?: string[]
  disconnectPatterns?: string[]
  resumeWithSameModel?: boolean
  maxResumeAttempts?: number
  continuationPromptTemplate?: string
  maxPartialContentLength?: number
  loopEnabled?: boolean
  loopStartPhrase?: string
  loopStopPhrase?: string
  loopPrompt?: string
  // Legacy field name support
  patterns?: string[]
}

const DEFAULT_RATE_LIMIT_PATTERNS = [
  "rate limit",
  "usage limit",
  "too many requests",
  "quota exceeded",
]

const DEFAULT_DISCONNECT_PATTERNS = [
  // Provider capacity / transient errors
  "overloaded",
  "service unavailable",
  "bad gateway",
  "internal server error",
  // Connection-level errors
  "connection reset",
  "connection closed",
  "econnreset",
  "econnaborted",
  "socket hang up",
  "network error",
  "reset by peer",
  "broken pipe",
  "upstream connect error",
  // Stream interruption
  "stream error",
  "unexpected end",
  "premature close",
  "disconnected",
  // Timeouts (specific phrasing to avoid matching OpenCode's own backoff messages)
  "request timed out",
  "connection timed out",
  "response timeout",
  // HTTP status codes (word-boundary matched, so "502" won't match inside "150200")
  "502",
  "503",
  "529",
]

const DEFAULT_CONTINUATION_TEMPLATE =
  `Your previous response was interrupted mid-stream by a provider error. ` +
  `Here is exactly what you had generated before the interruption:\n\n` +
  `---BEGIN PARTIAL RESPONSE---\n{{partial_content}}\n---END PARTIAL RESPONSE---\n\n` +
  `Continue your response EXACTLY where it was cut off. Do not repeat any of the content above. ` +
  `Do not acknowledge the interruption. Just seamlessly continue from the exact point where the text ends.`

const DEFAULT_CONFIG: FallbackConfig = {
  enabled: true,
  fallbackModel: "anthropic/claude-opus-4-5",
  cooldownMs: 300000,
  logging: false,
  rateLimitPatterns: DEFAULT_RATE_LIMIT_PATTERNS,
  disconnectPatterns: DEFAULT_DISCONNECT_PATTERNS,
  resumeWithSameModel: true,
  maxResumeAttempts: 3,
  continuationPromptTemplate: DEFAULT_CONTINUATION_TEMPLATE,
  maxPartialContentLength: 12000,
  loopEnabled: true,
  loopStartPhrase: "Ralph loop mode enabled",
  loopStopPhrase: "Ralph loop mode disabled",
  loopPrompt: "Continue working on the task.",
}

// Support both old and new config file names
const CONFIG_FILENAMES = ["fallback.json", "rate-limit-fallback.json"]
const SEARCH_SUBDIRS = ["config", "plugins", "plugin"]

function getConfigDir(): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
    return join(appData, "opencode")
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(xdgConfig, "opencode")
}

function findConfigFile(): string | null {
  const configDir = getConfigDir()

  for (const filename of CONFIG_FILENAMES) {
    const rootPath = join(configDir, filename)
    if (existsSync(rootPath)) {
      return rootPath
    }

    for (const subdir of SEARCH_SUBDIRS) {
      const subdirPath = join(configDir, subdir, filename)
      if (existsSync(subdirPath)) {
        return subdirPath
      }
    }
  }

  return null
}

export function parseModel(model: FallbackModel): FallbackModelObject {
  if (typeof model === "object") {
    return model
  }
  const slashIndex = model.indexOf("/")
  if (slashIndex === -1) {
    return { providerID: model, modelID: model }
  }
  return {
    providerID: model.substring(0, slashIndex),
    modelID: model.substring(slashIndex + 1),
  }
}

/**
 * Writes the default config file to the opencode config directory.
 * Called on first run when no config file exists, so the user has
 * something to edit immediately.
 * Returns the path written, or null on failure.
 */
function createDefaultConfigFile(): string | null {
  try {
    const configDir = getConfigDir()
    mkdirSync(configDir, { recursive: true })

    const configPath = join(configDir, CONFIG_FILENAMES[0]) // "fallback.json"

    // Write a human-readable JSON with comments-as-descriptions
    // (JSON doesn't support comments, so we use descriptive key names)
    const defaultFileContent = {
      enabled: DEFAULT_CONFIG.enabled,
      fallbackModel: DEFAULT_CONFIG.fallbackModel,
      cooldownMs: DEFAULT_CONFIG.cooldownMs,
      logging: DEFAULT_CONFIG.logging,
      resumeWithSameModel: DEFAULT_CONFIG.resumeWithSameModel,
      maxResumeAttempts: DEFAULT_CONFIG.maxResumeAttempts,
      maxPartialContentLength: DEFAULT_CONFIG.maxPartialContentLength,
      rateLimitPatterns: DEFAULT_CONFIG.rateLimitPatterns,
      disconnectPatterns: DEFAULT_CONFIG.disconnectPatterns,
      loopEnabled: DEFAULT_CONFIG.loopEnabled,
      loopStartPhrase: DEFAULT_CONFIG.loopStartPhrase,
      loopStopPhrase: DEFAULT_CONFIG.loopStopPhrase,
      loopPrompt: DEFAULT_CONFIG.loopPrompt,
    }

    writeFileSync(configPath, JSON.stringify(defaultFileContent, null, 2) + "\n", "utf-8")
    return configPath
  } catch {
    return null
  }
}

export interface LoadConfigResult {
  config: FallbackConfig
  createdDefaultConfig: string | null  // path if a new config file was created
}

/**
 * Overlays plugin options from opencode.json(c) on top of the file config.
 * Unknown keys are ignored so a mistyped option cannot break the plugin.
 */
export function applyOverrides(
  config: FallbackConfig,
  overrides: Record<string, unknown>
): FallbackConfig {
  const result = { ...config } as FallbackConfig & Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    if (key in config && value !== undefined) {
      result[key] = value
    }
  }
  return result
}

export function loadConfig(): LoadConfigResult {
  const configPath = findConfigFile()

  if (!configPath) {
    // First run: create the default config file so the user can find and edit it
    const createdPath = createDefaultConfigFile()
    return { config: DEFAULT_CONFIG, createdDefaultConfig: createdPath }
  }

  try {
    const content = readFileSync(configPath, "utf-8")
    const userConfig = JSON.parse(content) as RawConfig

    return {
      config: {
        enabled: userConfig.enabled ?? DEFAULT_CONFIG.enabled,
        fallbackModel: userConfig.fallbackModel ?? DEFAULT_CONFIG.fallbackModel,
        cooldownMs: userConfig.cooldownMs ?? DEFAULT_CONFIG.cooldownMs,
        logging: userConfig.logging ?? DEFAULT_CONFIG.logging,
        // Support legacy "patterns" field as rateLimitPatterns
        rateLimitPatterns: userConfig.rateLimitPatterns ?? userConfig.patterns ?? DEFAULT_CONFIG.rateLimitPatterns,
        disconnectPatterns: userConfig.disconnectPatterns ?? DEFAULT_CONFIG.disconnectPatterns,
        resumeWithSameModel: userConfig.resumeWithSameModel ?? DEFAULT_CONFIG.resumeWithSameModel,
        maxResumeAttempts: userConfig.maxResumeAttempts ?? DEFAULT_CONFIG.maxResumeAttempts,
        continuationPromptTemplate: userConfig.continuationPromptTemplate ?? DEFAULT_CONFIG.continuationPromptTemplate,
        maxPartialContentLength: userConfig.maxPartialContentLength ?? DEFAULT_CONFIG.maxPartialContentLength,
        loopEnabled: userConfig.loopEnabled ?? DEFAULT_CONFIG.loopEnabled,
        loopStartPhrase: userConfig.loopStartPhrase ?? DEFAULT_CONFIG.loopStartPhrase,
        loopStopPhrase: userConfig.loopStopPhrase ?? DEFAULT_CONFIG.loopStopPhrase,
        loopPrompt: userConfig.loopPrompt ?? DEFAULT_CONFIG.loopPrompt,
      },
      createdDefaultConfig: null,
    }
  } catch {
    return { config: DEFAULT_CONFIG, createdDefaultConfig: null }
  }
}
