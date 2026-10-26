// Run suggested `token-goat …` commands through a real POSIX shell and a real PowerShell, each with a `token-goat` function standing in for the binary, and return the argv each shell handed it. An oracle independent of quotedArg: a value reaches the command as written only if both shells agree with the literal reading of its quotes.
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'

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
function spawnFailure(res: { stderr?: string | null; error?: Error | null | undefined; signal?: string | null; status?: number | null }): string {
  const parts = [(res.stderr ?? '').trim(), res.error ? `spawn error: ${res.error.message}` : '', res.signal ? `killed by ${res.signal}` : '']
  return parts.filter((p) => p !== '').join('; ') || `exit status ${res.status}`
}

/** Commands sharing one subshell: a fork per command cost Git Bash about 34 ms idle and enough under full-suite load to cross the 120 s cap partway through 184 commands. */
const SH_CHUNK = 16

/** Seconds past the spawn timeout the shell's own `TG_BUDGET_S` deadline allows: the timeout kills a live run first, so the deadline only ever fires when the parent died and could not kill it. A parent check cannot stand in: under Git Bash a native parent reads as `$PPID` 1, so `kill -0` on it fails at once and would end every live run. */
const SH_BUDGET_SLACK_S = 15

/** Builtins only, since a process per argument made a few hundred commands take minutes under Git Bash: a call is `C<argc>` then each argument, every field NUL-terminated (no value holds NUL), `E<n>` ends command n's run, and `X` ends a chunk. The shell exits on its own once `$SECONDS` passes `TG_BUDGET_S` (default 600), so a run whose parent died cannot spin forever. Each chunk runs in a subshell, so a command that ends it cannot end the other chunks; a command can only change what its chunk mates see by smuggling in a statement, which already changes its own argv. */
export const SH_SCRIPT = [
  "token-goat() { printf '\\0C%d\\0' \"$#\"; printf '%s\\0' \"$@\"; }",
  '[ -n "${TG_N+x}" ] || exit 1',
  'case "$TG_N" in *[!0-9]*) exit 1 ;; esac',
  '[ -n "${TG_CHUNK+x}" ] || TG_CHUNK=16',
  '[ "$TG_CHUNK" -gt 0 ] 2>/dev/null || exit 1',
  'case "$TG_CHUNK" in *[!0-9]*) exit 1 ;; esac',
  '[ -n "${TG_BUDGET_S+x}" ] || TG_BUDGET_S=600',
  'case "$TG_BUDGET_S" in "" | *[!0-9]*) exit 1 ;; esac',
  'tg_chunk=$((10#$TG_CHUNK))',
  'tg_i=0',
  'while [ "$tg_i" -lt "$TG_N" ]; do',
  '  [ "$SECONDS" -lt "$TG_BUDGET_S" ] || exit 1',
  '  (',
  '    tg_end=$((tg_i + tg_chunk))',
  '    while [ "$tg_i" -lt "$TG_N" ] && [ "$tg_i" -lt "$tg_end" ]; do',
  '      tg_k=$tg_i',
  '      eval "tg_c=\\"\\$TG_CMD_$tg_k\\""',
  '      eval "$tg_c"',
  "      printf '\\0E%d\\0' \"$tg_k\"",
  '      tg_i=$((tg_k + 1))',
  '    done',
  '  ) 2>/dev/null',
  "  printf '\\0X\\0'",
  '  tg_next=$((tg_i + tg_chunk))',
  '  [ "$tg_next" -gt "$tg_i" ] 2>/dev/null || exit 1',
  '  tg_i=$tg_next',
  'done',
].join('\n')

/** The variable naming a run's owner token: every process the run starts inherits it, so a cleanup can find them all after a timeout killed only the outer shell. */
export const OWNER_VAR = 'TG_SHARGV_OWNER'

