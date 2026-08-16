import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildTopSymbolsSql } from '../src/baseline.js'
import { getDb } from '../src/db.js'
import { projectScopeClause, projectScopeIndex } from '../src/sql_path.js'
import { isCaseInsensitiveFs } from '../src/util.js'

// Regression: `map --compact` spent 1754ms of its 2330ms in one subquery. The refs aggregate is
// `SELECT name, COUNT(*) FROM refs WHERE <project scope> GROUP BY name`, and with no ANALYZE
// statistics SQLite prefers idx_refs_name -- because grouping by an indexed column makes GROUP BY
// sort-free -- over the far more selective path filter. On a global index shared by every project
// that means scanning all 751731 ref rows to keep 7918. Pinning the path index with INDEXED BY
// scans only this project's rows: 1754ms to 155ms, identical rows. This is invisible to a
// correctness test, so the query plan itself is the assertion. It runs against the string
// production actually prepares, not a copy -- a copy would stay green through a real regression.
describe('fetchTopSymbols query plan', () => {
  function tmpDbPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-plan-')), 'x.db')
  }

  function planOfShippingSql(): string {
    const db = getDb(tmpDbPath())
    const { param } = projectScopeClause('file_path')
    const rows = db
      .prepare(`EXPLAIN QUERY PLAN ${buildTopSymbolsSql()}`)
      .all(param('C:/proj'), param('C:/proj'), 40) as Array<{ detail: string }>
    return rows.map((r) => r.detail).join(' | ')
  }

  it('scans refs by the project-path index, never by the name index', () => {
    const detail = planOfShippingSql()
    expect(detail).toMatch(new RegExp(`refs USING (COVERING )?INDEX ${projectScopeIndex('refs')}`))
    expect(detail).not.toMatch(/refs USING (COVERING )?INDEX idx_refs_name/)
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

  it('pins an index that the schema always creates, so the plan cannot fail at runtime', () => {
    // INDEXED BY is a hard requirement, not a hint: naming an absent index makes prepare() throw.
    // Both candidates are created unconditionally by db.ts's schema on every connection open, so
    // a freshly created DB must already satisfy it -- that is exactly what preparing here proves.
    const db = getDb(tmpDbPath())
    expect(() => db.prepare(buildTopSymbolsSql())).not.toThrow()
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='refs'").all() as Array<{ name: string }>).map((r) => r.name)
    expect(names).toContain(projectScopeIndex('refs'))
  })

  it('picks the index whose stored expression matches the scope clause it is paired with', () => {
    // The folded index stores TG_LOWER(file_path) and only matches the case-insensitive clause;
    // the plain index only matches the other. Pairing them the wrong way round would still run,
    // just without the selectivity, so assert the pairing rather than trusting it.
    const folded = isCaseInsensitiveFs()
    expect(projectScopeIndex('refs')).toBe(folded ? 'idx_refs_file_folded' : 'idx_refs_file')
    expect(projectScopeIndex('symbols')).toBe(folded ? 'idx_symbols_file_folded' : 'idx_symbols_file')
    expect(projectScopeClause('file_path').clause.includes('TG_LOWER')).toBe(folded)
  })
})
