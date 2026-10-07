// Run suggested `token-goat …` commands through a real POSIX shell and a real PowerShell, each with a `token-goat` function standing in for the binary, and return the argv each shell handed it. An oracle independent of quotedArg: a value reaches the command as written only if both shells agree with the literal reading of its quotes.
import { spawnSync } from 'node:child_process'

import { resolveWindowsBash } from '../../src/shell.js'
import { powershellForParsing } from './powershell_parse.js'

/** The POSIX shell to run suggestions through, or null when none is available here. */
export const POSIX_SH: string | null = process.platform === 'win32' ? resolveWindowsBash() : '/bin/sh'

/** The PowerShell to run suggestions through, or null when none can run here (it throws on CI instead, see powershellForParsing). */
export const POWERSHELL: string | null = powershellForParsing()

/** What a shell printed for one command: the argv of every `token-goat` call it made, and any other stdout line, which only a command the suggestion smuggled in writes. */
export interface ShellRun {
  calls: string[][]
  stray: string[]
}

const END = '@@TG_END@@'

/** Split one shell's stdout into a run per command, at the END line each command is followed by. */
function splitRuns(stdout: string, decode: (payload: string) => string[], count: number, failure: string): ShellRun[] {
  const runs: ShellRun[] = []
  let cur: ShellRun = { calls: [], stray: [] }
  for (const line of stdout.split(/\r?\n/)) {
    if (line === END) {
      runs.push(cur)
      cur = { calls: [], stray: [] }
    } else if (line.startsWith('CALL:')) cur.calls.push(decode(line.slice(5)))
    else if (line !== '') cur.stray.push(line)
  }
  if (runs.length !== count) throw new Error(`shell ran ${runs.length} of ${count} commands: ${failure}`)
  return runs
}

/** Builtins only, since a process per argument made a few hundred commands take minutes under Git Bash: a call is `C<argc>` then each argument, every field NUL-terminated (no value holds NUL), and `E` ends a command's run. Each command runs in a subshell, so one that fails to parse cannot end the others. */
const SH_SCRIPT = [
  "token-goat() { printf '\\0C%d\\0' \"$#\"; printf '%s\\0' \"$@\"; }",
  'i=0',
  'while [ "$i" -lt "$TG_N" ]; do',
  '  eval "c=\\"\\$TG_CMD_$i\\""',
  '  ( eval "$c" ) 2>/dev/null',
  "  printf '\\0E\\0'",
  '  i=$((i+1))',
  'done',
].join('\n')

/** Each command run by a POSIX shell, its `token-goat` calls decoded. Git Bash drops a carriage return from the text it evaluates, quoted or not, so on Windows no quoting carries one: callers compare without it there. */
export function shRunAll(sh: string, commands: readonly string[]): ShellRun[] {
  const env: NodeJS.ProcessEnv = { ...process.env, TG_N: String(commands.length) }
  commands.forEach((c, i) => {
    env[`TG_CMD_${i}`] = c
  })
  const res = spawnSync(sh, ['-c', SH_SCRIPT], { encoding: 'utf8', env, windowsHide: true, timeout: 120_000 })
  const fields = res.stdout.split('\0')
  const runs: ShellRun[] = []
  let cur: ShellRun = { calls: [], stray: [] }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    const argc = /^C(\d+)$/.exec(f)
    if (argc !== null) {
      const n = Number(argc[1])
      cur.calls.push(fields.slice(i + 1, i + 1 + n))
      i += n
    } else if (f === 'E') {
      runs.push(cur)
      cur = { calls: [], stray: [] }
    } else if (f !== '') cur.stray.push(f)
  }
  if (runs.length !== commands.length) throw new Error(`shell ran ${runs.length} of ${commands.length} commands: ${res.stderr}`)
  return runs
}

/** Each command run by PowerShell through Invoke-Expression, its `token-goat` calls decoded. */
export function powershellRunAll(exe: string, commands: readonly string[]): ShellRun[] {
  const script = [
    'function token-goat { $j = ConvertTo-Json -InputObject @($args | ForEach-Object { [string]$_ }) -Compress; [Console]::Out.WriteLine("CALL:" + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))) }',
    '$all = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:TG_CMDS)))',
    `foreach ($c in $all) { try { Invoke-Expression ([string]$c) } catch { }; [Console]::Out.WriteLine('${END}') }`,
  ].join('\n')
  const res = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, TG_CMDS: Buffer.from(JSON.stringify(commands), 'utf8').toString('base64') }, timeout: 120_000, windowsHide: true })
  const decode = (payload: string): string[] => JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as string[]
  return splitRuns(res.stdout, decode, commands.length, res.stderr)
}

/** The argv `command` means when its quotes are read literally, which is how quotedArg writes them: it escapes nothing, so `'…'` and `"…"` each hold their body as is. */
export function literalArgv(command: string): string[] {
  const args: string[] = []
  let cur: string | null = null
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (c === ' ') {
      if (cur !== null) args.push(cur)
      cur = null
      continue
    }
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      if (close === -1) throw new Error(`unclosed ${c} in ${command}`)
      cur = (cur ?? '') + command.slice(i + 1, close)
      i = close
      continue
    }
    cur = (cur ?? '') + c
  }
  if (cur !== null) args.push(cur)
  return args.slice(1)
}
