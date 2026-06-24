/**
 * Bridges barrel.
 *
 * Re-exports the harness-detection surface, the shared bridge types, and each
 * harness bridge so callers import from `./bridges/index.js` rather than
 * reaching into individual files.
 */

export { detectHarness, getHarnessName } from './registry.js'
export type { BridgeConfig, HarnessName } from './types.js'
export { CLAUDECODE_HOOK_SCRIPT, getClaudeCodeHookConfig } from './claudecode.js'
export { CODEX_HOOK_SCRIPT, getCodexHookConfig } from './codex.js'
