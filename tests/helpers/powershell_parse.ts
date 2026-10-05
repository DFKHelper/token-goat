// Parse token-goat's suggested commands with PowerShell's own parser, an oracle independent of the guard's quote splitting: a suggestion that survives stripUnsafeSuggestions must be exactly one PowerShell statement.
import { spawnSync } from 'node:child_process'

import { canRunPowerShell, resolvePowerShell } from '../../src/shell.js'

/** What PowerShell's parser made of one command: its top-level statement count and how many parse errors it reported. */
export interface PowerShellParse {
  command: string
  statements: number
  errors: number
}

// Reads a base64 UTF-8 JSON array of strings from the environment (no console code page touches it) and prints one ASCII "statements errors" line per command.
const PARSE_SCRIPT = [
  '$in = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:TG_PS_PARSE_INPUT))',
  // Assigned first: Windows PowerShell 5.1 emits a JSON array as one object, which @() would not unroll.
  '$all = ConvertFrom-Json -InputObject $in',
  'foreach ($c in $all) {',
  '  $t = $null; $e = $null',
  '  $a = [System.Management.Automation.Language.Parser]::ParseInput([string]$c, [ref]$t, [ref]$e)',
  '  $n = 0; foreach ($b in @($a.BeginBlock, $a.ProcessBlock, $a.EndBlock)) { if ($b) { $n += $b.Statements.Count } }',
  "  [Console]::Out.WriteLine(('{0} {1}' -f $n, $e.Count))",
  '}',
].join('\n')

/** The PowerShell to parse with, or null when none can run here. On CI a missing PowerShell throws instead, because GitHub's ubuntu, macOS and Windows runners all ship pwsh, so a silent skip there would hide the oracle being gone. */
export function powershellForParsing(): string | null {
  if (canRunPowerShell()) return resolvePowerShell()
  if (process.env['CI']) throw new Error('PowerShell is required on CI to parse token-goat suggestions, but none was found')
  return null
}

/** Parse every command in one PowerShell process. */
export function parseWithPowerShell(exe: string, commands: readonly string[]): PowerShellParse[] {
  if (commands.length === 0) return []
  const input = Buffer.from(JSON.stringify(commands), 'utf8').toString('base64')
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', PARSE_SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, TG_PS_PARSE_INPUT: input },
    timeout: 60_000,
    windowsHide: true,
  })
  if (res.status !== 0) throw new Error(`PowerShell parse run failed (status ${String(res.status)}): ${res.stderr || String(res.error)}`)
  const lines = res.stdout.split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length !== commands.length) throw new Error(`PowerShell parsed ${lines.length} of ${commands.length} commands:\n${res.stdout}\n${res.stderr}`)
  return lines.map((line, i) => {
    const [statements, errors] = line.trim().split(' ').map(Number)
    return { command: commands[i]!, statements: statements!, errors: errors! }
  })
}

/** Every backtick-fenced `token-goat …` command in `text`, the form a hint hands the model to run, leaving out the guard's own "command omitted" placeholder, which is not a command. */
export function fencedSuggestions(text: string): string[] {
  return Array.from(text.matchAll(/`(token-goat [^`\r\n]*)`/g), (m) => m[1]!).filter((s) => !s.startsWith('token-goat (command omitted'))
}
