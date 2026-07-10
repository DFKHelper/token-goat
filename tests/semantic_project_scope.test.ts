/**
 * Regression: `global.db` is a single machine-wide index keyed by absolute path across every
 * project ever indexed (see constants.ts). `searchSemantic`'s sqlite-vec KNN query used to run
 * completely unscoped, so `token-goat semantic` silently mixed in chunks from unrelated projects
 * that happened to share the same index, and `runSemantic` (read_commands.ts) never post-filtered
 * by cwd/project root either.
 *
 * sqlite-vec's vec0 `chunk_vectors` table stores only (rowid, embedding) -- there is no
 * partition/file_path column to scope the ANN (MATCH + k) query itself against, so the fix
 * over-fetches candidates and post-filters each candidate's joined chunk metadata against the
 * project root via `projectScopeClause`, backfilling with a larger `k` once if too few survive.
 *
 * `fetchScopedHits` takes a raw query vector (not text), so these tests seed real vectors
 * directly into a real sqlite-vec-backed DB and query with a hand-built vector -- no embedding
 * model / network / inference required, only the optional native sqlite-vec extension. Skips
 * cleanly (not silently) when sqlite-vec isn't installed/loadable, mirroring
 * tests/semantic_embeddings_e2e.test.ts's classifyVec0() gate.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import {
  embedTexts,
  fetchScopedHits,
  insertChunkVector,
  isAvailable,
  searchSemantic,
  setPipelineFnForTesting,
  DEFAULT_DIM,
  QUERY_INSTRUCTION_PREFIX,
} from '../src/embeddings.js'
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
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sem-scope-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// A fixed, arbitrary 384-dim vector. All test chunks share this exact embedding, so every
// candidate is at distance 0 -- no need for a real model to produce a meaningful vector.
const QUERY_VEC: number[] = Array(DEFAULT_DIM).fill(0.01)

function seedChunk(dbPath: string, filePath: string, text: string): void {
  const db = getDb(dbPath)
  const chunkStmt = db.prepare(
    'INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)',
  )
  const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
  const result = chunkStmt.run(filePath, 1, 1, text, 'code')
  insertChunkVector(vecStmt, result.lastInsertRowid, QUERY_VEC)
}

describe.skipIf(!canExerciseVec0)('fetchScopedHits (project scoping SQL)', () => {
  it('boundary correctness: rootDir scoping never returns a chunk from a different project root', () => {
    const dbPath = path.join(TMP, 'index.db')
    seedChunk(dbPath, 'c:/rootA/a.ts', 'chunk from project A')
    seedChunk(dbPath, 'c:/rootB/b.ts', 'chunk from project B')
    const db = getDb(dbPath)

    const { hits } = fetchScopedHits(db, QUERY_VEC, 10, 1.2, 'c:/rootA')

    expect(hits.length).toBe(1)
    expect(hits[0]?.filePath).toBe('c:/rootA/a.ts')
    expect(hits.some((h) => h.filePath.includes('rootB'))).toBe(false)
  })

  it('boundary correctness: a rootDir prefix does not accidentally match a sibling directory (rootA vs rootA-other)', () => {
    const dbPath = path.join(TMP, 'index2.db')
    seedChunk(dbPath, 'c:/rootA-other/x.ts', 'chunk from sibling project')
    const db = getDb(dbPath)

    const { hits } = fetchScopedHits(db, QUERY_VEC, 10, 1.2, 'c:/rootA')

    expect(hits.length).toBe(0)
  })

  it('an unscoped call (rootDir omitted) returns chunks from every project', () => {
    const dbPath = path.join(TMP, 'index3.db')
    seedChunk(dbPath, 'c:/rootA/a.ts', 'chunk from project A')
    seedChunk(dbPath, 'c:/rootB/b.ts', 'chunk from project B')
    const db = getDb(dbPath)

    const { hits } = fetchScopedHits(db, QUERY_VEC, 10, 1.2, undefined)

    expect(hits.length).toBe(2)
  })

  it('reports candidateCount equal to the number of raw ANN rows, independent of scoping', () => {
    const dbPath = path.join(TMP, 'index4.db')
    seedChunk(dbPath, 'c:/rootA/a.ts', 'chunk from project A')
    seedChunk(dbPath, 'c:/rootB/b.ts', 'chunk from project B')
    const db = getDb(dbPath)

    const { hits, candidateCount } = fetchScopedHits(db, QUERY_VEC, 10, 1.2, 'c:/rootA')

    expect(candidateCount).toBe(2) // both rows came back from the KNN scan...
    expect(hits.length).toBe(1) // ...but only one survived the project-root filter
  })
})

// searchSemantic's own internal call to embedTexts (for the query) cannot be mocked from outside
// the module -- vi.mock only intercepts external imports, not a module's calls to its own other
// exports -- so this suite needs a real model load. Gated the same way
// tests/semantic_embeddings_e2e.test.ts gates its real-inference assertions: sqlite-vec must load
// AND isAvailable() (the @xenova/transformers package) must be true. To stay deterministic
// without depending on the model's actual semantic judgment, the test embeds a fixed seed string
// once itself (via the real, exported embedTexts) and reuses that literal vector to seed every
// test chunk -- so every chunk is at (near-)zero distance from the query embedded inside
// searchSemantic for the identical string, and the only thing under test is the project-scope
// filtering/backfill, not embedding quality.
//
// searchSemantic prefixes the query text with QUERY_INSTRUCTION_PREFIX before embedding it
// (BGE's asymmetric retrieval convention -- see embeddings.ts), so the seed vectors below must
// be embedded from the *prefixed* string too, or they'd sit at a nonzero distance from what
// searchSemantic actually embeds internally and the maxDistance assertion below would flake.
const canExerciseRealEmbeddings = canExerciseVec0 && isAvailable()
const SEED_QUERY = 'a fixed seed string for deterministic distance-zero test vectors'

describe.skipIf(!canExerciseRealEmbeddings)('searchSemantic project scoping + backfill', () => {
  // Regression: without the fix, this over-fetch/backfill loop never ran and searchSemantic
  // returned raw ANN hits regardless of rootDir. Seed many rootB chunks ahead of a single rootA
  // chunk so the first (small) over-fetch pass can plausibly miss the one rootA hit among a
  // crowd of rootB candidates, proving the backfill retry recovers it rather than just getting
  // lucky on the first pass.
  it(
    'never returns a hit from a different project root, even when the scoped project has few matching chunks',
    async () => {
      const dbPath = path.join(TMP, 'index5.db')
      const seedEmbeddings = await embedTexts([`${QUERY_INSTRUCTION_PREFIX}${SEED_QUERY}`])
      const seedVec = seedEmbeddings[0]
      expect(seedVec).toBeDefined()
      if (!seedVec) return

      const db = getDb(dbPath)
      const chunkStmt = db.prepare(
        'INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)',
      )
      const vecStmt = db.prepare('INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)')
      for (let i = 0; i < 20; i++) {
        const result = chunkStmt.run(`c:/rootB/file${i}.ts`, 1, 1, `rootB chunk ${i}`, 'code')
        insertChunkVector(vecStmt, result.lastInsertRowid, seedVec)
      }
      const rootAResult = chunkStmt.run('c:/rootA/only.ts', 1, 1, 'the one rootA chunk', 'code')
      insertChunkVector(vecStmt, rootAResult.lastInsertRowid, seedVec)

      const topK = 3
      const hits = await searchSemantic(db, SEED_QUERY, topK, undefined, 1.2, 'c:/rootA')

      expect(hits.length).toBeGreaterThan(0)
      expect(hits.every((h) => h.filePath.startsWith('c:/rootA'))).toBe(true)
      expect(hits.some((h) => h.filePath.includes('rootB'))).toBe(false)
    },
    30000,
  )
})

// Regression (round 10 #39): BGE's retrieval-tuned checkpoints expect an asymmetric
// instruction prefix on the query side only -- document/chunk embedding stays plain. This
// doesn't need a real model: setPipelineFnForTesting injects a fake extractor so the test can
// see exactly what text searchSemantic hands to embedTexts internally.
describe.skipIf(!canExerciseRealEmbeddings)('searchSemantic query embedding (BGE instruction prefix)', () => {
  // The earlier real-inference describe block above (project scoping + backfill) calls the
  // real embedTexts, which memoizes the pipeline per model name in a cache that only
  // registerReset()/clearModuleCaches() clears -- without resetting first, that cached real
  // extractor would silently win over setPipelineFnForTesting's override below.
  beforeEach(() => {
    clearModuleCaches()
  })

  afterEach(() => {
    clearModuleCaches()
  })

  it('prefixes the query text with QUERY_INSTRUCTION_PREFIX before embedding it', async () => {
    const dbPath = path.join(TMP, 'index6.db')
    const db = getDb(dbPath)
    // No chunks needed -- searchSemantic embeds the query before it ever runs the KNN scan,
    // so an empty (but present) chunk_vectors table is enough to reach that call.

    const fakeVec = new Float32Array(DEFAULT_DIM).fill(0.01)
    const seenTexts: string[] = []
    const fakeExtractor = vi.fn(async (text: string) => {
      seenTexts.push(text)
      return { data: fakeVec }
    })
    setPipelineFnForTesting(vi.fn(async () => fakeExtractor))

    await searchSemantic(db, 'find the login handler', 3)

    expect(seenTexts).toHaveLength(1)
    expect(seenTexts[0]).toBe(`${QUERY_INSTRUCTION_PREFIX}find the login handler`)
  })

  it('does not prefix document/chunk-side text embedded via embedTexts directly', async () => {
    const fakeVec = new Float32Array(DEFAULT_DIM).fill(0.01)
    const seenTexts: string[] = []
    const fakeExtractor = vi.fn(async (text: string) => {
      seenTexts.push(text)
      return { data: fakeVec }
    })
    setPipelineFnForTesting(vi.fn(async () => fakeExtractor))

    await embedTexts(['this is chunk/document text, not a search query'])

    expect(seenTexts).toEqual(['this is chunk/document text, not a search query'])
  })
})
