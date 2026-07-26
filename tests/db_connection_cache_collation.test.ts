/**
 * getDb()/closeDb() cache the open better-sqlite3 handle by resolved db path so two
 * callers naming the same file share one connection (see the `_connections` doc comment
 * in db.ts). On a case-insensitive filesystem (Windows/macOS default), two callers naming
 * the same physical file with different casing must still share that one handle — two
 * separate better-sqlite3 Database objects open on the same file risks WAL/locking issues
 * and defeats the whole point of the cache.
 *
 * Uses the TOKEN_GOAT_CASE_INSENSITIVE_FS env override (the same real seam isCaseInsensitiveFs()
 * reads, per session.test.ts's "case-insensitive filesystem path matching" pattern) so the fold
 * branch is exercised deterministically on every platform, including case-sensitive Linux CI.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { getDb, closeDb, closeAllDbs } = await import('../src/db.js')

let TMP: string
const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-cache-collation-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
  else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
})

describe('getDb connection cache case-folding', () => {
  it('case-insensitive FS: shares one connection across differently-cased paths to the same file', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const lower = path.join(TMP, 'index.db')
    const upper = lower.toUpperCase()

    const a = getDb(lower)
    const b = getDb(upper)

    expect(b).toBe(a)
  })

  it('case-insensitive FS: closeDb on a differently-cased path still evicts the cached connection', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const lower = path.join(TMP, 'index.db')
    const upper = lower.toUpperCase()

    const first = getDb(lower)
    closeDb(upper)
    const second = getDb(lower)

    expect(second).not.toBe(first)
  })

  it('case-sensitive FS: differently-cased paths get distinct connections (they may be distinct files)', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '0'
    const lower = path.join(TMP, 'index.db')
    const upper = lower.toUpperCase()

    const a = getDb(lower)
    const b = getDb(upper)

    expect(b).not.toBe(a)
  })
})
