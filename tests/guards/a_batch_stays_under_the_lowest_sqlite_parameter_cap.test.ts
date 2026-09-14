import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { getDb } from '../../src/db.js'
import { projectScopeClause } from '../../src/sql_path.js'

function tmpDbPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-batchcap-')), 'index.db')
}

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

// The cap SQLite compiled in before 3.32, and the lowest value any build this ships against is likely to carry. It is a literal here and not an import, because the point of the test is that the code's own number is small enough -- reading the same constant on both sides would assert nothing. PROVENANCE: FORMAT-DERIVED from sqlite.org/limits.html, "Maximum Number Of Host Parameters In A Single SQL Statement": the default was 999 through 3.31 and 32,766 from 3.32.
const PRE_3_32_DEFAULT_CAP = 999

/** Every `IN (?,?,...)` list whose width a caller chooses, as a source literal and the SQL that carries it. */
const BATCHED_WIDTHS = [{ file: 'index_reader.ts', constant: 'REF_COUNT_BATCH', extraParams: 2, why: 'the project-root scope adds a lower and an upper bound' }]

/** The lines of `src` with block comments blanked and line comments cut, so a guard counting identifier uses counts code and not the prose describing it. Blanking rather than deleting keeps line numbering intact for anything that reports a position. */
function codeLines(src: string): string[] {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
}

function sourceLiteral(file: string, constant: string): number {
  const src = fs.readFileSync(path.join(SRC, file), 'utf8')
  const match = new RegExp(`const ${constant} = ([0-9_]+)`).exec(src)
  expect(match, `${constant} is no longer declared as a plain numeric literal in ${file}, so this guard cannot read it`).not.toBeNull()
  return Number((match as RegExpExecArray)[1]?.replaceAll('_', ''))
}

describe('a batch stays under the lowest SQLite parameter cap', () => {
  it.each(BATCHED_WIDTHS)('$constant plus its scope parameters fits the pre-3.32 default', ({ file, constant, extraParams }) => {
    const width = sourceLiteral(file, constant)
    expect(width, `${constant} is not a positive width`).toBeGreaterThan(0)
    expect(width + extraParams, `${constant} + ${String(extraParams)} scope parameters is past the ${String(PRE_3_32_DEFAULT_CAP)} a pre-3.32 SQLite compiles in, so this query throws "too many SQL variables" on such a build and returns nothing at all`).toBeLessThanOrEqual(PRE_3_32_DEFAULT_CAP)
  })

  it.each(BATCHED_WIDTHS)('$constant is actually read by the query it bounds, not just declared beside it', ({ file, constant }) => {
    // Arithmetic on a number the query never consults is arithmetic about nothing: the width could be 900 and the statement still built over every name at once. Counting raw occurrences was not enough -- the declaration's own doc comment names the constant, so prose alone satisfied the floor and a guard that proves only "this identifier is mentioned twice" proves nothing. Code lines only, declaration excluded. That it is used *correctly* is what the over-the-cap regression test in tests/index_reader.test.ts proves, by asking for more names than this build will bind and expecting an answer rather than a throw.
    const src = fs.readFileSync(path.join(SRC, file), 'utf8')
    const uses = codeLines(src).filter((line) => line.includes(constant) && !new RegExp(`const ${constant}\\b`).test(line)).length
    expect(uses, `${constant} is mentioned in ${file} but never read by a line of code outside its own declaration, so nothing is bounded by it`).toBeGreaterThan(0)
  })

  it('the project-root scope really does add the two parameters the widths budget for', () => {
    // If the scope ever grows a third bound, every width above is budgeted one short and the guard has to be told. Counting the placeholders in the clause is what notices.
    const { clause, params } = projectScopeClause('file_path')
    expect(clause.split('?').length - 1).toBe(2)
    expect(params('c:/rootA')).toHaveLength(2)
  })

  it('this build refuses a statement wider than its own cap, which is why a width is needed at all', () => {
    // Calibration: without this, every assertion above could be protecting against nothing. The build's real cap is found by binding a growing list until it throws, so the test measures the limit rather than restating the number the source comment claims.
    const db = getDb(tmpDbPath())
    const prepareWidth = (n: number): string | null => {
      try {
        db.prepare(`SELECT name FROM refs WHERE name IN (${Array.from({ length: n }, () => '?').join(', ')})`)
        return null
      } catch (e) {
        return e instanceof Error ? e.message : String(e)
      }
    }
    expect(prepareWidth(PRE_3_32_DEFAULT_CAP), 'this build cannot even prepare the width the guard treats as always-safe').toBeNull()
    let cap = PRE_3_32_DEFAULT_CAP
    while (cap < 1_000_000 && prepareWidth(cap * 2) === null) cap *= 2
    const failed = prepareWidth(cap * 2)
    expect(failed, 'no width up to a million placeholders was refused, so there is no cap here to stay under and this guard proves nothing').not.toBeNull()
    expect(failed).toMatch(/too many SQL variables/)
  })
})
