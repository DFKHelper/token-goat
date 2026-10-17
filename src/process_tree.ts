// Ending a spawned command means ending everything it started. A child's own kill reaches only the shell it signals, so a command like `find / ...` or a test runner started through that shell kept running after the timeout fired, reparented to init, for as long as it liked. The child stays in this process's own process group (so a group-wide kill by whatever launched token-goat still reaches it) and its tree is ended by freezing and then killing the process table's descendants of it (POSIX, `ps`) or with `taskkill /T` (Windows) while the child is still alive. Not covered: a SIGKILL or TerminateProcess of token-goat itself runs no handler here, so a child started before that is left running (the fix for that is native, PR_SET_PDEATHSIG on Linux and a kill-on-close Job Object on Windows, and is not part of this module), and when that SIGKILL lands during the freeze walk the tree is left stopped instead of running; on Windows `taskkill /T` snapshots the tree with no freeze, so a command that is forking while it is ended can still slip a child out ahead of the kill there; a descendant that already left the tree by being reparented before the kill (its shell exited first); and, on POSIX, a descendant that changed its parent pid by other means.
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'

// taskkill and ps are local utilities that answer in milliseconds; the bound only keeps a wedged one from holding the caller.
const HELPER_TIMEOUT_MS = 10_000

// The most "list the descendants, stop the new ones" passes a tree gets before it is killed as found. Every stopped process is frozen (it cannot fork), so the set only grows through a process not yet stopped, and a pass that finds nothing new ends the loop: the cap is a count, not a clock, and a pass costs one `ps`.
const MAX_FREEZE_PASSES = 64

// The signals that end a CLI run from outside. SIGHUP is the terminal closing; on Windows Node emulates it for a console close, and SIGTERM is never delivered there.
const OWNER_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** The outcome of ending a tree: `ok` is false only when a live tree could not be ended with certainty, with the reason in `note`; `gone` marks the one failure where the root no longer exists (taskkill status 128, "process not found"), so no tree was left to end. */
export interface KillResult {
  ok: boolean
  note?: string
  gone?: boolean
}

function taskkillPath(): string {
  const root = process.env['SystemRoot'] ?? process.env['windir'] ?? 'C:\\Windows'
  return path.join(root, 'System32', 'taskkill.exe')
}

/** The process table as parent pid to child pids, or null when `ps` cannot list it. `-A -o pid=,ppid=` is accepted by procps (Linux) and by the BSD `ps` on macOS. */
function childrenByParent(): Map<number, number[]> | null {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: HELPER_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  if (listed.status !== 0 || typeof listed.stdout !== 'string') return null
  const table = new Map<number, number[]>()
  for (const line of listed.stdout.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const siblings = table.get(ppid as number)
    if (siblings === undefined) table.set(ppid as number, [pid as number])
    else siblings.push(pid as number)
  }
  return table
}

function descendantsOf(root: number, table: Map<number, number[]>): number[] {
  const found: number[] = []
  const queue = [root]
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const child of table.get(next) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // already gone: what the walk was for
  }
}

/** End *pid* and everything it started. The caller must know *pid* is a live child of its own: a pid that has already exited may belong to an unrelated process by now, and this never falls back to signalling a bare pid after the walk failed. POSIX: the root is stopped first, then every descendant the process table shows is stopped, pass after pass until a pass finds none new, and only then is the whole set killed. A stopped process cannot fork and its children are not reparented, so a tree that is forking while it is ended (make -j, a shell loop) cannot grow or lose members behind the walk; killing in the same pass instead would let the children of an already-killed process escape to init. When `ps` is unavailable only the root is killed and the result says the descendants were not reached. Windows: `taskkill /T /F`, which also ends the root; a non-zero status is reported, never retried with a bare pid kill. */
export function killProcessTree(pid: number | undefined): KillResult {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return { ok: true }
  if (process.platform === 'win32') {
    const result = spawnSync(taskkillPath(), ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: HELPER_TIMEOUT_MS })
    if (result.status === 0) return { ok: true }
    return { ok: false, note: `taskkill ended with ${result.status === null ? (result.error?.message ?? 'no status') : `status ${result.status}`}`, gone: result.status === 128 }
  }
  signalPid(pid, 'SIGSTOP')
  const frozen = [pid]
  const known = new Set(frozen)
  let note: string | undefined
  let settled = false
  for (let pass = 0; pass < MAX_FREEZE_PASSES && !settled; pass++) {
    const table = childrenByParent()
    if (table === null) {
      note = 'the process table could not be listed, so only the shell was killed'
      settled = true
      break
    }
    settled = true
    for (const d of descendantsOf(pid, table)) {
      if (known.has(d)) continue
      known.add(d)
      frozen.push(d)
      signalPid(d, 'SIGSTOP')
      settled = false
    }
  }
  if (!settled) note = `the tree was still growing after ${MAX_FREEZE_PASSES} passes, so it was killed as found`
  // Deepest first, root last; every member is stopped, so the order only matters for tidiness.
  for (const p of frozen.reverse()) signalPid(p, 'SIGKILL')
  return note === undefined ? { ok: true } : { ok: false, note }
}

