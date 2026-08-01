/**
 * Behavioural tests for `token-goat reclaim-index`.
 *
 * The interesting property here is not that a quiet reclaim shrinks the file -- it is what
 * happens when it *cannot*. The `--rebuild` deletes commit before VACUUM runs, so a VACUUM that
 * loses its lock race arrives after the irreversible work is already done. Throwing there would
 * abandon a half-reported recovery behind a stack trace; these tests pin the honest-reporting
 * behaviour instead.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { reclaimIndex } from '../src/index_reclaim.js'

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reclaim-'))
})

afterEach(() => {
  // Close the cached handle before rmSync or Windows refuses to delete the locked .db/.db-wal.
  closeAllDbs()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

/** Seed a DB with derived rows plus one row of user-authored state. */
function seed(dbPath: string): void {
  const db = getDb(dbPath)
  db.prepare(
    'INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)',
  ).run('src/a.ts', 'sha', 1, 'typescript', 1)
  for (let i = 0; i < 50; i++) {
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('src/a.ts', `sym${i}`, 'function', 1, 2, 'x'.repeat(4096), '')
  }
}

describe('reclaimIndex', () => {
  it('drops derived rows under rebuild and reports what it dropped', () => {
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath)

    const result = reclaimIndex(dbPath, { rebuild: true })

    expect(result.rebuilt).toBe(true)
    expect(result.dropped.symbols).toBe(50)
    expect(result.vacuumDeferred).toBe(false)
    const db = getDb(dbPath)
    expect(db.prepare('SELECT count(*) AS n FROM symbols').get()).toEqual({ n: 0 })
  })

  it('leaves derived rows alone without rebuild', () => {
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath)

    const result = reclaimIndex(dbPath)

    expect(result.rebuilt).toBe(false)
    expect(result.dropped).toEqual({})
    const db = getDb(dbPath)
    expect(db.prepare('SELECT count(*) AS n FROM symbols').get()).toEqual({ n: 50 })
  })

  it('reports vacuumDeferred instead of throwing when VACUUM cannot get its lock', () => {
    // The regression this file exists for. A second connection holding an exclusive transaction
    // is exactly the shape of the real race (worker or a short-lived CLI mid-write), and VACUUM
    // is the step most likely to lose it because it needs an exclusive lock of its own.
    const dbPath = path.join(tempDir, 'global.db')
    seed(dbPath)

    const blocker = new Database(dbPath)
    blocker.pragma('busy_timeout = 0')
    blocker.exec('BEGIN EXCLUSIVE')
    try {
      // reclaimIndex reuses the cached handle for this path, so shortening its busy_timeout here
      // shortens the very waits it is about to perform. Without this the test sits through the
      // production 15s patience three times over (checkpoint, VACUUM, final checkpoint) for no
      // added signal -- the code path exercised is identical either way.
      getDb(dbPath).pragma('busy_timeout = 100')

      const result = reclaimIndex(dbPath)
      // Must not throw, and must not claim a vacuum it never performed.
      expect(result.vacuumDeferred).toBe(true)
    } finally {
      blocker.exec('ROLLBACK')
      blocker.close()
    }
  })
})
