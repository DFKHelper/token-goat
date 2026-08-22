import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import {
  embeddingProvenance,
  ensureEmbeddingProvenance,
  resetAllEmbeddings,
} from '../src/embeddings.js'
import { DEFAULT_MODEL } from '../src/embeddings.js'

let TMP: string

/** A database holding chunk rows for `files`, with each file stamped as fully embedded. */
function seedIndex(dbPath: string, files: Record<string, number>): void {
  const db = getDb(dbPath)
  const insertFile = db.prepare('INSERT INTO files (path, sha, embed_sha) VALUES (?, ?, ?)')
  const insertChunk = db.prepare(
    'INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)',
  )
  for (const [filePath, chunkCount] of Object.entries(files)) {
    insertFile.run(filePath, 'sha-of-' + filePath, 'sha-of-' + filePath)
    for (let i = 0; i < chunkCount; i++) {
      insertChunk.run(filePath, i * 10 + 1, i * 10 + 9, `body ${i} of ${filePath}`, 'symbol')
    }
  }
}

function storedProvenance(dbPath: string): string | undefined {
  return getDb(dbPath)
    .prepare('SELECT provenance FROM embedding_provenance WHERE id = 1')
    .pluck()
    .get() as string | undefined
}

function chunkCount(dbPath: string): number {
  return getDb(dbPath).prepare('SELECT COUNT(*) FROM chunks').pluck().get() as number
}

