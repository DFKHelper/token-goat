import type { ChildProcess } from 'node:child_process'

import { onTestFinished } from 'vitest'

import { killProcessTree } from '../../src/process_tree.js'

export interface StopOptions {
  /** True when the test body finished without throwing: the child is asked to exit and the wait is for its exit event. False when the body threw: the child and what it started are killed outright, so a child that ignores SIGTERM cannot hold the test until its timeout and hide the body's own error. */
  readonly graceful: boolean
}

/** Stop a child this test spawned and holds the ChildProcess of: the handle signals the process it holds and nothing once that has exited, so no recorded number is signalled. A child with no pid (its spawn failed) is left alone and returns at once; an 'error' event also ends the wait, after which the child is killed through its handle and, on a graceful stop (the body finished, so nothing is masked), the error is rethrown; a stop after a failed body drops the error so the body's own is the one reported. A graceful stop sends SIGTERM and waits for the child's own exit event, which cannot be missed because an exit that already happened is read from exitCode/signalCode first and the listener is attached before the signal is sent; that wait has no deadline of its own, so nothing here measures how long an exit took. A stop that is not graceful ends the child's whole tree through its handle (SIGKILL cannot be ignored), then waits for the exit event, which that signal guarantees. The helper registers onTestFinished before it signals, which ends a child that is still alive through its handle with SIGKILL when the test finishes by any path. That makes an orphan impossible, and it must be called while a test is running (vitest refuses the registration anywhere else). */
export async function stopOwnedChild(child: ChildProcess, options: StopOptions): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  // A spawn that failed has no pid and will never emit 'exit': there is nothing to signal, and a kill of its half-made handle throws EINVAL.
  if (child.pid === undefined) return
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  // 'error' also settles the wait: a kill that failed emits 'error' with the child still running and no 'exit' to follow.
  const exited = new Promise<Error | undefined>((resolve) => {
    child.once('exit', () => resolve(undefined))
    child.once('error', (error: Error) => resolve(error))
  })
  if (options.graceful) child.kill('SIGTERM')
  else if (!killProcessTree(child.pid).ok) child.kill('SIGKILL')
  const failure = await exited
  if (failure === undefined) return
  // The child may still be running, so end it through its handle before the error is shown; a body that already threw keeps its own error, which is the one the run reports.
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  if (options.graceful) throw failure
}
