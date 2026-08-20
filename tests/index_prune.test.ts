import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Regression harness: pruneDeletedFiles used to call fs.existsSync(p), which per Node's own docs
// swallows ANY stat error (not just ENOENT -- also EPERM/EBUSY/permission-denied-mid-scan) and
// just returns false, indistinguishable from "genuinely deleted". existsSync is implemented via
// Node's internal binding, not by calling the public fs.statSync -- so a mock that only patches
// statSync never reaches the buggy existsSync call at all and would pass identically pre- and
// post-fix. To faithfully reproduce the real failure mode we mock BOTH: existsSync returns false
// for the blocked path (exactly what it does in real life when any stat error occurs underneath
// it), while statSync throws a non-ENOENT error for that same path (what the fixed code checks
// for). vi.spyOn cannot patch node:fs (its namespace exports are non-configurable: "Cannot
// redefine property"), so a module mock with a hoisted flag is the portable way to do this while
// every other fs call in this file passes straight through to the real module untouched.
const mockState = vi.hoisted(() => ({
  blockedPath: undefined as string | undefined,
  // Fires once, synchronously, from inside statSync for this exact path -- used to simulate a
  // concurrent recreate-and-reindex landing in the gap between a prune scan observing "file
  // gone" and the prune's own delete of that path actually running.
  onStatOnce: undefined as (() => void) | undefined,
  onStatOncePath: undefined as string | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedExistsSync = ((p: fs.PathLike) => {
    if (mockState.blockedPath !== undefined && p === mockState.blockedPath) return false
    return actual.existsSync(p)
  }) as typeof fs.existsSync
  const guardedStatSync = ((...args: Parameters<typeof fs.statSync>) => {
    if (mockState.blockedPath !== undefined && args[0] === mockState.blockedPath) {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    if (mockState.onStatOncePath !== undefined && args[0] === mockState.onStatOncePath) {
      const cb = mockState.onStatOnce
      mockState.onStatOnce = undefined
      mockState.onStatOncePath = undefined
      cb?.()
      const opts = args[1] as { throwIfNoEntry?: boolean } | undefined
      if (opts?.throwIfNoEntry === false) return undefined
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return actual.statSync(...args)
  }) as typeof fs.statSync
  return { ...actual, default: actual, existsSync: guardedExistsSync, statSync: guardedStatSync }
})

import * as fs from 'node:fs'

import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { indexFileSync, deleteFileRows } from '../src/parser.js'
import {
  pruneDeletedFiles,
  removeFileFromIndex,
  recordKnownRoot,
  recordKnownRootThrottled,
  sweepKnownRoots,
  findSystemTempFiles,
  pruneSystemTempFiles,
  findOrphanedChunkPaths,
  pruneOrphanedChunks,
} from '../src/index_prune.js'
import * as embeddingsModule from '../src/embeddings.js'

// Count symbol rows for a given normalized path key in the isolated DB.
function symbolCount(dbPath: string, key: string): number {
  const db = getDb(dbPath)
  const row = db.prepare(`SELECT COUNT(*) AS n FROM symbols WHERE file_path = ?`).get(key) as { n: number }
  return row.n
}

describe('index_prune', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-'))
    dbPath = path.join(dir, 'test.db')
  })

  afterEach(() => {
    mockState.blockedPath = undefined
    mockState.onStatOnce = undefined
    mockState.onStatOncePath = undefined
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if files are still locked
    }
  })

  it('prunes rows for a file deleted from disk', () => {
    const aPath = path.join(dir, 'a.ts')
    fs.writeFileSync(aPath, 'export const aSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    expect(symbolCount(dbPath, aKey)).toBe(1)
    fs.rmSync(aPath)
    const result = pruneDeletedFiles(normalizePath(dir), dbPath)
    expect(result).toBe(1)
    expect(symbolCount(dbPath, aKey)).toBe(0)
  })

  it('keeps rows for a file still on disk', () => {
    const aPath = path.join(dir, 'a.ts')
    fs.writeFileSync(aPath, 'export const aSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    const countBefore = symbolCount(dbPath, aKey)
    expect(countBefore).toBe(1)
    const result = pruneDeletedFiles(normalizePath(dir), dbPath)
    expect(result).toBe(0)
    expect(symbolCount(dbPath, aKey)).toBe(countBefore)
  })

  // Regression: pruneDeletedFiles used to call fs.existsSync(p), which swallows ANY
  // stat error (not just ENOENT -- also EPERM/EBUSY/permission-denied-mid-scan, all
  // documented Node behavior) and returns false. A transient lock (e.g. a Windows AV
  // scanner or search indexer holding the file open at the exact moment prune runs)
  // was therefore indistinguishable from "genuinely deleted", and the tracked file's
  // rows were wiped even though it was still on disk. The fix must confirm real
  // absence (ENOENT) before pruning, and leave a file's rows intact when its
  // existence can't be confirmed for any other reason.
  it('keeps rows for a file that cannot be stat-checked (e.g. EPERM/EBUSY), only prunes genuinely deleted files', () => {
    const lockedPath = path.join(dir, 'locked.ts')
    const goneePath = path.join(dir, 'gone.ts')
    fs.writeFileSync(lockedPath, 'export const lockedSym = 1\n')
    fs.writeFileSync(goneePath, 'export const goneSym = 1\n')
    const lockedKey = normalizePath(lockedPath)
    const goneKey = normalizePath(goneePath)
    indexFileSync(lockedKey, dbPath)
    indexFileSync(goneKey, dbPath)
    expect(symbolCount(dbPath, lockedKey)).toBe(1)
    expect(symbolCount(dbPath, goneKey)).toBe(1)

    // "gone" is genuinely deleted (real ENOENT via a plain fs.rmSync). "locked" stays on disk but
    // its existence is unconfirmable (simulated EPERM via the module-level mock above).
    fs.rmSync(goneePath)
    // pruneDeletedFiles iterates over the NORMALIZED paths stored in the DB (forward slashes,
    // lowercased drive letter), not the raw path.join() result -- match on that, or the mock
    // never actually intercepts the call the function makes and silently falls through to the
    // real filesystem instead.
    mockState.blockedPath = lockedKey

    const result = pruneDeletedFiles(normalizePath(dir), dbPath)
    expect(result).toBe(1)
    // Locked file's rows must survive -- its existence was never disproven.
    expect(symbolCount(dbPath, lockedKey)).toBe(1)
    // Genuinely deleted file's rows are still correctly pruned.
    expect(symbolCount(dbPath, goneKey)).toBe(0)
  })

  it('does not prune a sibling project\'s rows (trailing-slash boundary)', () => {
    const base = path.join(dir, 'projects')
    const appDir = path.join(base, 'app')
    const app2Dir = path.join(base, 'app-2')
    fs.mkdirSync(appDir, { recursive: true })
    fs.mkdirSync(app2Dir, { recursive: true })

    const appFile = path.join(appDir, 'main.ts')
    const app2File = path.join(app2Dir, 'main.ts')
    fs.writeFileSync(appFile, 'export const appSym = 1\n')
    fs.writeFileSync(app2File, 'export const app2Sym = 2\n')

    const appKey = normalizePath(appFile)
    const app2Key = normalizePath(app2File)
    indexFileSync(appKey, dbPath)
    indexFileSync(app2Key, dbPath)

    // Verify both are indexed
    expect(symbolCount(dbPath, appKey)).toBe(1)
    expect(symbolCount(dbPath, app2Key)).toBe(1)

    // Delete both files
    fs.rmSync(appFile)
    fs.rmSync(app2File)

    // Prune only app
    const result = pruneDeletedFiles(normalizePath(appDir), dbPath)
    expect(result).toBe(1)

    // app's row should be gone, app-2's row should remain
    expect(symbolCount(dbPath, appKey)).toBe(0)
    expect(symbolCount(dbPath, app2Key)).toBe(1)
  })

  it('refuses to prune at a drive/too-shallow root', () => {
    const aPath = path.join(dir, 'a.ts')
    fs.writeFileSync(aPath, 'export const aSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    const countBefore = symbolCount(dbPath, aKey)
    // Delete the file from disk so existsSync is NOT what keeps the row — only the too-shallow guard can, which is what this test must prove. Without the guard the row would match prefix `c:/` and be pruned.
    fs.rmSync(aPath)

    // Try to prune at drive root
    let result = pruneDeletedFiles('c:', dbPath)
    expect(result).toBe(0)
    expect(symbolCount(dbPath, aKey)).toBe(countBefore)

    // Try to prune at empty prefix
    result = pruneDeletedFiles('', dbPath)
    expect(result).toBe(0)
    expect(symbolCount(dbPath, aKey)).toBe(countBefore)
  })

  it('refuses to prune at a WSL-mounted drive root (/mnt/c), the same hazard as a bare drive letter', () => {
    // A file that would never actually be indexed this way on Windows (real paths use "c:/..."),
    // but exercises the guard directly: a row whose path genuinely falls under "/mnt/c/" must
    // survive a prune scoped to that prefix, exactly like the "c:" drive-letter case above.
    const db = getDb(dbPath)
    const fakePath = '/mnt/c/projects/fake/a.ts'
    db.prepare(
      `INSERT INTO files (path, sha, mtime, language, indexed_at, retry_count) VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(fakePath, 'deadbeef', Date.now(), 'ts', Date.now())

    const result = pruneDeletedFiles('/mnt/c', dbPath)
    expect(result).toBe(0)
    const row = db.prepare(`SELECT path FROM files WHERE path = ?`).get(fakePath) as
      | { path: string }
      | undefined
    expect(row?.path).toBe(fakePath)
  })

  describe('case-insensitive filesystem path matching', () => {
    const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    afterEach(() => {
      if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
    })

    // Regression (M8): pruneDeletedFiles compared the stored path and rootPrefix with a
    // case-SENSITIVE `startsWith`, while every other path comparison in this codebase
    // (pathEqClause/COLLATE NOCASE for SQL, foldPath for JS string comparisons -- see
    // parseDirtyQueueLines in worker.ts) folds case on case-insensitive filesystems.
    // normalizePath only lowercases the drive letter, so a rootPrefix whose casing
    // differs from the stored key elsewhere in the path (a realistic drift on
    // Windows/macOS) never matched the prefix check and the row was never pruned.
    it('prunes rows for a deleted file even when rootPrefix casing differs from the stored path', () => {
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
      const aPath = path.join(dir, 'a.ts')
      fs.writeFileSync(aPath, 'export const aSym = 1\n')
      const aKey = normalizePath(aPath)
      indexFileSync(aKey, dbPath)
      expect(symbolCount(dbPath, aKey)).toBe(1)
      fs.rmSync(aPath)

      // Casing differs beyond the drive letter, which normalizePath does not fold.
      const differentlyCasedRoot = normalizePath(dir).toUpperCase()
      const result = pruneDeletedFiles(differentlyCasedRoot, dbPath)
      expect(result).toBe(1)
      expect(symbolCount(dbPath, aKey)).toBe(0)
    })

    it('control: case-sensitive FS still requires matching casing', () => {
      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'
      const aPath = path.join(dir, 'a.ts')
      fs.writeFileSync(aPath, 'export const aSym = 1\n')
      const aKey = normalizePath(aPath)
      indexFileSync(aKey, dbPath)
      fs.rmSync(aPath)

      const differentlyCasedRoot = normalizePath(dir).toUpperCase()
      const result = pruneDeletedFiles(differentlyCasedRoot, dbPath)
      expect(result).toBe(0)
      expect(symbolCount(dbPath, aKey)).toBe(1)
    })
  })

  it('is idempotent', () => {
    const aPath = path.join(dir, 'a.ts')
    fs.writeFileSync(aPath, 'export const aSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    fs.rmSync(aPath)

    const result1 = pruneDeletedFiles(normalizePath(dir), dbPath)
    expect(result1).toBe(1)
    expect(symbolCount(dbPath, aKey)).toBe(0)

    const result2 = pruneDeletedFiles(normalizePath(dir), dbPath)
    expect(result2).toBe(0)
    expect(symbolCount(dbPath, aKey)).toBe(0)
  })

  // Regression: findDeletablePaths scans every candidate path for disk existence, THEN a second
  // pass deletes every path found gone -- these are not one atomic step. If a file is recreated
  // and reindexed (by a concurrent edit hook, worker drain, or second `token-goat index`
  // invocation) in the gap between "this path was observed gone" and "this path's row is
  // actually deleted", the unconditional delete used to wipe the freshly-written row too,
  // silently losing the new content even though the file exists on disk again with fresh index
  // rows. Simulated here via a statSync hook that fires exactly once for the target path (mid
  // prune scan) and, as a side effect, recreates the file with different content and reindexes
  // it before the mocked stat call reports "gone" -- faithfully reproducing the race without
  // needing real wall-clock timing.
  it('does not delete a file that was recreated and reindexed mid-scan (delete-recreate race)', () => {
    const aPath = path.join(dir, 'race.ts')
    fs.writeFileSync(aPath, 'export const oldSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    expect(symbolCount(dbPath, aKey)).toBe(1)

    mockState.onStatOncePath = aKey
    mockState.onStatOnce = () => {
      fs.writeFileSync(aPath, 'export const newSym = 2\n')
      indexFileSync(aKey, dbPath)
    }

    const result = pruneDeletedFiles(normalizePath(dir), dbPath)

    // The recreated file must survive with its fresh content indexed, not get wiped by the
    // prune pass that observed it "gone" a moment before the recreate landed.
    expect(result).toBe(0)
    expect(symbolCount(dbPath, aKey)).toBe(1)
    const db = getDb(dbPath)
    const row = db.prepare('SELECT body FROM symbols WHERE file_path = ?').get(aKey) as
      | { body: string }
      | undefined
    expect(row?.body).toContain('newSym')
  })

  // Regression: removeFileFromIndex called deleteFileRows then deleteFileEmbeddings with no
  // transaction wrapping the pair. A crash between them (e.g. deleteFileEmbeddings throwing)
  // left the files/symbols/refs rows deleted but the chunks/chunk_vectors rows for that same
  // file still present -- orphaned rows nothing else ever cleans up, since pruneDeletedFiles
  // only iterates `SELECT DISTINCT path FROM files`, which no longer names the file at all
  // once deleteFileRows alone has run. The fix wraps both deletes in one db.transaction() call
  // (mirroring upsertChunks in embeddings.ts), so a thrown error between them rolls back the
  // whole operation instead of leaving it half-applied.
  it('rolls back deleteFileRows when deleteFileEmbeddings throws (atomic removeFileFromIndex)', () => {
    const aPath = path.join(dir, 'atomic.ts')
    fs.writeFileSync(aPath, 'export const atomicSym = 1\n')
    const aKey = normalizePath(aPath)
    indexFileSync(aKey, dbPath)
    expect(symbolCount(dbPath, aKey)).toBe(1)

    const db = getDb(dbPath)
    const filesRowCount = (): number => {
      const row = db.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(aKey) as { n: number }
      return row.n
    }
    expect(filesRowCount()).toBe(1)

    const deleteEmbeddingsSpy = vi
      .spyOn(embeddingsModule, 'deleteFileEmbeddings')
      .mockImplementationOnce(() => {
        throw new Error('simulated crash between deletes')
      })

    expect(() => removeFileFromIndex(db, aKey)).toThrow('simulated crash between deletes')
    deleteEmbeddingsSpy.mockRestore()

    // Pre-fix (no transaction): deleteFileRows' effect would have persisted despite the throw
    // -- symbols/files rows gone, orphaning the (untested-here) chunks rows nothing else could
    // ever clean up. Post-fix: the whole operation rolls back, so the row survives intact.
    expect(symbolCount(dbPath, aKey)).toBe(1)
    expect(filesRowCount()).toBe(1)
  })
})

// Regression: nothing ever retroactively purged already-indexed rows for files living under the
// OS system temp directory (scratch checkouts, ad hoc debugging copies). The prevention half
// (hooks_edit.ts's postEditHandler gating on isUnderSystemTemp) only stops NEW pollution --
// these two cover the retroactive cleanup half, which `token-goat project prune` now also runs.
describe('findSystemTempFiles / pruneSystemTempFiles', () => {
  let tempScratchDir: string
  let nonTempDir: string
  let dbPath: string

  beforeEach(() => {
    // dir fixtures created via mkdtempSync(os.tmpdir(), ...) elsewhere in this file are
    // themselves already under system temp -- reused here as the "should be pruned" side.
    tempScratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-systemp-'))
    // A fixture rooted under the repo's own cwd, NOT under os.tmpdir(), proves the retroactive
    // cleanup leaves legitimate real-project rows untouched.
    nonTempDir = fs.mkdtempSync(path.join(process.cwd(), 'tg-prune-nontemp-'))
    dbPath = path.join(tempScratchDir, 'test.db')
  })

  afterEach(() => {
    try {
      fs.rmSync(tempScratchDir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if files are still locked
    }
    try {
      fs.rmSync(nonTempDir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if files are still locked
    }
  })

  it('findSystemTempFiles lists an indexed file under system temp but not one outside it', () => {
    const tempFile = path.join(tempScratchDir, 'scratch.ts')
    fs.writeFileSync(tempFile, 'export const scratchSym = 1\n')
    const tempKey = normalizePath(tempFile)
    indexFileSync(tempKey, dbPath)

    const realFile = path.join(nonTempDir, 'real.ts')
    fs.writeFileSync(realFile, 'export const realSym = 1\n')
    const realKey = normalizePath(realFile)
    indexFileSync(realKey, dbPath)

    const found = findSystemTempFiles(dbPath)
    expect(found).toContain(tempKey)
    expect(found).not.toContain(realKey)
  })

  it('pruneSystemTempFiles removes indexed rows under system temp and keeps everything else', () => {
    const tempFile = path.join(tempScratchDir, 'scratch.ts')
    fs.writeFileSync(tempFile, 'export const scratchSym = 1\n')
    const tempKey = normalizePath(tempFile)
    indexFileSync(tempKey, dbPath)

    const realFile = path.join(nonTempDir, 'real.ts')
    fs.writeFileSync(realFile, 'export const realSym = 1\n')
    const realKey = normalizePath(realFile)
    indexFileSync(realKey, dbPath)

    expect(symbolCount(dbPath, tempKey)).toBe(1)
    expect(symbolCount(dbPath, realKey)).toBe(1)

    const pruned = pruneSystemTempFiles(dbPath)

    expect(pruned).toContain(tempKey)
    expect(pruned).not.toContain(realKey)
    expect(symbolCount(dbPath, tempKey)).toBe(0)
    expect(symbolCount(dbPath, realKey)).toBe(1)
  })

  it('is a no-op when nothing indexed lives under system temp', () => {
    const realFile = path.join(nonTempDir, 'real.ts')
    fs.writeFileSync(realFile, 'export const realSym = 1\n')
    const realKey = normalizePath(realFile)
    indexFileSync(realKey, dbPath)

    expect(pruneSystemTempFiles(dbPath)).toEqual([])
    expect(symbolCount(dbPath, realKey)).toBe(1)
  })
})

// Regression: before recordKnownRoot/sweepKnownRoots, pruneDeletedFiles only ever ran via the
// manual `token-goat index [path]` CLI command -- nothing periodic existed, so a shared
// global.db could (and did) accumulate hundreds of dead rows indefinitely with zero automatic
// recovery. These cover the registry (recordKnownRoot) and the worker-driven sweep
// (sweepKnownRoots) that closes that gap.
describe('known_roots auto-prune (regression)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-known-roots-'))
    dbPath = path.join(dir, 'test.db')
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Cleanup may fail on Windows if files are still locked
    }
  })

describe('recordKnownRoot', () => {
  it('upserts the project root for an edited file, refreshing last_seen and clearing first_missing', () => {
    fs.mkdirSync(path.join(dir, '.git'))
    const filePath = path.join(dir, 'a.ts')
    fs.writeFileSync(filePath, 'export const a = 1\n')

    recordKnownRoot(normalizePath(filePath), dbPath)

    const db = getDb(dbPath)
    const row = db.prepare('SELECT root, first_missing_ms FROM known_roots').get() as
      | { root: string; first_missing_ms: number | null }
      | undefined
    expect(row).toBeDefined()
    expect(normalizePath(row!.root)).toBe(normalizePath(dir))
    expect(row!.first_missing_ms).toBeNull()

    // A second observation refreshes the existing row (and clears a stale first_missing_ms)
    // rather than duplicating it.
    db.prepare('UPDATE known_roots SET first_missing_ms = ?').run(Date.now())
    recordKnownRoot(normalizePath(filePath), dbPath)
    const rows = db.prepare('SELECT * FROM known_roots').all()
    expect(rows.length).toBe(1)
    const updated = db.prepare('SELECT first_missing_ms FROM known_roots').get() as {
      first_missing_ms: number | null
    }
    expect(updated.first_missing_ms).toBeNull()
  })

  it('is a no-op for a file with no recognizable project root', () => {
    // `dir` itself has no PROJECT_MARKERS (.git, package.json, ...), so findProject walks up to
    // the os.tmpdir() boundary without finding one and returns null.
    const filePath = path.join(dir, 'a.ts')
    fs.writeFileSync(filePath, 'export const a = 1\n')
    recordKnownRoot(normalizePath(filePath), dbPath)
    const db = getDb(dbPath)
    const row = db.prepare('SELECT COUNT(*) AS n FROM known_roots').get() as { n: number }
    expect(row.n).toBe(0)
  })
})

describe('recordKnownRootThrottled', () => {
  it('records on first call and skips a second call within the rate-limit window', () => {
    fs.mkdirSync(path.join(dir, '.git'))
    const filePath = path.join(dir, 'a.ts')
    fs.writeFileSync(filePath, 'export const a = 1\n')

    recordKnownRootThrottled(normalizePath(filePath), dir, dbPath)
    const db = getDb(dbPath)
    expect((db.prepare('SELECT COUNT(*) AS n FROM known_roots').get() as { n: number }).n).toBe(1)

    // A second call within the throttle window must not touch the DB again -- proven by
    // deleting the row and confirming it is NOT recreated (a real re-record would recreate it).
    db.prepare('DELETE FROM known_roots').run()
    recordKnownRootThrottled(normalizePath(filePath), dir, dbPath)
    expect((db.prepare('SELECT COUNT(*) AS n FROM known_roots').get() as { n: number }).n).toBe(0)
  })

  it('records each distinct project root independently, not just the first root seen in the rate-limit window', () => {
    // The throttle marker lives under one shared global dataDir() regardless of which project
    // is being edited (see recordKnownRootThrottled's real call site in hooks_edit.ts, which
    // always passes dataDir()). A dev machine routinely has edits land in more than one project
    // within the same hour -- the marker must not let the second project's root go permanently
    // unregistered just because a first, unrelated project's edit happened to land first.
    const proj1 = path.join(dir, 'proj1')
    const proj2 = path.join(dir, 'proj2')
    fs.mkdirSync(path.join(proj1, '.git'), { recursive: true })
    fs.mkdirSync(path.join(proj2, '.git'), { recursive: true })
    const file1 = path.join(proj1, 'a.ts')
    const file2 = path.join(proj2, 'b.ts')
    fs.writeFileSync(file1, 'export const a = 1\n')
    fs.writeFileSync(file2, 'export const b = 1\n')

    const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-markers-'))
    recordKnownRootThrottled(normalizePath(file1), markerDir, dbPath)
    recordKnownRootThrottled(normalizePath(file2), markerDir, dbPath)

    const db = getDb(dbPath)
    const roots = (db.prepare('SELECT root FROM known_roots').all() as Array<{ root: string }>).map((r) => r.root)
    expect(roots.map(normalizePath)).toContain(normalizePath(proj1))
    expect(roots.map(normalizePath)).toContain(normalizePath(proj2))
  })
})

describe('sweepKnownRoots', () => {
  it('prunes dead rows for a reachable known root', () => {
    fs.mkdirSync(path.join(dir, '.git'))
    const aPath = path.join(dir, 'a.ts')
    const bPath = path.join(dir, 'b.ts')
    fs.writeFileSync(aPath, 'export const a = 1\n')
    fs.writeFileSync(bPath, 'export const b = 1\n')
    indexFileSync(normalizePath(aPath), dbPath)
    indexFileSync(normalizePath(bPath), dbPath)
    recordKnownRoot(normalizePath(aPath), dbPath)
    fs.rmSync(aPath)

    const result = sweepKnownRoots(dbPath)
    expect(result.prunedRows).toBe(1)
    expect(result.prunedRoots.map(normalizePath)).toContain(normalizePath(dir))
    expect(result.flaggedRoots).toEqual([])
    expect(symbolCount(dbPath, normalizePath(aPath))).toBe(0)
    expect(symbolCount(dbPath, normalizePath(bPath))).toBe(1)
  })

  it('does not prune an unreachable root on first sight -- starts the missing-since clock instead', () => {
    const projectDir = path.join(dir, 'proj')
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    const aPath = path.join(projectDir, 'a.ts')
    fs.writeFileSync(aPath, 'export const a = 1\n')
    indexFileSync(normalizePath(aPath), dbPath)
    recordKnownRoot(normalizePath(aPath), dbPath)

    fs.rmSync(projectDir, { recursive: true, force: true })

    const result = sweepKnownRoots(dbPath, { now: 1000 })
    expect(result.prunedRows).toBe(0)
    expect(result.prunedRoots).toEqual([])
    expect(symbolCount(dbPath, normalizePath(aPath))).toBe(1)

    const db = getDb(dbPath)
    const row = db.prepare('SELECT first_missing_ms FROM known_roots').get() as {
      first_missing_ms: number | null
    }
    expect(row.first_missing_ms).toBe(1000)
  })

  it('does not prune yet while still within the missing grace period', () => {
    const projectDir = path.join(dir, 'proj')
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    const aPath = path.join(projectDir, 'a.ts')
    fs.writeFileSync(aPath, 'export const a = 1\n')
    indexFileSync(normalizePath(aPath), dbPath)
    recordKnownRoot(normalizePath(aPath), dbPath)

    fs.rmSync(projectDir, { recursive: true, force: true })

    const graceMs = 7 * 24 * 60 * 60 * 1000
    sweepKnownRoots(dbPath, { now: 1000, missingGraceMs: graceMs })
    const result = sweepKnownRoots(dbPath, { now: 1000 + graceMs - 1, missingGraceMs: graceMs })

    expect(result.prunedRows).toBe(0)
    expect(symbolCount(dbPath, normalizePath(aPath))).toBe(1)
  })

  it('fully prunes and forgets a root once it has been missing past the grace period', () => {
    const projectDir = path.join(dir, 'proj')
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    const aPath = path.join(projectDir, 'a.ts')
    fs.writeFileSync(aPath, 'export const a = 1\n')
    indexFileSync(normalizePath(aPath), dbPath)
    recordKnownRoot(normalizePath(aPath), dbPath)

    fs.rmSync(projectDir, { recursive: true, force: true })

    const graceMs = 1000
    sweepKnownRoots(dbPath, { now: 0, missingGraceMs: graceMs })
    const result = sweepKnownRoots(dbPath, { now: graceMs + 1, missingGraceMs: graceMs })

    expect(result.prunedRows).toBe(1)
    expect(result.prunedRoots.map(normalizePath)).toContain(normalizePath(projectDir))
    expect(symbolCount(dbPath, normalizePath(aPath))).toBe(0)

    const db = getDb(dbPath)
    expect(db.prepare('SELECT COUNT(*) AS n FROM known_roots').get() as { n: number }).toEqual({ n: 0 })
  })

  it('flags instead of pruning when a reachable root would lose an anomalously large fraction of its rows', () => {
    const projectDir = path.join(dir, 'proj')
    fs.mkdirSync(path.join(projectDir, '.git'), { recursive: true })
    // 25 files total; delete 21 of them (84%, well past the 50% ratio and 20-file minimum)
    // while the root itself stays reachable -- simulating a mount point/subdirectory inside the
    // root going offline, not the files actually being deleted.
    const files: string[] = []
    for (let i = 0; i < 25; i++) {
      const p = path.join(projectDir, `f${i}.ts`)
      fs.writeFileSync(p, `export const f${i} = ${i}\n`)
      indexFileSync(normalizePath(p), dbPath)
      files.push(p)
    }
    recordKnownRoot(normalizePath(files[0]!), dbPath)
    for (let i = 0; i < 21; i++) fs.rmSync(files[i]!)

    const result = sweepKnownRoots(dbPath)
    expect(result.flaggedRoots.map(normalizePath)).toContain(normalizePath(projectDir))
    expect(result.prunedRows).toBe(0)
    // Every row -- including the genuinely-deleted ones -- survives; nothing was pruned this
    // cycle. A human can investigate and re-run a manual `token-goat index` once confirmed.
    for (const f of files) {
      expect(symbolCount(dbPath, normalizePath(f))).toBe(1)
    }
  })

  it('never prunes a too-shallow root even if one somehow ends up in known_roots', () => {
    const db = getDb(dbPath)
    db.prepare(
      'INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, ?, NULL)',
    ).run('c:/', Date.now())

    const result = sweepKnownRoots(dbPath)
    expect(result.prunedRoots).toEqual([])
    expect(result.flaggedRoots).toEqual([])
    const row = db.prepare('SELECT first_missing_ms FROM known_roots WHERE root = ?').get('c:/') as
      | { first_missing_ms: number | null }
      | undefined
    expect(row?.first_missing_ms).toBeNull()
  })
})
})

// An embedding chunk whose `files` row is already gone. Every existing prune enumerates paths
// with `SELECT DISTINCT path FROM files`, so once the file row goes, no sweep can even name the
// path -- the chunk keeps its text and its vector and keeps being served by `semantic` forever.
// The live global index had 14 such rows, all under system temp, all holding the full source of
// files deleted long ago, and `project prune` reported a clean nothing-to-do on every one.
describe('orphaned embedding chunks (files row gone, chunks row left behind)', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphanchunk-'))
    dbPath = path.join(dir, 'test.db')
  })

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // Windows may still hold a lock on the DB file.
    }
  })

  // Reproduce the half-applied removal exactly: deleteFileRows drops symbols/refs/files and
  // leaves chunks untouched, which is what an interrupted removeFileFromIndex (or a prune racing
  // a lagging embed for the same path) leaves behind.
  function seedOrphanChunk(): string {
    const filePath = path.join(dir, 'gone.ts')
    fs.writeFileSync(filePath, 'export function secretHandlerAlpha(x: string): string { return x }\n')
    const key = normalizePath(filePath)
    indexFileSync(key, dbPath)
    const db = getDb(dbPath)
    db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(
      key,
      1,
      1,
      'export function secretHandlerAlpha(x: string): string { return x }',
      'symbol',
    )
    deleteFileRows(db, key)
    fs.rmSync(filePath)
    return key
  }

  function chunkCount(key: string): number {
    const db = getDb(dbPath)
    const row = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE file_path = ?').get(key) as { n: number }
    return row.n
  }

  it('findOrphanedChunkPaths names a chunk path with no files row', () => {
    const key = seedOrphanChunk()
    expect(chunkCount(key)).toBe(1)
    expect(findOrphanedChunkPaths(dbPath)).toContain(key)
  })

  it('leaves a chunk alone while its files row is still present', () => {
    const filePath = path.join(dir, 'alive.ts')
    fs.writeFileSync(filePath, 'export const aliveSym = 1\n')
    const key = normalizePath(filePath)
    indexFileSync(key, dbPath)
    const db = getDb(dbPath)
    db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(key, 1, 1, 'export const aliveSym = 1', 'symbol')
    expect(findOrphanedChunkPaths(dbPath)).not.toContain(key)
    expect(pruneOrphanedChunks(dbPath)).toEqual([])
    expect(chunkCount(key)).toBe(1)
  })

  it('pruneOrphanedChunks deletes the orphaned chunk row', () => {
    const key = seedOrphanChunk()
    expect(pruneOrphanedChunks(dbPath)).toEqual([key])
    expect(chunkCount(key)).toBe(0)
    expect(findOrphanedChunkPaths(dbPath)).not.toContain(key)
  })

  // The repair has to be reachable without the user knowing to run anything: the worker's
  // periodic sweep is the only thing that runs on its own, and before this it could not see the
  // row at all, so `reclaim --rebuild` (which wipes the whole index) was the only cure.
  // A chunk's vector lives in a separate virtual table keyed by the chunk id. Deleting the chunk
  // row alone leaves the vector behind, still reachable by the nearest-neighbour scan, so the
  // search hit survives the clean-up meant to remove it. Skipped where sqlite-vec is not
  // installed, since the table does not exist on those builds at all.
  it('clears the vector as well as the chunk row', () => {
    const key = seedOrphanChunk()
    const db = getDb(dbPath)
    const hasVectors = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'chunk_vectors'").get() as { n: number }).n > 0
    if (!hasVectors) return
    const id = db.prepare('SELECT id FROM chunks WHERE file_path = ?').pluck().get(key) as number
    // Written through the production helper: vec0 rejects a plain JS number for its rowid, and insertChunkVector is where the conversion lives. 384 floats matches the vec0 column db.ts declares.
    embeddingsModule.insertChunkVector(db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)'), id, Array(384).fill(0))
    const vectorCount = (): number => (db.prepare('SELECT COUNT(*) AS n FROM chunk_vectors_rowids WHERE rowid = ?').get(id) as { n: number }).n
    expect(vectorCount()).toBe(1)
    expect(pruneOrphanedChunks(dbPath)).toEqual([key])
    expect(vectorCount()).toBe(0)
  })

  // Same file, two spellings that differ by separator rather than by case. deleteFileEmbeddings
  // folds the spelling it is handed but does not normalize it, so these are two different deletes.
  // Reporting them as one file is right; deleting only one of them is not -- the survivor comes
  // back as an orphan on every future sweep and is never cleared.
  it('clears every stored spelling of one orphaned file', () => {
    const key = seedOrphanChunk()
    const db = getDb(dbPath)
    const backslashed = key.split('/').join(String.fromCharCode(92))
    expect(backslashed).not.toBe(key)
    db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(backslashed, 1, 1, 'export function secretHandlerAlpha(x: string): string { return x }', 'symbol')
    expect(findOrphanedChunkPaths(dbPath)).toHaveLength(1)
    expect(pruneOrphanedChunks(dbPath)).toHaveLength(1)
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n).toBe(0)
  })

  // The scan that decides a path is orphaned and the delete that acts on it must be one atomic
  // step: another process reindexing that path in between restores its files row and rewrites its
  // chunks, and a delete that never re-reads would wipe live rows. Only a second process can
  // actually interleave there, so what this pins is the property that makes such an interleave
  // impossible -- the deletes run inside a transaction, which pruneOrphanedChunks opens with the
  // write lock already held. It does not, and cannot in one process, demonstrate the race itself.
  it('runs its deletes inside a transaction', () => {
    seedOrphanChunk()
    const db = getDb(dbPath)
    const real = embeddingsModule.deleteFileEmbeddings
    const seenInTransaction: boolean[] = []
    const spy = vi.spyOn(embeddingsModule, 'deleteFileEmbeddings').mockImplementation((handle, filePath) => {
      seenInTransaction.push(db.inTransaction)
      real(handle, filePath)
    })
    try {
      expect(pruneOrphanedChunks(dbPath)).toHaveLength(1)
      expect(seenInTransaction).toEqual([true])
    } finally {
      spy.mockRestore()
    }
  })

  // The same file can be stored under two spellings that differ only by case, and
  // deleteFileEmbeddings folds -- so clearing one clears both. Counting both spellings reported
  // "2 files" for one file cleared once, which is how the dogfood run first surfaced it. Forces
  // the case-insensitive fold on every platform so the assertion means the same thing on Linux CI.
  it('counts two spellings of one folded path as one file', () => {
    const prior = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      const key = seedOrphanChunk()
      const db = getDb(dbPath)
      const otherSpelling = key.replace('gone.ts', 'GONE.ts')
      expect(otherSpelling).not.toBe(key)
      db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)').run(otherSpelling, 1, 1, 'export function secretHandlerAlpha(x: string): string { return x }', 'symbol')
      expect(findOrphanedChunkPaths(dbPath)).toHaveLength(1)
      expect(pruneOrphanedChunks(dbPath)).toHaveLength(1)
      const left = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }
      expect(left.n).toBe(0)
    } finally {
      if (prior === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prior
    }
  })

  it('the periodic sweep clears it with no known root registered', () => {
    const key = seedOrphanChunk()
    const result = sweepKnownRoots(dbPath)
    expect(result.prunedOrphanChunkPaths).toEqual([key])
    expect(chunkCount(key)).toBe(0)
  })
})
