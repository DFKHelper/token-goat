/**
 * Guard: a project-scoped semantic search must keep working once the machine-wide index outgrows the ANN scan's own row ceiling.
 *
 * `global.db` is shared by every project on the machine and vec0 has no partition column, so the ANN scan cannot be scoped: `searchSemantic` over-fetches candidates, filters them by project root afterwards, and grows `k` when too few survive. The growth was bounded only by the table's row count, on the reasoning that a fixed candidate ceiling is the cap-before-predicate shape and that the data itself should decide when to stop. sqlite-vec disagrees: it refuses `k` above 4096 with an error rather than truncating, so the escalation 100 -> 300 -> 900 -> 2700 -> 8100 throws on its fourth retry, and the caller reports semantic matching as unavailable for the whole query. The bound the code declined to place was enforced as an exception instead.
 *
 * Measured through the shipping bundle before the fix, against this machine's own index (209,208 chunk rows): indexing a one-file project and asking for its only symbol in words returned `Matching on meaning is off (k value in knn query too large, provided 8100 and the limit is 4096)` followed by no matches at all. An indexed, embedded, in-project answer came back as nothing.
 *
 * The fix clamps the scan at the ceiling and, when that is still not enough, ranks the project's own chunks exactly instead -- predicate first, then cap, which is what the backfill was reaching for and could not express through an unscoped scan. Both halves are required here: 4,200 out-of-project chunks sit closer than the answer, so a clamp alone would return an empty result rather than an error.
 *
 * HAND-DERIVED: every vector is constructed so the ranking is arithmetic rather than luck. Out-of-project chunks get the query vector exactly (distance 0); the single in-project chunk differs in one component by 0.01, so its L2 distance is 0.01 exactly and the last test can check the reported distance against a number computed here rather than read off the implementation. The 4096 ceiling is CAPTURE, quoted from sqlite-vec's own refusal.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../../src/db.js'
import { DEFAULT_DIM, ensureEmbeddingProvenance, insertChunkVector, MAX_OVER_FETCH, searchSemantic, setPipelineFnForTesting, VEC_MAX_K } from '../../src/embeddings.js'
import { clearModuleCaches } from '../../src/reset.js'
import Database from '../../src/sqlite_driver.js'

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

/** sqlite-vec's own ceiling, written out here rather than imported: a fixture sized from the constant under test would resize itself along with a wrong value for it, and a fixture that computes to nothing still reports green. The first test below holds this number to what the library actually does, and the second holds the product's constant to this number. */
const ANN_K_CEILING = 4096

/** Past the ANN ceiling, so the retry schedule both overruns what sqlite-vec accepts and cannot reach the answer even at the largest scan it does accept. */
const OUTSIDE_CHUNKS = ANN_K_CEILING + 104

/** The one component the in-project vector differs by, which is therefore its exact L2 distance from the query. */
const PERTURBATION = 0.01

let TMP: string

function seed(dbFile: string, opts: { withTarget: boolean }): ReturnType<typeof getDb> {
  const db = getDb(path.join(TMP, dbFile))
  ensureEmbeddingProvenance(db)
  const chunkStmt = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
  const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
  const exact = Array.from<number>({ length: DEFAULT_DIM }).fill(0.01)

  db.transaction(() => {
    for (let i = 0; i < OUTSIDE_CHUNKS; i++) {
      const row = chunkStmt.run(`c:/rootB/file${String(i)}.ts`, 1, 1, `rootB chunk ${String(i)}`, 'code')
      insertChunkVector(vecStmt, row.lastInsertRowid, exact)
    }
    if (opts.withTarget) {
      const perturbed = [...exact]
      perturbed[0] = exact[0]! + PERTURBATION
      const target = chunkStmt.run('c:/rootA/only.ts', 1, 1, 'THE ONE ROOTA CHUNK', 'code')
      insertChunkVector(vecStmt, target.lastInsertRowid, perturbed)
    }
  })()

  return db
}

function stubQueryVector(): void {
  const queryVec = new Float32Array(DEFAULT_DIM).fill(0.01)
  setPipelineFnForTesting(vi.fn(async () => vi.fn(async () => ({ data: queryVec }))))
}