function embedShaOf(dbPath: string, filePath: string): string | null {
  const row = getDb(dbPath)
    .prepare('SELECT embed_sha FROM files WHERE path = ?')
    .pluck()
    .get(filePath) as string | null | undefined
  return row ?? null
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-prov-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('embeddingProvenance()', () => {
  it('names the model, its pinned revision and the backend, so a change to any one is visible', () => {
    const provenance = embeddingProvenance()
    expect(provenance).toContain(DEFAULT_MODEL)
    // The pinned revision, abbreviated. Its presence is the point: bumping PINNED_MODEL_REVISION
    // has to change this string, or a re-pinned model would silently mix with the old one.
    expect(provenance).toMatch(/@[0-9a-f]{12}\//)
    // Major.minor and no patch, deliberately: int8 kernel changes land in minor releases, so those
    // must invalidate, while a patch that cannot move a number must not re-embed every project on
    // the machine. The `$` is what pins that -- without it a patch-carrying string still passes.
    expect(provenance).toMatch(/\/onnxruntime-node@\d+\.\d+$/)
  })

  it('distinguishes a non-default model from the pinned one rather than claiming the same revision', () => {
    // A caller-supplied model has no guarantee of carrying PINNED_MODEL_REVISION, so reusing that
    // SHA in its provenance would assert something untrue and make two different models collide.
    const custom = embeddingProvenance('some-org/some-other-model')
    expect(custom).toContain('some-org/some-other-model')
    expect(custom).toContain('unpinned')
    expect(custom).not.toBe(embeddingProvenance())
  })
})

describe('resetAllEmbeddings()', () => {
  it('drops every chunk and re-opens the embed gate for the files that had them', () => {
    const dbPath = path.join(TMP, 'reset.db')
    seedIndex(dbPath, { 'a.ts': 3, 'b.ts': 2 })
    expect(chunkCount(dbPath)).toBe(5)

    const cleared = resetAllEmbeddings(getDb(dbPath))

    expect(cleared).toBe(2)
    expect(chunkCount(dbPath)).toBe(0)
    expect(embedShaOf(dbPath, 'a.ts')).toBeNull()
    expect(embedShaOf(dbPath, 'b.ts')).toBeNull()
  })

  it('leaves a deliberate terminal skip alone instead of forcing it to be re-read', () => {
    // A file stamped with a bare embed_sha but holding no chunks was skipped on purpose -- an empty
    // file, or a policy exclusion like a multi-megabyte .profile-meta.xml. Clearing its stamp would
    // make the next drain read that whole file again just to reach the same early return.
    const dbPath = path.join(TMP, 'terminal.db')
    seedIndex(dbPath, { 'embedded.ts': 2 })
    getDb(dbPath)
      .prepare('INSERT INTO files (path, sha, embed_sha) VALUES (?, ?, ?)')
      .run('huge.profile-meta.xml', 'sha-skip', 'sha-skip')

    const cleared = resetAllEmbeddings(getDb(dbPath))

    expect(cleared).toBe(1)
    expect(embedShaOf(dbPath, 'embedded.ts')).toBeNull()
    expect(embedShaOf(dbPath, 'huge.profile-meta.xml')).toBe('sha-skip')
  })

  it('reports nothing cleared on an index that holds no chunks at all', () => {
    const dbPath = path.join(TMP, 'empty.db')
    getDb(dbPath)
    expect(resetAllEmbeddings(getDb(dbPath))).toBe(0)
  })
})

describe('ensureEmbeddingProvenance()', () => {
  it('stamps a fresh index without warning, because there is nothing to invalidate', () => {
    const dbPath = path.join(TMP, 'fresh.db')
    getDb(dbPath)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ensureEmbeddingProvenance(getDb(dbPath))

    expect(storedProvenance(dbPath)).toBe(embeddingProvenance())
    expect(warn).not.toHaveBeenCalled()
  })

  it('discards vectors that predate the stamp, because their provenance is unknowable', () => {
    // This is the upgrade path: every database written before embedding_provenance existed has
    // chunks and no stamp, and nothing can say which model or runtime produced them.
    const dbPath = path.join(TMP, 'unstamped.db')
    seedIndex(dbPath, { 'a.ts': 3, 'b.ts': 1 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ensureEmbeddingProvenance(getDb(dbPath))

    expect(chunkCount(dbPath)).toBe(0)
    expect(embedShaOf(dbPath, 'a.ts')).toBeNull()
    expect(storedProvenance(dbPath)).toBe(embeddingProvenance())
    const message = warn.mock.calls.flat().join(' ')
    expect(message).toContain('unrecorded')
    expect(message).toContain('token-goat index')
  })

  it('discards vectors stamped by a different stack and names both in the warning', () => {
    const dbPath = path.join(TMP, 'foreign.db')
    seedIndex(dbPath, { 'a.ts': 2 })
    getDb(dbPath)
      .prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (1, ?)')
      .run('some-model@deadbeefcafe/@xenova/transformers@1.0.0')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ensureEmbeddingProvenance(getDb(dbPath))

    expect(chunkCount(dbPath)).toBe(0)
    expect(storedProvenance(dbPath)).toBe(embeddingProvenance())
    const message = warn.mock.calls.flat().join(' ')
    expect(message).toContain('some-model@deadbeefcafe')
    expect(message).toContain(embeddingProvenance())
  })

  it('keeps a matching index intact instead of re-embedding it for no reason', () => {
    const dbPath = path.join(TMP, 'match.db')
    seedIndex(dbPath, { 'a.ts': 4 })
    getDb(dbPath)
      .prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (1, ?)')
      .run(embeddingProvenance())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    ensureEmbeddingProvenance(getDb(dbPath))

    expect(chunkCount(dbPath)).toBe(4)
    expect(embedShaOf(dbPath, 'a.ts')).toBe('sha-of-a.ts')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reads the stored provenance once per connection, so the hot path does not re-query it', () => {
    // Counting the query rather than observing the outcome, because the outcome cannot tell the
    // two apart: once the first call has stamped the database, an unmemoized second call also
    // finds a match and also does nothing. Only the read itself distinguishes them, and the read
    // is the entire cost this memo exists to avoid on a path that runs per file and per query.
    const dbPath = path.join(TMP, 'memo.db')
    seedIndex(dbPath, { 'a.ts': 1 })
    const db = getDb(dbPath)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const prepare = vi.spyOn(db, 'prepare')
    const provenanceReads = (): number =>
      prepare.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('SELECT provenance FROM embedding_provenance'),
      ).length

    ensureEmbeddingProvenance(db)
    expect(provenanceReads()).toBe(1)

    ensureEmbeddingProvenance(db)
    ensureEmbeddingProvenance(db)
    expect(provenanceReads()).toBe(1)
  })

  it('checks a second connection to the same database independently of the first', () => {
    // The memo is keyed on the connection object, not the file. Two connections are two separate
    // processes' worth of state as far as this is concerned, and the second one has to make its
    // own decision rather than inherit a conclusion it never reached.
    const dbPath = path.join(TMP, 'per-connection.db')
    seedIndex(dbPath, { 'a.ts': 2 })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    ensureEmbeddingProvenance(getDb(dbPath))
    closeAllDbs()

    const reopened = getDb(dbPath)
    const prepare = vi.spyOn(reopened, 'prepare')
    ensureEmbeddingProvenance(reopened)

    expect(
      prepare.mock.calls.filter(
        ([sql]) => typeof sql === 'string' && sql.includes('SELECT provenance FROM embedding_provenance'),
      ).length,
    ).toBe(1)
  })

  it('refuses a second provenance row rather than silently tracking two answers', () => {
    const dbPath = path.join(TMP, 'single.db')
    const db = getDb(dbPath)
    db.prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (1, ?)').run('first')
    expect(() =>
      db.prepare('INSERT INTO embedding_provenance (id, provenance) VALUES (2, ?)').run('second'),
    ).toThrow(/CHECK constraint failed/i)
  })
})