/** A child started by {@link spawnOwned}: `kill` ends its whole tree now (at most once, and never after the child has exited), `release` drops the parent-side hooks once the child has finished. */
export interface OwnedChild {
  child: ChildProcess
  kill: () => void
  release: () => void
}

// One set of process hooks serves every live owned child, so any number of children at once adds four listeners, not four each (Node warns past ten).
const live = new Set<{ kill: () => void }>()
let hooked = false

function onProcessExit(): void {
  for (const owned of [...live]) owned.kill()
}

function onProcessSignal(signal: NodeJS.Signals): void {
  unhook()
  for (const owned of [...live]) owned.kill()
  if (process.platform === 'win32') process.exit(128 + ((os.constants.signals as Record<string, number>)[signal] ?? 0))
  // The hooks are off, so this second delivery takes the default action and the process dies of the signal.
  process.kill(process.pid, signal)
}

function hook(): void {
  if (hooked) return
  hooked = true
  process.on('exit', onProcessExit)
  for (const s of OWNER_SIGNALS) process.on(s, onProcessSignal)
}

function unhook(): void {
  if (!hooked) return
  hooked = false
  process.removeListener('exit', onProcessExit)
  for (const s of OWNER_SIGNALS) process.removeListener(s, onProcessSignal)
}

/** Spawn *file* as a child this process answers for. The tree is ended when the caller asks (`kill`, for a timeout or an overflow), when this process exits normally, and when it receives INT, TERM or HUP, in each case only while the child is still running. After a signal the process dies of that signal as it would have without the hook (POSIX), or exits 128 plus the signal number (Windows, where a signal cannot be re-raised). The hooks come off when the last live child closes or fails to start. Not covered: this process being killed outright (SIGKILL, TerminateProcess, a harness killing only its pid) runs nothing here. A tree kill that fails (the helper could not run, or a growing tree) is reported on stderr and the root is then ended through its handle, so a caller waiting on its exit is not left waiting. */
export function spawnOwned(file: string, args: string[], options: SpawnOptions): OwnedChild {
  const child = spawn(file, args, options)
  let killed = false
  let ended = false
  const onChildEnd = (): void => {
    ended = true
  }
  child.once('exit', onChildEnd)
  child.once('close', onChildEnd)
  child.once('error', () => {
    if (child.pid === undefined) ended = true
  })
  const kill = (): void => {
    if (killed || ended || child.pid === undefined) return
    killed = true
    const result = killProcessTree(child.pid)
    // A root that was already gone by the time taskkill ran is not a failure worth a line.
    if (result.ok || result.gone || ended) return
    process.stderr.write(`[token-goat: could not end the process tree of pid ${child.pid}: ${result.note ?? 'unknown reason'}]\n`)
    // A tree kill that failed reached nothing (taskkill unreachable or wedged), so a caller waiting on the child's exit would wait for ever; the handle Node owns ends the root itself and cannot hit a reused pid, which a signal to the bare pid could.
    child.kill('SIGKILL')
  }
  const handle = { kill }
  const release = (): void => {
    live.delete(handle)
    if (live.size === 0) unhook()
  }
  live.add(handle)
  hook()
  child.once('close', release)
  child.once('error', release)
  return { child, kill, release }
}
