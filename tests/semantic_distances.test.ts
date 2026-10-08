// `semantic.weak_distance` and the `semantic_queries` ledger behind `semantic --distances`: the config key clamps, a real runSemantic lands one text-free row in global.db, the aggregation computes percentiles and bands, and the flag on an empty ledger says so and exits 0.
//
// Provenance: HAND-DERIVED for every expected number (computed in the comments beside each assertion from the inputs, independently of the implementation); the dense hits are mocked at searchSemantic, the same seam tests/semantic_multi_query_and_weak_match.test.ts uses, so each query's distance is exact.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'
import { loadConfig } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { projectHash, resolveProjectRoot } from '../src/project.js'
import { clearModuleCaches } from '../src/reset.js'
import { getGlobalDb, pruneSemanticQueries, STATS_RETENTION_DAYS } from '../src/stats.js'
import { formatDistanceReport, summarizeDistances } from '../src/semantic_distances.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
  }
})

const { run } = await import('../src/cli.js')

const QUERY = 'sdprobequery9k'

function hit(distance: number): SearchHit {
  return { filePath: 'src/sd_probe.ts', startLine: 1, endLine: 3, kind: 'window', distance, text: 'sd probe body' }
}

async function runCli(argv: string[]): Promise<{ code: number | string | undefined; stdout: string }> {
  const prev = process.exitCode
  process.exitCode = 0
  const out: string[] = []
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk))
    return true
  })
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, stdout: out.join('') }
  } finally {
    outSpy.mockRestore()
    errSpy.mockRestore()
    warnSpy.mockRestore()
    process.exitCode = prev
  }
}

function writeGlobalConfig(toml: string): void {
  fs.writeFileSync(path.join(path.dirname(globalDbPath()), 'config.toml'), toml)
  clearModuleCaches()
}

let prevEmbedEnv: string | undefined

beforeEach(() => {
  prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  searchSemanticMock.mockReset()
  getGlobalDb().exec('DELETE FROM semantic_queries')
})

afterEach(() => {
  if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
  fs.rmSync(path.join(path.dirname(globalDbPath()), 'config.toml'), { force: true })
  clearModuleCaches()
})

describe('semantic.weak_distance', () => {
  it('defaults to the 0.85 the constant used to hold', () => {
    expect(loadConfig().semantic.weak_distance).toBe(0.85)
  })

  it('loads a value in range and clamps one outside the 0.05..1.2 bounds it shares with max_distance', () => {
    writeGlobalConfig('[semantic]\nweak_distance = 0.7\n')
    expect(loadConfig().semantic.weak_distance).toBe(0.7)
    writeGlobalConfig('[semantic]\nweak_distance = 5\n')
    expect(loadConfig().semantic.weak_distance).toBe(1.2)
    writeGlobalConfig('[semantic]\nweak_distance = 0.001\n')
    expect(loadConfig().semantic.weak_distance).toBe(0.05)
  })

  it('labels a result weak against the configured value, not a constant', async () => {
    searchSemanticMock.mockResolvedValue([hit(0.75)])
    writeGlobalConfig('[semantic]\nweak_distance = 0.7\n')
    const weak = JSON.parse((await runCli(['semantic', QUERY, '--json'])).stdout) as { lowConfidence?: { threshold: number } }
    expect(weak.lowConfidence?.threshold).toBe(0.7)
    writeGlobalConfig('')
    const fine = JSON.parse((await runCli(['semantic', QUERY, '--json'])).stdout) as { lowConfidence?: unknown }
    expect(fine.lowConfidence).toBeUndefined()
  })
})

