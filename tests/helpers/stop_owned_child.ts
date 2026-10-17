import type { ChildProcess } from 'node:child_process'

/** Stop a child this test spawned and holds the ChildProcess of: the handle signals the process it holds and nothing once that has exited, so no recorded number is signalled. SIGTERM, then wait for the child's own exit event, which cannot be missed because an exit that already happened is read from exitCode/signalCode first and the listener is attached before the signal is sent. The wait has no deadline of its own: a child that ignores SIGTERM runs into the test timeout, and nothing here measures how long an exit took. */
export async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGTERM')
  await exited
}
