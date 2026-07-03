/**
 * Test-only worker for tests/session_store_race.test.ts (task #15 regression test).
 *
 * Run as a real child OS process -- not simulated in-process interleaving -- so it races
 * against a sibling worker with a genuinely independent event loop and OS scheduling. Each
 * loop iteration mirrors one real hook call's session bookkeeping: load the persisted
 * state, record a distinct file read, then save. That load -> mutate -> save sequence is
 * exactly what relay() drives per hook invocation, and exactly the sequence whose
 * unprotected read-modify-write in saveSessionState() used to silently lose a concurrent
 * sibling process's update.
 *
 * Usage: tsx session_race_worker.ts <sessionId> <prefix> <count>
 */
import { loadSessionState, saveSessionState } from '../../src/session_store.js'
import { recordFileRead } from '../../src/session.js'

const [, , sessionId, prefix, countArg] = process.argv
if (!sessionId || !prefix || !countArg) {
  throw new Error('usage: session_race_worker <sessionId> <prefix> <count>')
}
const count = Number(countArg)

for (let i = 0; i < count; i++) {
  loadSessionState(sessionId)
  recordFileRead(`/race/${prefix}-${i}.ts`)
  saveSessionState(sessionId)
}
