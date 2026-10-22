/** Metamorphic check on the symbol and heading channels of `search`: symbol FTS tries every term (AND) and only widens to any term (OR) when that finds nothing, so a query that already needs the OR widening must keep its result order when one more term is appended that no indexed row contains. Search ranking has no oracle, so this pins a relation rather than today's output. Driven through the real path: indexFileSync fills the isolated global index and executeParallelSearch runs each channel as the CLI does. Provenance: HAND-DERIVED. Each fixture row holds "alpha" or "beta" and never both, so the AND attempt of an "alpha beta" query is empty by construction, which the control asserts against the FTS table instead of assuming; the term counts differ per row so no two rows share a bm25 score, which the control also asserts, because src orders by bm25 alone with no tiebreak and a tie would make the order depend on SQLite's plan. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs, getReadDb } from '../src/db.js'
import { sanitizeFtsQuery } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'

// One project indexed once: the isolated global db outlives each test, so a per-test project would leave rows for the unscoped control queries to see in whatever order the tests run.
let dir = ''

beforeAll(() => {
  dir = project()
})

afterAll(() => {
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

const CODE = [
  "export function alpha_one(): string {\n  return 'alpha'\n}\n",
  "export function alpha_two_alpha(): string {\n  return 'alpha alpha'\n}\n",
  "export function alpha_three_alpha_alpha(): string {\n  return 'alpha alpha alpha'\n}\n",
  "export function beta_one(): string {\n  return 'beta with some padding words here'\n}\n",
  "export function beta_two_beta(): string {\n  return 'beta beta'\n}\n",
].join('\n')

const DOC = [
  '# Notes',
  '',
  '## Alpha overview',
  '',
  'Alpha.',
  '',
  '## Alpha alpha details',
  '',
  'Alpha alpha alpha.',
  '',
  '## Alpha alpha alpha deep dive',
  '',
  'Alpha alpha alpha alpha.',
  '',
  '## Beta summary',
  '',
  'Beta with some padding words here and there.',
  '',
  '## Beta beta recap',
  '',
  'Beta beta beta.',
  '',
].join('\n')

const BASE_QUERIES = ['alpha beta', 'beta alpha']
const ZERO_MATCH_TERMS = ['zzqxv', 'nonexistentterm', 'q9q9q9']
// Below the five matching rows each channel holds, so the cut-off decides which rows a channel keeps.
const LIMIT = 4

function project(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-meta-')))
  fs.writeFileSync(path.join(root, 'tools.ts'), CODE)
  fs.writeFileSync(path.join(root, 'notes.md'), DOC)
  for (const f of ['tools.ts', 'notes.md']) indexFileSync(path.join(root, f), globalDbPath())
  return root
}

function ftsCount(match: string): number {
  const row = getReadDb(globalDbPath()).prepare('SELECT count(*) AS n FROM symbols_fts WHERE symbols_fts MATCH ?').get(match) as { n: number }
  return row.n
}

function bm25Scores(match: string): number[] {
  const rows = getReadDb(globalDbPath()).prepare('SELECT bm25(symbols_fts) AS score FROM symbols_fts WHERE symbols_fts MATCH ?').all(match) as { score: number }[]
  return rows.map((r) => r.score)
}

async function channelOrder(query: string, channel: 'symbol' | 'heading'): Promise<string[]> {
  const summary = await executeParallelSearch({ query, limit: LIMIT, projectRoot: dir, channels: [channel] })
  return summary.results.map((r) => `${r.kind}:${r.name}`)
}

describe('search symbol and heading channels, metamorphic', () => {
  it('start from a populated index whose base queries really need the OR fallback (control)', async () => {
    expect(ftsCount('"alpha"')).toBeGreaterThan(0)
    expect(ftsCount('"beta"')).toBeGreaterThan(0)
    for (const query of BASE_QUERIES) {
      const and = sanitizeFtsQuery(query, 'AND')
      const or = sanitizeFtsQuery(query, 'OR')
      expect(and, `AND and OR joins of "${query}" should differ`).not.toBe(or)
      expect(ftsCount(and), `AND path of "${query}" must find nothing`).toBe(0)
      expect(ftsCount(or), `OR path of "${query}" must find rows`).toBeGreaterThan(0)
      const scores = bm25Scores(or)
      expect(new Set(scores).size, `bm25 scores of "${query}" must be distinct so no tie decides the order`).toBe(scores.length)
      for (const channel of ['symbol', 'heading'] as const) {
        const order = await channelOrder(query, channel)
        expect(order.length, `${channel} channel of "${query}" must return hits through the fallback`).toBeGreaterThan(1)
      }
    }
  })

  for (const channel of ['symbol', 'heading'] as const) {
    for (const query of BASE_QUERIES) {
      for (const zero of ZERO_MATCH_TERMS) {
        it(`keeps the ${channel} order of "${query}" when "${zero}" is appended`, async () => {
          expect(ftsCount(`"${zero}"`), `"${zero}" must match no indexed row`).toBe(0)
          expect(ftsCount(sanitizeFtsQuery(query, 'AND'))).toBe(0)
          const base = await channelOrder(query, channel)
          const extended = await channelOrder(`${query} ${zero}`, channel)
          expect(base.length).toBeGreaterThan(1)
          expect(extended).toEqual(base)
        })
      }
    }
  }
})
