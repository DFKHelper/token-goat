// Run suggested `token-goat …` commands through a real POSIX shell and a real PowerShell, each with a `token-goat` function standing in for the binary, and return the argv each shell handed it. An oracle independent of quotedArg: a value reaches the command as written only if both shells agree with the literal reading of its quotes.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import * as fs from 'node:fs'

import { resolveWindowsBash } from '../../src/shell.js'
import { powershellForParsing } from './powershell_parse.js'

/** bash rather than /bin/sh, since the stand-in function is named `token-goat`: bash accepts that name, while Ubuntu's dash ("Bad function name") and macOS's POSIX-mode bash ("not a valid identifier") refuse it and fail every command. Null when no bash is available here; on CI that throws instead, as a missing PowerShell does, because a silent skip would hide the oracle being gone. */
function posixShell(): string | null {
  const sh = process.platform === 'win32' ? resolveWindowsBash() : fs.existsSync('/bin/bash') ? '/bin/bash' : null
  if (sh === null && process.env['CI']) throw new Error('bash is required on CI to run token-goat suggestions through a POSIX shell, but none was found')
  return sh
}

/** The POSIX shell to run suggestions through, or null when none is available here. */
export const POSIX_SH: string | null = posixShell()

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

/** Why a shell run stopped short, so a timeout or a kill reads as one instead of as an empty stderr. */
function spawnFailure(res: SpawnSyncReturns<string>): string {
  const parts = [(res.stderr ?? '').trim(), res.error ? `spawn error: ${res.error.message}` : '', res.signal ? `killed by ${res.signal}` : '']
  return parts.filter((p) => p !== '').join('; ') || `exit status ${res.status}`
}

/** Commands sharing one subshell: a fork per command cost Git Bash about 34 ms idle and enough under full-suite load to cross the 120 s cap partway through 184 commands. */
const SH_CHUNK = 16

/** Builtins only, since a process per argument made a few hundred commands take minutes under Git Bash: a call is `C<argc>` then each argument, every field NUL-terminated (no value holds NUL), `E<n>` ends command n's run, and `X` ends a chunk. Each chunk runs in a subshell, so a command that ends it cannot end the other chunks; a command can only change what its chunk mates see by smuggling in a statement, which already changes its own argv. */
const SH_SCRIPT = [
  "token-goat() { printf '\\0C%d\\0' \"$#\"; printf '%s\\0' \"$@\"; }",
  'tg_i=0',
  'while [ "$tg_i" -lt "$TG_N" ]; do',
  '  (',
  '    tg_end=$((tg_i + TG_CHUNK))',
  '    while [ "$tg_i" -lt "$TG_N" ] && [ "$tg_i" -lt "$tg_end" ]; do',
  '      tg_k=$tg_i',
  '      eval "tg_c=\\"\\$TG_CMD_$tg_k\\""',
  '      eval "$tg_c"',
  "      printf '\\0E%d\\0' \"$tg_k\"",
  '      tg_i=$((tg_k + 1))',
  '    done',
  '  ) 2>/dev/null',
  "  printf '\\0X\\0'",
  '  tg_i=$((tg_i + TG_CHUNK))',
  'done',
].join('\n')

/** Each command run by a POSIX shell, its `token-goat` calls decoded. A command that ends its chunk's subshell keeps what it printed as its run, and the chunk mates after it run again in a later pass. Git Bash drops a carriage return from the text it evaluates, quoted or not, so on Windows no quoting carries one: callers compare without it there. */
export function shRunAll(sh: string, commands: readonly string[], opts: { timeoutMs?: number } = {}): ShellRun[] {
  const runs: (ShellRun | undefined)[] = new Array<ShellRun | undefined>(commands.length)
  let pending = commands.map((_, i) => i)
  while (pending.length > 0) {
    const env: NodeJS.ProcessEnv = { ...process.env, TG_N: String(pending.length), TG_CHUNK: String(SH_CHUNK) }
    pending.forEach((ci, j) => {
      env[`TG_CMD_${j}`] = commands[ci]
    })
    const res = spawnSync(sh, ['-c', SH_SCRIPT], { encoding: 'utf8', env, windowsHide: true, timeout: opts.timeoutMs ?? 120_000 })
    const fields = (res.stdout ?? '').split('\0')
    const rerun: number[] = []
    let chunkEnd = Math.min(SH_CHUNK, pending.length)
    let next = 0
    let cur: ShellRun = { calls: [], stray: [] }
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!
      const argc = /^C(\d+)$/.exec(f)
      const end = /^E(\d+)$/.exec(f)
      if (argc !== null) {
        const n = Number(argc[1])
        cur.calls.push(fields.slice(i + 1, i + 1 + n))
        i += n
      } else if (end !== null && Number(end[1]) === next && next < chunkEnd) {
        runs[pending[next]!] = cur
        next++
        cur = { calls: [], stray: [] }
      } else if (f === 'X' && next <= chunkEnd) {
        if (next < chunkEnd) {
          runs[pending[next]!] = cur
          rerun.push(...pending.slice(next + 1, chunkEnd))
        }
        next = chunkEnd
        chunkEnd = Math.min(chunkEnd + SH_CHUNK, pending.length)
        cur = { calls: [], stray: [] }
      } else if (f !== '') cur.stray.push(f)
    }
    if (next < pending.length) {
      const ran = runs.filter((r) => r !== undefined).length
      throw new Error(`shell ran ${ran} of ${commands.length} commands: ${spawnFailure(res)}`)
    }
    pending = rerun
  }
  return runs as ShellRun[]
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
  return splitRuns(res.stdout ?? '', decode, commands.length, spawnFailure(res))
}

/** The argv of the one `token-goat` call `command` made; throws when it made none or several, or printed anything else. */
function onlyCall(run: ShellRun, command: string): string[] {
  if (run.calls.length !== 1 || run.stray.length > 0) throw new Error(`expected one token-goat call from ${command}, got ${JSON.stringify(run)}`)
  return run.calls[0]!
}

/** The argv a POSIX shell hands the `token-goat` function when it runs `command`. */
export function shArgv(sh: string, command: string): string[] {
  return onlyCall(shRunAll(sh, [command])[0]!, command)
}

/** The argv PowerShell hands the `token-goat` function when it runs `command`. */
export function powershellArgv(exe: string, command: string): string[] {
  return onlyCall(powershellRunAll(exe, [command])[0]!, command)
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
