/** A chunker-only change (EMBED_FINGERPRINT moved while the model, revision and runtime did not) used to discard every vector in the machine-wide index, so `semantic` came back empty in every project until each was reindexed by hand; embeddings.ts is itself a hashed source, so any edit to it did this. Driven on the real default wiring: the worker's makeIndexer through drainOnce with no injected callback, searchSemantic on a fresh connection, and reconcileProject finding the file nobody edited. The embedding backend is the one thing stubbed (setPipelineFnForTesting, as in tests/index_embedding_provenance_regate.test.ts), since a real model is not what this is about. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, embeddingProvenance, isAvailable, searchSemantic, setPipelineFnForTesting } from '../src/embeddings.js'
import { normalizePath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'

// PROVENANCE: HAND-DERIVED. Forty one-line exported functions, enough for several chunks and far under any size threshold; the stale stamp is the running stack's own with only its `/embed-` suffix swapped, the state an edit to any embedding source leaves behind.
const SOURCE = Array.from({ length: 40 }, (_, i) => `export function chunkerChangeFn${i}(): number { return ${i} }`).join('\n') + '\n'

// Same three-state classification tests/embeddings_vec_insert.test.ts uses: 'absent' is a legitimate platform skip, 'broken' would be silent-dead semantic search and must fail rather than hide.
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
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-chunker-change-'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  // The suite forces embeddings off (tests/setup/isolate-home.ts); the path under test only runs with them on.
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
  setPipelineFnForTesting(
    (async () => async (text: string) => ({
      data: Float32Array.from({ length: DEFAULT_DIM }, (_, i) => ((text.length + i) % 17) / 1700),
    })) as never,
  )
})

afterEach(() => {
  setPipelineFnForTesting(null)
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('a chunker-only embedding change', () => {
  it.skipIf(!canExerciseRealEmbed)('keeps semantic search answering, then rebuilds each file exactly once', async () => {
    const workerDb = path.join(TMP, 'global.db')
    const src = normalizePath(path.join(TMP, 'chunker_change.ts'))
    fs.writeFileSync(src, SOURCE, 'utf8')
    for (const args of [['init'], ['add', '-A']]) spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
    fs.mkdirSync(path.join(TMP, 'queue'), { recursive: true })
    fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${src}\n`)

    expect(drainOnce(TMP)).toBe(1)
    await pendingEmbeddings()

    const db = getDb(workerDb)
    const chunkIds = (): number[] => getDb(workerDb).prepare('SELECT id FROM chunks ORDER BY id').pluck().all() as number[]
    const vectorCount = (): number => getDb(workerDb).prepare('SELECT COUNT(*) FROM chunk_vectors').pluck().get() as number
    const embedSha = (): string | null => getDb(workerDb).prepare('SELECT embed_sha FROM files').pluck().get() as string | null
    const sha = db.prepare('SELECT sha FROM files').pluck().get() as string
    const before = chunkIds()
    // Calibration: the real embed path ran and stamped the file, and a fresh index has nothing embed-stale, so the cases below are a change under live vectors rather than a check over an empty index.
    expect(before.length).toBeGreaterThan(1)
    expect(vectorCount()).toBe(before.length)
    expect(embedSha()).toBe(sha)
    expect(reconcileProject({ cwd: TMP, dbPath: workerDb, dryRun: true }).embedStale).toBe(0)

    db.prepare('UPDATE embedding_provenance SET provenance = ? WHERE id = 1').run(
      embeddingProvenance().replace(/\/embed-[0-9a-f]{16}/, '/embed-0000000000000000'),
    )
    // A new process, which is what an upgrade is: the provenance check is memoized per connection.
    closeAllDbs()

    const hits = await searchSemantic(getDb(workerDb), 'chunkerChangeFn function', 5, undefined, 2)
    expect(hits.length, 'semantic search came back empty after a chunker-only change').toBeGreaterThan(0)
    expect(chunkIds()).toEqual(before)
    expect(vectorCount()).toBe(before.length)
    expect(embedSha(), 'the file was not marked stale for re-embedding').toBeNull()
    expect(getDb(workerDb).prepare('SELECT provenance FROM embedding_provenance WHERE id = 1').pluck().get()).toBe(embeddingProvenance())

    // Nobody edits the file, so only the sweep can find it.
    const sweep = reconcileProject({ cwd: TMP, dbPath: workerDb, dryRun: true })
    expect(sweep.embedStale).toBe(1)
    expect(sweep.changed.map((p) => normalizePath(p))).toEqual([src])

    fs.writeFileSync(path.join(TMP, 'queue', 'dirty.txt'), `${src}\n`)
    drainOnce(TMP)
    await pendingEmbeddings()

    const after = chunkIds()
    expect(after.length, 're-embedding duplicated the file\'s chunks instead of replacing them').toBe(before.length)
    expect(after.filter((id) => before.includes(id)), 'the old chunks were not rebuilt').toEqual([])
    expect(vectorCount()).toBe(after.length)
    expect(embedSha()).toBe(sha)
    expect(reconcileProject({ cwd: TMP, dbPath: workerDb, dryRun: true }).embedStale).toBe(0)
  })
})
