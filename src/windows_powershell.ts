/** How token-goat starts Windows PowerShell to ask about processes: one place for the executable and its arguments, shared by doctor and the hidden-rule scan. Imports only Node built-ins and shell.ts, which imports only built-ins, so claude_hidden_rules.ts stays off every hook's eager path. */

import { powerShellCommandArgs } from './shell.js'
import { windowsSystem32Exe } from './windows_system32.js'

/** The Windows PowerShell 5.1 executable under the validated Windows folder; when no folder holds it, the absolute C:\Windows path, which a spawn fails on rather than resolving a bare name from PATH or the working directory. */
export function windowsPowerShellPath(): string {
  return windowsSystem32Exe('WindowsPowerShell', 'v1.0', 'powershell.exe')
}

export { powerShellCommandArgs } from './shell.js'

/** The arguments for a PowerShell script whose printed text this process reads back. Windows PowerShell 5.1 writes a pipe in the console's OEM code page (437 here), where a launcher path with an accented or non-Latin character comes back as 0x82 or '?' and never matches the install it names; the script is prefixed with a UTF-8 (no byte order mark) output encoding so the text arrives whole. Every text-reading query goes through here, and tests/guards/powershell_text_queries_set_utf8_output.test.ts fails a query that does not. */
export function powerShellTextQueryArgs(script: string): string[] {
  return powerShellCommandArgs(`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ${script}`)
}
