/**
 * A project-scoped semantic search must not report "no match" because closer chunks belonged to
 * other projects.
 *
 * `global.db` is machine-wide: every project ever indexed shares one `chunk_vectors` table, and vec0
 * has no partition column, so the ANN scan cannot be scoped. `fetchScopedHits` therefore caps the
 * scan with `AND k = ?` and applies the project-root predicate afterwards, per candidate row. That is
 * the cap-before-predicate shape this repo has shipped before: the limit runs in one layer and the
 * predicate that decides what was wanted runs in the next, so the answer can be discarded before it
 * is ever considered.
 *
 * `searchSemantic` softens it with one backfill retry at BACKFILL_MULTIPLIER times the over-fetch,
 * bounded by MAX_OVER_FETCH. Bounded is the operative word: past that ceiling of candidates there is
 * no further retry and no signal to the caller. A project whose nearest chunk ranks past the ceiling
 * gets an empty result that is indistinguishable from having nothing to match.
 *
 * Provenance: HAND-DERIVED. The vectors here are constructed so the ranking is decided arithmetic,
 * not luck: every out-of-project chunk is given the exact query vector (distance 0) and the single
 * in-project chunk a perturbed copy (distance > 0, still inside maxDistance). Ordering by distance
 * therefore puts every out-of-project chunk ahead of the answer, deterministically, with no reliance
 * on tie-break order among equal distances. No model runs: setPipelineFnForTesting supplies the query
 * vector, as the BGE-prefix tests in tests/semantic_project_scope.test.ts already do.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { ensureEmbeddingProvenance, insertChunkVector, searchSemantic, setPipelineFnForTesting, DEFAULT_DIM, MAX_OVER_FETCH } from '../src/embeddings.js'
import { clearModuleCaches } from '../src/reset.js'
import Database from '../src/sqlite_driver.js'

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return false
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const probe = new Database(':memory:')
    sqliteVec.load(probe)
    probe.prepare('SELECT vec_version()').get()
    probe.close()
    return true
  } catch {
    return false
  }
}

const canExerciseVec0 = vec0Working()

describe.skipIf(!canExerciseVec0)('project-scoped semantic search past the candidate ceiling', () => {
  let TMP: string

  beforeEach(() => {
    clearModuleCaches()
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-ceiling-'))
  })

  afterEach(() => {
    closeAllDbs()
    clearModuleCaches()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  /** Comfortably past MAX_OVER_FETCH, so no retry schedule bounded by that ceiling can reach the answer. */
  const OUTSIDE_CHUNKS = MAX_OVER_FETCH + 50

  it('finds the in-project chunk even when more than MAX_OVER_FETCH closer chunks belong to other projects', async () => {
    const queryVec = new Float32Array(DEFAULT_DIM).fill(0.01)
    setPipelineFnForTesting(vi.fn(async () => vi.fn(async () => ({ data: queryVec }))))

    const db = getDb(path.join(TMP, 'ceiling.db'))
    ensureEmbeddingProvenance(db)
    const chunkStmt = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')

    const exact = Array.from(queryVec)
    for (let i = 0; i < OUTSIDE_CHUNKS; i++) {
      const r = chunkStmt.run(`c:/rootB/file${String(i)}.ts`, 1, 1, `rootB chunk ${String(i)}`, 'code')
      insertChunkVector(vecStmt, r.lastInsertRowid, exact)
    }
    // Perturbed on one component only: far enough to sort behind every exact match, near enough to stay well inside maxDistance so a miss cannot be blamed on the distance threshold.
    const perturbed = Array.from(queryVec)
    perturbed[0] = 0.02
    const target = chunkStmt.run('c:/rootA/only.ts', 1, 1, 'THE ONE ROOTA CHUNK', 'code')
    insertChunkVector(vecStmt, target.lastInsertRowid, perturbed)

    const hits = await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')

    // An empty result here is the defect, and it is worse than a wrong result: the caller cannot tell it from a project that genuinely has no match.
    expect(hits.length, `scoped search returned nothing while c:/rootA/only.ts sat at rank ${String(OUTSIDE_CHUNKS + 1)}`).toBeGreaterThan(0)
    expect(hits[0]?.filePath).toBe('c:/rootA/only.ts')
    expect(hits.some((h) => h.filePath.includes('rootB'))).toBe(false)
  })

  it('still returns nothing when the project genuinely has no chunk, so the case above is not passing by accident', async () => {
    const queryVec = new Float32Array(DEFAULT_DIM).fill(0.01)
    setPipelineFnForTesting(vi.fn(async () => vi.fn(async () => ({ data: queryVec }))))

    const db = getDb(path.join(TMP, 'empty-scope.db'))
    ensureEmbeddingProvenance(db)
    const chunkStmt = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
    const exact = Array.from(queryVec)
    for (let i = 0; i < OUTSIDE_CHUNKS; i++) {
      const r = chunkStmt.run(`c:/rootB/file${String(i)}.ts`, 1, 1, `rootB chunk ${String(i)}`, 'code')
      insertChunkVector(vecStmt, r.lastInsertRowid, exact)
    }

    expect(await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')).toHaveLength(0)
  })
})
