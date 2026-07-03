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
const mockState = vi.hoisted(() => ({ blockedPath: undefined as string | undefined }))
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
    return actual.statSync(...args)
  }) as typeof fs.statSync
  return { ...actual, default: actual, existsSync: guardedExistsSync, statSync: guardedStatSync }
})

import * as fs from 'node:fs'

import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { indexFileSync } from '../src/parser.js'
import { pruneDeletedFiles } from '../src/index_prune.js'

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
    expect(symbolCount(dbPath, aKey)).toBeGreaterThan(0)
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
    expect(countBefore).toBeGreaterThan(0)
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
    expect(symbolCount(dbPath, lockedKey)).toBeGreaterThan(0)
    expect(symbolCount(dbPath, goneKey)).toBeGreaterThan(0)

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
    expect(symbolCount(dbPath, lockedKey)).toBeGreaterThan(0)
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
    expect(symbolCount(dbPath, appKey)).toBeGreaterThan(0)
    expect(symbolCount(dbPath, app2Key)).toBeGreaterThan(0)

    // Delete both files
    fs.rmSync(appFile)
    fs.rmSync(app2File)

    // Prune only app
    const result = pruneDeletedFiles(normalizePath(appDir), dbPath)
    expect(result).toBe(1)

    // app's row should be gone, app-2's row should remain
    expect(symbolCount(dbPath, appKey)).toBe(0)
    expect(symbolCount(dbPath, app2Key)).toBeGreaterThan(0)
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
      expect(symbolCount(dbPath, aKey)).toBeGreaterThan(0)
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
      expect(symbolCount(dbPath, aKey)).toBeGreaterThan(0)
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
})