describe('semantic_queries recording', () => {
  it('lands one row per query with the closest distance and no query text anywhere', async () => {
    searchSemanticMock.mockResolvedValue([hit(0.9), hit(0.6)])
    await runCli(['semantic', QUERY])
    const db = getGlobalDb()
    const rows = db.prepare('SELECT * FROM semantic_queries').all() as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    // Closest of 0.9 and 0.6 is 0.6, which is under the 0.85 weak line, so weak is 0 and nothing was floor-rejected (default floor 1.2).
    expect(rows[0]).toMatchObject({ closest_distance: 0.6, floor_rejected_min: null, weak: 0 })
    const columns = (db.prepare('PRAGMA table_info(semantic_queries)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(columns).toEqual(['ts', 'project_hash', 'closest_distance', 'floor_rejected_min', 'weak'])
    expect(JSON.stringify(rows)).not.toContain(QUERY)
  })

  it('records the nearest floor-rejected distance and a null closest when the floor empties the half', async () => {
    searchSemanticMock.mockResolvedValue([hit(0.9), hit(0.6)])
    writeGlobalConfig('[semantic]\nmax_distance = 0.5\n')
    await runCli(['semantic', QUERY])
    const rows = getGlobalDb().prepare('SELECT closest_distance, floor_rejected_min, weak FROM semantic_queries').all()
    // Both hits exceed 0.5, so none survive and the smallest rejected distance is 0.6.
    expect(rows).toEqual([{ closest_distance: null, floor_rejected_min: 0.6, weak: 0 }])
  })

  it('marks a query weak when its closest distance is above weak_distance', async () => {
    searchSemanticMock.mockResolvedValue([hit(0.95)])
    await runCli(['semantic', QUERY])
    const rows = getGlobalDb().prepare('SELECT closest_distance, weak FROM semantic_queries').all()
    expect(rows).toEqual([{ closest_distance: 0.95, weak: 1 }])
  })
})

describe('summarizeDistances', () => {
  // Five queries at 0.5, 0.6, 0.7, 0.8, 0.9 plus one with nothing returned.
  const rows = [0.9, 0.5, 0.7, null, 0.6, 0.8].map((d) => ({ closest_distance: d }))

  it('computes linear-interpolated percentiles over the returned distances', () => {
    const s = summarizeDistances(rows, 0.85)
    // Sorted 0.5 0.6 0.7 0.8 0.9, index = p*(n-1): p10 -> 0.4 -> 0.5+0.4*0.1=0.54; p25 -> 1 -> 0.6; p50 -> 2 -> 0.7; p75 -> 3 -> 0.8; p90 -> 3.6 -> 0.8+0.6*0.1=0.86.
    expect(s.total).toBe(6)
    expect(s.percentiles?.p10).toBeCloseTo(0.54, 10)
    expect(s.percentiles?.p25).toBeCloseTo(0.6, 10)
    expect(s.percentiles?.p50).toBeCloseTo(0.7, 10)
    expect(s.percentiles?.p75).toBeCloseTo(0.8, 10)
    expect(s.percentiles?.p90).toBeCloseTo(0.86, 10)
  })

  it('counts the bands: below 0.70, 0.70 up to 0.85, 0.85 and above, and none returned', () => {
    const s = summarizeDistances(rows, 0.85)
    // 0.5 and 0.6 are below 0.70; 0.7 and 0.8 are in 0.70..0.85; 0.9 is above; one null. Of 6 queries: 2, 2, 1, 1.
    expect(s.bands.map((b) => b.count)).toEqual([2, 2, 1, 1])
    expect(s.bands.map((b) => Math.round(b.pct))).toEqual([33, 33, 17, 17])
  })

  it('counts a query weak against the given threshold, over the queries that returned a match', () => {
    // Above 0.85 only 0.9 is weak: 1 of 5 returned; above 0.65 it is 0.7, 0.8, 0.9: 3 of 5.
    expect(summarizeDistances(rows, 0.85).weakShare).toBeCloseTo(0.2, 10)
    expect(summarizeDistances(rows, 0.65).weakShare).toBeCloseTo(0.6, 10)
  })

  it('has no percentiles and no weak share when nothing returned a match', () => {
    const s = summarizeDistances([{ closest_distance: null }], 0.85)
    expect(s.percentiles).toBeNull()
    expect(s.weakShare).toBeNull()
  })
})

describe('formatDistanceReport', () => {
  it('declines to suggest a value below 20 queries and says why', () => {
    const text = formatDistanceReport(summarizeDistances([{ closest_distance: 0.5 }], 0.85), { weakDistance: 0.85, maxDistance: 1.2 })
    expect(text).toContain('fewer than 20')
    expect(text).not.toMatch(/consider|suggest|recommend/i)
  })

  it('words one recorded query in the singular and none as "None"', () => {
    const thresholds = { weakDistance: 0.85, maxDistance: 1.2 }
    const one = formatDistanceReport(summarizeDistances([{ closest_distance: 0.5 }], 0.85), thresholds)
    expect(one).toContain('): 1 query\n')
    expect(one).not.toContain('1 queries')
    expect(one).toContain('Only 1 recorded')
    const none = formatDistanceReport(summarizeDistances([], 0.85), thresholds)
    expect(none).toContain('): 0 queries\n')
    expect(none).toContain('None recorded')
    expect(none).not.toContain('Only 0')
  })

  it('prints the percentiles, the band table and both thresholds from 20 queries up', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ closest_distance: 0.5 + i * 0.01 }))
    const text = formatDistanceReport(summarizeDistances(many, 0.85), { weakDistance: 0.85, maxDistance: 1.2 })
    expect(text).toContain('p50')
    expect(text).toContain('weak_distance')
    expect(text).toContain('max_distance')
    expect(text).toContain('0.85')
    expect(text).not.toContain('fewer than 20')
  })
})

