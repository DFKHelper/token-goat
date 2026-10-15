/** Deterministic proof of the worker's poll cadence, with no clock in it. The regression: startDetachedWorker wrote the 2000 ms default into the spawned daemon's environment instead of resolving the interval, so TG_WORKER_POLL_MS was inert on `worker start`, the one path that starts a real daemon. The daemon e2e (tests/worker_daemon_e2e.test.ts) proves the same thing through the built bundle; this file pins the two seams where the interval travels, by the value each one hands on rather than by how long a cycle took: what the parent puts in the child's environment, and what the real default loop passes to its between-cycle sleep. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as ChildProcessModule from 'node:child_process'
import type * as QueueWakerModule from '../src/queue_waker.js'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The spawn is faked so no daemon starts; everything else in startDetachedWorker (the poll resolution, the env it builds, the pid-file claim) runs for real.
const state = vi.hoisted(() => ({ sleeps: [] as number[] }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  return { ...actual, spawn: vi.fn() }
})

// Only the sleep is replaced: it records the interval the loop asks for and returns at once, so the loop's own cycle count (not a clock) decides how long the test runs.
vi.mock('../src/queue_waker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof QueueWakerModule>()
  return {
    ...actual,
    createQueueWaker: () => ({
      sleep: (ms: number): Promise<void> => {
        state.sleeps.push(ms)
        return Promise.resolve()
      },
      close: (): void => undefined,
    }),
  }
})

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { closeAllDbs } from '../src/db.js'
import { runWorkerLoop } from '../src/worker.js'
import { startDetachedWorker } from '../src/worker_lifecycle.js'

/** The fake child: an emitter with a pid and `unref`, the three things startDetachedWorker touches. */
class FakeChild extends EventEmitter {
  // Provenance: HAND-DERIVED. Any positive integer works; the pid file only has to name something.
  pid = 4242424
  unref(): void {}
}

const dirs: string[] = []
let savedPoll: string | undefined

beforeEach(() => {
  savedPoll = process.env['TG_WORKER_POLL_MS']
  state.sleeps.length = 0
  vi.mocked(spawn).mockReset()
  vi.mocked(spawn).mockImplementation(() => new FakeChild() as never)
})

afterEach(() => {
  if (savedPoll === undefined) delete process.env['TG_WORKER_POLL_MS']
  else process.env['TG_WORKER_POLL_MS'] = savedPoll
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function mkDataDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-poll-cadence-'))
  dirs.push(d)
  return d
}

/** The TG_WORKER_POLL_MS the single spawn call handed the child, as the child would read it. */
function spawnedPollMs(): string | undefined {
  expect(spawn).toHaveBeenCalledTimes(1)
  const [, , opts] = vi.mocked(spawn).mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }]
  return opts.env['TG_WORKER_POLL_MS']
}

describe('startDetachedWorker hands the daemon the poll interval it resolved', () => {
  // The regression itself. Provenance: HAND-DERIVED. 237 is no default of this codebase, so only a value read from the variable can produce it.
  it('forwards an inherited TG_WORKER_POLL_MS to the child', () => {
    process.env['TG_WORKER_POLL_MS'] = '237'
    startDetachedWorker({ dataDir: mkDataDir() })
    expect(spawnedPollMs()).toBe('237')
  })

  it('lets an explicit interval from the caller win over the variable', () => {
    process.env['TG_WORKER_POLL_MS'] = '237'
    startDetachedWorker({ dataDir: mkDataDir(), pollIntervalMs: 311 })
    expect(spawnedPollMs()).toBe('311')
  })

  // Provenance: HAND-DERIVED from the documented default (DEFAULT_POLL_INTERVAL_MS, 2000) and the rule that a non-positive or non-numeric setting is ignored.
  it.each([undefined, '', 'soon', '0', '-5'])('falls back to the 2000 ms default for %j', (raw) => {
    if (raw === undefined) delete process.env['TG_WORKER_POLL_MS']
    else process.env['TG_WORKER_POLL_MS'] = raw
    startDetachedWorker({ dataDir: mkDataDir() })
    expect(spawnedPollMs()).toBe('2000')
  })
})

describe('the default worker loop sleeps the interval it was given, once per cycle', () => {
  // Real loop, real default drain and index callbacks (none are injected); only the sleep is observed. Counting cycles replaces measuring them: three cycles are three sleeps, whatever the machine's speed.
  it('asks for exactly the given interval on each of three cycles', async () => {
    const dir = mkDataDir()
    await runWorkerLoop(dir, 237, () => state.sleeps.length >= 3, { pidFileGraceMs: 600_000, idleExitMs: 600_000 })
    expect(state.sleeps).toEqual([237, 237, 237])
  })
})
