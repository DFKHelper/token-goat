/**
 * Bridges barrel.
 *
 * Re-exports the harness-detection surface, the shared bridge types, and each
 * harness bridge so callers import from `./bridges/index.js` rather than
 * reaching into individual files.
 */

export { detectHarness, getHarnessName } from './registry.js'
export type { BridgeConfig, HarnessName } from './types.js'
export { CLAUDECODE_HOOK_SCRIPT } from './claudecode.js'
export { CODEX_HOOK_SCRIPT } from './codex.js'
export {
  CodexConfigParseError,
  codexAgentsPath,
  codexConfigPath,
  codexHookScriptPath,
  installCodex,
  isCodexInstalled,
  uninstallCodex,
} from './codex_install.js'
export type { CodexInstallResult } from './codex_install.js'
