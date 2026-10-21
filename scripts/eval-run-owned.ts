/** Runs one command for the retrieval eval and ends its whole process tree when the run must stop. spawnSync cannot do that: its timeout signals only the top process, so a grandchild outlives it, and on POSIX a child that ignores SIGTERM keeps the call blocked for ever. The child is started through `spawnOwned`, whose `kill` freezes and then kills every descendant (`taskkill /T` on Windows), and the deadline, an abort and an output overflow all end the tree through it. A root that exited on its own while a survivor still holds a pipe is ended by `endSurvivors` on a later stop. Residuals: a survivor that left the root's process group (setsid) on POSIX, and on Windows a survivor whose intermediate parent had already died (its parent pid then names a process that is not the root), are not reached; a survivor holding no pipe is not tracked at all; and INT, TERM or HUP after the root exited is not covered, because the signal hook belongs to spawnOwned, which only kills a root that is still running. */
import { spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from 'node:child_process'

import { spawnOwned } from '../src/process_tree.js'
import { powerShellTextQueryArgs, windowsPowerShellPath } from '../src/windows_powershell.js'

export interface OwnedRun {
  readonly stdout: string
  readonly stderr: string
  readonly status: number | null
  readonly signal: NodeJS.Signals | null
  /** Set when the run did not end by itself: `code` ETIMEDOUT for the deadline, ABORT_ERR for an abort, ENOBUFS for an output overflow, or a spawn failure. */
  readonly error?: NodeJS.ErrnoException
}

export interface OwnedOptions {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /** Absent means no deadline: only an abort, an overflow or the process exiting ends the run. */
  readonly timeoutMs?: number
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

/** The bound on the one PowerShell query that lists the process table for the survivors of an exited root; it answers in milliseconds, the bound only keeps a wedged one from holding the run. */
export const SURVIVOR_QUERY_TIMEOUT_MS = 30_000

/** One row of the Windows process table: pid, parent pid and creation time in epoch milliseconds. */
export interface ProcRow {
  readonly pid: number
  readonly ppid: number
  readonly createdMs: number
}

/** The pids an exited root left behind, from a process table. Windows keeps a child's parent pid after the parent exits, so the first generation is every process whose parent pid is the root's and whose creation lies between the spawn and the root's exit (a child of a recycled root pid is created after that window); every deeper member must be created at or after its parent, so a recycled pid, whose creation is newer than the child that names it, is never taken. */
export function selectSurvivors(rows: readonly ProcRow[], rootPid: number, fromMs: number, toMs: number): number[] {
  const created = new Map<number, number>()
  for (const r of rows) if (r.ppid === rootPid && r.createdMs >= fromMs && r.createdMs <= toMs) created.set(r.pid, r.createdMs)
  for (let grew = true; grew; ) {
    grew = false
    for (const r of rows) {
      const parent = created.get(r.ppid)
      if (parent === undefined || created.has(r.pid) || r.createdMs < parent) continue
      created.set(r.pid, r.createdMs)
      grew = true
    }
  }
  return [...created.keys()]
}

const LIST_SCRIPT = 'Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; c = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } } | ConvertTo-Json -Compress'

/** Reads the output of LIST_SCRIPT; null when it is not that shape. PowerShell prints a single row as an object, not a one-element array. */
function parseRows(text: string): ProcRow[] | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  const out: ProcRow[] = []
  for (const row of Array.isArray(data) ? (data as unknown[]) : [data]) {
    const r = row as { p?: unknown; pp?: unknown; c?: unknown } | null
    if (typeof r?.p !== 'number' || typeof r.pp !== 'number' || typeof r.c !== 'number') return null
    out.push({ pid: r.p, ppid: r.pp, createdMs: r.c })
  }
  return out
}

/** The system calls `endSurvivors` makes, so a test can stand in for them: the platform, the one process-table query and the signal send. */
export interface SurvivorIo {
  readonly platform: NodeJS.Platform
  readonly query: (file: string, args: string[], options: SpawnSyncOptionsWithStringEncoding) => Pick<SpawnSyncReturns<string>, 'status' | 'stdout' | 'error'>
  readonly kill: (pid: number, signal: NodeJS.Signals | 0) => void
}

const realIo: SurvivorIo = { platform: process.platform, query: (file, args, options) => spawnSync(file, args, options), kill: (pid, signal) => process.kill(pid, signal) }

/** Ends the processes an exited root left behind, which spawnOwned's kill cannot reach once the root is gone (it never signals a pid that has exited). POSIX: the root led its own process group, which outlives it while any member runs, so one SIGKILL to the group ends them; a probe first skips a group that no longer exists, and a group recycled between the probe and the kill is the residual. Windows: the process table is listed once and `selectSurvivors` picks the survivors by recorded parent pid inside the root's lifetime window. */
export function endSurvivors(rootPid: number | undefined, spawnedAt: number, exitedAt: number, io: SurvivorIo = realIo): void {
  if (rootPid === undefined) return
  if (io.platform !== 'win32') {
    try {
      io.kill(-rootPid, 0)
      io.kill(-rootPid, 'SIGKILL')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') process.stderr.write(`[eval: could not end the process group of pid ${rootPid}: ${(e as Error).message}]\n`)
    }
    return
  }
  const r = io.query(windowsPowerShellPath(), powerShellTextQueryArgs(LIST_SCRIPT), { encoding: 'utf8', windowsHide: true, timeout: SURVIVOR_QUERY_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })
  const rows = r.status === 0 ? parseRows(r.stdout) : null
  if (rows === null) {
    process.stderr.write(`[eval: could not list the survivors of pid ${rootPid}: ${r.status === null ? (r.error?.message ?? 'no status') : `status ${r.status}`}]\n`)
    return
  }
  for (const pid of selectSurvivors(rows, rootPid, spawnedAt, exitedAt)) {
    try {
      io.kill(pid, 'SIGKILL')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') process.stderr.write(`[eval: could not end survivor pid ${pid}: ${(e as Error).message}]\n`)
    }
  }
}

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** Resolves, never rejects: the caller reads `error` and decides. It resolves once the root has exited after an ended tree, without waiting for pipes a survivor might still hold. A root that exits on its own while a survivor holds a pipe leaves the run waiting for the pipe; a stop after that ends the survivors too and resolves. */
export function runOwned(command: string, args: string[], options: OwnedOptions): Promise<OwnedRun> {
  return new Promise((resolve) => {
    const spawnedAt = Date.now()
    // owner: runOwned; the root and its tree end through owned.kill on a stop and a survivor of an exited root through endSurvivors on a later stop, and a survivor on the normal-exit path ends only when it closes its pipe or a stop reaches it; detached only gives the root its own process group on POSIX.
    const owned = spawnOwned(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const { child } = owned
    let exitedAt: number | undefined
    child.once('exit', (code, signal) => {
      exitedAt = Date.now()
      if (cause !== undefined) finish(code, signal)
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let cause: NodeJS.ErrnoException | undefined
    let settled = false
    const stop = (e: NodeJS.ErrnoException): void => {
      if (cause !== undefined) return
      cause = e
      if (exitedAt === undefined) {
        owned.kill()
        return
      }
      endSurvivors(child.pid, spawnedAt, exitedAt)
      finish(child.exitCode, child.signalCode)
    }
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({ stdout, stderr, status, signal, ...(cause === undefined ? {} : { error: cause }) })
    }
    const take = (into: 'stdout' | 'stderr') => (chunk: string): void => {
      bytes += Buffer.byteLength(chunk)
      if (bytes > options.maxBytes) return stop(failure('ENOBUFS', `output passed ${options.maxBytes} bytes`))
      if (into === 'stdout') stdout += chunk
      else stderr += chunk
    }
    const onAbort = (): void => stop(failure('ABORT_ERR', 'aborted'))
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => stop(failure('ETIMEDOUT', `no exit within ${options.timeoutMs} ms`)), options.timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', take('stdout'))
    child.stderr?.setEncoding('utf8').on('data', take('stderr'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    child.on('error', (e: NodeJS.ErrnoException) => {
      cause ??= e
      if (child.pid === undefined) finish(null, null)
    })
    child.once('close', (code, signal) => finish(code, signal))
  })
}
