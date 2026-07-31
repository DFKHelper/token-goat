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
export { COPILOT_CLI_HOOK_SCRIPT } from './copilot_cli.js'
export {
  copilotCliConfigPath,
  copilotCliInstructionsPath,
  copilotCliProjectHooksDir,
  copilotCliScriptPath,
  copilotCliUserHooksDir,
  installCopilotCli,
  isCopilotCliInstalled,
  uninstallCopilotCli,
} from './copilot_cli_install.js'
export type { CopilotCliInstallResult, CopilotCliScopeOptions } from './copilot_cli_install.js'
export { GROK_HOOK_SCRIPT } from './grok.js'
export {
  grokConfigPath,
  grokHooksDir,
  grokHookScriptPath,
  installGrok,
  isGrokInstalled,
  uninstallGrok,
} from './grok_install.js'
export type { GrokInstallResult } from './grok_install.js'
