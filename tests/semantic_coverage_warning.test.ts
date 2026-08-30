// `semantic` reports "no matches" in exactly the same words whether it searched the whole corpus
// or 3% of it. Every terminal skip in indexFileEmbeddings (parser.ts) -- a file over
// indexing.large_file_symbol_only_kb, a .profile-meta.xml, oversized Salesforce metadata, a
// document with no extractable text -- stamps a real embed_sha so the worker stops re-reading the
// file, which is correct on its own and also means the file never gets retried. Summed over a
// corpus those skips can leave the dense half searching almost nothing while the BM25 pass keeps
// answering, so the output still looks like a complete result. This covers the one moment that is
// worth saying so: zero dense hits, model present, and coverage short of the indexed set.
//
// searchSemantic and isAvailable are both mocked (same pattern as
// tests/semantic_enclosing_symbol.test.ts). isAvailable specifically, because the real one reports
// false wherever the optional 34 MB inference runtime is absent -- which is the default, including
// CI -- and that would send every case here down the "matching on meaning is off" branch above the
// code under test. The coverage numbers themselves come from real rows in a real DB.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as EmbeddingsModule from '../src/embeddings.js'
import type { SearchHit } from '../src/embeddings.js'

import { closeAllDbs, getDb } from '../src/db.js'
import { globalDbPath } from '../src/constants.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'

const searchSemanticMock = vi.fn()

vi.mock('../src/embeddings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbeddingsModule>()
  return {
    ...actual,
    searchSemantic: (...args: Parameters<typeof actual.searchSemantic>) => searchSemanticMock(...args),
    isAvailable: () => true,
  }
})

const { runSemantic } = await import('../src/read_commands.js')

let TMP: string
let warnings: string[]
let prevEmbedEnv: string | undefined

/** An indexed file with no chunks -- the shape every terminal skip in indexFileEmbeddings leaves behind. */
function insertUnembeddedFile(p: string): void {
  getDb(globalDbPath())
    .prepare('INSERT INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)')
    .run(normalizePath(p), 'sha', 1, 'typescript', 1)
}

function insertChunk(p: string): void {
  getDb(globalDbPath())
    .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    .run(normalizePath(p), 1, 3, 'export function baz() {', 'symbol')
}

beforeEach(() => {
  // isolate-home.ts turns embeddings off for the whole suite; the warning is deliberately silent
  // in that state, so every case here would pass while asserting nothing without this.
  prevEmbedEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  clearModuleCaches()
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-semantic-coverage-'))
  // fixture.ts exists on disk because the renderer reads the lines behind a hit. Its index rows are
  // inserted explicitly like every other row here, rather than through indexFileSync, so the counts
  // under test come from a set this file states outright.
  fs.writeFileSync(path.join(TMP, 'fixture.ts'), 'export function baz() {\n  return 2\n}\n', 'utf8')
  searchSemanticMock.mockReset()
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbedEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbedEnv
  clearModuleCaches()
})

describe('runSemantic embedding-coverage warning', () => {
  it('warns with the real counts when the dense half finds nothing and most indexed files were never embedded', async () => {
    for (const f of ['fixture.ts', 'a.ts', 'b.ts', 'c.ts']) insertUnembeddedFile(path.join(TMP, f))
    insertChunk(path.join(TMP, 'fixture.ts'))
    searchSemanticMock.mockResolvedValue([] as SearchHit[])

    // No dense hit and no keyword hit is a non-zero exit by design ("no matches for ..."), which is
    // precisely the state the warning exists to qualify.
    const { code } = await runSemantic('anything', { json: false, projectRoot: TMP })
    expect(code).toBe(1)
    const warning = warnings.find((w) => w.includes('have embeddings'))
    expect(warning).toBeDefined()
    expect(warning).toContain('1 of 4')
    // Must say the results are still real, or this reads as a failed search rather than a partial one.
    expect(warning).toContain('keyword search alone')
  })

  // The discriminating case. Deleting the `embeddedFiles < indexedFiles` condition -- warning on
  // every empty dense result -- leaves the case above green and turns this one red. Without it the
  // warning fires on a perfectly embedded corpus that simply contains nothing similar, which is
  // the ordinary outcome of a `semantic` query and would train the reader to ignore the message.
  it('stays silent on an empty dense result when every indexed file is embedded', async () => {
    insertUnembeddedFile(path.join(TMP, 'fixture.ts'))
    insertChunk(path.join(TMP, 'fixture.ts'))
    searchSemanticMock.mockResolvedValue([] as SearchHit[])

    const { code } = await runSemantic('anything', { json: false, projectRoot: TMP })
    expect(code).toBe(1)
    expect(warnings.filter((w) => w.includes('have embeddings'))).toEqual([])
  })

  // The other half of the gate: with dense hits in hand the reader already has evidence embeddings
  // work, so partial coverage is not worth interrupting a successful search over, and the coverage
  // query is not worth paying for on the path that succeeded.
  it('stays silent when the dense half returned hits, even though coverage is partial', async () => {
    for (const f of ['fixture.ts', 'a.ts', 'b.ts', 'c.ts']) insertUnembeddedFile(path.join(TMP, f))
    insertChunk(path.join(TMP, 'fixture.ts'))
    searchSemanticMock.mockResolvedValue([
      {
        filePath: path.join(TMP, 'fixture.ts'),
        startLine: 1,
        endLine: 3,
        kind: 'window',
        distance: 0.1,
        text: 'return 2',
      },
    ] as SearchHit[])

    const { code } = await runSemantic('baz', { json: false, projectRoot: TMP })
    expect(code).toBe(0)
    expect(warnings.filter((w) => w.includes('have embeddings'))).toEqual([])
  })
})