/** Defines `tg_live PID`, true while the pid runs: a zombie is gone, and so is a pid with no /proc entry; a present entry whose stat reads empty is unknown, so it answers alive and the caller re-reads it, since under load MSYS keeps answering kill -0 for one that already exited, which cannot decide it; macOS has no /proc, so it asks `ps` for the state, since a killed child of a parent that is blocked in a synchronous wait (the test process inside spawnSync) stays a zombie and kill -0 answers yes for it; an empty or failed listing falls through to kill -0. */
export const SH_LIVE = 'tg_live() { tg_proc=${TG_PROC_ROOT:-/proc}; if [ -r /proc/self/stat ]; then tg_st=; read -r tg_st 2>/dev/null < "$tg_proc/$1/stat"; if [ -z "$tg_st" ]; then [ -d "$tg_proc/$1" ] || return 1; return 0; fi; case "${tg_st##*) }" in Z*) return 1 ;; esac; else tg_st=; read -r tg_st _ 2>/dev/null < <(ps -o stat= -p "$1" 2>/dev/null); case "$tg_st" in Z*) return 1 ;; esac; fi; kill -0 "$1" 2>/dev/null; }'

/** The awk program that finds kin of the owned set from a PID PPID PGID listing (`ps -e` under MSYS, whose columns are PID PPID PGID WINPID ...; `ps -A -o pid=,ppid=,pgid=,stat=` elsewhere, since a procps `ps -e` prints PID TTY TIME CMD and its second column is no parent, which left the scan blind on Linux, and a BSD `ps -e` adds the environment to a listing of only the caller's processes that have a terminal, which left it blind on macOS where a test child has none): prints `L pid` for an owned process leading its own group, and `K pid` for a live process that is a child of an owned or killed pid or sits in a group an owned leader led. Under MSYS a process shows in stat (with its parent and group) one to several seconds before its environment is readable, so a child its parent started just before being killed is kin here long before the token scan can see it. */
const KIN_AWK = '$1 ~ /^[0-9]+$/ && $0 !~ /defunct/ && $4 !~ /^Z/ { known = index(seeds, " " $1 " "); if (known && $3 == $1) print "L", $1; if (!known && (index(seeds, " " $2 " ") || index(leaders, " " $3 " "))) print "K", $1 }'