describe.skipIf(!canExerciseVec0)('semantic search on an index past the ANN ceiling', () => {
  beforeEach(() => {
    clearModuleCaches()
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-annceiling-'))
  })

  afterEach(() => {
    setPipelineFnForTesting(null)
    closeAllDbs()
    clearModuleCaches()
    fs.rmSync(TMP, { recursive: true, force: true })
  })

  it('refuses a scan wider than the ceiling, which is why the ceiling has to be respected rather than discovered', () => {
    // CAPTURE, and the reason this whole file exists: the library answers an oversized scan with an exception, not with the truncation a bound normally gets.
    const db = seed('ceiling-probe.db', { withTarget: false })
    const vec = Buffer.from(new Float32Array(DEFAULT_DIM).fill(0.01).buffer)
    const scan = (k: number): unknown[] => db.prepare('SELECT rowid FROM chunk_vectors WHERE embedding MATCH ? AND k = ?').all(vec, k)
    expect(scan(ANN_K_CEILING)).toHaveLength(ANN_K_CEILING)
    expect(() => scan(ANN_K_CEILING + 1)).toThrow(/k value in knn query too large/)
  })

  it('is the number the search actually clamps to, so an upgrade that moves the ceiling cannot pass silently', () => {
    expect(VEC_MAX_K).toBe(ANN_K_CEILING)
  })

  it('finds the in-project chunk when every closer chunk belongs to another project and the index is larger than the ceiling', async () => {
    stubQueryVector()
    const db = seed('past-ceiling.db', { withTarget: true })

    const hits = await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')

    // Before the fix this threw instead of returning, and the caller turned the throw into "matching on meaning is off". An empty result is no better: the caller cannot tell it from a project with nothing to match.
    expect(hits.length, `scoped search returned nothing while c:/rootA/only.ts sat behind ${String(OUTSIDE_CHUNKS)} closer out-of-project chunks`).toBeGreaterThan(0)
    expect(hits[0]?.filePath).toBe('c:/rootA/only.ts')
    expect(hits.some((h) => h.filePath.includes('rootB'))).toBe(false)
  })

  it('reports the same distance the scan would, so the fallback cannot quietly change what the threshold means', async () => {
    // The scan ranks by vec0's MATCH distance, which is L2 -- the table is declared with no distance_metric. A fallback ranking by cosine would order these fixtures identically and still be wrong: every stored vector is unit-normalized only after the model runs, and the maxDistance callers pass is an L2 number. One component differs by 0.01, so 0.01 is the whole distance.
    stubQueryVector()
    const db = seed('distance.db', { withTarget: true })

    const hits = await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')

    expect(hits[0]?.distance).toBeCloseTo(PERTURBATION, 5)
  })

  it('is not crowded out by in-project rows whose stored vector holds a NaN', async () => {
    // The row limit has to run after the distance test, not before it. A NaN component makes the distance SQL NULL, NULL sorts ahead of every real distance under ASC, and a limit applied first is spent entirely on rows that are not matches -- a filter in JavaScript afterwards cannot recover what the query already discarded. The count is what makes this bite: a page the poisoned rows do not fill leaves room for the answer behind them, and MAX_OVER_FETCH is the ceiling on how wide that page can ever be, so seeding past it is the only size that holds whatever the over-fetch arithmetic becomes.
    stubQueryVector()
    const db = seed('poisoned.db', { withTarget: true })
    const chunkStmt = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
    const poison = Buffer.from(new Float32Array(DEFAULT_DIM).fill(Number.NaN).buffer)
    db.transaction(() => {
      for (let i = 0; i < MAX_OVER_FETCH + 8; i++) {
        // Inserted raw rather than through insertChunkVector, which refuses a non-finite vector outright. Rows like these were written by earlier builds and are still on disk.
        const row = chunkStmt.run(`c:/rootA/poisoned${String(i)}.ts`, 1, 1, `poisoned ${String(i)}`, 'code')
        vecStmt.run(BigInt(row.lastInsertRowid), poison)
      }
    })()

    const hits = await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')

    expect(hits.map((h) => h.filePath)).toEqual(['c:/rootA/only.ts'])
  })

  it('still returns nothing for a project that has no chunk at all, so the case above is not passing by accident', async () => {
    // Calibration in the other direction. A fallback that scanned the whole table instead of the project's slice of it would answer this one with rootB rows.
    stubQueryVector()
    const db = seed('empty-scope.db', { withTarget: false })

    expect(await searchSemantic(db, 'anything', 3, undefined, 1.2, 'c:/rootA')).toHaveLength(0)
  })

  it('excludes an in-project chunk that sits beyond maxDistance, so the fallback keeps the threshold it inherited', async () => {
    stubQueryVector()
    const db = seed('threshold.db', { withTarget: true })

    // The target's distance is exactly PERTURBATION, so a threshold just under it must exclude it and a threshold just over it must not.
    expect(await searchSemantic(db, 'anything', 3, undefined, PERTURBATION / 2, 'c:/rootA')).toHaveLength(0)
    expect(await searchSemantic(db, 'anything', 3, undefined, PERTURBATION * 2, 'c:/rootA')).toHaveLength(1)
  })
})
