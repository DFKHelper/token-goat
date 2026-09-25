/** Test-only worker for the withFileLock live-holder regression test in tests/util.test.ts. Run as a real child OS process so the "holder" genuinely has its own event loop, blocked synchronously by fn() for holdMs, past staleMs. Nothing in this process can refresh the lock file's mtime while fn() has the thread pinned, so a lock that is not stolen here is protected by the holder's pid being alive, which a caller in another process checks. Usage: tsx lock_holder.ts <lockPath> <holdMs> <staleMs> */
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
    // Announce acquisition on stderr (stdout stays pure JSON for the caller to parse) BEFORE the busy-spin pins this thread. The caller waits for this line rather than polling for the lock file within a fixed window: under a loaded parallel suite, tsx's transpile-and-start cost alone has exceeded a four-second poll, which failed the test for a reason that has nothing to do with what it is testing.
    process.stderr.write('acquired\n')
    // Busy-spin: genuinely synchronous, non-yielding work -- never awaits, never lets this process's own event loop turn -- for holdMs, which is deliberately longer than staleMs.
    const end = Date.now() + holdMs
    while (Date.now() < end) {
      /* intentionally empty */
    }
    return 'holder-done'
  },
  { staleMs, waitMs: 100 },
)

process.stdout.write(JSON.stringify({ result }))
