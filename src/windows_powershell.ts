/** How token-goat starts Windows PowerShell to ask about processes: one place for the executable and its arguments, shared by doctor's process list and the hidden-rule scan's command-line read. Imports only Node built-ins, so claude_hidden_rules.ts can keep off every hook's eager path. */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** The Windows PowerShell 5.1 executable under the system root, or the bare name for PATH to resolve when that file is missing. */
export function windowsPowerShellPath(): string {
  const systemRoot = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  const shell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return fs.existsSync(shell) ? shell : 'powershell.exe'
}

/** The arguments that run `command` without a profile and without waiting on input. */
export function powerShellCommandArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command]
}
