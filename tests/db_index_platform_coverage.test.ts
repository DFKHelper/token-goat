/**
 * S4 guard (gap_analysis_pass3.md section 4, finding 9): every `idx_<table>_file` /
 * `idx_<table>_file_folded` index pair exists because pathEqClause() (sql_path.ts) emits ONE of
 * two SQL shapes for a path-equality lookup depending on isCaseInsensitiveFs() -- `TG_LOWER(col)
 * = ?` on win32/darwin, plain `col = ?` on Linux. Each platform's real query traffic only ever
 * issues one shape, so the OTHER member of every pair is genuinely dead weight FOR THAT PLATFORM
 * -- but it is not dead everywhere: dropping either half would break every query on whichever
 * platform relies on it. This guard proves BOTH forms are still real, indexed, planner-chosen
 * paths (never let one bit-rot into a forgotten expression neither mode reaches), across every
 * pair the schema currently declares -- not a hand-picked list, so a fourth `idx_*_file` pair
 * added later is covered automatically instead of silently falling outside this guard's
 * population.
 *
 * This needs a real SQLite connection and a real EXPLAIN QUERY PLAN, so it cannot be I/O-free --
 * it intentionally does NOT live under tests/guards (vitest run tests/guards is the pre-commit
 * tier; see run-guards.sh) and instead rides the full `npm test` pre-push/CI tier (run-test.sh),
 * per the standing rule that a guard needing a real query plan belongs on pre-push, not pre-commit.
 */

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

/**
 * Every idx_<table>_file / idx_<table>_file_folded pair the live schema currently declares,
 * discovered from sqlite_master itself rather than hand-listed -- so a pair added or removed
 * later changes this guard's population automatically instead of silently falling outside it.
 *
 * Deliberately does NOT skip a plain `idx_*_file` index that lacks a folded sibling: that would
 * be exactly the "silently-emptied enumeration passes forever" failure this guard exists to
 * prevent (dropping the chunks pair here once made the two EXPLAIN QUERY PLAN tests below check
 * only the surviving pairs and report green while the actual regression -- a missing folded
 * index -- went unasserted). A missing sibling is itself the guarded-against defect, so it throws.
 */
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

// A plain substring check (`.includes(indexName)`) is unsound here: `idx_symbols_file` is itself
// a substring of `idx_symbols_file_folded`, so a query that actually used the FOLDED index would
// still read as a false positive for the plain index's name. Regex `\b` word boundaries are
// ALSO unsound for the same reason: `_` counts as a word character, so there is no boundary
// between `file` and `_folded` either. Only a negative lookaround for another identifier
// character (letter/digit/underscore) on both sides correctly rejects `idx_symbols_file` matching
// inside `idx_symbols_file_folded` while still matching a bare, complete occurrence of the name.
function explainUsesIndex(sql: string, params: unknown[], indexName: string): boolean {
  const db = getDb(dbPath)
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[]
  const re = new RegExp(`(?<![A-Za-z0-9_])${indexName}(?![A-Za-z0-9_])`)
  return rows.some((r) => re.test(r.detail))
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
      const used = explainUsesIndex(`SELECT * FROM ${table} WHERE ${clause}`, [value], plainIndex)
      expect(used, `expected ${table}'s case-sensitive query to use ${plainIndex}`).toBe(true)
    }
  })

  it('every discovered pair: case-insensitive-shaped query plan uses the FOLDED index (the win32/darwin-issued query shape)', () => {
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    const pairs = discoverFileIndexPairs()
    for (const { table, foldedIndex } of pairs) {
      const clause = pathEqClause('file_path')
      const value = foldPath('src/example.ts')
      const used = explainUsesIndex(`SELECT * FROM ${table} WHERE ${clause}`, [value], foldedIndex)
      expect(used, `expected ${table}'s case-insensitive query to use ${foldedIndex}`).toBe(true)
    }
  })
})
