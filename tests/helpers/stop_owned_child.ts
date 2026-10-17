import type { ChildProcess } from 'node:child_process'

import { onTestFinished } from 'vitest'

/** Stop a child this test spawned and holds the ChildProcess of: the handle signals the process it holds and nothing once that has exited, so no recorded number is signalled. SIGTERM, then wait for the child's own exit event, which cannot be missed because an exit that already happened is read from exitCode/signalCode first and the listener is attached before the signal is sent. The wait has no deadline of its own, so nothing here measures how long an exit took; instead the helper registers onTestFinished before it signals, which ends a child that is still alive through its handle with SIGKILL when the test finishes by any path (a pass, a failure, or the test timeout a SIGTERM-ignoring child runs into). That makes an orphan impossible, and it must be called while a test is running (vitest refuses the registration anywhere else). */
export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
}
