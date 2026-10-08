# opencode-fallback

OpenCode 2 plugin that automatically recovers from provider disconnects (resuming mid-response) and rate limits (switching to a fallback model). Also includes an optional auto-continue loop mode.

> **OpenCode 2 only.** Version 2.x targets the OpenCode 2 plugin API (`@opencode/plugin`).
> For OpenCode 1, use version 1.x of this package.

## Features

- **Disconnect Recovery**: Detects when a provider drops the connection mid-response, captures partial output, and sends a continuation prompt so the model picks up exactly where it left off.
- **Rate Limit Fallback**: Detects rate-limit/quota errors and seamlessly re-sends the original request using a configurable fallback model.
- **Auto-Continue Loop** ("Ralph Loop"): Activate per-session autonomous looping that sends a configurable nudge prompt every time the session finishes a turn, keeping the model working continuously.

## Installation

Add to your `opencode.jsonc`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-fallback"]
}
```

You can also pass configuration directly from the OpenCode config, which takes
precedence over `fallback.json` (see [Configuration](#configuration)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-fallback",
      "options": {
        "fallbackModel": "opencode/qwen3.6-plus-free",
        "logging": true
      }
    }
  ]
}
```

Local directories are supported too (the path must point at the plugin
directory, not an individual file):

```json
{
  "plugins": ["/absolute/path/to/opencode-fallback"]
}
```

## Configuration

The plugin auto-creates a default `fallback.json` in your OpenCode config directory on first run. Edit it to customize behavior.

**Locations checked (in order):**
1. `~/.config/opencode/fallback.json`
2. `~/.config/opencode/config/fallback.json`
3. `~/.config/opencode/plugins/fallback.json`
4. `~/.config/opencode/plugin/fallback.json`

Legacy `rate-limit-fallback.json` filenames are also supported in all the same locations.

**Example config:**

```json
{
  "enabled": true,
  "fallbackModel": "anthropic/claude-opus-4-5",
  "cooldownMs": 300000,
  "logging": false,
  "resumeWithSameModel": true,
  "maxResumeAttempts": 3,
  "maxPartialContentLength": 12000,
  "rateLimitPatterns": [
    "rate limit",
    "usage limit",
    "too many requests",
    "quota exceeded"
  ],
  "disconnectPatterns": [
    "overloaded",
    "service unavailable",
    "bad gateway",
    "internal server error",
    "connection reset",
    "connection closed",
    "econnreset",
    "econnaborted",
    "socket hang up",
    "network error",
    "reset by peer",
    "broken pipe",
    "upstream connect error",
    "stream error",
    "unexpected end",
    "premature close",
    "disconnected",
    "request timed out",
    "connection timed out",
    "response timeout",
    "502",
    "503",
    "529"
  ],
  "loopEnabled": true,
  "loopStartPhrase": "Ralph loop mode enabled",
  "loopStopPhrase": "Ralph loop mode disabled",
  "loopPrompt": "Continue working on the task."
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable the plugin entirely |
| `fallbackModel` | string \| object | `"anthropic/claude-opus-4-5"` | Fallback model (see formats below) |
| `cooldownMs` | number | `300000` | Rate-limit cooldown period in ms (default: 5 minutes) |
| `logging` | boolean | `false` | Enable file-based debug logging |
| `rateLimitPatterns` | string[] | *(see above)* | Case-insensitive substring patterns for rate-limit detection |
| `disconnectPatterns` | string[] | *(see above)* | Word-boundary regex patterns for disconnect/stream-error detection |
| `resumeWithSameModel` | boolean | `true` | On first disconnect, retry with the same model before escalating |
| `maxResumeAttempts` | number | `3` | Max consecutive disconnect resume attempts before giving up |
| `maxPartialContentLength` | number | `12000` | Max characters of partial content included in the continuation prompt (tail-truncated if exceeded) |
| `continuationPromptTemplate` | string | *(see below)* | Template for the continuation prompt; use `{{partial_content}}` as placeholder |
| `loopEnabled` | boolean | `true` | Master toggle for the auto-continue loop feature |
| `loopStartPhrase` | string | `"Ralph loop mode enabled"` | Phrase in a user message that activates the loop for that session |
| `loopStopPhrase` | string | `"Ralph loop mode disabled"` | Phrase in a user message that deactivates the loop for that session |
| `loopPrompt` | string | `"Continue working on the task."` | Prompt text sent to keep the model working each loop iteration |

Every one of these can also be supplied through the `options` object of the
`plugins` entry in `opencode.json(c)`; the OpenCode config wins over
`fallback.json` when both define the same key.

### Fallback Model Format

The `fallbackModel` field accepts a `"provider/model"` string:

```json
{
  "fallbackModel": "anthropic/claude-opus-4-5"
}
```

Or an explicit object:

```json
{
  "fallbackModel": {
    "providerID": "anthropic",
    "modelID": "claude-opus-4-5"
  }
}
```

> A bare model name with no `/` is treated as `providerID == modelID`. Always
> include the provider prefix if the provider ID differs from the model ID.

### Continuation Prompt Template

The default template for disconnect recovery is:

```
Your previous response was interrupted mid-stream by a provider error.
Here is exactly what you had generated before the interruption:

---BEGIN PARTIAL RESPONSE---
{{partial_content}}
---END PARTIAL RESPONSE---

