import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  drainOnce,
  getDirtyPathsFor,
  isWorkerRunning,
  processDirtyBatch,
  stopWorker,
  workerPidPath,
} from '../src/worker.js'
import { querySymbols } from '../src/index_reader.js'
import { closeDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'

let DIR: string

function queueFile(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
}

function writeQueue(dir: string, lines: string[]): void {
  const qp = queueFile(dir)
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, lines.map((l) => `${l}\n`).join(''))
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-'))
})

afterEach(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('isWorkerRunning', () => {
  it('returns false when no pid file exists', () => {
    expect(isWorkerRunning(DIR)).toBe(false)
  })

  it('returns false for a stale (dead) pid', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    expect(isWorkerRunning(DIR)).toBe(false)
  })

  it('returns true when the pid file names a live process', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    expect(isWorkerRunning(DIR)).toBe(true)
  })
})

describe('stopWorker', () => {
  it('returns false when no worker is running', () => {
    expect(stopWorker(DIR)).toBe(false)
  })

  it('removes a stale pid file and returns false', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    expect(stopWorker(DIR)).toBe(false)
    expect(fs.existsSync(workerPidPath(DIR))).toBe(false)
  })
})

describe('getDirtyPathsFor', () => {
  it('returns [] when no queue file exists', () => {
    expect(getDirtyPathsFor(DIR)).toEqual([])
  })

  it('returns queued paths in order, deduplicated', () => {
    writeQueue(DIR, ['/a/one.ts', '/a/two.ts', '/a/one.ts', ''])
    expect(getDirtyPathsFor(DIR)).toEqual(['/a/one.ts', '/a/two.ts'])
  })
})

describe('processDirtyBatch', () => {
  it('indexes existing files and skips missing ones', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    const indexed: string[] = []
    const count = processDirtyBatch([real, path.join(DIR, 'ghost.ts')], (p) => indexed.push(p))
    expect(count).toBe(1)
    expect(indexed).toEqual([real])
  })
})

describe('drainOnce', () => {
  it('reads dirty.txt, processes paths via the indexer, and clears the queue', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    writeQueue(DIR, [real])

    const indexed: string[] = []
    const count = drainOnce(DIR, (p) => indexed.push(p))

    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    expect(fs.existsSync(queueFile(DIR))).toBe(false)
  })

  it('is a no-op (returns 0) when the queue is empty', () => {
    expect(drainOnce(DIR)).toBe(0)
  })

  // Regression: the shipping path is `runWorkerLoop -> drainOnce(dir)` with NO
  // injected index callback. Before the fix, the default callback was a stub
  // that wrote "would index" to stderr and never touched the DB, so every
  // surgical-read command silently returned an empty index. This test drives
  // the real default path (no callback) end-to-end and asserts the symbols
  // table is actually populated — it fails against the stub (0 rows) and passes
  // once the real indexer is wired in. The existing drainOnce/processDirtyBatch
  // tests inject their own callback, so they never exercised this path.
  it('default path indexes drained files into global.db (no injected callback)', () => {
    const src = path.join(DIR, 'sample.ts')
    fs.writeFileSync(src, 'export function knownWorkerSymbol(): number {\n  return 42\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    // Real shipping path: drain with no index callback.
    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const all = querySymbols({ limit: 1000 }, projectDb)
      expect(all.length).toBeGreaterThan(0)
      const found = querySymbols({ name: 'knownWorkerSymbol', limit: 10 }, projectDb)
      expect(found.length).toBeGreaterThan(0)
      expect(found[0]?.name).toBe('knownWorkerSymbol')
    } finally {
      // Release the better-sqlite3 handle so afterEach can remove DIR on Windows.
      closeDb(projectDb)
    }
  })
})
