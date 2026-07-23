/**
 * Regression coverage for the real index-path wiring gap: `indexFileSync` (called by both
 * `cmdIndex` and `worker.ts::makeIndexer`) used to only ever write symbols/refs - the
 * embeddings pipeline (chunkFile/embedTexts/upsertChunks) existed, was fully unit-tested, and
 * had zero production callers other than the delete-on-removal cleanup in index_prune.ts. Every
 * existing embeddings*.test.ts calls embeddings.ts functions directly (the exact
 * injected-seam trap this project's CLAUDE.md warns about for this codebase), so none of them
 * would have caught the real index path never populating chunks/chunk_vectors.
 *
 * This file drives the real choke point - parser.ts's exported `indexFileEmbeddings`, the
 * function `cmdIndex` awaits and `makeIndexer` fires-and-forgets - rather than embeddings.ts's
 * internals directly, and proves: (a) it actually populates chunks/chunk_vectors for a real
 * file, (b) real embedding-vector search then finds a meaning-based match plain FTS misses
 * (the same distinguishing example as tests/semantic_embeddings_e2e.test.ts, at the
 * in-process integration level rather than through a spawned built-bundle process), and (c)
 * indexing degrades gracefully - symbols still index - when the embeddings step is disabled
 * by config or when the optional chunk_vectors table is unavailable.
 */
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { indexFileEmbeddings, indexFileSync } from '../src/parser.js'
import { isAvailable, mergeNearbyHits, searchSemantic } from '../src/embeddings.js'
import { querySymbols, queryRefs, searchSymbolsFts } from '../src/index_reader.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { buildDocxFixture } from './helpers/ooxml_fixtures.js'

type Vec0State = 'working' | 'broken' | 'absent'

// Mirrors tests/embeddings_vec_insert.test.ts's classifyVec0(): 'absent' (package not
// installed) is a legitimate platform skip; 'broken' (installed but vec0 fails to load) is
// silent-dead semantic search and must fail loudly, not be swallowed by a skip.
function classifyVec0(): Vec0State {
  const req = createRequire(import.meta.url)
  try {
    req.resolve('sqlite-vec')
  } catch {
    return 'absent'
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
    return 'working'
  } catch {
    return 'broken'
  }
}

const vec0State = classifyVec0()
// Both the model and a genuinely loaded vec0 table must be real for these tests to exercise
// the actual insert/search code, mirroring embeddings_vec_insert.test.ts's canExerciseRealUpsert.
const canExerciseRealEmbeddings = vec0State === 'working' && isAvailable()

let TMP: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-wiring-'))
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  if (prevEmbeddingsEnv === undefined) {
    delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  } else {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  }
})

