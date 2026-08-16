import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTopSymbolsSql } from '../src/baseline.js'
import { getDb } from '../src/db.js'
import { projectScopeClause } from '../src/sql_path.js'
import { isCaseInsensitiveFs } from '../src/util.js'

// Regression: `map --compact` spent nearly all of its time in two project-scope filters. Both were
// `<path> LIKE ? ESCAPE '\'`, and SQLite disables its LIKE-to-range optimization outright whenever
// an ESCAPE clause is present -- so neither filter could be served from an index and both scanned
// every row in the machine-wide index before filtering. Writing the prefix test as a half-open
// range instead lets the planner search the path index directly. This is invisible to a
// correctness test, so the query plan itself is the assertion. It runs against the string
// production actually prepares, not a copy -- a copy would stay green through a real regression.
describe('fetchTopSymbols query plan', () => {
  function tmpDbPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plan-')), 'x.db')
  }

  /** The path index each table's scope filter must be served from, per the case-folding split. */
  function pathIndex(table: string): string {
    return isCaseInsensitiveFs() ? `idx_${table}_file_folded` : `idx_${table}_file`
  }

  function planOfShippingSql(): string {
    const db = getDb(tmpDbPath())
    const bounds = projectScopeClause('file_path').params('C:/proj')
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${buildTopSymbolsSql()}`)
      .all(...bounds, ...bounds, 40) as Array<{ detail: string }>
    return rows.map((r) => r.detail).join(' | ')
  }

  it('searches refs by the project-path index, never scanning refs or the name index', () => {
    const detail = planOfShippingSql()
    expect(detail).toMatch(new RegExp(`SEARCH refs USING (COVERING )?INDEX ${pathIndex('refs')}`))
    expect(detail).not.toMatch(/refs USING (COVERING )?INDEX idx_refs_name/)
    expect(detail).not.toMatch(/SCAN refs\b/)
  })

  it('searches symbols by the project-path index rather than scanning the whole table', () => {
    // The symbols side had the same defect and no INDEXED BY override ever covered it: on a global
    // index shared by every project it scanned every symbol row to keep this project's few thousand.
    const detail = planOfShippingSql()
    expect(detail).toMatch(new RegExp(`SEARCH symbols USING (COVERING )?INDEX ${pathIndex('symbols')}`))
    expect(detail).not.toMatch(/SCAN symbols\b/)
  })

  it('never carries symbol bodies through the ranking window functions', () => {
    // The other half of the fix: `body` is fetched by a rowid join after LIMIT, so the window
    // functions sort on body_len alone. If `s.body` reappears inside the ranking subquery, SQLite
    // materializes every symbol's full text (up to boundSymbolBody's 131072 chars) before LIMIT
    // discards nearly all of it. The rowid join is what keeps that out.
    const sql = buildTopSymbolsSql()
    // The ranking is the derived table aliased `top`; the outer projection that legitimately
    // selects s.body sits textually before it, so slice between its delimiters rather than at the join.
    const ranking = sql.slice(sql.indexOf('FROM (') + 'FROM ('.length, sql.indexOf(') top'))
    // Computing the length reads the column, which is unavoidable; projecting it is the defect.
    // So the only mention of `body` allowed above the join is inside that LENGTH() call.
    const withoutLengthCalls = ranking.replaceAll("LENGTH(COALESCE(body, ''))", 'LEN')
    expect(withoutLengthCalls).not.toMatch(/\bbody\b/)
    expect(sql).toMatch(/JOIN symbols s ON s\.rowid = top\.rid/)
  })

  it('leans on indexes the schema always creates, so the plan cannot fail at runtime', () => {
    // The plan above is only reachable if both path indexes exist on a freshly opened DB. db.ts's
    // schema creates them unconditionally on every connection open; this proves it for a new file.
    const db = getDb(tmpDbPath())
    expect(() => db.prepare(buildTopSymbolsSql())).not.toThrow()
    for (const table of ['refs', 'symbols']) {
      const names = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?").all(table) as Array<{
          name: string
        }>
      ).map((r) => r.name)
      expect(names).toContain(pathIndex(table))
    }
  })

  it('pairs the scope clause with the index whose stored expression matches it', () => {
    // The folded index stores TG_LOWER(file_path) and can only serve the case-insensitive clause;
    // the plain index only serves the other. A mismatch would still run, just without an index.
    const folded = isCaseInsensitiveFs()
    expect(pathIndex('refs')).toBe(folded ? 'idx_refs_file_folded' : 'idx_refs_file')
    expect(projectScopeClause('file_path').clause.includes('TG_LOWER')).toBe(folded)
  })
})
