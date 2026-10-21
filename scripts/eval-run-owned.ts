/** Runs one command for the retrieval eval and ends its whole process tree when the run must stop. spawnSync cannot do that: its timeout signals only the top process, so a grandchild outlives it, and on POSIX a child that ignores SIGTERM keeps the call blocked for ever. The child is started through `spawnOwned`, whose `kill` freezes and then kills every descendant (`taskkill /T` on Windows), and the deadline, an abort and an output overflow all end the tree through it. */
import { spawnOwned } from '../src/process_tree.js'

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
  readonly timeoutMs: number
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

function failure(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code })
}

/** Resolves, never rejects: the caller reads `error` and decides. It resolves once the root has exited after an ended tree, without waiting for pipes a survivor might still hold. */
export function runOwned(command: string, args: string[], options: OwnedOptions): Promise<OwnedRun> {
  return new Promise((resolve) => {
    const owned = spawnOwned(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const { child } = owned
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let cause: NodeJS.ErrnoException | undefined
    let settled = false
    const stop = (e: NodeJS.ErrnoException): void => {
      if (cause !== undefined) return
      cause = e
      owned.kill()
    }
    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
    const timer = setTimeout(() => stop(failure('ETIMEDOUT', `no exit within ${options.timeoutMs} ms`)), options.timeoutMs)
    child.stdout?.setEncoding('utf8').on('data', take('stdout'))
    child.stderr?.setEncoding('utf8').on('data', take('stderr'))
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    child.on('error', (e: NodeJS.ErrnoException) => {
      cause ??= e
      if (child.pid === undefined) finish(null, null)
    })
    child.once('exit', (code, signal) => {
      if (cause !== undefined) finish(code, signal)
    })
    child.once('close', (code, signal) => finish(code, signal))
  })
}