/** Stops then kills every process whose environment carries `${OWNER_VAR}=$TG_REAP_TOKEN`, rescanning so a child forked between scan and stop is caught, and exits 1 naming any it killed that are still alive ten seconds later, each with its process state and Windows pid and with what `kill -f` printed, so a failure explains itself (a zombie awaiting its reaper counts as gone, so does a pid with no /proc entry where /proc exists, and the report lists only pids still alive when it is written, since under load a killed process can finish exiting just after the deadline). A survivor at two seconds is killed again, under MSYS through the Win32 interface (`kill -f`), since a loaded Windows machine left a signalled Git Bash process running past five seconds; the CONT after the KILL wakes a stopped process that would otherwise sit on its pending signal. Matching the token instead of a recorded pid finds the chunk subshell a timeout orphaned and everything it started, reparented or not, and cannot hit an unrelated process that reused a dead one's pid. One `grep -z` pass over every /proc/<pid>/environ on Linux and under MSYS (a pass that grep did not finish, killed by a signal, is repeated and never read as finding nothing, since a captured run had it die with SIGHUP and the empty answer ended the reap with the run still alive), since bash's `read` pulls a /proc file a byte at a time and that took a loaded Windows machine past a minute; `ps -E` on macOS. Once everything found is dead the scan runs once more and exits 0 only when it finds no live owned process outside the killed set, since a process forked after the last scan (a stop signal can land after a fork already began, and a loaded machine stretches the gap between scan and kill) would otherwise outlive the reap unseen; a process that scan finds is killed and the check repeats. Every scan, with or without /proc, also adds the kin found by KIN_AWK, because the token scan alone cannot see an MSYS child in the seconds between its parent starting it and its environment becoming readable (a child started just before its parent was killed outlived the reap that way); the reap exits 0 only after two consecutive scans find nothing live outside the killed set, survivors are sent KILL again every second, and a run that keeps producing new processes fails after 20 rounds instead of looping. The scan runs only after a failed run, so its cost never lands on a passing one. */
export const REAP_SCRIPT = [
  `tg_needle="${OWNER_VAR}=$TG_REAP_TOKEN"`,
  'tg_leaders=',
  'tg_ps() { case $OSTYPE in msys* | cygwin*) ps -e ;; *) ps -A -o pid=,ppid=,pgid=,stat= ;; esac; }',
  'tg_owned() {',
  '  echo scan',
  '  tg_found=',
  '  if [ -r /proc/self/environ ]; then',
  '    if [ "$tg_light" != 1 ]; then',
  '      tg_try=0; tg_rc=128',
  '      while [ "$tg_rc" -ge 128 ] && [ "$tg_try" -lt 10 ]; do tg_out=$(grep -lzxF -e "$tg_needle" /proc/[0-9]*/environ 2>/dev/null); tg_rc=$?; tg_try=$((tg_try + 1)); done',
  '      [ "$tg_rc" -lt 128 ] || { echo "the owned-process scan was killed ten times in a row" >&2; exit 1; }',
  '      for tg_f in $tg_out; do tg_f=${tg_f#/proc/}; tg_found="$tg_found ${tg_f%/environ}"; done',
  '    fi',
  '  else',
  '    while read -r tg_p tg_rest; do case " $tg_rest " in *" $tg_needle "*) tg_found="$tg_found $tg_p" ;; esac; done < <(ps -wwAE -o pid= -o command= 2>/dev/null)',
  '  fi',
  `  tg_kin=$(tg_ps 2>/dev/null | awk -v seeds=" $tg_found $tg_all " -v leaders=" $tg_leaders " '${KIN_AWK}')`,
  '  while read -r tg_k tg_p; do',
  '    case $tg_k in',
  '      L) tg_leaders="$tg_leaders $tg_p" ;;',
  '      K) case " $tg_found " in *" $tg_p "*) ;; *) tg_found="$tg_found $tg_p" ;; esac ;;',
  '    esac',
  '  done <<< "$tg_kin"',
  '}',
  'tg_all=',
  'for tg_round in 1 2 3 4 5; do',
  '  tg_light=; [ "$tg_round" -gt 1 ] && tg_light=1',
  '  tg_owned',
  // A full scan can list nothing while a live process exists: reading a forking process's environment came back empty with no error in 1 of 32 scans under load, so an empty first scan is repeated up to two more times, and the first scan that lists a process is taken as the answer.
  '  tg_again=0',
  '  while [ -z "$tg_found" ] && [ -z "$tg_all" ] && [ "$tg_again" -lt 2 ]; do tg_again=$((tg_again + 1)); tg_owned; done',
  '  tg_new=',
  '  for tg_p in $tg_found; do case " $tg_all " in *" $tg_p "*) ;; *) tg_new="$tg_new $tg_p" ;; esac; done',
  '  [ -z "$tg_new" ] && break',
  '  kill -STOP $tg_new 2>/dev/null',
  '  tg_all="$tg_all$tg_new"',
  'done',
  '[ -z "$tg_all" ] || { kill -KILL $tg_all; kill -CONT $tg_all; } 2>/dev/null',
  SH_LIVE,
  'tg_start=$SECONDS',
  'tg_begin=$SECONDS',
  'tg_forced=',
  'tg_clean=0',
  'tg_rounds=0',
  'tg_lastkill=$SECONDS',
  'while [ $((SECONDS - tg_begin)) -lt 300 ]; do',
  '  tg_left=',
  '  for tg_p in $tg_all; do tg_live "$tg_p" && tg_left="$tg_left $tg_p"; done',
  '  if [ -z "$tg_left" ]; then',
  '    tg_light=; [ "$tg_clean" -eq 0 ] && tg_light=1',
  '    tg_owned; tg_late=',
  '    for tg_p in $tg_found; do case " $tg_all " in *" $tg_p "*) ;; *) tg_live "$tg_p" && tg_late="$tg_late $tg_p" ;; esac; done',
  '    if [ -z "$tg_late" ]; then tg_clean=$((tg_clean + 1)); [ "$tg_clean" -ge 2 ] && exit 0; continue; fi',
  '    tg_clean=0; tg_rounds=$((tg_rounds + 1)); tg_start=$SECONDS; tg_forced=',
  '    [ "$tg_rounds" -le 20 ] || { echo "owned processes kept appearing after SIGKILL:$tg_late" >&2; exit 1; }',
  '    kill -STOP $tg_late 2>/dev/null; kill -KILL $tg_late 2>/dev/null; kill -CONT $tg_late 2>/dev/null',
  '    tg_all="$tg_all$tg_late"',
  '    continue',
  '  fi',
  '  tg_clean=0',
  '  [ $((SECONDS - tg_start)) -lt 10 ] || break',
  '  if [ -z "$tg_forced" ] && [ $((SECONDS - tg_start)) -ge 2 ]; then',
  '    tg_forced=1',
  '    case $OSTYPE in msys* | cygwin*) tg_fout=$(/usr/bin/kill -f -KILL $tg_left 2>&1) ;; *) kill -KILL $tg_left 2>/dev/null ;; esac',
  '  fi',
  '  if [ $((SECONDS - tg_lastkill)) -ge 1 ]; then tg_lastkill=$SECONDS; { kill -KILL $tg_left; kill -CONT $tg_left; } 2>/dev/null; fi',
  '  sleep 0.1',
  'done',
  'tg_why=',
  'for tg_p in $tg_left; do tg_live "$tg_p" || continue; tg_st=; read -r tg_st 2>/dev/null < "/proc/$tg_p/stat"; tg_st=${tg_st##*) }; tg_w=; read -r tg_w 2>/dev/null < "/proc/$tg_p/winpid"; tg_why="$tg_why $tg_p (state ${tg_st%% *}, winpid ${tg_w:-none})"; done',
  '[ -z "$tg_why" ] && exit 0',
  'echo "still running after SIGKILL:$tg_why${tg_fout:+; kill -f said: $tg_fout}" >&2',
  'exit 1',
].join('\n')

