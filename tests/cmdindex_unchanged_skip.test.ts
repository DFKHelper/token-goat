/**
 * Regression: worker.ts's incremental drain path (makeIndexer) sha-gates so a touched-but-
 * unchanged file skips reindexing, but `cmdIndex` (the `token-goat index` bulk CLI command)
 * called indexFileSync unconditionally for every tracked file on every invocation, and
 * indexFileEmbeddings re-chunked/re-embedded every file every run even when byte-for-byte
 * unchanged. A repeated `token-goat index` over an unchanged tree did full work every time
 * instead of being a fast no-op.
 *
 * Drives the real `cmdIndex` (the shipping path for the CLI `index` command), spying only on
 * `parserModule.indexFileSync`/`indexFileEmbeddings` to count invocations while still calling
 * through to the real implementations -- the narrowest seam that preserves real DB writes
 * (files.sha / files.embed_sha), which the unchanged-skip gate itself reads.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import * as parserModule from '../src/parser.js'
import { closeAllDbs } from '../src/db.js'
import { getFileEntry, querySymbols } from '../src/index_reader.js'
import { isAvailable } from '../src/embeddings.js'

let TMP: string
let dbPath: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cmdindex-skip-'))
  dbPath = path.join(TMP, 'index.db')
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
})

afterEach(() => {
  vi.restoreAllMocks()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
})

describe('cmdIndex unchanged-file skip gate (regression)', () => {
  it('skips indexFileSync for an unchanged file on a repeat run, but still reindexes a changed file', async () => {
    // Embeddings deliberately left disabled (the tests/setup default): this isolates the
    // parse-sha half of the gate, which must skip regardless of embedding state.
    const realIndexFileSync = parserModule.indexFileSync

    const stable = path.join(TMP, 'stable.ts')
    const mutable = path.join(TMP, 'mutable.ts')
    fs.writeFileSync(stable, 'export function stableSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(mutable, 'export function mutableSymbolV1(): number {\n  return 2\n}\n')

    const indexFileSyncSpy = vi
      .spyOn(parserModule, 'indexFileSync')
      .mockImplementation((filePath, dbp) => realIndexFileSync(filePath, dbp))

    // First run: both files are new, so both must be parsed.
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(indexFileSyncSpy).toHaveBeenCalledTimes(2)
    expect(querySymbols({ name: 'stableSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
    expect(querySymbols({ name: 'mutableSymbolV1', limit: 10 }, dbPath).length).toBeGreaterThan(0)

    indexFileSyncSpy.mockClear()

    // Second run over the SAME, byte-identical tree: both files must be skipped entirely.
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(indexFileSyncSpy).not.toHaveBeenCalled()
    // The rows must still be intact -- "skipped" must not mean "lost".
    expect(querySymbols({ name: 'stableSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)

    indexFileSyncSpy.mockClear()

    // Now change one file's content and run a third time: the unchanged file must still be
    // skipped, but the changed file must be reprocessed.
    fs.writeFileSync(mutable, 'export function mutableSymbolV2(): number {\n  return 3\n}\n')
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(indexFileSyncSpy).toHaveBeenCalledTimes(1)
    expect(indexFileSyncSpy).toHaveBeenCalledWith(expect.stringContaining('mutable.ts'), dbPath)
    expect(querySymbols({ name: 'mutableSymbolV1', limit: 10 }, dbPath).length).toBe(0)
    expect(querySymbols({ name: 'mutableSymbolV2', limit: 10 }, dbPath).length).toBeGreaterThan(0)
    expect(querySymbols({ name: 'stableSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })

  // Regression: a parser.ts change to what extractRefs/valueRefIdentifiers extracts (e.g. the
  // extends-clause fix) leaves every already-indexed file's SHA untouched, so the unchanged-skip
  // gate above silently keeps serving stale symbols/refs computed under the old parser until each
  // file happens to be edited -- there was no way to force a full reindex short of deleting the
  // db. --force must bypass both the parse-sha and embed-sha freshness checks unconditionally.
  it('--force reindexes an unchanged file instead of skipping it', async () => {
    const realIndexFileSync = parserModule.indexFileSync
    const src = path.join(TMP, 'stable.ts')
    fs.writeFileSync(src, 'export function stableSymbol(): number {\n  return 1\n}\n')

    const indexFileSyncSpy = vi
      .spyOn(parserModule, 'indexFileSync')
      .mockImplementation((filePath, dbp) => realIndexFileSync(filePath, dbp))

    await cmdIndex(TMP, { walk: true, dbPath })
    expect(indexFileSyncSpy).toHaveBeenCalledTimes(1)
    indexFileSyncSpy.mockClear()

    // Without --force: byte-identical content skips.
    await cmdIndex(TMP, { walk: true, dbPath })
    expect(indexFileSyncSpy).not.toHaveBeenCalled()
    indexFileSyncSpy.mockClear()

    // With --force: same byte-identical content must still be reparsed.
    await cmdIndex(TMP, { walk: true, dbPath, force: true })
    expect(indexFileSyncSpy).toHaveBeenCalledTimes(1)
    expect(querySymbols({ name: 'stableSymbol', limit: 10 }, dbPath).length).toBeGreaterThan(0)
  })

  // A file only becomes fully skippable (indexFileSync AND indexFileEmbeddings both gated out,
  // surfaced via the "Skipped N unchanged file(s)" summary line) once it has both a matching
  // parse-sha AND a matching embed-sha -- see the embed-freshness test below for why these are
  // tracked independently. With embeddings left at the tests/setup default (disabled), embed_sha
  // never gets stamped, so this needs the same real pipeline as that test to observe the full
  // "skipped" (not just "indexed with a no-op reparse") outcome.
  it.skipIf(!isAvailable())(
    'prints a skipped count in the summary once a file is fully unchanged (parse + embed)',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const src = path.join(TMP, 'printed.ts')
      fs.writeFileSync(src, 'export function printedSymbol(): number {\n  return 1\n}\n')

      await cmdIndex(TMP, { walk: true, dbPath })

      const stdoutChunks: string[] = []
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
        stdoutChunks.push(String(chunk))
        return true
      })
      try {
        await cmdIndex(TMP, { walk: true, dbPath })
      } finally {
        stdoutSpy.mockRestore()
      }
      expect(stdoutChunks.join('')).toMatch(/skipped 1 unchanged file/i)
    },
  )

  // Embeddings require the real @xenova/transformers + sqlite-vec pipeline to actually stamp
  // files.embed_sha, so this test is skipped when that pipeline isn't usable in this environment
  // (mirrors the skipIf gating already used in tests/embeddings_index_wiring.test.ts).
  it.skipIf(!isAvailable())(
    'also skips indexFileEmbeddings once a file has been successfully embedded and content is unchanged',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const realIndexFileEmbeddings = parserModule.indexFileEmbeddings

      const src = path.join(TMP, 'embedded.ts')
      fs.writeFileSync(src, 'export function embeddedSymbol(): number {\n  return 1\n}\n')

      const embedSpy = vi
        .spyOn(parserModule, 'indexFileEmbeddings')
        .mockImplementation((filePath, dbp, sha) => realIndexFileEmbeddings(filePath, dbp, sha))

      await cmdIndex(TMP, { walk: true, dbPath })
      expect(embedSpy).toHaveBeenCalledTimes(1)
      const key = path.resolve(src)
      expect(getFileEntry(key, dbPath)?.embedSha).not.toBe('')

      embedSpy.mockClear()
      await cmdIndex(TMP, { walk: true, dbPath })
      expect(embedSpy).not.toHaveBeenCalled()
    },
  )
})
