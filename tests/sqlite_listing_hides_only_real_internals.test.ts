/**
 * Regression: the table filters in `sqlite-tables` and `sqlite-schema` must hide SQLite's own internals, not user tables that merely resemble them.
 *
 * Both queries excluded objects with `name NOT LIKE 'sqlite_%'` and friends, and `_` is LIKE's single-character wildcard. Nothing made it literal, so each `_` matched any character and the filters were far wider than they read. Measured against the built binary on a database of four user tables, `sqlite-tables` listed ONE of them: `sqlitedata` was eaten by `sqlite_%` (the `_` matched `d`) and `my_ftsx_cache` by `%_fts_%` (the `_` after `fts` matched `x`). `sqlite-schema` hid `sqlitedata` the same way.
 *
 * This is a discovery command, which is what makes it worth a test: a table missing from the inventory does not read as a filter being too broad, it reads as the table not existing, and the caller's next query is written as though it does not.
 *
 * The fix adds `ESCAPE '\'` to each pattern. Both directions are driven here, because widening the filter is the obvious wrong fix: the real FTS5 shadow tables must still be absent, or an inventory meant to fit in ~50 tokens grows five rows of machinery per indexed table.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Database from '../src/sqlite_driver.js'
import { getSqliteSchema, getSqliteTables } from '../src/sqlite_query.js'

describe('the internals filter reads `_` as a character, not as a wildcard', () => {
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

  // HAND-DERIVED: names chosen to sit one character away from each filter pattern. `sqlitedata` differs from the `sqlite_` prefix only in that the seventh character is a letter rather than an underscore, and `my_ftsx_cache` likewise for `_fts_`. Neither is anything SQLite, FTS5, or sqlite-vec creates.
  const DECOYS = 'CREATE TABLE sqlitedata (id INTEGER); CREATE TABLE plain (id INTEGER); CREATE TABLE my_ftsx_cache (id INTEGER);'

  it('lists a user table whose name only resembles an internal one', () => {
    create(DECOYS)

    const names = getSqliteTables(dbPath).map((t) => t.name)

    // Pre-fix this returned ['plain'] alone.
    expect(names).toEqual(['my_ftsx_cache', 'plain', 'sqlitedata'])
  })

  it('describes that table in the schema view too', () => {
    // The same defect at a second call site, which had only the `sqlite_%` pattern and so lost one table rather than two.
    create(DECOYS)

    expect(getSqliteSchema(dbPath).tables.map((t) => t.name)).toContain('sqlitedata')
  })

  it('still hides the shadow tables FTS5 creates beside a virtual table', () => {
    // CAPTURE: the five shadow names are the real output of `SELECT name FROM sqlite_master` against a database built by exactly the two statements below, on this repo's own sqlite build -- not read off the filter they must defeat. Without this, the cheapest fix (drop the patterns) passes every assertion above while adding five rows of machinery to the inventory for each indexed table.
    create('CREATE TABLE docs (id INTEGER, body TEXT); CREATE VIRTUAL TABLE docs_fts USING fts5(body);')

    const names = getSqliteTables(dbPath).map((t) => t.name)

    for (const shadow of ['docs_fts_config', 'docs_fts_content', 'docs_fts_data', 'docs_fts_docsize', 'docs_fts_idx']) {
      expect(names).not.toContain(shadow)
    }
    // The virtual table itself is queryable and stays listed, along with the ordinary table; hiding it would be the same defect pointing the other way.
    expect(names).toEqual(['docs', 'docs_fts'])
  })

  it('still hides the internal table SQLite creates for an autoincrement column', () => {
    // CAPTURE: `sqlite_sequence` is created by SQLite itself the first time an AUTOINCREMENT table is defined; its presence here is observed, not asserted from the pattern. This is the one thing `sqlite_%` genuinely exists to exclude, so it is the calibration for the two tests above.
    create('CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);')

    expect(getSqliteTables(dbPath).map((t) => t.name)).toEqual(['items'])
  })
})
