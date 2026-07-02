import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
