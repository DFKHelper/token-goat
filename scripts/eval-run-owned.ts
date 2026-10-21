/** Runs one command for the retrieval eval and ends its whole process tree when the run must stop. spawnSync cannot do that: its timeout signals only the top process, so a grandchild outlives it, and on POSIX a child that ignores SIGTERM keeps the call blocked for ever. The child is started through `spawnOwned`, whose `kill` freezes and then kills every descendant (`taskkill /T` on Windows), and the deadline, an abort and an output overflow all end the tree through it. */
import { spawnSync } from 'node:child_process'

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

/** The bound on the one PowerShell query that lists and ends the survivors of an exited root; it answers in milliseconds, the bound only keeps a wedged one from holding the run. */
const SURVIVOR_QUERY_TIMEOUT_MS = 30_000

/** The Windows query that ends what an exited root left behind. Windows keeps a child's parent pid after the parent exits, so the survivors are the processes whose parent pid is the root's and whose creation time lies between the spawn and the root's exit (a later child of a reused pid is outside that window), and their descendants. */
function survivorScript(rootPid: number, fromMs: number, toMs: number): string {
  return [
    '$t = @{}; Get-CimInstance Win32_Process | ForEach-Object { $t[[int]$_.ProcessId] = $_ }',
    '$set = New-Object System.Collections.Generic.HashSet[int]',
    `foreach ($p in $t.Values) { if ([int]$p.ParentProcessId -eq ${rootPid}) { $c = ([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds(); if ($c -ge ${fromMs} -and $c -le ${toMs}) { [void]$set.Add([int]$p.ProcessId) } } }`,
    '$grew = $true; while ($grew) { $grew = $false; foreach ($p in $t.Values) { if ($set.Contains([int]$p.ParentProcessId) -and -not $set.Contains([int]$p.ProcessId)) { [void]$set.Add([int]$p.ProcessId); $grew = $true } } }',
    'foreach ($id in $set) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }',
  ].join('; ')
}

/** Ends the processes an exited root left behind, which spawnOwned's kill cannot reach once the root is gone (it never signals a pid that has exited). POSIX: the root led its own process group, which outlives it while any member runs, so one SIGKILL to the group ends them. Windows: the survivors are found by their recorded parent pid inside the root's lifetime window. A survivor that left the group (setsid) on POSIX is not reached. */
function endSurvivors(rootPid: number | undefined, spawnedAt: number, exitedAt: number): void {
  if (rootPid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-rootPid, 'SIGKILL')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') process.stderr.write(`[eval: could not end the process group of pid ${rootPid}: ${(e as Error).message}]
`)
    }
    return
  }
  const r = spawnSync(windowsPowerShellPath(), powerShellTextQueryArgs(survivorScript(rootPid, spawnedAt, exitedAt)), { stdio: 'ignore', windowsHide: true, timeout: SURVIVOR_QUERY_TIMEOUT_MS })
  if (r.status !== 0) process.stderr.write(`[eval: could not end the survivors of pid ${rootPid}: ${r.status === null ? (r.error?.message ?? 'no status') : `status ${r.status}`}]
`)
}

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** Resolves, never rejects: the caller reads `error` and decides. It resolves once the root has exited after an ended tree, without waiting for pipes a survivor might still hold. A root that exits on its own while a survivor holds a pipe leaves the run waiting for the pipe; a stop after that ends the survivors too and resolves. */
export function runOwned(command: string, args: string[], options: OwnedOptions): Promise<OwnedRun> {
  return new Promise((resolve) => {
    const spawnedAt = Date.now()
    // owner: runOwned, which ends the group through owned.kill or endSurvivors and dies when the run resolves; detached only gives the root its own process group so survivors of an exited root can still be signalled.
    const owned = spawnOwned(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    const { child } = owned
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let cause: NodeJS.ErrnoException | undefined
    let settled = false
    let exitedAt: number | undefined
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
    child.once('exit', (code, signal) => {
      exitedAt = Date.now()
      if (cause !== undefined) finish(code, signal)
    })
    child.once('close', (code, signal) => finish(code, signal))
  })
}
