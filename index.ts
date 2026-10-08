// OpenCode 2 entrypoint: the default export must be a plugin definition with
// an `id` and a `setup` (or `effect`) function.
export { plugin as default, plugin as FallbackPlugin } from "./src/plugin"

// Type exports are fine (stripped at runtime)
export type {
  FallbackConfig,
  RateLimitFallbackConfig,
  FallbackModel,
  FallbackModelObject,
} from "./src/config"
