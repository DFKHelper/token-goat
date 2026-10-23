/** Regression: table discovery must hide SQLite's reserved objects and actual virtual-table shadows without dropping ordinary tables based on their names. `pragma_table_list` classifies shadow rows, so exact FTS/vec suffixes and old wildcard near-matches remain visible. Both `sqlite-tables` and `sqlite-schema` must satisfy this; FTS5 creates five shadow tables per virtual index. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Database from '../src/sqlite_driver.js'
import { getSqliteSchema, getSqliteTables } from '../src/sqlite_query.js'

describe('SQLite listings distinguish actual internals from name lookalikes', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sqlite-listing-'))
    dbPath = path.join(dir, 'wild.db')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function create(sql: string): void {
    const db = new Database(dbPath)
    db.exec(sql)
    db.close()
  }

  // HAND-DERIVED: names that match old shadow suffixes exactly or differ by one character. None is created by SQLite, FTS5, or sqlite-vec.
  const DECOYS =
    'CREATE TABLE sqlitedata (id INTEGER); CREATE TABLE plain (id INTEGER); CREATE TABLE my_ftsx_cache (id INTEGER); CREATE TABLE my_fts_cache (id INTEGER); CREATE TABLE my_vec0_cache (id INTEGER);'

  it('lists a user table whose name only resembles an internal one', () => {
    create(DECOYS)

    const names = getSqliteTables(dbPath).map((t) => t.name)

    // The old wildcard filters returned only ['plain']; suffix guesses also hid exact-lookalike names.
    expect(names).toEqual(['my_fts_cache', 'my_ftsx_cache', 'my_vec0_cache', 'plain', 'sqlitedata'])
  })

  it('describes that table in the schema view too', () => {
    // The schema view must share the compact inventory's object-discovery rules.
    create(DECOYS)

    expect(getSqliteSchema(dbPath).tables.map((t) => t.name)).toEqual([
      'my_fts_cache',
      'my_ftsx_cache',
      'my_vec0_cache',
      'plain',
      'sqlitedata',
    ])
  })

  it('still hides the shadow tables FTS5 creates beside a virtual table', () => {
    // CAPTURE: the five shadow names are the real output of `SELECT name FROM sqlite_master` against a database built by exactly the two statements below, on this repo's own sqlite build -- not read off the filter they must defeat. Without this, the cheapest fix (drop the patterns) passes every assertion above while adding five rows of machinery to the inventory for each indexed table.
    create('CREATE TABLE docs (id INTEGER, body TEXT); CREATE VIRTUAL TABLE docs_fts USING fts5(body);')

    const names = getSqliteTables(dbPath).map((t) => t.name)
    const schemaNames = getSqliteSchema(dbPath).tables.map((t) => t.name)

    for (const shadow of ['docs_fts_config', 'docs_fts_content', 'docs_fts_data', 'docs_fts_docsize', 'docs_fts_idx']) {
      expect(names).not.toContain(shadow)
      expect(schemaNames).not.toContain(shadow)
    }
    // The virtual table itself is queryable and stays listed, along with the ordinary table; hiding it would be the same defect pointing the other way.
    expect(names).toEqual(['docs', 'docs_fts'])
    expect(schemaNames).toEqual(['docs', 'docs_fts'])
  })

  it('still hides the internal table SQLite creates for an autoincrement column', () => {
    // CAPTURE: `sqlite_sequence` is created by SQLite itself the first time an AUTOINCREMENT table is defined; its presence here is observed, not asserted from the pattern. This is the one thing `sqlite_%` genuinely exists to exclude, so it is the calibration for the two tests above.
    create('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);')

    expect(getSqliteTables(dbPath).map((t) => t.name)).toEqual(['items'])
  })
})
