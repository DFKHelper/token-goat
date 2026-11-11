/** S4 guard (gap_analysis_pass3.md section 4, finding 9): every `idx_<table>_file` / `idx_<table>_file_folded` index pair exists because pathEqClause() (sql_path.ts) emits ONE of two SQL shapes for a path-equality lookup depending on isCaseInsensitiveFs() -- `TG_LOWER(col) = ?` on win32/darwin, plain `col = ?` on Linux. Each platform's real query traffic only ever issues one shape, so the OTHER member of every pair is genuinely dead weight FOR THAT PLATFORM -- but it is not dead everywhere: dropping either half would break every query on whichever platform relies on it. This guard proves BOTH forms are still real, indexed, planner-chosen paths (never let one bit-rot into a forgotten expression neither mode reaches), across every pair the schema currently declares -- not a hand-picked list, so a fourth `idx_*_file` pair added later is covered automatically instead of silently falling outside this guard's population. This needs a real SQLite connection and a real EXPLAIN QUERY PLAN, so it cannot be I/O-free -- it intentionally does NOT live under tests/guards (vitest run tests/guards is the pre-commit tier; see run-guards.sh) and instead rides the full `npm test` pre-push/CI tier (run-test.sh), per the standing rule that a guard needing a real query plan belongs on pre-push, not pre-commit. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { getDb, closeAllDbs } = await import('../src/db.js')
const { pathEqClause } = await import('../src/sql_path.js')
const { foldPath } = await import('../src/util.js')

let TMP: string
let dbPath: string
const prevCaseEnv = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-db-index-platform-'))
  dbPath = path.join(TMP, 'index.db')
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevCaseEnv === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
  else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevCaseEnv
})

/** Every idx_<table>_file / idx_<table>_file_folded pair the live schema currently declares, discovered from sqlite_master itself rather than hand-listed -- so a pair added or removed later changes this guard's population automatically instead of silently falling outside it. Deliberately does NOT skip a plain `idx_*_file` index that lacks a folded sibling: that would be exactly the "silently-emptied enumeration passes forever" failure this guard exists to prevent (dropping the chunks pair here once made the two EXPLAIN QUERY PLAN tests below check only the surviving pairs and report green while the actual regression -- a missing folded index -- went unasserted). A missing sibling is itself the guarded-against defect, so it throws. */
function discoverFileIndexPairs(): { table: string; plainIndex: string; foldedIndex: string }[] {
  const db = getDb(dbPath)
  const rows = db
    .prepare(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%_file'`)
    .all() as { name: string; tbl_name: string }[]
  return rows.map((r) => {
    const foldedName = `${r.name}_folded`
    const foldedExists = (
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(foldedName) as
        | { 1: number }
        | undefined
    ) !== undefined
    if (!foldedExists) {
      throw new Error(
        `${r.name} (on table ${r.tbl_name}) has no folded sibling ${foldedName} -- either it was ` +
          `never meant to be a pair (rename it out of the idx_*_file naming shape) or the folded ` +
          `index was dropped, which would break every path-equality query on a case-insensitive ` +
          `filesystem (win32/darwin).`,
      )
    }
    return { table: r.tbl_name, plainIndex: r.name, foldedIndex: foldedName }
  })
}

// A plain substring check (`.includes(indexName)`) is unsound here: `idx_symbols_file` is itself a substring of `idx_symbols_file_folded`, so a query that actually used the FOLDED index would still read as a false positive for the plain index's name. Regex `\b` word boundaries are ALSO unsound for the same reason: `_` counts as a word character, so there is no boundary between `file` and `_folded` either. Only a negative lookaround for another identifier character (letter/digit/underscore) on both sides correctly rejects `idx_symbols_file` matching inside `idx_symbols_file_folded` while still matching a bare, complete occurrence of the name.
function explainUsesIndex(sql: string, params: unknown[], indexName: string): boolean {
  const db = getDb(dbPath)
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]
  const re = new RegExp(`(?<![A-Za-z0-9_])${indexName}(?![A-Za-z0-9_])`)
  return rows.some((r) => re.test(r.detail))
}

/** The first key of an index as declared in sqlite_master, e.g. `TG_LOWER(file_path)` for idx_symbols_file_folded and for every composite that starts with it. Provenance: FORMAT-DERIVED from the CREATE INDEX text SQLite stores in sqlite_master (https://www.sqlite.org/schematab.html), read with the same db the planner queries. */
function leadingKey(indexName: string): string {
  const db = getDb(dbPath)
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`).get(indexName) as { sql: string } | undefined
  const key = row?.sql.match(/\bON\s+\w+\s*\(\s*(.+?)\s*(?:,|\)\s*(?:WHERE\b.*)?$)/is)?.[1]
  expect(key, `could not read the first key of ${indexName} from sqlite_master`).toBeTruthy()
  return key!
}

/** True when a path-equality query on `table` is served by `declaredIndex`: the planner picks it, or the planner picks a wider index on the same table that STARTS with the same first key (symbols carries idx_symbols_call_graph_scope and idx_symbols_call_graph_enclosing, db.ts, which share idx_symbols_file_folded's first key, so the planner is free to prefer either) AND `declaredIndex` itself still accepts the query when pinned with INDEXED BY, which SQLite refuses ("no query solution") for an index that cannot serve the clause. A path that matches neither (a scan, or an index on another key) is not served. */
function pathLookupServedBy(table: string, clause: string, value: string, declaredIndex: string): boolean {
  const sql = `SELECT * FROM ${table} WHERE ${clause}`
  if (explainUsesIndex(sql, [value], declaredIndex)) return true
  const db = getDb(dbPath)
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(value) as { detail: string }[]
  const chosen = plan.map((r) => r.detail.match(/USING (?:COVERING )?INDEX (\w+)/)?.[1]).find((n): n is string => n !== undefined)
  if (chosen === undefined || leadingKey(chosen) !== leadingKey(declaredIndex)) return false
  return explainUsesIndex(`SELECT * FROM ${table} INDEXED BY ${declaredIndex} WHERE ${clause}`, [value], declaredIndex)
}

describe('idx_*_file / idx_*_file_folded pairs stay real, planner-chosen paths on both platform shapes', () => {
  it('discovers at least one file-path index pair (population-emptiness guard: a silently-emptied population would make every assertion below vacuously pass)', () => {
    const pairs = discoverFileIndexPairs()
    expect(pairs.length).toBeGreaterThan(0)
  })

  it('every discovered pair: case-sensitive-shaped query plan uses the PLAIN index (the Linux-issued query shape)', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '0'
    const pairs = discoverFileIndexPairs()
    for (const { table, plainIndex } of pairs) {
      const clause = pathEqClause('file_path')
      const value = foldPath('src/example.ts')
      const used = pathLookupServedBy(table, clause, value, plainIndex)
      expect(used, `expected ${table}'s case-sensitive query to use ${plainIndex}`).toBe(true)
    }
  })

  it('every discovered pair: case-insensitive-shaped query plan uses the FOLDED index (the win32/darwin-issued query shape)', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const pairs = discoverFileIndexPairs()
    for (const { table, foldedIndex } of pairs) {
      const clause = pathEqClause('file_path')
      const value = foldPath('src/example.ts')
      const used = pathLookupServedBy(table, clause, value, foldedIndex)
      expect(used, `expected ${table}'s case-insensitive query to use ${foldedIndex}`).toBe(true)
    }
  })
})