describe('indexFileEmbeddings wires the real embeddings pipeline into indexing', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    'populates chunks/chunk_vectors for a real file, alongside indexFileSync writing its symbols',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'wired.ts')
      const content = 'export function wiredSymbol(): number {\n' + '  return 1\n'.repeat(10) + '}\n'
      fs.writeFileSync(filePath, content)

      // Drive the real default path: indexFileSync (symbols) then indexFileEmbeddings
      // (chunks/vectors) for the SAME file - exactly what cmdIndex and worker.ts::makeIndexer
      // each do for every file they touch.
      indexFileSync(filePath, dbPath)
      await indexFileEmbeddings(filePath, dbPath)

      const db = getDb(dbPath)
      const symRow = db
        .prepare("SELECT COUNT(*) c FROM symbols WHERE file_path = ? AND name = 'wiredSymbol'")
        .get(filePath) as { c: number }
      expect(symRow.c).toBe(1)

      const chunkRow = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as {
        c: number
      }
      // Single symbol, one chunk boundary -- confirmed stable across 3 consecutive runs.
      expect(chunkRow.c).toBe(1)

      const vecRow = db
        .prepare(
          'SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)',
        )
        .get(filePath) as { c: number }
      expect(vecRow.c).toBe(1)
    },
  )

  it('is a no-op for embeddings (symbols still index normally) when indexing.embeddings_enabled is false', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'gated.ts')
    const content = 'export function gatedSymbol(): number {\n' + '  return 1\n'.repeat(10) + '}\n'
    fs.writeFileSync(filePath, content)

    indexFileSync(filePath, dbPath)
    await indexFileEmbeddings(filePath, dbPath)

    const db = getDb(dbPath)
    const symRow = db
      .prepare("SELECT COUNT(*) c FROM symbols WHERE file_path = ? AND name = 'gatedSymbol'")
      .get(filePath) as { c: number }
    expect(symRow.c).toBe(1)

    const chunkRow = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as {
      c: number
    }
    expect(chunkRow.c).toBe(0)
  })

  it('keeps Salesforce profiles out of the semantic index and removes stale chunks', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'Example.profile-meta.xml')
    fs.writeFileSync(
      filePath,
      '<Profile>\n  <userPermissions><name>ExamplePermission</name></userPermissions>\n</Profile>\n',
    )

    indexFileSync(filePath, dbPath)
    const db = getDb(dbPath)
    db.prepare(
      "INSERT INTO chunks(file_path, start_line, end_line, text, kind) VALUES (?, 1, 1, 'stale', 'symbol')",
    ).run(filePath)

    await indexFileEmbeddings(filePath, dbPath)

    const symbolRow = db
      .prepare("SELECT COUNT(*) c FROM symbols WHERE file_path = ? AND kind = 'sf_profile'")
      .get(filePath) as { c: number }
    expect(symbolRow.c).toBe(1)
    const chunkRow = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as {
      c: number
    }
    expect(chunkRow.c).toBe(0)
  })

  it('keeps oversized Salesforce metadata out of the semantic index', async () => {
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'Example.permissionset-meta.xml')
    fs.writeFileSync(
      filePath,
      `<PermissionSet><description>${'x'.repeat(600 * 1024)}</description></PermissionSet>`,
    )

    indexFileSync(filePath, dbPath)
    await indexFileEmbeddings(filePath, dbPath)

    const db = getDb(dbPath)
    const symbolRow = db
      .prepare("SELECT COUNT(*) c FROM symbols WHERE file_path = ? AND kind = 'sf_permission_set'")
      .get(filePath) as { c: number }
    expect(symbolRow.c).toBe(1)
    const chunkRow = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as {
      c: number
    }
    expect(chunkRow.c).toBe(0)
  })

  it('degrades gracefully - symbols still index - when chunk_vectors is unavailable (sqlite-vec-absent simulation)', async () => {
    // Drop the real table rather than mocking isAvailable(): this is exactly what
    // chunkVectorsTableExists() sees on an install where sqlite-vec never loaded, matching
    // the same simulation tests/embeddings_novec_upsert_search.test.ts already uses for
    // upsertChunks/searchSemantic. Runs unconditionally (no skipIf): dropping the table
    // reproduces the absent-dependency condition regardless of what is actually installed on
    // this machine.
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'degraded.ts')
    const content = 'export function degradedSymbol(): number {\n' + '  return 1\n'.repeat(10) + '}\n'
    fs.writeFileSync(filePath, content)

    const db = getDb(dbPath)
    db.exec('DROP TABLE IF EXISTS chunk_vectors')

    indexFileSync(filePath, dbPath)
    await expect(indexFileEmbeddings(filePath, dbPath)).resolves.toBeUndefined()

    const symRow = db
      .prepare("SELECT COUNT(*) c FROM symbols WHERE file_path = ? AND name = 'degradedSymbol'")
      .get(filePath) as { c: number }
    expect(symRow.c).toBe(1)
  })
})

describe('indexFileEmbeddings extracts and embeds text from binary document formats (task #337)', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    'populates chunks/chunk_vectors for a real .docx file and stamps embed_sha, driven through the real default path',
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'spec.docx')
      const bytes = buildDocxFixture([
        { text: 'Design Spec', headingLevel: 1 },
        { text: 'The rollout plan covers three regions in Q3.' },
      ])
      fs.writeFileSync(filePath, bytes)

      // Drive the real default path -- indexFileSync (a no-op for these formats, no Language
      // union member) then indexFileEmbeddings, exactly what cmdIndex and worker.ts::makeIndexer
      // each do for every file they touch.
      indexFileSync(filePath, dbPath)
      const sha = fingerprintFile(filePath)
      await indexFileEmbeddings(filePath, dbPath, sha ?? undefined)

      const db = getDb(dbPath)
      const chunkRow = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as {
        c: number
      }
      // Single section-boundary chunk (one heading) -- confirmed stable across 3 consecutive runs.
      expect(chunkRow.c).toBe(1)

      const vecRow = db
        .prepare(
          'SELECT COUNT(*) c FROM chunk_vectors WHERE rowid IN (SELECT id FROM chunks WHERE file_path = ?)',
        )
        .get(filePath) as { c: number }
      expect(vecRow.c).toBe(1)

      const fileRow = db.prepare('SELECT embed_sha FROM files WHERE path = ?').get(filePath) as
        | { embed_sha: string | null }
        | undefined
      // buildDocxFixture's own zip encoding embeds a timestamp, so embed_sha is NOT stable
      // across runs even though the visible text is fixed -- see the matching finding in
      // tests/cmdindex_unchanged_skip.test.ts. Pin the real sha256-hex shape, not an exact value.
      expect(fileRow?.embed_sha).toMatch(/^[0-9a-f]{64}$/)

      const hits = mergeNearbyHits(await searchSemantic(db, 'plan for the rollout across regions', 5))
      expect(hits.some((h) => h.filePath === filePath && h.text.includes('rollout plan'))).toBe(true)
    },
  )
})

