import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  drainOnce,
  getDirtyPathsFor,
  isWorkerRunning,
  processDirtyBatch,
  stopWorker,
  workerPidPath,
} from '../src/worker.js'
import * as parserModule from '../src/parser.js'
import { querySymbols, queryRefs } from '../src/index_reader.js'
import { closeDb, getDb } from '../src/db.js'
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

  it('deduplicates paths with different case on case-insensitive systems', () => {
    // Regression: on Windows/macOS, queue entries that differ only in case should be deduplicated since NTFS and HFS+ are case-insensitive. Before the fix, getDirtyPathsFor would return both "c:/projects/File.ts" and "C:/PROJECTS/file.ts" as separate entries. Test with paths that will normalize but differ in case after normalization.
    const isCaseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
    if (!isCaseInsensitive) {
      // On case-sensitive filesystems, paths with different case are different. Skip this test on non-Windows, non-macOS systems.
      expect(true).toBe(true)
      return
    }
    writeQueue(DIR, ['c:/projects/File.ts', 'C:/PROJECTS/file.ts'])
    const result = getDirtyPathsFor(DIR)
    // Should be deduplicated to 1 entry (the first one encountered, normalized)
    expect(result.length).toBe(1)
  })
})

describe('processDirtyBatch', () => {
  it('indexes existing files and prunes missing ones', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    const ghost = path.join(DIR, 'ghost.ts')
    const indexed: string[] = []
    const removed: string[] = []
    const count = processDirtyBatch(
      [real, ghost],
      (p) => indexed.push(p),
      (p) => removed.push(p),
    )
    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    // The vanished path is reconciled as a deletion, not silently skipped.
    expect(removed).toEqual([ghost])
  })

  // Regression: the returned count must reflect paths actually (re)indexed, not paths merely
  // visited. An index callback that signals a no-op (returns `false`, mirroring the default
  // indexer's sha-gate skip for byte-identical content) must not inflate the count.
  it('does not count a path whose index callback signals a no-op skip', () => {
    const real = path.join(DIR, 'unchanged.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    const count = processDirtyBatch([real], () => false)
    expect(count).toBe(0)
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

  // Regression: the shipping path is `runWorkerLoop -> drainOnce(dir)` with NO injected index callback. Before the fix, the default callback was a stub that wrote "would index" to stderr and never touched the DB, so every surgical-read command silently returned an empty index. This test drives the real default path (no callback) end-to-end and asserts the symbols table is actually populated — it fails against the stub (0 rows) and passes once the real indexer is wired in. The existing drainOnce/processDirtyBatch tests inject their own callback, so they never exercised this path.
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

  // Companion to the symbols regression above, for the refs table. The default drain path must populate refs (it was hard-coded to [] in the parser), with the enclosing caller in `context`, so `refs --callers` can resolve callers.
  it('default path populates the refs table from drained files (no injected callback)', () => {
    const src = path.join(DIR, 'callers.ts')
    fs.writeFileSync(
      src,
      'function knownCallee(): number {\n  return 1\n}\n' +
        'export function knownCaller(): number {\n  return knownCallee()\n}\n',
    )
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const refs = queryRefs({ name: 'knownCallee' }, projectDb)
      expect(refs.length).toBeGreaterThan(0)
      expect(refs[0]?.context).toBe('knownCaller')
    } finally {
      closeDb(projectDb)
    }
  })
  // Regression: the incremental drain must reconcile DELETIONS, not just edits. The shipping path is `drainOnce(dir)` with no injected callbacks; before the fix a dirty path whose file was gone was skipped, orphaning its symbol/ref rows forever. This drives the real default path: index a file, delete it, re-queue its path, drain again, and asserts the symbol is gone from the project's global.db. It fails pre-fix (row survives) and passes post-fix.
  it('default path prunes a deleted file\'s rows on re-drain (no injected callback)', () => {
    const src = path.join(DIR, 'doomed.ts')
    fs.writeFileSync(src, 'export function doomedWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      expect(
        querySymbols({ name: 'doomedWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBeGreaterThan(0)
      fs.rmSync(src)
      writeQueue(DIR, [norm])
      drainOnce(DIR)
      expect(querySymbols({ name: 'doomedWorkerSymbol', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })


  // Regression: the real drain path must SHA-gate. makeIndexer is handed each file's fingerprint but the buggy version dropped it and reparsed every queued file on every drain. Drive the real default path (no injected callback): index a file, delete its symbol rows to prove a reindex would repopulate, then re-queue the UNCHANGED file. With the gate the stored files.sha matches the fingerprint so indexFileSync is skipped and the rows stay deleted; the buggy version reindexes and repopulates them.
  it('default path skips re-indexing a file whose content is unchanged (sha gate)', () => {
    const src = path.join(DIR, 'cached.ts')
    fs.writeFileSync(src, 'export function shaGatedSymbol(): number {\n  return 7\n}\n')
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')
    try {
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBeGreaterThan(0)

      // Corrupt the index: drop the file's symbol rows but leave its files row (and stored sha) intact.
      getDb(projectDb).prepare('DELETE FROM symbols WHERE file_path = ?').run(norm)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBe(0)

      // Re-queue the unchanged file and drain again; the sha gate must skip the reparse, and the
      // returned count must not include it (it was visited but not actually reindexed).
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(0)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })

  describe('drainOnce atomic rename-to-claim (lost-update regression)', () => {
    it('does not drop paths appended during a drain', () => {
      // Regression: drainOnce must not delete the entire queue without first claiming it atomically. A path appended by a concurrent appendDirtyPath during processDirtyBatch would be deleted without being indexed. The atomic rename-to-claim pattern fixes this.
      const A = path.join(DIR, 'a.ts')
      const B = path.join(DIR, 'b.ts')
      fs.writeFileSync(A, 'export const a = 1\n')
      fs.writeFileSync(B, 'export const b = 2\n')

      // Seed the queue with just A.
      writeQueue(DIR, [A])

      // The callback simulates concurrent appendDirtyPath calls that land during processDirtyBatch. When we process A, we append B to the queue to simulate a race.
      const indexedPaths: string[] = []
      drainOnce(DIR, (p) => {
        indexedPaths.push(p)
        if (p === A) {
          // Simulate concurrent appendDirtyPath(B) landing during our batch processing.
          fs.appendFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${B}\n`)
        }
      })

      // After the drain, B should still be in the queue (was not deleted). Pre-fix: B would be deleted without being indexed. Post-fix: B is preserved in the fresh queue created after the rename.
      const remaining = getDirtyPathsFor(DIR)
      expect(remaining).toContain(B)
    })

    it('recovers from abandoned .draining file', () => {
      // Regression: if a previous drain process crashed, its .draining file would be abandoned. drainOnce must recover by reading and indexing it, so those paths are not lost.
      const C = path.join(DIR, 'c.ts')
      fs.writeFileSync(C, 'export const c = 3\n')

      // Simulate a crashed drain by creating a .draining file directly.
      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${C}\n`)

      // No live queue exists; only the .draining file.
      expect(fs.existsSync(queuePath)).toBe(false)

      // The drain should recover the .draining file, index C, and clean it up.
      const indexedPaths: string[] = []
      const count = drainOnce(DIR, (p) => {
        indexedPaths.push(p)
      })

      // C should have been recovered and indexed.
      expect(count).toBe(1)
      expect(indexedPaths).toContain(C)

      // The .draining file should be cleaned up.
      expect(fs.existsSync(drainingPath)).toBe(false)
    })
  })

  describe('drainOnce rm-after-process (crash-safety regression)', () => {
    it('does not lose claimed queue paths when processing crashes mid-batch (stage b)', () => {
      // Regression: drainOnce used to delete the claimed .draining file BEFORE running
      // processDirtyBatch, so a crash (simulated here as the index callback throwing) partway
      // through a batch already had the queue file deleted -- the paths were lost forever until
      // some unrelated future edit re-queued them. The fix defers the rm until after
      // processDirtyBatch completes successfully.
      const A = path.join(DIR, 'a.ts')
      const B = path.join(DIR, 'b.ts')
      fs.writeFileSync(A, 'export const a = 1\n')
      fs.writeFileSync(B, 'export const b = 2\n')
      writeQueue(DIR, [A, B])

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`

      expect(() =>
        drainOnce(DIR, (p) => {
          if (p === B) throw new Error('simulated crash mid-batch')
        }),
      ).toThrow('simulated crash mid-batch')

      // Pre-fix, the claimed .draining file was already removed before processDirtyBatch ran,
      // so it would be gone here even though the batch never finished.
      expect(fs.existsSync(drainingPath)).toBe(true)

      // A later drain (simulating a restart after the crash) must still recover both paths.
      const indexed: string[] = []
      const count = drainOnce(DIR, (p) => indexed.push(p))
      expect(count).toBe(2)
      expect(indexed).toEqual([A, B])
      expect(fs.existsSync(drainingPath)).toBe(false)
    })

    it('does not lose recovered .draining paths when processing crashes mid-batch (stage a)', () => {
      // Same regression as above, exercised via the crash-recovery path: an abandoned .draining
      // file (from a previous crashed drain) must also survive a crash during ITS OWN
      // processDirtyBatch run, rather than being deleted up front.
      const C = path.join(DIR, 'c.ts')
      const D = path.join(DIR, 'd.ts')
      fs.writeFileSync(C, 'export const c = 3\n')
      fs.writeFileSync(D, 'export const d = 4\n')

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${C}\n${D}\n`)

      expect(() =>
        drainOnce(DIR, (p) => {
          if (p === D) throw new Error('simulated crash mid-recovery-batch')
        }),
      ).toThrow('simulated crash mid-recovery-batch')

      expect(fs.existsSync(drainingPath)).toBe(true)

      const indexed: string[] = []
      const count = drainOnce(DIR, (p) => indexed.push(p))
      expect(count).toBe(2)
      expect(indexed).toEqual([C, D])
      expect(fs.existsSync(drainingPath)).toBe(false)
    })
  })
})

// Regression: makeIndexer's catch block used to swallow a genuine indexFileSync failure with
// zero logging anywhere, and the caught exception's implicit `undefined` return was `!== false`,
// so processDirtyBatch counted the failed file as successfully indexed and dequeued it from the
// dirty queue forever -- no error surfaced anywhere, and the file's index silently went stale
// for good. This drives the real shipping path: `drainOnce(DIR)` with NO injected index/remove
// callbacks, so the actual default `makeIndexer` -> `indexFileSync` pipeline runs. Only
// `indexFileSync` itself is mocked (genuinely throwing for one specific path, genuinely calling
// through to the real implementation for the other), which is the narrowest possible seam for
// deterministic failure injection -- the orchestration under test (makeIndexer,
// processDirtyBatch, drainOnce) is entirely real.
describe('makeIndexer failure handling (regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a swallowed indexFileSync failure, does not count it as indexed, and still indexes the rest of the batch', () => {
    const realIndexFileSync = parserModule.indexFileSync
    const good = path.join(DIR, 'good.ts')
    const bad = path.join(DIR, 'bad.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')
    writeQueue(DIR, [good, bad])

    vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath, dbPath) => {
      if (filePath === bad) throw new Error('simulated parse failure')
      return realIndexFileSync(filePath, dbPath)
    })

    const projectDb = path.join(DIR, 'global.db')
    try {
      // (b) Batch isolation: one bad file must not abort the rest of the batch.
      const count = drainOnce(DIR)
      // (c) The failed file must not be counted as a successful index.
      expect(count).toBe(1)
      expect(
        querySymbols({ name: 'knownGoodSymbol', limit: 10 }, projectDb).length,
      ).toBeGreaterThan(0)
      expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, projectDb).length).toBe(0)

      // (a) The swallowed failure must be surfaced somewhere discoverable: the worker's error
      // log, since the detached worker process's stdio is discarded (startDetachedWorker uses
      // `stdio: 'ignore'`) and nothing in this file otherwise logs anything.
      const logPath = path.join(DIR, 'worker-errors.log')
      expect(fs.existsSync(logPath)).toBe(true)
      const logContent = fs.readFileSync(logPath, 'utf8')
      expect(logContent).toContain(bad)
      expect(logContent).toContain('simulated parse failure')
    } finally {
      closeDb(projectDb)
    }
  })
})
