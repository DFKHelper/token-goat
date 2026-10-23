/** The non-blocking git runner. Kept apart from util.ts so the hook entry's static import graph does not carry it (and process_tree.ts with it): a hook loads this module with `await import('./git_async.js')` only once it has decided to run git. The argument list, executable and time limit come from util.ts, shared with runGit so the two cannot drift. Like `runGit`, a git spawn site named by tests/guards/git_is_spawned_only_by_runGit.test.ts. */

import { spawnOwned, type OwnedChild } from './process_tree.js'
import type { GitResult, RunGitAsyncOptions } from './types.js'
import { forgetGitExecutable, gitExecutable, gitInvocation, gitTimeoutMs } from './util.js'

const GIT_MAX_OUTPUT_BYTES = 200 * 1024 * 1024

/** Run git without blocking the event loop, and end its whole process tree (a launcher, a `!` alias shell, a filter or credential helper) when the call times out, overflows or is aborted. The same invocation, limit and result as {@link runGit}, plus `signal`; it never rejects. A call that times out or overflows ends with exit -1 (`timedOut` for the first; the second carries ENOBUFS in `stderr`, which callers of runGit already read), and an aborted one with exit -1 and neither. After a kill the call settles on git's own exit and destroys the pipes, so a survivor holding one cannot keep it pending. Output beyond 200 MiB in total is an overflow. {@link GIT_UNBOUNDED} with a survivor holding the pipe of a git that exited normally has no bound to end the wait. */
export function runGitAsync(args: string[], opts: RunGitAsyncOptions = {}): Promise<GitResult> {
  const failed = (stderr: string, timedOut?: true): GitResult => ({ stdout: '', stderr, exitCode: -1, ...(timedOut ? { timedOut } : {}) })
  if (opts.signal?.aborted) return Promise.resolve(failed('git was aborted before it started'))
  const timeout = gitTimeoutMs(opts.timeoutMs)
  return new Promise<GitResult>((resolve) => {
    let owned: OwnedChild
    try {
      owned = spawnOwned(gitExecutable(), gitInvocation(args), { ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve(failed(String((err as Error).message ?? err)))
      return
    }
    const { child } = owned
    const out: Buffer[] = []
    const err: Buffer[] = []
    let bytes = 0
    let cause: 'timeout' | 'overflow' | 'abort' | undefined
    let exited = false
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const onAbort = (): void => stop('abort')
    const settle = (result: GitResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      child.stdin?.destroy()
      child.stdout?.destroy()
      child.stderr?.destroy()
      owned.release()
      resolve(result)
    }
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (cause === 'timeout') settle(failed(`spawn git ETIMEDOUT after ${timeout} ms`, true))
      else if (cause === 'overflow') settle(failed('spawn git ENOBUFS: output exceeded the 200 MiB buffer'))
      else if (cause === 'abort') settle(failed('git was aborted'))
      else if (exitCode === null) settle({ stdout: '', stderr: `git was killed by ${signal ?? 'a signal'}`, exitCode: -1, ...(signal === null ? {} : { signal }) })
      else settle({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode })
    }
    // The first cause wins. A git that already exited has no exit event to wait for, so its call settles here.
    const stop = (why: 'timeout' | 'overflow' | 'abort'): void => {
      if (cause !== undefined || settled) return
      cause = why
      // Synchronous on purpose: OwnedChild.kill is shared with the exit hooks, which cannot wait, and this runs only on a timeout, overflow or abort; a wedged helper costs one HELPER_TIMEOUT_MS (10 s): taskkill is one call on win32, and on POSIX a timed-out ps ends the walk, so only MAX_FREEZE_PASSES (64) ps calls that each answer, in milliseconds in practice, can add to it.
      owned.kill()
      if (exited) finish(null, null)
    }
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      if (cause === 'overflow') return
      bytes += chunk.length
      if (bytes > GIT_MAX_OUTPUT_BYTES) stop('overflow')
      else into.push(chunk)
    }
    child.stdout?.on('data', collect(out))
    child.stderr?.on('data', collect(err))
    child.stdin?.on('error', () => undefined)
    child.once('error', (e: NodeJS.ErrnoException) => {
      if (child.pid !== undefined) return
      if (e.code === 'ENOENT') forgetGitExecutable()
      settle(failed(e.message))
    })
    child.once('exit', (code, signal) => {
      exited = true
      if (cause !== undefined) finish(code, signal)
    })
    // Without a cause, close follows the exit once every pipe has ended, so all of git's output is in.
    child.once('close', (code, signal) => finish(code, signal))
    if (timeout !== undefined) timer = setTimeout(() => stop('timeout'), timeout)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdin?.end(opts.input)
  })
}