/** A synchronous run that waits on events instead of a clock: the shell runs in a worker that counts every chunk it prints, and this thread wakes each tick to look at that count and at `killWhen`. It gives up only after `quietTicks` ticks in which the count did not move, so a slow machine stretches a run without failing it and a run that stopped advancing still ends; a tick delayed by a stall counts as one. */
const RUN_WORKER = `
const { workerData } = require('node:worker_threads')
const { spawn } = require('node:child_process')
const { sh, args, env, flags, port } = workerData
let stdout = ''
let stderr = ''
const child = spawn(sh, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
const bump = () => { Atomics.add(flags, 1, 1) }
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => { stdout += chunk; bump() })
child.stderr.on('data', (chunk) => { stderr += chunk; bump() })
port.on('message', () => { child.kill() })
let sent = false
const finish = (message) => {
  if (sent) return
  sent = true
  port.postMessage(message)
  Atomics.store(flags, 0, 1)
  Atomics.notify(flags, 0)
}
child.once('error', (err) => finish({ status: null, signal: null, stdout, stderr, error: String(err && err.message) }))
child.once('exit', (status, signal) => finish({ status, signal, stdout, stderr }))
`
const RUN_TICK_MS = 50

interface WorkerRun {
  status: number | null
  signal: string | null
  stdout: string
  stderr: string
  error?: Error | undefined
}

function runInWorker(sh: string, args: string[], env: NodeJS.ProcessEnv, opts: { quietTicks?: number; killWhen?: () => boolean; deadlineMs?: number }): WorkerRun {
  const flags = new Int32Array(new SharedArrayBuffer(8))
  const { port1, port2 } = new MessageChannel()
  const worker = new Worker(RUN_WORKER, { eval: true, workerData: { sh, args, env, flags, port: port2 }, transferList: [port2] })
  let quiet = 0
  let last = 0
  let ended = ''
  let killed = false
  try {
    while (Atomics.wait(flags, 0, 0, RUN_TICK_MS) === 'timed-out') {
      const seen = Atomics.load(flags, 1)
      quiet = seen === last ? quiet + 1 : 0
      last = seen
      if (ended === '' && opts.killWhen?.() === true) ended = 'ended once the event it waited for happened'
      if (ended === '' && opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs) ended = 'ETIMEDOUT: ran past its deadline and was ended'
      if (ended === '' && opts.quietTicks !== undefined && quiet >= opts.quietTicks) ended = `printed nothing for ${String(Math.round((opts.quietTicks * RUN_TICK_MS) / 1000))} s and was ended`
      if (ended !== '' && !killed) {
        killed = true
        port1.postMessage('kill')
      }
    }
    const got = receiveMessageOnPort(port1)?.message as (Omit<WorkerRun, 'error'> & { error?: string }) | undefined
    if (got === undefined) return { status: null, signal: null, stdout: '', stderr: 'the worker ended without a result', error: new Error('no result') }
    return { ...got, error: got.error === undefined ? undefined : new Error(got.error), stderr: ended === '' ? got.stderr : `${got.stderr}\n${ended}`.trim() }
  } finally {
    port1.close()
    void worker.terminate()
  }
}

