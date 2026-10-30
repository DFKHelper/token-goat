/** Search misses retry near-word names through the real search path. Provenance: HAND-DERIVED. Each fixture name sits within (or outside) rankSimilarNames's two-edit budget for its query, counted by hand, and the expected near names follow from that count, not from the code under test. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { nearSymbolNames } from '../src/read_suggest.js'
import { NEAR_RETRY, runParallelSearch, searchWithNearRetry } from '../src/search/search_cli.js'

let root: string
let cwdSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-near-retry-')))
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
  fs.writeFileSync(path.join(root, 'parse.ts'), 'export function parseFile(): number {\n  return 1\n}\n')
  fs.writeFileSync(path.join(root, 'gizmos.ts'), 'export function gizmoAa(): number {\n  return 1\n}\nexport function gizmoAb(): number {\n  return 2\n}\nexport function gizmoAc(): number {\n  return 3\n}\nexport function gizmoAd(): number {\n  return 4\n}\n')
  fs.writeFileSync(path.join(root, 'guide.md'), '# Guide\n\n## Unrelated topic\n\nNo code names here.\n')
  for (const f of ['parse.ts', 'gizmos.ts', 'guide.md']) indexFileSync(path.join(root, f), globalDbPath())
})

afterEach(() => {
  closeAllDbs()
  cwdSpy.mockRestore()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('search retries near-word names on a miss', () => {
  it('returns the exact match on the first retry for a near spelling', async () => {
    const out = await searchWithNearRetry({ query: 'parseFle', channels: ['symbol'] })
    expect(out.answeredFrom).toBe('parseFle')
    expect(out.retries).toBe(1)
    expect(out.summary.query).toBe('parseFile')
    expect(out.summary.results.map((r) => r.name)).toContain('parseFile')
  })

  it('issues at most NEAR_RETRY.max retries when more near names exist', async () => {
    // Control: the premise is that more near names than the cap exist for this miss.
    const near = nearSymbolNames('gizmoAx', root)
    expect(near.skipped).toBe(false)
    expect(near.skipped ? 0 : near.candidates.length).toBeGreaterThan(NEAR_RETRY.max)
    // Headings never hold code names, so every near retry misses on this channel.
    const out = await searchWithNearRetry({ query: 'gizmoAx', channels: ['heading'] })
    expect(out.answeredFrom).toBeNull()
    expect(out.retries).toBe(NEAR_RETRY.max)
    expect(out.summary.totalHits).toBe(0)
  })

  it('returns the normal miss output with no retry when no near name exists', async () => {
    const out = await searchWithNearRetry({ query: 'zzqxNopeDoesNotExist', channels: ['symbol'] })
    expect(out.answeredFrom).toBeNull()
    expect(out.retries).toBe(0)
    expect(out.summary.totalHits).toBe(0)
    expect(out.summary.query).toBe('zzqxNopeDoesNotExist')
  })

  it('does not retry when the first search already hits', async () => {
    const out = await searchWithNearRetry({ query: 'parseFile', channels: ['symbol'] })
    expect(out.answeredFrom).toBeNull()
    expect(out.retries).toBe(0)
    expect(out.summary.totalHits).toBeGreaterThan(0)
  })

  it('names the substituted near name in the text output', async () => {
    const r = await runParallelSearch({ query: 'parseFle', channels: ['symbol'] })
    expect(r.code).toBe(0)
    expect(r.text).toMatch(/\(note: no match for \S*parseFle\S*; showing results for near name \S*parseFile\S*\)/)
  })

  it('reports the typed query in the JSON output on a retry', async () => {
    const r = await runParallelSearch({ query: 'parseFle', channels: ['symbol'], json: true })
    const parsed = JSON.parse(r.text) as { query: string; answeredFrom?: string }
    expect(parsed.query).toBe('parseFile')
    expect(parsed.answeredFrom).toBe('parseFle')
  })

  it('prints no retry note when the first search hits', async () => {
    const r = await runParallelSearch({ query: 'parseFile', channels: ['symbol'] })
    expect(r.text).not.toContain('(note: no match')
  })
})
