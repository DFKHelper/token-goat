/** Rows whose bm25 scores are equal come back in a fixed, useful order from the symbol and heading channels: a name that is a query term first, then the shorter name, then the shallower file, then file path and line. Driven through the real path: indexFileSync writes markdown headings and a TypeScript file into the isolated global index and searchSymbolsFtsByKind (the function both channels call) reads them. Provenance: HAND-DERIVED. Each case builds rows with the same indexed token count and the same number of hits, so their bm25 scores are equal by construction, which every case asserts against the FTS table instead of assuming; the expected order follows from the tiebreak rule, with the row an unordered query would return first (earlier line or earlier-indexed file) placed last so the rule has to move it. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs, getReadDb } from '../src/db.js'
import { sanitizeFtsQuery } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { searchSymbolsFtsByKind, type SymbolKindFilter } from '../src/search/symbol_fts.js'

const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const HEADINGS: SymbolKindFilter = { equals: 'heading' }
const CODE: SymbolKindFilter = { notEquals: 'heading' }

// gz comes first in the file and holds the term twice in its body; gizmo holds it once in its name and once in its body: seven indexed tokens and two hits each.
const TWO_CODE_ROWS = 'export function gz() {\n  return gizmo(gizmo)\n}\nexport function gizmo(): number {\n  return 1\n}\n'

/** Writes the files in the given order, indexes them in that order and returns the project root. */
function project(files: Record<string, string>): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-tie-')))
  dirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), content)
    indexFileSync(path.join(root, rel), globalDbPath())
  }
  return root
}

function found(root: string, query: string, kind: SymbolKindFilter = HEADINGS): { name: string; file: string; line: number }[] {
  return searchSymbolsFtsByKind(query, 10, globalDbPath(), root, kind).map((h) => ({ name: h.name, file: path.relative(root, h.filePath).replace(/\\/g, '/'), line: h.lineStart }))
}

/** Asserts the rows under `root` that match `query` all share one bm25 score, so only the tiebreak can order them. */
function expectAllTied(root: string, query: string, expectedRows: number, kindClause = "s.kind = 'heading'"): void {
  const rows = getReadDb(globalDbPath())
    .prepare(`SELECT bm25(symbols_fts) AS score FROM symbols_fts JOIN symbols s ON s.id = symbols_fts.rowid WHERE symbols_fts MATCH ? AND ${kindClause} AND s.file_path LIKE ?`)
    .all(sanitizeFtsQuery(query, 'AND'), `${root.replace(/\\/g, '/')}%`) as { score: number }[]
  expect(rows, `rows matching "${query}" under the fixture`).toHaveLength(expectedRows)
  expect(new Set(rows.map((r) => r.score)).size, 'all rows must share one bm25 score').toBe(1)
}

describe('symbol and heading channel tiebreaks', () => {
  it('puts a name equal to a query term before an equally scored name that only contains it', () => {
    const root = project({ 'a.ts': TWO_CODE_ROWS })
    expectAllTied(root, 'gizmo', 2, "s.kind != 'heading'")
    expect(found(root, 'gizmo', CODE).map((h) => h.name)).toEqual(['gizmo', 'gz'])
  })

  it('puts the shorter name first among equally scored names', () => {
    const root = project({ 'a.md': '## Gizmo abcdefgh\n\nz\n\n## Gizmo ab\n\nz\n' })
    expectAllTied(root, 'gizmo', 2)
    expect(found(root, 'gizmo').map((h) => h.name)).toEqual(['Gizmo ab', 'Gizmo abcdefgh'])
  })

  it('puts the shallower file first even when the deeper path sorts earlier alphabetically', () => {
    const root = project({ 'deep/er/z.md': '## Gizmo kit\n\nz\n', 'z.md': '## Gizmo kit\n\nz\n' })
    expectAllTied(root, 'gizmo', 2)
    expect(found(root, 'gizmo').map((h) => h.file)).toEqual(['z.md', 'deep/er/z.md'])
  })

  it('orders identical rows by file path, then by line, whatever order they were indexed in', () => {
    const body = '## Gizmo kit\n\nz\n\n## Gizmo kit\n\nz\n'
    const root = project({ 'b.md': body, 'a.md': body })
    expectAllTied(root, 'gizmo', 4)
    expect(found(root, 'gizmo').map((h) => `${h.file}:${h.line}`)).toEqual(['a.md:1', 'a.md:5', 'b.md:1', 'b.md:5'])
  })

  for (const [label, query] of [['a trailing comma', 'gizmo,'], ['double quotes', '"gizmo"'], ['parentheses', '(gizmo)']] as const) {
    it(`still puts the exact name first when the query term carries ${label}`, () => {
      const root = project({ 'a.ts': TWO_CODE_ROWS })
      expectAllTied(root, 'gizmo', 2, "s.kind != 'heading'")
      expect(found(root, query, CODE).map((h) => h.name)).toEqual(['gizmo', 'gz'])
    })
  }

  // The names are École and gz: gz is the shorter name, so only the exact-name key can put École first.
  it('folds non-ASCII case the same way on the query and the name', () => {
    const root = project({ 'a.ts': TWO_CODE_ROWS.replaceAll('gizmo', 'École') })
    expectAllTied(root, 'école', 2, "s.kind != 'heading'")
    expect(found(root, 'école', CODE).map((h) => h.name)).toEqual(['École', 'gz'])
  })

  it('matches a name case-insensitively and through the any-term fallback', () => {
    const root = project({ 'a.ts': TWO_CODE_ROWS.replace('function gizmo', 'function GIZMO') })
    expect(found(root, 'gizmo nothingmatchesthis', CODE).map((h) => h.name)).toEqual(['GIZMO', 'gz'])
  })
})
