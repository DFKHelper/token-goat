/** Work per page of the full-scope symbol walk behind `find`, `locate` and a filtered `symbol` (`--grep`, `--exclude-tests`, `--exclude-vendored`). The walk used to page `querySymbols` by `OFFSET`. Its `ORDER BY file_path, line_start, rowid` is not the order of any index (the path index is on the folded path), so every page sorted every row in scope, bodies included, before skipping to its offset: on the 546,394-symbol aws-cdk index the 55 pages grew from 1.2 s to 5.2 s each, and `find` took 165.6 s, `locate` 167.7 s and `symbol --grep` 194.7 s. Nothing caught it because tests/symbol_scan_beyond_one_page.test.ts checks that the walk reaches every row, which the slow walk did, and wall clock never enters CI. These tests pin what each page asks SQLite to do instead: an index seek with no sort, no `OFFSET`, no body read, and a resumed page that starts at the previous page's last key rather than at the start of the project. Fixture provenance: HAND-DERIVED. The rows are generated below, and the expected counts and names follow from them; the plan lines are SQLite's own EXPLAIN QUERY PLAN output for the statements the walk actually ran, with the arguments it actually bound. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { runFind, runLocate } from '../src/read_inspect.js'
import { runSymbol } from '../src/read_symbol.js'
import { forEachSymbol } from '../src/symbol_scan.js'
import { instrumentSymbolReads, queryPlan, type SymbolRun, type SymbolWork } from './helpers/symbol_work.js'

/** Past two full 10,000-row pages, so the walk runs three page statements and two of them resume. */
const FILLER_ROWS = 25_000
const PAGE = 10_000

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = normalizePath(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-scan-work-')))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  const db = getDb(globalDbPath())
  const insert = db.prepare('INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < FILLER_ROWS; i++) {
      const line = (i % 10) * 3 + 1
      insert.run(`${root}/aaa_filler_${String(Math.floor(i / 10)).padStart(5, '0')}.ts`, `fillerSymbol${i}`, 'function', line, line + 1, `function fillerSymbol${i}() {}`, '')
    }
    insert.run(`${root}/zzz_target.ts`, 'quokkaLandmark', 'function', 1, 3, 'function quokkaLandmark() {}', '')
  })()
})

afterEach(() => {
  cwdSpy.mockRestore()
  getDb(globalDbPath()).prepare('DELETE FROM symbols WHERE file_path >= ? AND file_path < ?').run(`${root}/`, `${root}0`)
  fs.rmSync(root, { recursive: true, force: true })
})

function measured<T>(fn: () => T): { result: T; work: SymbolWork } {
  const { work, restore } = instrumentSymbolReads()
  try {
    return { result: fn(), work }
  } finally {
    restore()
  }
}

/** The page statements of a walk: the ones that select a scan's columns across the project rather than look up a known set of rows. */
function pageRuns(work: SymbolWork): SymbolRun[] {
  return work.runs.filter((r) => /\bORDER BY\b/i.test(r.sql))
}

/** Every page is one seek on the file-path index (`idx_symbols_file_folded` on a case-insensitive filesystem, `idx_symbols_file` elsewhere) with no sort, reads no body, skips nothing by `OFFSET`, and a resumed page has the previous page's last key as its only lower bound. */
function expectFlatPages(runs: SymbolRun[]): void {
  expect(runs.length).toBeGreaterThan(0)
  runs.forEach((run, i) => {
    const plan = queryPlan(run)
    expect(plan.some((line) => /\bUSING (?:COVERING )?INDEX idx_symbols_file(?:_folded)? \(/.test(line)), `page ${i}: ${plan.join(' | ')}`).toBe(true)
    expect(plan.filter((line) => /TEMP B-TREE/.test(line)), `page ${i}`).toEqual([])
    expect(run.sql, `page ${i}`).not.toMatch(/\bOFFSET\b/i)
    expect(run.sql.split(/\bFROM\b/i)[0], `page ${i}`).not.toMatch(/\bbody\b/i)
    expect(run.rows, `page ${i}`).toBeLessThanOrEqual(PAGE)
    if (i > 0) expect(run.sql.match(/>= \?/g), `page ${i}: ${run.sql}`).toHaveLength(1)
  })
}

describe('full-scope symbol walk', () => {
  it('reads a project in index-seek pages that do the same work at every page index', () => {
    let visited = 0
    const { work } = measured(() => forEachSymbol({ rootDir: root }, () => { visited++ }))
    expect(visited).toBe(FILLER_ROWS + 1)
    const pages = pageRuns(work)
    expect(pages.map((p) => p.rows)).toEqual([PAGE, PAGE, FILLER_ROWS + 1 - 2 * PAGE])
    expectFlatPages(pages)
    expect(work.bodyRows).toBe(0)
  })

  it('find walks the project the same way and reads no body', () => {
    const { result, work } = measured(() => runFind({ pattern: 'quokkaLandmark', json: true }))
    expect(result).toBe(0)
    expectFlatPages(pageRuns(work))
    expect(work.bodyRows).toBe(0)
  })

  it('locate walks the project the same way and reads no body', () => {
    const { result, work } = measured(() => runLocate({ spec: 'quokkaLandmark', json: true }))
    expect(result).toBe(0)
    expectFlatPages(pageRuns(work))
    expect(work.bodyRows).toBe(0)
  })

  it('symbol --grep walks the project the same way and reads a body only for each row it prints', () => {
    // HAND-DERIVED: fillerSymbol12340 to fillerSymbol12349 are the ten names the pattern matches.
    const { result, work } = measured(() => runSymbol({ grep: '^fillerSymbol1234\\d$', projectRoot: root, json: true }))
    expect(result.code).toBe(0)
    const payload = JSON.parse(result.text) as { items: Array<{ name: string }>; totalCount: number }
    expect(payload.items.map((s) => s.name)).toEqual(Array.from({ length: 10 }, (_, i) => `fillerSymbol1234${i}`))
    expectFlatPages(pageRuns(work))
    expect(work.bodyRows).toBe(10)
  })
})
