/** Search misses retry near-word names through the real search path. Provenance: HAND-DERIVED. Each fixture name sits within (or outside) rankSimilarNames's two-edit budget for its query, counted by hand, and the expected near names follow from that count, not from the code under test. */

import type * as NodeFs from 'node:fs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { checkSemanticReadiness } from '../src/embed_preflight.js'
import type * as PreflightModule from '../src/embed_preflight.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { nearSymbolNames } from '../src/read_suggest.js'
import { NEAR_RETRY, runParallelSearch, searchWithNearRetry } from '../src/search/search_cli.js'

const textReadState = vi.hoisted(() => ({ watchedPath: '', reads: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (typeof args[0] === 'string' && normalizePath(args[0]) === normalizePath(textReadState.watchedPath)) textReadState.reads++
    return actual.readFileSync(...args)
  }) as typeof actual.readFileSync
  return { ...actual, readFileSync, default: { ...actual, readFileSync } }
})

// The semantic channel asks checkSemanticReadiness before any search, so its call count is the request count for that channel.
vi.mock('../src/embed_preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof PreflightModule>()
  return { ...actual, checkSemanticReadiness: vi.fn(actual.checkSemanticReadiness) }
})

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
  textReadState.watchedPath = ''
  textReadState.reads = 0
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

  it('reuses text reads for retries without sharing the cache across searches', async () => {
    const parsePath = path.join(root, 'parse.ts')
    const parseSource = 'export function parseFile(): number {\n  return 1\n}\n'
    fs.writeFileSync(parsePath, `${parseSource}${' '.repeat(200_100)}`)
    indexFileSync(parsePath, globalDbPath())

    const guidePath = path.join(root, 'guide.md')
    fs.writeFileSync(guidePath, '# Guide\n\nThe parseFile guide entry.\n')
    indexFileSync(guidePath, globalDbPath())

    textReadState.watchedPath = guidePath
    textReadState.reads = 0
    const guideReads = (): number => textReadState.reads
    const first = await searchWithNearRetry({ query: 'parseFle', projectRoot: root, channels: ['text'] })
    expect(first.answeredFrom).toBe('parseFle')
    expect(first.retries).toBe(1)
    expect(
      guideReads(),
      'the first search and retry should read guide.md once',
    ).toBe(1)

    fs.writeFileSync(guidePath, '# Guide\n\nFresh parseFile guide entry.\n')
    indexFileSync(guidePath, globalDbPath())
    textReadState.reads = 0
    const second = await searchWithNearRetry({ query: 'parseFle', projectRoot: root, channels: ['text'] })
    const guideHit = second.summary.results.find((result) => path.basename(result.filePath) === 'guide.md')
    expect(guideHit?.preview).toContain('Fresh parseFile guide entry.')
    expect(guideReads(), 'the second search should read guide.md with a fresh cache').toBe(1)
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

  // Provenance: HAND-DERIVED: the first search has no --channels, so it requests semantic once; a retry must not request it again.
  it('retries on the cheap channels only when the user named no channels', async () => {
    const preflight = vi.mocked(checkSemanticReadiness)
    preflight.mockClear()
    const out = await searchWithNearRetry({ query: 'gizmoAx' })
    expect(out.retries, 'no retry ran, so the row proves nothing').toBeGreaterThan(0)
    expect(preflight, 'a retry requested the semantic channel').toHaveBeenCalledTimes(1)
  })

  // Provenance: HAND-DERIVED: heading never holds a code name and semantic is named, so each of the NEAR_RETRY.max retries must request semantic too.
  it('keeps the channels the user named on each retry', async () => {
    const preflight = vi.mocked(checkSemanticReadiness)
    preflight.mockClear()
    const out = await searchWithNearRetry({ query: 'gizmoAx', channels: ['heading', 'semantic'] })
    expect(out.retries).toBe(NEAR_RETRY.max)
    expect(preflight, 'a retry dropped the user-named semantic channel').toHaveBeenCalledTimes(1 + NEAR_RETRY.max)
  })

  // Provenance: HAND-DERIVED: 'parseFle' misses the symbol channel and 'parseFile' is its one-edit near name, so exactly one retry answers it.
  it('carries retries in the JSON output after a retried miss', async () => {
    const r = await runParallelSearch({ query: 'parseFle', channels: ['symbol'], json: true })
    expect(JSON.parse(r.text)).toMatchObject({ answeredFrom: 'parseFle', retries: 1 })
  })

  // Provenance: HAND-DERIVED: 'parseFile' is an indexed name, so the first search hits and the JSON keeps its pre-retry shape with no retry fields.
  it('omits retries and answeredFrom from the JSON output on a first-search hit', async () => {
    const r = await runParallelSearch({ query: 'parseFile', channels: ['symbol'], json: true })
    const parsed = JSON.parse(r.text) as Record<string, unknown>
    expect(parsed).not.toHaveProperty('retries')
    expect(parsed).not.toHaveProperty('answeredFrom')
  })
})
