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
        // Provenance: HAND-DERIVED. Ten minutes is past the five-minute IDLE_VACUUM_COOLDOWN_MS in src/worker.ts after one step, and three steps (thirty minutes) stay inside the six-hour IDLE_VACUUM_INTERVAL_MS there.
        clock.nowMs += 10 * 60 * 1000
        clock.onSleep()
        return Promise.resolve()
      },
      close: (): void => undefined,
    }),
  }
})

import { closeAllDbs, getDb } from '../src/db.js'
import { logIdleReclaimPoll, runWorkerLoop } from '../src/worker.js'
import type { IdleReclaimRefusals } from '../src/worker.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import Database from '../src/sqlite_driver.js'
import { runTeardown } from './helpers/strict_teardown.js'

// Longer than the three fake ten-minute steps, so the loop's pid-file grace and idle exit (both read the fake clock) never end the run before the cycle count does.
const DAY_MS = 24 * 60 * 60 * 1000

const dirs: string[] = []

beforeEach(() => {
  // Provenance: HAND-DERIVED. Any instant far from zero works: the loop's last-vacuum mark starts at 0, so the first pass is due once the cooldown has passed.
  clock.nowMs = 1_800_000_000_000
  clock.onSleep = (): void => undefined
  vi.spyOn(Date, 'now').mockImplementation(() => clock.nowMs)
})

// Connections are closed before the directories go, each step on its own, and a failed removal fails the test: a retry would hide the connection that still holds the file.
afterEach(() => {
  vi.restoreAllMocks()
  runTeardown([closeAllDbs, ...dirs.splice(0).map((d) => () => fs.rmSync(d, { recursive: true, force: true }))])
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
    // Provenance: HAND-DERIVED. Forty 64 KiB blobs take about 680 4096-byte pages, and the DELETE of every row frees nearly all of them, far over the tenth (IDLE_VACUUM_MIN_FREE_SHARE, 0.1 in src/worker.ts) that makes a pass vacuum.
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
    // Provenance: HAND-DERIVED. The 5 is the poll interval handed to the fake sleep, which ignores it; 3 stops the loop after the three cycles the comments below count.
    await runWorkerLoop(dir, 5, () => sleeps >= 3, { pidFileGraceMs: DAY_MS, idleExitMs: DAY_MS })

    // Cycle 1 runs inside the cooldown and leaves the file alone; cycle 2 vacuums (cookie + 1); cycle 3 is inside the six-hour interval and must not vacuum.
    const [afterFirst = -1, afterSecond = -1, afterThird = -1] = cookies
    expect(afterSecond, 'the second cycle vacuums once the idle cooldown has passed').toBe(afterFirst + 1)
    expect(afterThird, 'the third cycle is inside the interval and leaves the refilled database alone').toBe(afterSecond)
  })
})

function errorLogLines(dir: string): string[] {
  try {
    return fs.readFileSync(workerErrorLogPath(dir), 'utf8').split('\n').filter((line) => line !== '')
  } catch {
    return []
  }
}

describe('the worker error log for a run of refused idle reclaims', () => {
  function logDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idle-reclaim-log-'))
    dirs.push(dir)
    return dir
  }

  // Provenance: HAND-DERIVED. The expected line count is the contract itself: one line when a run of refusals starts, one when it ends, none in between; 7 is any count above two, so a log on every refusal shows as more lines.
  it('writes one line when the first poll is refused and one, with the count, when a later poll settles', () => {
    const dir = logDir()
    const dbPath = path.join(dir, 'global.db')
    const run: IdleReclaimRefusals = { polls: 0 }

    for (let i = 0; i < 7; i++) logIdleReclaimPoll(dir, dbPath, run, { settled: false })
    const midRun = errorLogLines(dir)
    logIdleReclaimPoll(dir, dbPath, run, { settled: true })
    const lines = errorLogLines(dir)

    expect(midRun, 'seven refusals wrote a single line').toHaveLength(1)
    expect(midRun[0], 'the first line names the database and says a reader holds the log').toContain(`idle reclaim of ${dbPath} was refused (a reader is holding the -wal`)
    expect(lines, 'the run wrote two lines in all').toHaveLength(2)
    expect(lines[1], 'the second line counts the refused polls').toContain('settled and the -wal was truncated after 7 refused polls')
  })

  it('writes nothing for a poll that settles with no refusal before it, and starts a new run after one that ended', () => {
    const dir = logDir()
    const dbPath = path.join(dir, 'global.db')
    const run: IdleReclaimRefusals = { polls: 0 }

    logIdleReclaimPoll(dir, dbPath, run, { settled: true })
    expect(errorLogLines(dir), 'a success with no refusal before it writes nothing').toEqual([])

    logIdleReclaimPoll(dir, dbPath, run, { settled: false })
    logIdleReclaimPoll(dir, dbPath, run, { settled: true })
    logIdleReclaimPoll(dir, dbPath, run, { settled: false, error: new Error('database is locked') })
    const lines = errorLogLines(dir)

    expect(lines, 'a second run writes its own first line').toHaveLength(3)
    expect(lines[0], 'the first run starts with a refusal line').toContain('was refused')
    expect(lines[1], 'the first run counted one poll').toContain('after 1 refused polls')
    expect(lines[2], 'a pass that threw says why').toContain('(database is locked)')
  })

  // Provenance: HAND-DERIVED. The reader opens a snapshot and then the writer commits one more row, so the log holds a frame the reader has not seen and a truncating checkpoint is refused until the reader closes; the fake sleep closes it after the third cycle. Cycle 1 is inside the idle cooldown, so cycles 2 and 3 are the two refused polls and cycle 4 settles.
  it('reaches the log from the real loop: two lines for two refused polls and the poll that settled', async () => {
    const dir = logDir()
    const dbPath = path.join(dir, 'global.db')
    const db = getDb(dbPath)
    db.exec('CREATE TABLE payload (id INTEGER PRIMARY KEY, body BLOB)')
    db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
    const reader = new Database(dbPath)
    let readerOpen = true
    const closeReader = (): void => {
      if (!readerOpen) return
      readerOpen = false
      reader.close()
    }
    let sleeps = 0
    try {
      reader.exec('BEGIN')
      reader.prepare('SELECT count(*) AS c FROM payload').get()
      db.prepare('INSERT INTO payload (body) VALUES (zeroblob(16))').run()
      clock.onSleep = (): void => {
        sleeps++
        if (sleeps === 3) closeReader()
      }
      // Provenance: HAND-DERIVED. The 5 is the poll interval handed to the fake sleep, which ignores it; 4 stops the loop after the four cycles counted above.
      await runWorkerLoop(dir, 5, () => sleeps >= 4, { pidFileGraceMs: DAY_MS, idleExitMs: DAY_MS })
    } finally {
      closeReader()
    }

    const lines = errorLogLines(dir)
    expect(lines, 'two refused polls and the settling one wrote two lines').toHaveLength(2)
    expect(lines[0], 'the first refusal is logged').toContain('was refused')
    expect(lines[1], 'the settling poll logs the count').toContain('after 2 refused polls')
  })
})