describe('real embeddings find meaning-based matches plain FTS misses', () => {
  it.skipIf(!canExerciseRealEmbeddings)(
    "a query using none of the symbol's literal words still surfaces it via searchSemantic, where FTS finds nothing",
    async () => {
      process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
      const dbPath = path.join(TMP, 'index.db')
      const filePath = path.join(TMP, 'users.ts')
      const content =
        'export function getUserByEmail(input: string): { id: number } | null {\n' +
        '  const match = ACCOUNTS.find((row) => row.contact === input)\n' +
        '  return match ? { id: match.id } : null\n' +
        '}\n\n' +
        'const ACCOUNTS = [{ id: 1, contact: "a@example.com" }]\n'
      fs.writeFileSync(filePath, content)

      indexFileSync(filePath, dbPath)
      await indexFileEmbeddings(filePath, dbPath)

      const query = 'look up an account using its email address'
      const db = getDb(dbPath)

      // Control: searchSymbolsFts now retries with an OR-joined query when the AND-joined
      // attempt returns zero rows, so this control must avoid *every* literal word overlap with
      // the fixture (not just avoid an all-terms-present AND match) -- none of the query's words
      // appear verbatim in the fixture's name/body/docstring, so even the OR-widened retry can't
      // match it. That's what makes the embeddings match below a genuine meaning-based hit.
      const ftsHits = searchSymbolsFts(query, 20, dbPath)
      expect(ftsHits.some((s) => s.name === 'getUserByEmail')).toBe(false)

      // Real embedding-vector search finds it by meaning.
      const hits = mergeNearbyHits(await searchSemantic(db, query, 5))
      expect(hits.some((h) => h.filePath === filePath && h.text.includes('getUserByEmail'))).toBe(true)
    },
  )
})

describe('indexFileSync indexes Jupyter notebook (.ipynb) code cells as real symbols', () => {
  it('extracts a function defined in a notebook code cell, with a non-empty body and a resolved call ref', () => {
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'analysis.ipynb')
    const notebook = {
      cells: [
        { cell_type: 'markdown', metadata: {}, source: ['# Helper utilities\n'] },
        {
          cell_type: 'code',
          metadata: {},
          source: ['def helper():\n', '    return 42\n'],
        },
        {
          cell_type: 'code',
          metadata: {},
          source: ['def notebook_main():\n', '    return helper() + 1\n'],
        },
      ],
      metadata: { kernelspec: { name: 'python3', language: 'python' } },
    }
    fs.writeFileSync(filePath, JSON.stringify(notebook))

    indexFileSync(filePath, dbPath)

    const symbols = querySymbols({ filePath, name: 'notebook_main' }, dbPath)
    expect(symbols.length).toBe(1)
    expect(symbols[0]?.body).toContain('def notebook_main')
    expect(symbols[0]?.body).toContain('helper()')

    const helperSymbols = querySymbols({ filePath, name: 'helper' }, dbPath)
    expect(helperSymbols.length).toBe(1)
    expect(helperSymbols[0]?.body).toContain('return 42')

    // The stored language is still 'ipynb', not 'python' -- distinguishing a notebook from a plain .py file.
    const db = getDb(dbPath)
    const fileRow = db.prepare('SELECT language FROM files WHERE path = ?').get(filePath) as
      | { language: string }
      | undefined
    expect(fileRow?.language).toBe('ipynb')

    const refs = queryRefs({ name: 'helper', filePath }, dbPath)
    // helper() is called exactly once, by notebook_main -- pin the exact count and enclosing
    // caller so a regression that resolved the ref to the wrong scope (still non-empty) is
    // caught, matching this test's own exact-count rigor on symbols above.
    expect(refs.length).toBe(1)
    expect(refs[0]?.context).toBe('notebook_main')
  })

  it('never throws and indexes zero symbols for a notebook with a non-Python kernel', () => {
    const dbPath = path.join(TMP, 'index.db')
    const filePath = path.join(TMP, 'r_notebook.ipynb')
    const notebook = {
      cells: [{ cell_type: 'code', metadata: {}, source: ['f <- function() 1\n'] }],
      metadata: { kernelspec: { name: 'ir', language: 'r' } },
    }
    fs.writeFileSync(filePath, JSON.stringify(notebook))

    expect(() => indexFileSync(filePath, dbPath)).not.toThrow()
    const symbols = querySymbols({ filePath }, dbPath)
    expect(symbols.length).toBe(0)
  })
})
