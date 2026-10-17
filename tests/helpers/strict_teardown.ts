/** Run every teardown step, each in its own try, then throw all the failures together. A step that fails (a removal Windows refuses because a connection still holds the file open) must fail the test loudly: swallowing it strands the files, and retrying it hides the open handle that is the defect. */
export function runTeardown(steps: ReadonlyArray<() => void>): void {
  const failures: unknown[] = []
  for (const step of steps) {
    try {
      step()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} teardown step(s) failed`)
}
