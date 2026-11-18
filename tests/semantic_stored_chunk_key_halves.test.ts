// A private key block cut in half by the semantic index's chunking: the chunk holding one half has one marker or none, so the paired PEM pattern never matched it and the key fragment printed raw. `semantic` and `search`'s semantic channel both print stored chunk text, and both take their hits through mergeNearbyHits, which now redacts each stored chunk as a cut.
//
// This is the model-free wiring row for CI, where tests/read_output_redacts_secrets_bundle_e2e.test.ts skips its real-index rows (no embedding model in the isolated data dir). It drives the real runSemantic and the real executeParallelSearch over a stubbed scan, so what is under test is that every print site redacts a half.
//
// Provenance: HAND-DERIVED. The scan is replaced by a stub returning made-up chunk texts that hold one half of a key block (BEGIN marker and body, END marker and body, body lines only); the expected output is computed from those by hand, independently of the redactor.
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

const { closeAllDbs } = await import('../src/db.js')
const { executeParallelSearch } = await import('../src/search/parallel_search.js')
const { runSemantic } = await import('../src/read_semantic.js')
const { formatSearchText } = await import('../src/search/search_cli.js')

const BEGIN = '-----BEGIN RSA PRIVATE ' + 'KEY-----'
const END = '-----END RSA PRIVATE ' + 'KEY-----'
const keyLine = (name: string): string => name.padEnd(64, 'A')
const BEGIN_HALF = ['config follows', BEGIN, keyLine('BEGINHALFBODY1')].join('\n')
const END_HALF = [keyLine('ENDHALFBODY1'), END, 'config continues'].join('\n')
const BODY_ONLY = [keyLine('BODYONLYBODY1'), keyLine('BODYONLYBODY2'), keyLine('BODYONLYBODY3')].join('\n')
const LEAKS = /BEGINHALFBODY|ENDHALFBODY|BODYONLYBODY|PRIVATE KEY/

let root = ''
let prevEmbed: string | undefined

function hit(file: string, startLine: number, endLine: number, distance: number, text: string): SearchHit {
  return { filePath: path.join(root, file), startLine, endLine, kind: 'window', distance, text }
}

function halves(): SearchHit[] {
  return [hit('a.md', 1, 3, 0.2, BEGIN_HALF), hit('b.md', 40, 42, 0.3, END_HALF), hit('c.md', 80, 82, 0.4, BODY_ONLY)]
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chunk-key-halves-'))
  prevEmbed = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // isolate-home.ts turns embeddings off for the suite, which would stop runSemantic before it reached the stubbed scan.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  scan.hits = halves()
})

afterEach(() => {
  closeAllDbs()
  if (prevEmbed === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbed
  fs.rmSync(root, { recursive: true, force: true })
})

describe('semantic prints no half of a stored key block', () => {
  it('hides the BEGIN half, the END half and a body-only chunk in the text blocks, ranges intact', async () => {
    const { text, code } = await runSemantic('private key', { projectRoot: root })
    expect(code).toBe(0)
    expect(text).not.toMatch(LEAKS)
    expect(text).toContain('[REDACTED:private_key_block]')
    expect(text).toContain('config follows')
    expect(text).toContain('config continues')
    expect(text).toContain('a.md:1-3')
    expect(text).toContain('b.md:40-42')
    expect(text).toContain('c.md:80-82')
  })

  it('hides the same three chunks in --json, ranges intact', async () => {
    const { text, code } = await runSemantic('private key', { projectRoot: root, json: true })
    expect(code).toBe(0)
    expect(text).not.toMatch(LEAKS)
    const parsed = JSON.parse(text) as { items: { filePath: string; startLine: number; endLine: number }[] }
    expect(parsed.items.map((i) => [path.basename(i.filePath), i.startLine, i.endLine])).toEqual([['a.md', 1, 3], ['b.md', 40, 42], ['c.md', 80, 82]])
  })
})

describe("search's semantic channel prints no half of a stored key block", () => {
  it('hides the BEGIN half, the END half and a body-only chunk in the previews, ranges intact', async () => {
    const summary = await executeParallelSearch({ query: 'private key', channels: ['semantic'], projectRoot: root })
    expect(summary.results.map((r) => [path.basename(r.filePath), r.lineStart, r.lineEnd])).toEqual([['a.md', 1, 3], ['b.md', 40, 42], ['c.md', 80, 82]])
    const printed = JSON.stringify(summary.results) + formatSearchText(summary)
    expect(printed).not.toMatch(LEAKS)
    expect(printed).toContain('[REDACTED:private_key_block]')
  })
})
