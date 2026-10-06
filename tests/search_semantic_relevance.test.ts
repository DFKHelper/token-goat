// `search`'s semantic channel took every hit the dense scan returned, so a `semantic.max_distance` a user set narrowed `semantic` and left `search` untouched, and a page of nearest-neighbour noise printed under `search` with none of the weak-match notice `semantic` gives the same query. Both surfaces now make the relevance decision in src/semantic_relevance.ts.
//
// Provenance: HAND-DERIVED. The scan is replaced by a stub returning made-up hits at chosen distances, so what is under test is the floor and weak label applied to them. The weak band (0.85) and the noise distances near 1.0 follow the measurements cited on semantic.weak_distance in src/config_defaults.ts (CAPTURE: nonsense queries best-hit 0.863-1.043 on this repo's index).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbedPreflightModule from '../src/embed_preflight.js'
import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'

const scan = vi.hoisted(() => ({ hits: [] as SearchHit[] }))

vi.mock('../src/embed_preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof EmbedPreflightModule>()),
  checkSemanticReadiness: async () => ({ status: 'ready', summary: 'ready' }),
}))

vi.mock('../src/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof EmbeddingsModule>()),
  searchSemantic: async () => scan.hits.map((h) => ({ ...h })),
}))

const { globalDbPath } = await import('../src/constants.js')
const { closeAllDbs } = await import('../src/db.js')
const { clearModuleCaches } = await import('../src/reset.js')
const { executeParallelSearch } = await import('../src/search/parallel_search.js')
const { runSemantic } = await import('../src/read_semantic.js')
const { formatSearchText } = await import('../src/search/search_cli.js')

let root = ''

function hit(file: string, startLine: number, distance: number): SearchHit {
  return { filePath: path.join(root, file), startLine, endLine: startLine + 4, kind: 'chunk', distance, text: `chunk of ${file}` }
}

function writeGlobalSemanticConfig(body: string): void {
  fs.mkdirSync(path.dirname(globalDbPath()), { recursive: true })
  fs.writeFileSync(path.join(path.dirname(globalDbPath()), 'config.toml'), `[semantic]\n${body}\n`)
  clearModuleCaches()
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-search-relevance-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(path.join(path.dirname(globalDbPath()), 'config.toml'), { force: true })
  clearModuleCaches()
  fs.rmSync(root, { recursive: true, force: true })
})

async function searchSemanticOnly(query: string) {
  return executeParallelSearch({ query, channels: ['semantic'], projectRoot: root })
}

describe("search's semantic channel applies semantic.max_distance", () => {
  it('drops a hit above a configured floor and keeps the one under it', async () => {
    writeGlobalSemanticConfig('max_distance = 0.7')
    scan.hits = [hit('a.ts', 1, 0.6), hit('b.ts', 1, 0.95)]
    const summary = await searchSemanticOnly('parse the config')
    expect(summary.results.map((r) => path.basename(r.filePath))).toEqual(['a.ts'])
    expect(summary.channelCounts.semantic).toBe(1)
    expect(summary.notes).toBeUndefined()
  })

  it('says the floor emptied the channel, with the closest distance it dropped', async () => {
    writeGlobalSemanticConfig('max_distance = 0.5')
    scan.hits = [hit('a.ts', 1, 0.912), hit('b.ts', 1, 0.95)]
    const summary = await searchSemanticOnly('parse the config')
    expect(summary.totalHits).toBe(0)
    expect(summary.notes).toEqual([{ channel: 'semantic', note: 'found nothing within 0.5 (closest was 0.912); raise semantic.max_distance to see weaker matches' }])
    expect(formatSearchText(summary)).toContain('(note: semantic channel found nothing within 0.5 (closest was 0.912); raise semantic.max_distance to see weaker matches)')
  })
})

describe('semantic and search read the same relevance decision', () => {
  it('reports the same floor and closest distance from both surfaces', async () => {
    const prevEmbed = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    // isolate-home.ts turns embeddings off for the suite, which would stop runSemantic before it reached the stubbed scan.
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const warnings: string[] = []
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    })
    try {
      writeGlobalSemanticConfig('max_distance = 0.5')
      scan.hits = [hit('a.ts', 1, 0.912)]
      await runSemantic('parse the config', { projectRoot: root })
      const summary = await searchSemanticOnly('parse the config')
      expect(warnings.filter((w) => w.includes('found nothing within'))).toEqual([
        'Matching on meaning found nothing within 0.5 (closest was 0.912); these results come from keyword search alone. Raise semantic.max_distance to see weaker matches.',
      ])
      expect(summary.notes?.[0]?.note).toContain('nothing within 0.5 (closest was 0.912)')
    } finally {
      warnSpy.mockRestore()
      if (prevEmbed === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
      else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbed
    }
  })
})

describe("search's semantic channel labels a weak page", () => {
  it('notes and flags a channel whose best hit is above semantic.weak_distance', async () => {
    scan.hits = [hit('a.ts', 1, 1.001), hit('b.ts', 1, 1.04)]
    const summary = await searchSemanticOnly('zzzqqq_nothing')
    expect(summary.totalHits).toBe(2)
    expect(summary.lowConfidence).toEqual({ closestDistance: 1.001, threshold: 0.85 })
    expect(formatSearchText(summary)).toContain('(note: semantic channel found nothing close (closest was 1.001, weak above 0.85); its hits may be unrelated)')
  })

  it('says nothing when the best hit is a strong match', async () => {
    scan.hits = [hit('a.ts', 1, 0.62), hit('b.ts', 1, 1.04)]
    const summary = await searchSemanticOnly('parse the config')
    expect(summary.lowConfidence).toBeUndefined()
    expect(summary.notes).toBeUndefined()
    expect(formatSearchText(summary)).not.toContain('(note:')
  })
})