/** Runs a liveness probe script in a POSIX shell: true for status 0 (alive), false for status 1 (gone). Any other answer, such as a null status from a probe that hit its timeout, throws, so an unanswered probe never reads as a process that exited. */
export function probeAlive(sh: string, script: string): boolean {
  const res = spawnSync(sh, ['-c', script], { windowsHide: true, timeout: 30_000 })
  if (res.status === 0) return true
  if (res.status === 1) return false
  throw new Error(`liveness probe gave no answer: status ${String(res.status)}, signal ${String(res.signal)}${res.error ? `, ${res.error.message}` : ''}`)
}

/** Kill whatever a failed run left behind, returning why that failed or null when nothing of the run survives. A reap that prints nothing for sixty seconds has stopped advancing and is ended. */
export function reapOwned(sh: string, token: string, script: string = REAP_SCRIPT): string | null {
  const res = runInWorker(sh, ['-c', script], { ...process.env, TG_REAP_TOKEN: token }, { quietTicks: 60_000 / RUN_TICK_MS })
  return res.error || res.signal || res.status !== 0 ? spawnFailure(res) : null
}


/** Each command run by a POSIX shell, its `token-goat` calls decoded. A command that ends its chunk's subshell keeps what it printed as its run, and the chunk mates after it run again in a later pass. Git Bash drops a carriage return from the text it evaluates, quoted or not, so on Windows no quoting carries one: callers compare without it there. */
export function shRunAll(sh: string, commands: readonly string[], opts: { timeoutMs?: number; killWhen?: () => boolean } = {}): ShellRun[] {
  const runs: (ShellRun | undefined)[] = new Array<ShellRun | undefined>(commands.length)
  let pending = commands.map((_, i) => i)
  while (pending.length > 0) {
    const token = `${process.pid}-${randomBytes(8).toString('hex')}`
    const env: NodeJS.ProcessEnv = { ...process.env, TG_N: String(pending.length), TG_CHUNK: String(SH_CHUNK), TG_BUDGET_S: String(Math.ceil((opts.timeoutMs ?? 120_000) / 1000) + SH_BUDGET_SLACK_S), [OWNER_VAR]: token }
    pending.forEach((ci, j) => {
      env[`TG_CMD_${j}`] = commands[ci]
    })
    const res = opts.killWhen === undefined ? spawnSync(sh, ['-c', SH_SCRIPT], { encoding: 'utf8', env, windowsHide: true, timeout: opts.timeoutMs ?? 120_000 }) : runInWorker(sh, ['-c', SH_SCRIPT], env, { killWhen: opts.killWhen, quietTicks: 60_000 / RUN_TICK_MS, deadlineMs: Date.now() + (opts.timeoutMs ?? 120_000) })
    // A timeout kills the outer shell only, orphaning the chunk subshell and anything a command started under it.
    const reapedAfterRun = Boolean(res.error || res.signal || (res.status !== null && res.status !== 0))
    let reapFailure = reapedAfterRun ? reapOwned(sh, token) : null
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
    // A run already reaped above is not scanned a second time: under load each scan of the process table took tens of seconds, and the repeat doubled a killed run's time.
    if (next < pending.length && !reapedAfterRun) reapFailure = reapOwned(sh, token)
    const cleanup = reapFailure === null ? '' : `; cleanup after the kill failed: ${reapFailure}`
    if (next < pending.length) {
      const ran = runs.filter((r) => r !== undefined).length
      throw new Error(`shell ran ${ran} of ${commands.length} commands: ${spawnFailure(res)}${cleanup}`)
    }
    if (cleanup !== '') throw new Error(`shell ran every command but was killed: ${spawnFailure(res)}${cleanup}`)
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
