import type { ChildProcess } from 'node:child_process'

import { onTestFinished } from 'vitest'

import { killProcessTree } from '../../src/process_tree.js'

export interface StopOptions {
  /** True when the test body finished without throwing: the child is asked to exit and the wait is for its exit event. False when the body threw: the child and what it started are killed outright, so a child that ignores SIGTERM cannot hold the test until its timeout and hide the body's own error. */
  readonly graceful: boolean
}

/** Kill through the handle and return the failure instead of throwing it: Node's ChildProcess.kill emits 'error' when the handle's kill fails with an errno other than ESRCH, and an 'error' nobody listens for is thrown by emit; EINVAL and ENOSYS are thrown by kill itself. A listener is attached for exactly this call. */
function killThroughHandle(child: ChildProcess, signal: NodeJS.Signals): Error | undefined {
  let failure: Error | undefined
  const onError = (error: Error): void => {
    failure = error
  }
  child.on('error', onError)
  try {
    child.kill(signal)
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  } finally {
    child.off('error', onError)
  }
  return failure
}

const tracked = new WeakSet<ChildProcess>()

/** Make it impossible for a child this test spawned to outlive the test: call it right after spawn, before any wait, so a test that vitest's timeout rejects while its body is still waiting (its finally never runs) still ends the child through its handle with SIGKILL, which also ends a wait loop that watches the child's exitCode. A listener for 'error' is attached so a spawn failure is not thrown as an uncaught error; the test's own pid assertion reports it. A second call for the same child registers nothing, and stopOwnedChild calls it too. It must be called while a test is running (vitest refuses the registration anywhere else). */
export function trackOwnedChild(child: ChildProcess): void {
  if (tracked.has(child)) return
  tracked.add(child)
  child.on('error', () => undefined)
  onTestFinished(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    // A spawn that failed has no pid and nothing to end.
    if (child.pid === undefined) return
    // A backstop that cannot end the child fails the test, beside whatever the body threw, rather than leaving it running unreported.
    const failure = killThroughHandle(child, 'SIGKILL')
    if (failure !== undefined) throw failure
  })
}

/** Stop a child this test spawned and holds the ChildProcess of: the handle signals the process it holds and nothing once that has exited, so no recorded number is signalled. A child with no pid (its spawn failed) is left alone and returns at once; an 'error' event also ends the wait, after which the child is killed through its handle and, on a graceful stop (the body finished, so nothing is masked), the error is rethrown; a stop after a failed body drops the error so the body's own is the one reported. A graceful stop sends SIGTERM and waits for the child's own exit event, which cannot be missed because an exit that already happened is read from exitCode/signalCode first and the listener is attached before the signal is sent; that wait has no deadline of its own, so nothing here measures how long an exit took. A stop that is not graceful ends the child's whole tree through its handle (SIGKILL cannot be ignored), then waits for the exit event, which that signal guarantees. The helper calls trackOwnedChild before it signals (a no-op when the test already tracked the child at spawn), which registers onTestFinished and so ends a child that is still alive through its handle with SIGKILL when the test finishes by any path. That makes an orphan impossible, and it must be called while a test is running (vitest refuses the registration anywhere else). Every kill goes through killThroughHandle, so a kill that fails (Node emits 'error' for an errno other than ESRCH and throws for EINVAL/ENOSYS) is returned and never thrown out of the stop in place of the body's own error; the final kill's failure is left to the onTestFinished backstop, which retries and reports it beside the body's error. */
export async function stopOwnedChild(child: ChildProcess, options: StopOptions): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  // A spawn that failed has no pid and will never emit 'exit': there is nothing to signal, and a kill of its half-made handle throws EINVAL.
  if (child.pid === undefined) return
  trackOwnedChild(child)
  // 'error' also settles the wait: a kill that failed emits 'error' with the child still running and no 'exit' to follow.
  const exited = new Promise<Error | undefined>((resolve) => {
    child.once('exit', () => resolve(undefined))
    child.once('error', (error: Error) => resolve(error))
  })
  const early = options.graceful ? killThroughHandle(child, 'SIGTERM') : killProcessTree(child.pid).ok ? undefined : killThroughHandle(child, 'SIGKILL')
  const failure = early ?? (await exited)
  if (failure === undefined) return
  // The child may still be running, so end it through its handle before the error is shown; a body that already threw keeps its own error, which is the one the run reports.
  if (child.exitCode === null && child.signalCode === null) killThroughHandle(child, 'SIGKILL')
  if (options.graceful) throw failure
}
