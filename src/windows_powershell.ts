/** How token-goat starts Windows PowerShell to ask about processes: one place for the executable and its arguments, shared by doctor and the hidden-rule scan. Imports only Node built-ins and shell.ts, which imports only built-ins, so claude_hidden_rules.ts stays off every hook's eager path. */

import { windowsSystem32Exe } from './windows_system32.js'

/** The Windows PowerShell 5.1 executable under the validated Windows folder; when no folder holds it, the absolute C:\Windows path, which a spawn fails on rather than resolving a bare name from PATH or the working directory. */
export function windowsPowerShellPath(): string {
  return windowsSystem32Exe('WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export { powerShellCommandArgs } from './shell.js'
