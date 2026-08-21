/**
 * Regression: a vector holding a NaN (or an infinity) used to be stored as readily as a real one,
 * and sqlite-vec then reports no distance at all for that row. JavaScript reads the resulting SQL
 * NULL as `null`, which compares as 0 against the distance threshold and subtracts as 0 in the
 * re-ranking, so one such row cleared every threshold and sorted ahead of every genuine match --
 * in every project sharing `global.db`, since the index is machine-wide.
 *
 * Two independent guards, tested independently: `embedTexts` refuses to hand back a vector with a
 * non-finite component (the write side), and `fetchScopedHits` ignores a row whose distance is not
 * a finite number (the read side, which also covers a row an earlier build already wrote).
 *
 * The read-side cases seed vectors directly into a real sqlite-vec-backed DB and query with a
 * hand-built vector, exactly as tests/semantic_project_scope.test.ts does -- no model inference
 * required, only the optional native extension, and the suite skips cleanly without it.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { DEFAULT_DIM, embedTexts, fetchScopedHits, insertChunkVector, packVec, setPipelineFnForTesting } from '../src/embeddings.js'
import { clearModuleCaches } from '../src/reset.js'

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return false
  }
  try {
    const sqliteVec = req('sqlite-vec') as { load: (db: unknown) => void }
    const Database = req('better-sqlite3') as new (p: string) => {
      prepare: (s: string) => { get: () => unknown }
      close: () => void
    }
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

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-nan-'))
})

afterEach(() => {
  setPipelineFnForTesting(null)
  clearModuleCaches()
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const GOOD_VEC: number[] = Array(DEFAULT_DIM).fill(0.01)

function seedChunk(dbPath: string, filePath: string, vec: number[]): void {
  const db = getDb(dbPath)
  const chunkStmt = db.prepare(
    'INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)',
  )
  const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
  const result = chunkStmt.run(filePath, 1, 1, `chunk for ${filePath}`, 'code')
  insertChunkVector(vecStmt, result.lastInsertRowid, vec)
}

/**
 * Store a poisoned row the way an older build did -- packing the bytes directly, bypassing packVec
 * -- because packVec now refuses it. The read-side guard exists precisely for rows already on disk.
 */
function seedRawChunk(dbPath: string, filePath: string, vec: number[]): void {
  const db = getDb(dbPath)
  const result = db
    .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    .run(filePath, 1, 1, `chunk for ${filePath}`, 'code')
  const view = Float32Array.from(vec)
  db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
    .run(BigInt(result.lastInsertRowid), Buffer.from(view.buffer))
}

/** A fake extractor returning one `dim`-length vector built from `fill`. */
function fakePipelineReturning(fill: (i: number) => number): () => Promise<unknown> {
  return () =>
    Promise.resolve(
      Object.assign(
        (_texts: string[] | string, _opts?: unknown) =>
          Promise.resolve({ data: Float32Array.from({ length: DEFAULT_DIM }, (_v, i) => fill(i)) }),
        { dims: [1, DEFAULT_DIM] },
      ),
    )
}

describe('embedTexts rejects a non-finite vector', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
  ])('throws when the model returns a %s component', async (_label, bad) => {
    setPipelineFnForTesting(fakePipelineReturning((i) => (i === 7 ? bad : 0.01)) as never)
    await expect(embedTexts(['some text'])).rejects.toThrow(/[Nn]on-finite embedding component at index 7/)
  })

  // A value that is finite as a JavaScript number but too large for a 32-bit float becomes
  // Infinity the instant it is written into the Float32Array, so a Number.isFinite check upstream
  // of the packing lets it through and stores exactly the poisoned row it was meant to stop.
  // packVec is the one place every stored vector passes through, so the guarantee lives there.
  it.each([
    ['1e39', 1e39],
    ['-1e39', -1e39],
    ['Number.MAX_VALUE', Number.MAX_VALUE],
  ])('packVec refuses %s, which overflows float32 to Infinity', (_label, big) => {
    const vec = Array(DEFAULT_DIM).fill(0.01)
    vec[3] = big
    expect(() => packVec(vec)).toThrow(/[Nn]on-finite embedding component at index 3/)
  })

  it('packVec still accepts an ordinary vector and packs 4 bytes per component', () => {
    expect(packVec(Array(DEFAULT_DIM).fill(0.01))).toHaveLength(DEFAULT_DIM * 4)
  })

  it('still accepts an ordinary finite vector', async () => {
    setPipelineFnForTesting(fakePipelineReturning(() => 0.01) as never)
    const vecs = await embedTexts(['some text'])
    expect(vecs).toHaveLength(1)
    expect(vecs[0]).toHaveLength(DEFAULT_DIM)
  })
})

describe.skipIf(!canExerciseVec0)('fetchScopedHits ignores a non-finite distance', () => {
  it('drops a chunk whose stored vector holds a NaN, and keeps the real match', () => {
    const dbPath = path.join(TMP, 'nan.db')
    seedChunk(dbPath, 'c:/rootA/real.ts', GOOD_VEC)
    seedRawChunk(dbPath, 'c:/rootA/poisoned.ts', Array(DEFAULT_DIM).fill(NaN))
    const db = getDb(dbPath)

    const { hits } = fetchScopedHits(db, GOOD_VEC, 10, 1.2, 'c:/rootA')

    expect(hits.map((h) => h.filePath)).toEqual(['c:/rootA/real.ts'])
  })

  it('a poisoned chunk cannot outrank a real one, even alone in the results', () => {
    const dbPath = path.join(TMP, 'nan2.db')
    seedRawChunk(dbPath, 'c:/rootA/poisoned.ts', Array(DEFAULT_DIM).fill(NaN))
    const db = getDb(dbPath)

    // A threshold of 0 admits nothing at all: before the fix the null distance compared as 0 and
    // passed even this, which is what made it sort first everywhere.
    const { hits, candidateCount } = fetchScopedHits(db, GOOD_VEC, 10, 0, 'c:/rootA')

    expect(candidateCount).toBe(1) // the ANN scan did return the row...
    expect(hits).toEqual([]) // ...and it was rejected rather than trusted
  })

  it('still returns an ordinary chunk within the threshold', () => {
    const dbPath = path.join(TMP, 'ok.db')
    seedChunk(dbPath, 'c:/rootA/real.ts', GOOD_VEC)
    const db = getDb(dbPath)

    const { hits } = fetchScopedHits(db, GOOD_VEC, 10, 1.2, 'c:/rootA')

    expect(hits).toHaveLength(1)
    expect(Number.isFinite(hits[0]?.distance)).toBe(true)
  })
})
