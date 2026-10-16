/** The retry schedule of withFileLock: a short wait budget must still get many looks at the lock, or a waiter facing a holder that re-takes the lock in a tight loop is starved while nothing is stuck (tests/session_store_race.test.ts lost an entry at one skipped session save in about half the Windows runs). */
import { describe, expect, it } from 'vitest'

import { lockPollMs } from '../src/util.js'

/** How many times a waiter looks at the lock before a budget of `waitMs` is spent, summing the sleeps lockPollMs hands out; the first look is the create that precedes the first sleep. */
function looksWithin(waitMs: number): number {
  let spent = 0
  let looks = 1
  for (let attempt = 1; spent < waitMs; attempt++) {
    spent += lockPollMs(attempt, waitMs)
    looks++
  }
  return looks
}

describe('lockPollMs', () => {
  // HAND-DERIVED: the sleeps are computed from the formula min(20 * attempt, 200, waitMs / 50), floored at 1, not read off the implementation's output.
  it('gives the 500 ms session-save budget at least 45 looks, where the 20 ms-per-attempt backoff gave 6', () => {
    expect(looksWithin(500)).toBeGreaterThanOrEqual(45)
  })

  it('keeps the long budgets on the 200 ms ceiling and the default 2 s budget at 40 ms', () => {
    expect(lockPollMs(50, 15_000)).toBe(200)
    expect(lockPollMs(50, 2000)).toBe(40)
  })

  it('still backs off from 20 ms per attempt when the budget is long enough to allow it', () => {
    expect(lockPollMs(1, 15_000)).toBe(20)
    expect(lockPollMs(3, 15_000)).toBe(60)
  })

  it('never sleeps less than 1 ms, whatever the budget', () => {
    expect(lockPollMs(1, 10)).toBe(1)
    expect(lockPollMs(1, 0)).toBe(1)
  })
})
