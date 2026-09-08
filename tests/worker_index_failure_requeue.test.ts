/**
 * A file the worker failed to INDEX must get another attempt, exactly as one it failed to READ does.
 *
 * `drainOnce` claims the dirty queue by renaming it to `.draining`, processes the batch, then deletes
 * the claimed file. So a path is durably removed from the queue the moment its batch is processed, and
 * whatever `processDirtyBatch` decides is the path's last chance. It already handles the read half
 * correctly: `fingerprintFile` returning null logs a transient failure and requeues. The index half did
 * not. `makeIndexer` catches everything, logs it, and returns the INDEX_FAILED sentinel, and
 * `processDirtyBatch` used that only to skip the tally -- so a file whose write lost a SQLITE_BUSY race,
 * or whose read inside indexFileSync hit a lock the earlier fingerprint had missed, was dropped from the
 * queue for good. Its symbols then stay stale until something edits it again, and nothing says so: the
 * index is silently wrong rather than visibly behind.
 *
 * The retry accounting had to move for this to be safe. `clearRetryCount` ran as soon as the fingerprint
 * succeeded, on the reasoning that a successful read is progress. It is not progress if the index that
 * follows it fails: clearing there and requeuing here would reset the budget every cycle and hammer a
 * permanently unparseable file forever. The counter now clears only once the path is actually current,
 * which is why the give-up case below is part of this file rather than a separate concern.
 *
 * Provenance: CAPTURE for the mechanism, HAND-DERIVED for the counts. The failure is injected by making
 * the real `indexFileSync` throw, so the path under test is the production one: real `makeIndexer`, real
 * catch, real sentinel, real `drainOnce` queue claim and deletion against real files on disk. Nothing
 * here asserts on the sentinel itself (it is module-private) -- only on what a reader can observe: which
 * paths are on the queue afterwards, what the error log says, and whether the file ever gets indexed.
 * The cycle counts are chosen from MAX_TRANSIENT_RETRIES = 5, read from src/worker.ts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config.js'
import { closeDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import * as parserModule from '../src/parser.js'
import { drainOnce, getDirtyPathsFor } from '../src/worker.js'

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))

let DIR: string

function writeQueue(dir: string, lines: string[]): void {
  const qp = path.join(dir, 'queue', 'dirty.txt')
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, lines.map((l) => `${l}\n`).join(''))
}

function errorLog(dir: string): string {
  try {
    return fs.readFileSync(path.join(dir, 'worker-errors.log'), 'utf8')
  } catch {
    return ''
  }
}

/** getDirtyPathsFor returns whatever spelling the queue holds; compare normalized so a backslash/forward-slash difference cannot pass or fail this for the wrong reason. */
function queuedNormalized(dir: string): string[] {
  return getDirtyPathsFor(dir).map((p) => normalizePath(p))
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idxfail-'))
  vi.mocked(loadConfig).mockReturnValue({
    worker: { blocked_roots: [] },
    indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
  } as unknown as ReturnType<typeof loadConfig>)
})

afterEach(() => {
  vi.restoreAllMocks()
  closeDb(path.join(DIR, 'global.db'))
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('a path whose indexing failed is retried, not dropped', () => {
  it('requeues a readable file whose index attempt threw', () => {
    const target = path.join(DIR, 'busy.ts')
    fs.writeFileSync(target, 'export const x = 1\n')
    writeQueue(DIR, [target])
    // Thrown from inside indexFileSync so the real makeIndexer catch is what handles it -- the shape a SQLITE_BUSY on the index write, or a lock the earlier fingerprint read did not hit, actually arrives in.
    vi.spyOn(parserModule, 'indexFileSync').mockImplementation(() => {
      throw new Error('EBUSY: resource busy or locked')
    })

    drainOnce(DIR)

    // The drain claimed and deleted the queue file, so if the path is not back here it is gone for good.
    expect(queuedNormalized(DIR), 'the failed path was dropped from the dirty queue entirely').toContain(normalizePath(target))
    expect(errorLog(DIR)).toContain('busy.ts')
  })

  it('indexes the file on the next cycle once the failure clears, which is the point of requeuing it', () => {
    const target = path.join(DIR, 'transient.ts')
    fs.writeFileSync(target, 'export const y = 2\n')
    writeQueue(DIR, [target])
    const real = parserModule.indexFileSync
    let calls = 0
    const spy = vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath: string, dbPath?: string, preReadBytes?: Buffer) => {
      calls += 1
      if (calls === 1) throw new Error('EBUSY: resource busy or locked')
      return real(filePath, dbPath, preReadBytes)
    })

    drainOnce(DIR)
    drainOnce(DIR)

    expect(spy.mock.calls.length, 'the second cycle never retried the file').toBeGreaterThanOrEqual(2)
    // Recovered: nothing left owing, so the index is current rather than quietly behind.
    expect(queuedNormalized(DIR)).toEqual([])
  })

  it('gives up on a file that fails every time, instead of requeuing it forever', () => {
    const doomed = path.join(DIR, 'doomed.ts')
    fs.writeFileSync(doomed, 'export const z = 3\n')
    const healthy = path.join(DIR, 'fine.ts')
    fs.writeFileSync(healthy, 'export const w = 4\n')
    writeQueue(DIR, [doomed, healthy])
    const real = parserModule.indexFileSync
    vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath: string, dbPath?: string, preReadBytes?: Buffer) => {
      if (normalizePath(filePath) === normalizePath(doomed)) throw new Error('unparseable, and it always will be')
      return real(filePath, dbPath, preReadBytes)
    })

    // Comfortably more cycles than MAX_TRANSIENT_RETRIES, so a budget that resets each cycle shows up here as a queue that never empties.
    for (let cycle = 0; cycle < 12; cycle++) drainOnce(DIR)

    expect(queuedNormalized(DIR), 'the doomed path is still being requeued after 12 cycles, so its retry budget is resetting').toEqual([])
    const giveUp = errorLog(DIR)
      .split('\n')
      .filter((l) => l.includes('giving up on') && l.includes('doomed.ts'))
    // Exactly one, not one per cycle: the give-up notice is throttled the same way the read-failure one is.
    expect(giveUp.length).toBe(1)
  })
})
