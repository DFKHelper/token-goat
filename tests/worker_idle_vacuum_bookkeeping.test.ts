/** The worker loop vacuums an idle database once per IDLE_VACUUM_INTERVAL_MS, not once per cycle: after an idle pass settles, the next cycles leave the database alone even when it again has a tenth of its pages free. The loop is the real one with its real default drain and idle pass. Two seams stand in for time: the between-cycle sleep, which here advances a fake clock by ten minutes and returns at once, and Date.now, which reads that clock. No step waits on a real clock; the cycle count decides how long the test runs. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as QueueWakerModule from '../src/queue_waker.js'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const clock = vi.hoisted(() => ({ nowMs: 0, onSleep: (): void => undefined }))

// Only the sleep is replaced: it moves the fake clock past the five-minute idle cooldown, lets the test act between two cycles, and returns at once.
vi.mock('../src/queue_waker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueWakerModule>()
  return {
    ...actual,
    createQueueWaker: () => ({
      sleep: (): Promise<void> => {
        clock.nowMs += 10 * 60 * 1000
        clock.onSleep()
        return Promise.resolve()
      },
      close: (): void => undefined,
    }),
  }
})

import { closeAllDbs, getDb } from '../src/db.js'
import { runWorkerLoop } from '../src/worker.js'

// Longer than the three fake ten-minute steps, so the loop's pid-file grace and idle exit (both read the fake clock) never end the run before the cycle count does.
const DAY_MS = 24 * 60 * 60 * 1000

const dirs: string[] = []

beforeEach(() => {
  // Provenance: HAND-DERIVED. Any instant far from zero works: the loop's last-vacuum mark starts at 0, so the first pass is due once the cooldown has passed.
  clock.nowMs = 1_800_000_000_000
  clock.onSleep = (): void => undefined
  vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function schemaCookie(db: ReturnType<typeof getDb>): number {
  return Number(db.pragma('schema_version', { simple: true }))
}

describe('the idle vacuum interval', () => {
  it('does not vacuum again on the cycles after a pass that settled, though the database is once more mostly free pages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idle-vacuum-'))
    dirs.push(dir)
    const db = getDb(path.join(dir, 'global.db'))
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    const fillAndEmpty = (): void => {
      db.transaction(() => {
        const insert = db.prepare('INSERT INTO payload (body) VALUES (zeroblob(65536))')
        for (let i = 0; i < 40; i++) insert.run()
      }).immediate()
      db.prepare('DELETE FROM payload').run()
    }
    fillAndEmpty()
    const cookies: number[] = []
    let sleeps = 0

    clock.onSleep = (): void => {
      sleeps++
      cookies.push(schemaCookie(db))
      // After the second cycle (the one that vacuumed) the file is made mostly free again, so only the interval can stop a third pass.
      if (sleeps === 2) fillAndEmpty()
    }
    await runWorkerLoop(dir, 5, () => sleeps >= 3, { pidFileGraceMs: DAY_MS, idleExitMs: DAY_MS })

    // Cycle 1 runs inside the cooldown and leaves the file alone; cycle 2 vacuums (cookie + 1); cycle 3 is inside the six-hour interval and must not vacuum.
    const [afterFirst = -1, afterSecond = -1, afterThird = -1] = cookies
    expect(afterSecond, 'the second cycle vacuums once the idle cooldown has passed').toBe(afterFirst + 1)
    expect(afterThird, 'the third cycle is inside the interval and leaves the refilled database alone').toBe(afterSecond)
  })
})
