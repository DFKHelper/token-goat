// `search` down-weights archive and docs paths the way `semantic` does, so a changelog or docs page that merely mentions a name stops outranking the source file that defines it.
//
// Provenance: HAND-DERIVED. Scores follow from RRF's 1/(60+rank) by arithmetic (1/61 = 0.016393, 1/62 = 0.016129) and the default weights (archive 0.7, docs 0.92); the file layouts are made up.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { executeParallelSearch } from '../src/search/parallel_search.js'
import { pathPriorityWeight } from '../src/search/path_weight.js'
import { fuseChannelHits } from '../src/search/rrf.js'
import type { ChannelHit, SearchChannel } from '../src/search/types.js'

const sem = loadConfig().semantic
const dirs: string[] = []

afterEach(() => {
  closeAllDbs()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function textHit(filePath: string, rank: number): ChannelHit {
  return { channel: 'text', filePath, lineStart: 1, lineEnd: 1, preview: 'x', rank }
}

describe('pathPriorityWeight', () => {
  it('gives live source 1, a docs hit docs_weight and an archival hit archive_weight', () => {
    expect(pathPriorityWeight('src/x.ts', sem)).toBe(1)
    expect(pathPriorityWeight('docs/guide.txt', sem)).toBe(sem.docs_weight)
    expect(pathPriorityWeight('README.md', sem)).toBe(sem.docs_weight)
    expect(pathPriorityWeight('CHANGELOG.md', sem)).toBe(sem.archive_weight)
    expect(pathPriorityWeight('notes\\Archive\\a.ts', sem)).toBe(sem.archive_weight)
  })

  it('lets archive win over docs when a path is both', () => {
    expect(pathPriorityWeight('docs/old/a.md', sem)).toBe(sem.archive_weight)
  })
})

describe('fuseChannelHits weightOf', () => {
  it('ranks the source file first when two hits tie on fused score', () => {
    const map = new Map<SearchChannel, ChannelHit[]>([['text', [textHit('CHANGELOG.md', 1), textHit('src/x.ts', 1)]]])
    // Unweighted, both score 1/61 and the path tiebreak puts CHANGELOG.md first; weighted, it scores 1/61 * 0.7.
    expect(fuseChannelHits(map, {}).map((r) => r.filePath)).toEqual(['CHANGELOG.md', 'src/x.ts'])
    const weighted = fuseChannelHits(map, { weightOf: (p) => pathPriorityWeight(p, sem) })
    expect(weighted.map((r) => r.filePath)).toEqual(['src/x.ts', 'CHANGELOG.md'])
    expect(weighted[1]!.score).toBeCloseTo((1 / 61) * 0.7, 6)
  })

  it('applies docs_weight to a docs hit', () => {
    const map = new Map<SearchChannel, ChannelHit[]>([['text', [textHit('docs/a.md', 1)]]])
    const [only] = fuseChannelHits(map, { weightOf: (p) => pathPriorityWeight(p, sem) })
    expect(only!.score).toBeCloseTo((1 / 61) * 0.92, 6)
  })
})

describe('executeParallelSearch path weighting', () => {
  it('ranks the src definition above a docs page that mentions the name more often', async () => {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-weight-')))
    dirs.push(dir)
    fs.mkdirSync(path.join(dir, 'docs'))
    fs.mkdirSync(path.join(dir, 'src'))
    // The docs page mentions the word three times so the text channel ranks it first (1/61); src/guide.ts mentions it once and ranks second (1/62). Unweighted docs wins; at docs_weight 0.92 it drops to 0.015082, under 0.016129.
    fs.writeFileSync(path.join(dir, 'docs', 'guide.md'), '# Frobnicator\n\nfrobnicator one\nfrobnicator two\n')
    fs.writeFileSync(path.join(dir, 'src', 'guide.ts'), 'export function frobnicator(): void {}\n')
    for (const f of ['docs/guide.md', 'src/guide.ts']) indexFileSync(path.join(dir, f), globalDbPath())

    const summary = await executeParallelSearch({ query: 'frobnicator', limit: 5, projectRoot: dir, channels: ['text'] })
    expect(summary.results.map((r) => path.basename(r.filePath))).toEqual(['guide.ts', 'guide.md'])
    expect(summary.results[0]!.filePath.replace(/\\/g, '/')).toContain('src/guide.ts')
    expect(summary.results[1]!.score).toBeCloseTo((1 / 61) * 0.92, 6)
  }, 60_000)
})
