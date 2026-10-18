/** Teardown for a test fixture that cached db handles and made temp directories. Every step runs in its own try, so one that throws does not skip the rest, and the failures are reported together as one AggregateError. A handle whose close throws is reported with the rest (closeAllDbsCollect), where closeAllDbs would have swallowed it and left it to show only as a failed removal (EBUSY or EPERM), and only on Windows. A failed removal is a defect to find, not to retry. */
import { rmSync } from 'node:fs'

import { closeAllDbsCollect } from '../../src/db.js'

function release(failures: unknown[], dirs: string[]): void {
  const step = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      failures.push(err)
    }
  }
  // Handles first: a directory cannot be removed while a connection into it is open.
  step(() => {
    failures.push(...closeAllDbsCollect())
  })
  for (const dir of dirs) if (dir !== '') step(() => rmSync(dir, { recursive: true, force: true }))
}

/** Closes every db handle this process cached, then removes each directory. Empty strings are skipped, so a fixture that never got its directory can be passed as it stands. */
export function releaseFixture(...dirs: string[]): void {
  const failures: unknown[] = []
  release(failures, dirs)
  if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup failed')
}

/** As {@link releaseFixture}, but first waits for `settle` (the worker's pendingEmbeddings), so a fire-and-forget embedding write a drain started cannot land in a directory that is already gone. Runs on every path, including a test that threw before it reached its own wait; a `settle` that rejects is reported with the other failures and the cleanup still goes on. */
export async function releaseFixtureAfter(settle: () => Promise<unknown>, ...dirs: string[]): Promise<void> {
  const failures: unknown[] = []
  try {
    await settle()
  } catch (err) {
    failures.push(err)
  }
  release(failures, dirs)
  if (failures.length > 0) throw new AggregateError(failures, 'fixture cleanup failed')
}