describe('semantic --distances', () => {
  it('on an empty ledger says fewer than 20 queries were recorded, needs no query argument, and exits 0', async () => {
    const { code, stdout } = await runCli(['semantic', '--distances'])
    expect(code).toBe(0)
    expect(stdout).toContain('fewer than 20')
    expect(stdout).toContain('0 queries')
    expect(searchSemanticMock).not.toHaveBeenCalled()
  })

  it('counts only the current project unless --all is given', async () => {
    const insert = getGlobalDb().prepare('INSERT INTO semantic_queries (ts, project_hash, closest_distance, floor_rejected_min, weak) VALUES (?, ?, 0.6, NULL, 0)')
    const here = projectHash(resolveProjectRoot({ project: process.cwd() }))
    const now = Math.floor(Date.now() / 1000)
    // 20 rows for this project and 5 for another: the default scope sees 20, --all sees 25.
    for (let i = 0; i < 20; i++) insert.run(now, here)
    for (let i = 0; i < 5; i++) insert.run(now, 'some-other-project')
    expect((await runCli(['semantic', '--distances'])).stdout).toContain('(this project): 20 queries')
    expect((await runCli(['semantic', '--distances', '--all'])).stdout).toContain('(all projects): 25 queries')
  })

  it('refuses a query alongside --distances, since it runs none', async () => {
    const { code } = await runCli(['semantic', QUERY, '--distances'])
    expect(code).not.toBe(0)
    expect(searchSemanticMock).not.toHaveBeenCalled()
  })
})

describe('semantic_queries retention', () => {
  it('prunes rows older than STATS_RETENTION_DAYS and keeps newer ones', () => {
    const db = getGlobalDb()
    const now = Math.floor(Date.now() / 1000)
    // One row a day past the 180-day window, one a day inside it.
    const insert = db.prepare('INSERT INTO semantic_queries (ts, project_hash, closest_distance, floor_rejected_min, weak) VALUES (?, ?, ?, NULL, 0)')
    insert.run(now - (STATS_RETENTION_DAYS + 1) * 86400, 'old', 0.5)
    insert.run(now - (STATS_RETENTION_DAYS - 1) * 86400, 'new', 0.6)
    pruneSemanticQueries(db)
    expect(db.prepare('SELECT project_hash FROM semantic_queries').all()).toEqual([{ project_hash: 'new' }])
  })
})
