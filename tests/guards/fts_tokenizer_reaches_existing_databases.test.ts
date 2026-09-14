/**
 * Guard: a change to the FTS5 tokenizer must reach databases that already exist, not only ones created after it.
 *
 * `CREATE VIRTUAL TABLE IF NOT EXISTS ... tokenize='X'` sets the tokenizer exactly once, when the table is first created. Run it again against a table of that name with a different `tokenize=` argument and SQLite does nothing and says nothing -- measured: the stored declaration still reads `tokenize='unicode61'` after a second statement asking for `unicode61 remove_diacritics 2`. So the literal in FTS_SQL is not, on its own, a statement about what any given index actually uses.
 *
 * That made the original change inert twice over. `unicode61` is already FTS5's default, so naming it changed nothing for a new database either; measured across eight accent queries against a table declared `fts5(body)` and one declared `fts5(body, tokenize='unicode61')`, the two agreed on all eight. The release notes nevertheless described it as new support for accented European characters.
 *
 * Two tests, guarding the two halves:
 *  - the behavioral one, which is the point: a database stamped at the previous schema version and carrying the previous tokenizer must come out of `getDb` carrying the current one, with its rows searchable under it.
 *  - the tripwire, which catches the mistake this guard is named for: the tokenizer literal is pinned next to the schema version it shipped with, so moving the literal without bumping SCHEMA_VERSION (and adding the migration step that re-creates the tables) fails here rather than silently splitting users into two populations that search differently.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import Database from '../../src/sqlite_driver.js'
import { FTS_TOKENIZER, SCHEMA_VERSION, closeAllDbs, getDb } from '../../src/db.js'

/**
 * The tokenizer the shipping schema declares, and the schema version that declaration shipped at.
 *
 * FORMAT-DERIVED from FTS5's own tokenizer documentation (https://sqlite.org/fts5.html#unicode61_tokenizer): `remove_diacritics 2` folds diacritics that are encoded as separate combining codepoints, which `remove_diacritics 1` -- the default -- leaves alone.
 *
 * Changing the tokenizer means changing BOTH constants here and adding a MIGRATIONS step that drops, re-creates and rebuilds the tables. Bumping only the literal is the defect this guard exists for.
 */
const DECLARED_TOKENIZER = 'unicode61 remove_diacritics 2'
const TOKENIZER_SHIPPED_AT_VERSION = 14

describe('the declared FTS5 tokenizer is the one databases actually get', () => {
  let dir: string
  let dbPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fts-tokenizer-'))
    dbPath = path.join(dir, 'index.db')
  })

  afterEach(() => {
    closeAllDbs()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function storedTokenizer(conn: { prepare: (sql: string) => { get: () => unknown } }, table: string): string {
    const row = conn.prepare(`SELECT sql FROM sqlite_master WHERE name = '${table}'`).get() as { sql?: string } | undefined
    return /tokenize\s*=\s*'([^']*)'/.exec(row?.sql ?? '')?.[1] ?? ''
  }

  it('gives a brand-new database the declared tokenizer', () => {
    // Calibration for the migration test below: if this fails, the declaration itself is wrong and the migration result proves nothing.
    const db = getDb(dbPath)

    expect(storedTokenizer(db, 'symbols_fts')).toBe(DECLARED_TOKENIZER)
    expect(storedTokenizer(db, 'cache_recall_fts')).toBe(DECLARED_TOKENIZER)
  })

  it('re-creates an older database at the declared tokenizer instead of leaving it behind', () => {
    // Build a realistic pre-migration database: a real current one, then wind both FTS tables back to the previous declaration and re-stamp the version, which is exactly the state a user upgrading from the last release is in.
    const fresh = getDb(dbPath)
    fresh
      .prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, 1, 1, ?, ?)')
      .run('a.ts', 'hanoiCity', 'function', 'Hà Nội and Việt Nam', '')
    closeAllDbs()

    const raw = new Database(dbPath)
    raw.exec('DROP TABLE symbols_fts; DROP TABLE cache_recall_fts;')
    raw.exec("CREATE VIRTUAL TABLE symbols_fts USING fts5(name, body, docstring, content='symbols', content_rowid='id', tokenize='unicode61');")
    raw.exec("CREATE VIRTUAL TABLE cache_recall_fts USING fts5(label, content, content='cache_recall', content_rowid='row_id', tokenize='unicode61');")
    raw.exec("INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild');")
    raw.pragma(`user_version = ${TOKENIZER_SHIPPED_AT_VERSION - 1}`)
    // Calibration: the wound-back database really does fail the search, so a pass after reopening is the migration working and not the query being trivially satisfiable.
    expect((raw.prepare("SELECT count(*) c FROM symbols_fts WHERE symbols_fts MATCH 'Noi'").get() as { c: number }).c).toBe(0)
    raw.close()

    const migrated = getDb(dbPath)

    expect(storedTokenizer(migrated, 'symbols_fts')).toBe(DECLARED_TOKENIZER)
    expect(storedTokenizer(migrated, 'cache_recall_fts')).toBe(DECLARED_TOKENIZER)
    // The rows survive the drop (both tables are external-content) and are searchable under the new tokenizer. Asserting the declaration alone would pass on a table that was re-created but never rebuilt.
    const hits = migrated.prepare("SELECT count(*) c FROM symbols_fts WHERE symbols_fts MATCH 'Noi'").get() as { c: number }
    expect(hits.c).toBe(1)
  })

  it('pins the tokenizer to the schema version it shipped with', () => {
    // The tripwire. A tokenizer change reaches an existing database only through a MIGRATIONS step, and a step only runs when SCHEMA_VERSION moves past the version the database is stamped at. Changing the literal in FTS_SQL without that bump is silent: new databases get it, every existing one keeps what it has, and no error is raised anywhere. If this assertion is what failed, the fix is to bump SCHEMA_VERSION, register a migration that drops/re-creates/rebuilds both tables, and update both constants at the top of this file.
    expect(FTS_TOKENIZER).toBe(DECLARED_TOKENIZER)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(TOKENIZER_SHIPPED_AT_VERSION)
  })
})
