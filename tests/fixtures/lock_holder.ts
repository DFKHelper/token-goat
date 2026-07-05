/**
 * Test-only worker for the withFileLock heartbeat regression test in tests/util.test.ts.
 *
 * Run as a real child OS process so the "holder" genuinely has its own event loop, blocked
 * synchronously by fn() for holdMs -- the exact scenario a heartbeat interval living in the
 * SAME process as fn() cannot detect (a setInterval there would never fire while fn() has the
 * thread pinned). Only a heartbeat running in a separate process (as withFileLock now spawns
 * internally) can keep refreshing the lock file's mtime while this holder is busy.
 *
 * Usage: tsx lock_holder.ts <lockPath> <holdMs> <staleMs>
 */
import { withFileLock } from '../../src/util.js'

const [, , lockPath, holdMsArg, staleMsArg] = process.argv
if (!lockPath || !holdMsArg || !staleMsArg) {
  throw new Error('usage: lock_holder <lockPath> <holdMs> <staleMs>')
}
const holdMs = Number(holdMsArg)
const staleMs = Number(staleMsArg)

const result = withFileLock(
  lockPath,
  () => {
    // Busy-spin: genuinely synchronous, non-yielding work -- never awaits, never lets this
    // process's own event loop turn -- for holdMs, which is deliberately longer than staleMs.
    const end = Date.now() + holdMs
    while (Date.now() < end) {
      /* intentionally empty */
    }
    return 'holder-done'
  },
  { staleMs, waitMs: 100 },
)

process.stdout.write(JSON.stringify({ result }))
