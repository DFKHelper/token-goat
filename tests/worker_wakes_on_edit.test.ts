/** The worker slept a fixed poll interval (2 s by default) between drains, so a file an edit hook queued waited up to that long before a surgical read could see its new symbols, and a read in that window answered from the old index. The worker now watches its queue directory and ends the sleep as soon as a producer appends (src/queue_waker.ts), keeping the interval as the fallback. Why didn't a test catch this: every worker test either drives drainOnce directly or runs the loop with a poll of 5-10 ms, so how long an edit waits between the enqueue and the drain was never measured on the real path. Driven here on the production default wiring: the real postEditHandler enqueues, runWorkerLoop drains with its own indexer (no injected callback), and the symbol is looked up in the index the drain wrote, with a poll interval of 10 s so that only a wake can answer inside the bound. PROVENANCE: HAND-DERIVED. One-function TypeScript files written by the test, and an Edit hook event built from the HookEvent fields postEditHandler reads (src/hook_registry.ts). */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { dataDir, globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { dirtyQueuePathFor } from '../src/dirty_queue.js'
import type { HookEvent } from '../src/hook_registry.js'
import { postEditHandler } from '../src/hooks_edit.js'
import { querySymbols } from '../src/index_reader.js'
import { createQueueWaker, noteOwnQueueWrite } from '../src/queue_waker.js'
import { pendingEmbeddings, runWorkerLoop } from '../src/worker.js'
import { indexableDir } from './helpers/temp-config.js'

/** Far above the bound every test asserts, so the timer alone can never satisfy one. */
const POLL_MS = 10_000
/** The poll interval the worker used before: an edit indexed inside it could only have been woken. */
const OLD_POLL_MS = 2000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function editEvent(file: string, cwd: string): HookEvent {
  return {
    eventName: 'post_tool_use',
    toolName: 'Edit',
    toolInput: { file_path: file },
    sessionId: 'worker-wake-probe',
    agentId: undefined,
    raw: { session_id: 'worker-wake-probe', tool_name: 'Edit', tool_input: { file_path: file }, cwd, tool_response: { output: 'ok' } },
  }
}

function project(): string {
  const dir = indexableDir()
  const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' })
  expect(r.status, r.stderr).toBe(0)
  return dir
}

function writeSource(dir: string, name: string): string {
  const file = path.join(dir, `${name}.ts`)
  fs.writeFileSync(file, `export function ${name}(): number {\n  return 1\n}\n`)
  return file
}

async function resolvesWithin(name: string, timeoutMs: number): Promise<number | undefined> {
  const start = performance.now()
  while (performance.now() - start < timeoutMs) {
    if (querySymbols({ name }, globalDbPath()).length > 0) return performance.now() - start
    await sleep(10)
  }
  return undefined
}

let stopLoop: (() => Promise<void>) | undefined

afterEach(async () => {
  await stopLoop?.()
  stopLoop = undefined
  await pendingEmbeddings()
  closeAllDbs()
})

/** Starts the real loop on the data directory the hooks write to. `onCheck` runs on every shouldStop call: the loop makes one at the top of a cycle and one just before it sleeps. Returns once the loop has reached its first sleep. */
async function startLoop(onCheck: (call: number) => void = () => {}): Promise<void> {
  fs.mkdirSync(dataDir(), { recursive: true })
  let stop = false
  let calls = 0
  let sleeping = false
  const done = runWorkerLoop(dataDir(), POLL_MS, () => {
    calls += 1
    onCheck(calls)
    if (calls === 2) sleeping = true
    return stop
  })
  stopLoop = async () => {
    stop = true
    // Any queue change wakes the sleep, and the loop then sees the stop.
    fs.appendFileSync(dirtyQueuePathFor(dataDir()), `${path.join(dataDir(), 'no-such-file.ts')}\n`)
    await done
  }
  const start = Date.now()
  while (!sleeping) {
    if (Date.now() - start > 15_000) throw new Error('the worker loop never reached its first sleep')
    await sleep(10)
  }
  // The check before the sleep has run; let the loop reach the await itself.
  await sleep(50)
}

describe('an edit wakes the worker (real default drain)', () => {
  it('indexes a file the edit hook queued while the worker sleeps, well inside the old poll interval', async () => {
    const dir = project()
    await startLoop()
    const file = writeSource(dir, 'wakeProbeWhileSleeping')

    const start = performance.now()
    postEditHandler(editEvent(file, dir))
    const queued = performance.now() - start
    const ms = await resolvesWithin('wakeProbeWhileSleeping', POLL_MS - 1000)

    expect(ms, 'the edit waited out the poll interval: nothing woke the worker').toBeDefined()
    expect(ms as number).toBeLessThan(OLD_POLL_MS)
    // Calibration: the hook itself returned quickly, so the time measured is the worker's.
    expect(queued).toBeLessThan(OLD_POLL_MS)
  }, 30_000)

  it('does not sleep over a file queued while a cycle was running', async () => {
    const dir = project()
    const file = writeSource(dir, 'wakeProbeMidCycle')
    let queuedAt = 0
    // The second check runs after the first cycle's drain and before its sleep, where no watch event can reach a sleep that has not begun yet.
    await startLoop((call) => {
      if (call !== 2) return
      postEditHandler(editEvent(file, dir))
      queuedAt = performance.now()
    })
    expect(queuedAt, 'calibration: the edit was queued from inside the cycle').toBeGreaterThan(0)
    const ms = await resolvesWithin('wakeProbeMidCycle', POLL_MS - 1000)
    expect(ms, 'a file queued during a cycle waited out the next sleep').toBeDefined()
    expect(performance.now() - queuedAt).toBeLessThan(OLD_POLL_MS)
  }, 30_000)
})

describe('the queue waker', () => {
  function scratchDataDir(): string {
    const dir = path.join(indexableDir(), 'data')
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  async function timedSleep(waker: ReturnType<typeof createQueueWaker>, ms: number, during?: () => void): Promise<number> {
    const start = performance.now()
    const slept = waker.sleep(ms)
    if (during !== undefined) {
      await sleep(50)
      during()
    }
    await slept
    return performance.now() - start
  }

  it('creates the queue directory it watches, so the first append after a start wakes it', async () => {
    const dir = scratchDataDir()
    const waker = createQueueWaker(dir)
    try {
      const ms = await timedSleep(waker, 5000, () => fs.appendFileSync(dirtyQueuePathFor(dir), '/x.ts\n'))
      expect(ms).toBeLessThan(1000)
    } finally {
      waker.close()
    }
  })

  it("sleeps the full interval over the worker's own append, which is paced on purpose", async () => {
    const dir = scratchDataDir()
    const waker = createQueueWaker(dir)
    try {
      const ms = await timedSleep(waker, 600, () => {
        fs.appendFileSync(dirtyQueuePathFor(dir), '/requeued.ts\n')
        noteOwnQueueWrite(dir)
      })
      expect(ms).toBeGreaterThanOrEqual(590)
      // And the next sleep starts from that queue rather than treating it as new work.
      expect(await timedSleep(waker, 300)).toBeGreaterThanOrEqual(290)
    } finally {
      waker.close()
    }
  })

  it('sleeps the full interval over a queue the drain could not claim, rather than spinning on it', async () => {
    const dir = scratchDataDir()
    fs.mkdirSync(path.dirname(dirtyQueuePathFor(dir)), { recursive: true })
    fs.writeFileSync(dirtyQueuePathFor(dir), '/locked.ts\n')
    const waker = createQueueWaker(dir)
    try {
      expect(await timedSleep(waker, 300)).toBeGreaterThanOrEqual(290)
      expect(await timedSleep(waker, 300)).toBeGreaterThanOrEqual(290)
    } finally {
      waker.close()
    }
  })

  it('falls back to the timer once the data directory is deleted under it, and does not recreate it', async () => {
    const dir = scratchDataDir()
    const waker = createQueueWaker(dir)
    try {
      const ms = await timedSleep(waker, 400, () => fs.rmSync(dir, { recursive: true, force: true }))
      expect(ms).toBeGreaterThanOrEqual(390)
      await timedSleep(waker, 100)
      expect(fs.existsSync(dir)).toBe(false)
    } finally {
      waker.close()
    }
  })
})
