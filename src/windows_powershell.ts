/** How token-goat starts Windows PowerShell to ask about processes: one place for the executable and its arguments, shared by doctor and the hidden-rule scan. Imports only Node built-ins and shell.ts, which imports only built-ins, so claude_hidden_rules.ts stays off every hook's eager path. */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The Windows PowerShell 5.1 executable under the system root, or the bare name for PATH to resolve when that file is missing. */
export function windowsPowerShellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(shell) ? shell : 'powershell.exe'
}

export { powerShellCommandArgs } from './shell.js'
