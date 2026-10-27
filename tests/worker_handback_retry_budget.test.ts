/** A path a retiring drain hands back was never tried, so handing it back must not use up its retry budget. Pinned in-thread: the daemon's pid file goes missing during the first batch's heartbeat, so the remaining paths are unreached, and the live queue path is a directory, so appending them to it fails and each takes the hand-back fallback. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Lifecycle from '../src/worker_lifecycle.js'
import type * as Preflight from '../src/embed_preflight.js'

// A drained file would dispatch an embed call once the loop is past its drain; holding the model download keeps the loop from reaching one.
vi.mock('../src/embed_preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Preflight>()
  return { ...actual, modelDownloadHeld: () => true }
})

// The drain's per-path heartbeat runs after the retire decision for that path, so the first call marks the point where the daemon's pid file goes missing mid-batch.
const hooks = vi.hoisted(() => ({ onFirstHeartbeat: null as null | (() => void) }))
vi.mock('../src/worker_lifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Lifecycle>()
  return {
    ...actual,
    writeDrainHeartbeat: (dir: string, force?: boolean) => {
      const hook = hooks.onFirstHeartbeat
      hooks.onFirstHeartbeat = null
      hook?.()
      return actual.writeDrainHeartbeat(dir, force)
    },
  }
})

import { closeDb, getDb } from '../src/db.js'
import { dirtyQueuePathFor } from '../src/dirty_queue.js'
import { runWorkerLoop } from '../src/worker.js'
import { workerPidPath } from '../src/worker_lifecycle.js'

const dirs: string[] = []

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    closeDb(path.join(d, 'global.db'))
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // best-effort
    }
  }
})

describe('a retiring drain hands its unreached paths back without charging a retry', () => {
  it('leaves the retry budget of every unreached path untouched', async () => {
    const dir = scratch('tg-handback-budget-')
    const repo = scratch('tg-handback-budget-repo-')
    const queued: string[] = []
    for (let i = 0; i < 3; i++) {
      const f = path.join(repo, `handback_${i}.ts`)
      fs.writeFileSync(f, `export const h${i} = ${i}\n`)
      queued.push(f)
    }
    const queuePath = dirtyQueuePathFor(dir)
    fs.mkdirSync(path.dirname(queuePath), { recursive: true })
    fs.writeFileSync(queuePath, `${queued.join('\n')}\n`)
    fs.writeFileSync(workerPidPath(dir), `${process.pid}\n`)

    let retiredInDrain = 0
    hooks.onFirstHeartbeat = () => {
      retiredInDrain++
      fs.rmSync(workerPidPath(dir))
      // The live queue path cannot take an append, so the hand-back of the unreached paths falls back to one call per path.
      fs.mkdirSync(queuePath)
      // The retire probe is rate-limited, so wait past its window before the next path asks it again.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
    }

    await runWorkerLoop(dir, 5, () => false, { pidFileGraceMs: 0, idleExitMs: 60_000 })
    fs.rmSync(queuePath, { recursive: true, force: true })

    expect(retiredInDrain, 'the daemon did not retire during its first batch').toBe(1)
    const charged = getDb(path.join(dir, 'global.db')).prepare('SELECT COUNT(*) AS n FROM index_retries WHERE retry_count > 0').get() as { n: number }
    expect(charged.n, 'unreached paths were charged a transient retry').toBe(0)
  })
})