Continue your response EXACTLY where it was cut off. Do not repeat any of
the content above. Do not acknowledge the interruption. Just seamlessly
continue from the exact point where the text ends.
```

Override via the `continuationPromptTemplate` config field. The `{{partial_content}}` placeholder is replaced with the captured partial output.

### Pattern Matching

The two pattern sets use different matching strategies:

- **Rate-limit patterns** use case-insensitive **substring** matching (safe for multi-word phrases like "rate limit").
- **Disconnect patterns** use case-insensitive **word-boundary** regex matching (`\b...\b`), preventing false positives like "eof" matching inside "thereof" or "502" matching inside longer numbers.

Patterns are matched against the structured provider error exposed by the V2
`retry` hook (error type, message, HTTP status and response body), not against a
UI message.

### Logging

When `logging: true`, logs are written to:

```
~/.local/share/opencode/logs/fallback.log
```

Log entries include timestamps and structured details about detection events, recovery attempts, and errors.

## How It Works

OpenCode 2 does not publish `session.status` events to plugins, so detection uses
the V2 `session.hook("retry", ...)` hook. The hook fires right before OpenCode
retries a failed request and exposes the classified error (`type`, `message`,
optional `status` and `response.body`).

When a pattern matches, the plugin sets `decision = { retry: false }` to take
over from OpenCode's built-in retry policy and schedules a recovery a moment
later, so the failing run can settle.

### Disconnect Recovery

1. **Detection**: `retry` hook error matches a disconnect pattern.
2. **Take over**: Disable OpenCode's own retry for this attempt.
3. **Abort**: Interrupt the current run.
4. **Capture**: Fetch messages and extract text from the last (interrupted) assistant response.
5. **Continue**: Send a continuation prompt that includes the partial content, instructing the model to pick up exactly where it left off.
6. **Model selection**: First attempt retries with the same model (it was a disconnect, not a model issue). Subsequent attempts escalate to the fallback model.
7. **Backoff**: Exponential delay between attempts (2s, 4s, 8s, up to 30s).
8. **Guard**: Stops after `maxResumeAttempts` consecutive failures.

If no partial content was captured (e.g., the response hadn't started), the original user message is re-sent instead.

### Rate Limit Fallback

1. **Detection**: `retry` hook error matches a rate-limit pattern.
2. **Take over**: Disable OpenCode's own retry for this attempt.
3. **Abort**: Interrupt the current run.
4. **Re-send**: Switch the session to the configured fallback model and re-send the original user message.
5. **Cooldown**: Starts a cooldown timer (default 5 minutes). During cooldown, subsequent rate limits on the same session are ignored to prevent re-trigger spam.

### Auto-Continue Loop

The loop feature is activated per-session using a magic phrase in any user message.

1. Include your configured start phrase (default: `"Ralph loop mode enabled"`) in any message to activate the loop for that session.
2. Once active, every time a turn completes successfully, the plugin automatically sends the configured loop prompt (default: `"Continue working on the task."`).
3. Include the stop phrase (default: `"Ralph loop mode disabled"`) to deactivate.

Notes:
- Stop takes priority over start if both phrases appear in the same message.
- The activation message itself does not trigger a loop iteration (the loop starts on the *next* completed turn).
- The loop integrates with disconnect/rate-limit recovery: recovery runs first, and the loop resumes on the next completed turn.
- Only successfully completed turns continue the loop; a failed turn stops it instead of spinning on a broken provider.

## OpenCode 2 Differences

The V2 plugin API differs from V1 in ways that affect this plugin's behavior:

- **Detection via `retry` hook.** V2 does not deliver `session.status` events
  (busy/retry/idle) to plugins, so detection moved from the event stream to the
  `retry` hook. This gives structured provider errors instead of parsed strings.
- **No `revert`.** The V2 plugin API has no `session.revert`, so the failed
  assistant turn cannot be removed. Recovery appends a new message after the
  failed attempt; the transcript therefore keeps the incomplete/erroring turn.
- **Fallback model is session-scoped.** V2 prompts do not accept a model, so the
  plugin uses `session.switchModel` before re-sending. The session stays on the
  fallback model until you switch it back manually or start a new session.
  (V1 scoped the fallback model to a single re-sent message.)
- **"Idle" is inferred from `session.execution.succeeded`.** The loop only
  advances on successfully completed turns.
- **Plugins load per location.** Hooks and events are broadcast to every loaded
  plugin instance, so only the instance that owns the session's location
  performs a recovery. This prevents one failure from triggering one recovery
  per location.

## Race Condition Handling

The plugin uses a timestamp-based grace window to avoid re-triggering on retry
events that belong to the attempt it is already recovering. Any retry event
arriving within 5 seconds of the last plugin takeover is ignored.

## Backwards Compatibility

- The legacy config filename `rate-limit-fallback.json` is still recognized.
- The legacy `patterns` field in the config file maps to `rateLimitPatterns`.
- The old type export `RateLimitFallbackConfig` is preserved as an alias for `FallbackConfig`.
- Version 2.x requires OpenCode 2. Version 1.x remains available for OpenCode 1.

## Local Development

Point the config at the plugin **directory** (a file path is rejected by the
OpenCode 2 plugin loader):

```json
{
  "plugins": ["/absolute/path/to/opencode-fallback"]
}
```

Then typecheck and reload:

```sh
npm install
npm run typecheck
opencode api post /api/location/reload
```

## License

MIT
