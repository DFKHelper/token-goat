/**
 * Embedding freshness must be decided on `files.embed_sha` alone, never on parse freshness.
 *
 * Both shipping index paths -- `worker.ts::makeIndexer` (the dirty-queue drain) and `cli.ts::cmdIndex`
 * (`token-goat index`) -- conjoined `parseUnchanged` into `embedUnchanged`. `files.parser_sha` answers
 * "which extractor wrote the symbol/ref rows"; it says nothing about whether the stored vectors still
 * describe this content. Conjoining it meant a parser-stamp bump re-embedded every file in the index
 * even though the bytes never moved, and made `writeParseResult`'s `embedShaToCarry` dead for exactly
 * the waste its own comment says it exists to prevent. Measured before the fix on an isolated 300-file
 * project: a stamp-only reparse cost 94% of the work of indexing from nothing (reparse 12257ms, full
 * 12908ms, against a 347ms no-op floor).
 *
 * Driven on the real default wiring -- `drainOnce` with no injected callback, and `cmdIndex` itself --
 * with only the embedding backend stubbed (`setPipelineFnForTesting`, as in
 * tests/embeddings_chunker_change_keeps_vectors.test.ts), since a real model is not what this is about.
 *
 * Provenance: HAND-DERIVED. The fixture is forty one-line exported functions; the stale parser stamp is
 * written by this file, and the expectation -- chunk rows keep their identity across a stamp-only
 * reparse, and are rebuilt when the content really moves or the path spelling does -- is computed from
 * what a reparse means, not read back out of any gate in `src/`.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cmdIndex } from '../src/cli.js'
import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, isAvailable, setPipelineFnForTesting } from '../src/embeddings.js'
import { PARSER_FINGERPRINT } from '../src/parser_fingerprint.js'
import { isCaseInsensitiveFs } from '../src/path_containment.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

// PROVENANCE: HAND-DERIVED. Forty one-line exported functions, enough that the chunker produces more than one chunk and far under any size threshold.
const SOURCE = Array.from({ length: 40 }, (_, i) => `export function stampGateFn${i}(): number { return ${i} }`).join('\n') + '\n'

// Same three-state classification tests/embeddings_chunker_change_keeps_vectors.test.ts uses: 'absent' is a legitimate platform skip, 'broken' would be silent-dead semantic search and must fail rather than hide.
function classifyVec0(): 'working' | 'broken' | 'absent' {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return 'working'
  } catch {
    return 'broken'
  }
}

const canExerciseRealEmbed = classifyVec0() === 'working' && isAvailable()

let TMP: string
let DB_PATH: string
let SRC: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tg-stamp-embed-'))
  DB_PATH = path.join(TMP, 'global.db')
  SRC = normalizePath(path.join(TMP, 'stamp_gate.ts'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); the gate under test only decides anything with them on.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function chunkRows(): { id: number; file_path: string }[] {
  return getDb(DB_PATH).prepare('SELECT id, file_path FROM chunks ORDER BY id').all() as { id: number; file_path: string }[]
}

function vectorCount(): number {
  return getDb(DB_PATH).prepare('SELECT COUNT(*) FROM chunk_vectors').pluck().get() as number
}

function enqueue(p: string): void {
  fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
  fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${p}\n`)
}

/** Index and embed the fixture for real through the worker's default wiring, then return the chunk rows that reparse must not disturb. */
async function indexAndEmbed(): Promise<{ id: number; file_path: string }[]> {
  fs.writeFileSync(SRC, SOURCE, 'utf8')
  for (const args of [['init'], ['add', '-A']]) spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
  enqueue(SRC)
  expect(drainOnce(TMP)).toBe(1)
  await pendingEmbeddings()
  const rows = chunkRows()
  // Calibration: the real embed path ran, so "these rows survived" below is a claim about live vectors rather than about an empty table.
  expect(rows.length, 'the fixture produced no chunks, so nothing below could be disturbed anyway').toBeGreaterThan(1)
  expect(vectorCount()).toBe(rows.length)
  expect(getDb(DB_PATH).prepare('SELECT embed_sha FROM files').pluck().get()).toBe(
    getDb(DB_PATH).prepare('SELECT sha FROM files').pluck().get(),
  )
  return rows
}

/** Put the file in the state an upgraded binary meets: same bytes on disk, symbol rows written by an older extractor. */
function makeParserStampStale(): void {
  getDb(DB_PATH).prepare('UPDATE files SET parser_sha = ?').run('0000000000000000')
}

function parserSha(): string {
  return getDb(DB_PATH).prepare('SELECT parser_sha FROM files').pluck().get() as string
}

describe.skipIf(!canExerciseRealEmbed)('a stale parser stamp does not force a re-embed', () => {
  it('leaves the chunks and vectors alone when the worker reparses for a parser-stamp bump alone', async () => {
    const before = await indexAndEmbed()
    makeParserStampStale()

    enqueue(SRC)
    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    expect(parserSha(), 'the stamp bump must actually reparse the file, or this test also passes on a gate that does nothing').toBe(PARSER_FINGERPRINT)
    expect(chunkRows(), 'a parser-stamp-only reparse re-embedded the file, discarding vectors that still describe its unchanged content').toEqual(before)
    expect(vectorCount()).toBe(before.length)
  })

  it('leaves the chunks and vectors alone when `token-goat index` reparses for a parser-stamp bump alone', async () => {
    const before = await indexAndEmbed()
    makeParserStampStale()

    await cmdIndex(TMP, { dbPath: DB_PATH })

    expect(parserSha(), 'cmdIndex must reparse a stamp-stale file, or this test proves nothing about its embed gate').toBe(PARSER_FINGERPRINT)
    expect(chunkRows(), 'cmdIndex holds its own copy of this gate and re-embedded on a parser-stamp bump').toEqual(before)
    expect(vectorCount()).toBe(before.length)
  })

  it('calibration: content that really moved is still re-embedded, so survival above is not an inert embedding step', async () => {
    const before = await indexAndEmbed()
    fs.writeFileSync(SRC, `${SOURCE}export const extra = 1\n`, 'utf8')

    enqueue(SRC)
    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    expect(chunkRows().map((r) => r.id), 'changed content kept its old chunk rows; if this passes, the two tests above prove nothing').not.toEqual(before.map((r) => r.id))
  })

  it.runIf(isCaseInsensitiveFs())('still re-embeds under a case-only rename, whose chunk rows carry the old path spelling', async () => {
    await indexAndEmbed()
    // Content is byte-identical across such a rename, so isEmbedFresh says fresh -- but `chunks` is keyed by file_path, and left alone the rows would name a spelling the file no longer has. This is the one parse-side condition the embed gate must keep.
    const renamed = normalizePath(path.join(TMP, 'Stamp_Gate.ts'))
    fs.renameSync(SRC, renamed)

    enqueue(renamed)
    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    const spellings = [...new Set(chunkRows().map((r) => r.file_path))]
    expect(spellings, 'the chunk rows kept the pre-rename spelling, where nothing keyed on the current one can reach them').toEqual([renamed])
  })
})
