/**
 * Guard: every cache type a production writer persists into `cache_recall` must be a member of
 * `VALID_TYPES`, so the recall queries' row cap can never discard a wanted row.
 *
 * The recall search path (src/recall_index.ts) applies its cap and its type predicate on opposite
 * sides of the SQL boundary. `ftsSearch`, `likeSearch` and `listRecentRecall` each end in
 * `... LIMIT ?`, and only then does `mapRowsToHits` run the rows through `isRecallCacheType`. Cap
 * first, filter second is the shape that silently returns fewer rows than asked for, because the
 * rows the filter removes were already counted against the cap and the rows past the cap were never
 * fetched to replace them. `token-goat recall` compounds it: `runRecallCommand` asks for
 * `limit + 1` rows purely so it can tell the reader "more are available", so a single dropped row
 * both shortens the listing and suppresses the notice that the listing is short.
 *
 * That loss is unreachable today for one reason only: the filter has nothing to reject. There are
 * exactly three production writers -- `storeBashOutputSync`, `storeWebOutput`, `storeMcpOutput` --
 * and each passes a string literal that is already a `VALID_TYPES` member, so every row in the
 * table answers `isRecallCacheType` true and `mapRowsToHits` is a pass-through. The invariant is
 * what makes the query correct, not the query's own ordering.
 *
 * This guard pins that invariant at the writers rather than rearranging the query. Constraining the
 * writer set prevents the whole class: no persisted row can ever be unrepresentable, so cap-then-
 * filter stays equivalent to filter-then-cap for every query on this table, present and future.
 * Moving the predicate into SQL would fix the three queries that exist and leave the fourth one
 * somebody adds next year exposed, and applying the cap after the filter would mean over-fetching
 * an unbounded number of rows to fill it. `cache_type` is a plain `TEXT NOT NULL` column with no
 * CHECK constraint (see SCHEMA_SQL in src/db.ts), so nothing below this level enforces it either.
 *
 * What this cannot catch: a writer that reaches the table through raw SQL instead of
 * `indexRecallEntry`, and a value passed as a variable rather than a literal. Both are failed
 * explicitly below rather than skipped, so the guard cannot be defeated by changing call shape.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { isRecallCacheType } from '../../src/recall_index.js'
import { pinnedPopulation } from './population.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..', '..', 'src')

/** The writer this guard tracks. A raw INSERT that bypasses it is caught separately below. */
const WRITER = 'indexRecallEntry'

function srcFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) srcFiles(full, acc)
    else if (entry.name.endsWith('.ts')) acc.push(full)
  }
  return acc
}

type Call = { file: string; line: number; literal: string | null }

const FILES = srcFiles(SRC).map((abs) => ({ abs, rel: path.relative(path.dirname(SRC), abs).split(path.sep).join('/') }))

const CALLS: Call[] = []
for (const f of FILES) {
  const source = readFileSync(f.abs, 'utf8')
  if (!source.includes(WRITER)) continue
  const sf = ts.createSourceFile(f.abs, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const visit = (node: ts.Node): void => {
    // The declaration itself is a FunctionDeclaration, not a CallExpression, so it is skipped without needing a name check.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === WRITER) {
      const first = node.arguments[0]
      CALLS.push({
        file: f.rel,
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        literal: first !== undefined && ts.isStringLiteralLike(first) && !ts.isTemplateExpression(first) ? first.text : null,
      })
    }
    node.forEachChild(visit)
  }
  visit(sf)
}

describe('nothing can persist a recall cache type the search path would filter out', () => {
  it('found the real writer call sites, one in each cache module', () => {
    pinnedPopulation({
      what: `src/**/*.ts call sites of ${WRITER}`,
      items: CALLS.map((c) => `${c.file}:${c.line}`),
      floor: 3,
      // One anchor per cache surface: a sweep that kept its count while losing a surface is a substitution, not a pass.
      mustInclude: ['src/bash_output_cache.ts', 'src/web_cache.ts', 'src/mcp_cache.ts'],
    })
  })

  it('passes a string literal for the cache type at every call site, so the value is checkable here at all', () => {
    expect(
      CALLS.filter((c) => c.literal === null).map((c) => `${c.file}:${c.line}`),
      `A ${WRITER} call whose cache type is a variable puts the value out of this guard's reach. Pass the literal at the call site, or extend this guard to resolve the variable.`,
    ).toEqual([])
  })

  it('persists only cache types isRecallCacheType accepts, so the search filter can never drop a stored row', () => {
    expect(
      CALLS.filter((c) => c.literal !== null && !isRecallCacheType(c.literal)).map((c) => `${c.file}:${c.line} wrote "${c.literal ?? ''}"`),
      'This cache type is not in VALID_TYPES, so mapRowsToHits would silently discard every row written with it -- after the SQL LIMIT already counted those rows, which is how a recall query returns fewer results than it was asked for and looks exactly like an honest no-match. Add the type to VALID_TYPES and RecallCacheType, or write an existing one.',
    ).toEqual([])
    // Proof the check above is a real check and not a vacuous filter over an empty set.
    expect(CALLS.every((c) => c.literal !== null && isRecallCacheType(c.literal))).toBe(true)
    expect(isRecallCacheType('not-a-cache-type')).toBe(false)
  })

  it('reaches cache_recall only through that writer, so no raw statement can sidestep the type check', () => {
    const raw: string[] = []
    for (const f of FILES) {
      if (f.rel === 'src/recall_index.ts' || f.rel === 'src/db.ts') continue
      const source = readFileSync(f.abs, 'utf8')
      for (const verb of ['INSERT INTO cache_recall', 'UPDATE cache_recall', 'REPLACE INTO cache_recall']) {
        if (source.includes(verb)) raw.push(`${f.rel}: ${verb}`)
      }
    }
    expect(
      raw,
      `A statement writing cache_recall outside ${WRITER} is not covered by the literal check above, and cache_type is a plain TEXT column with no CHECK constraint to catch it.`,
    ).toEqual([])
  })
})
