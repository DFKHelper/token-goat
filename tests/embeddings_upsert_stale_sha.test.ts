// Provenance: HAND-DERIVED. The two file versions are literal strings; the embedding is a constant 384-dim vector from the pipeline test seam (setPipelineFnForTesting), and the runtime-availability probe is mocked true because the model files are not needed to exercise the write-side sha guard. Needs the optional sqlite-vec extension, so it skips cleanly without it.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as embedRuntime from '../src/embed_runtime.js'

vi.mock('../src/embed_runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof embedRuntime>()),
  isRuntimeAvailable: () => true,
}))

import { closeAllDbs, getDb } from '../src/db.js'
import { chunkFile, DEFAULT_DIM, setPipelineFnForTesting, upsertChunks } from '../src/embeddings.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { canonicalizeIndexPath, indexFileEmbeddings, indexFileSync } from '../src/parser.js'
import Database from '../src/sqlite_driver.js'

function vec0Working(): boolean {
  const req = createRequire(import.meta.url)
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

let TMP: string
let prevEmbeddingsEnv: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-upsert-stale-'))
  setPipelineFnForTesting((async () => async () => ({ data: Float32Array.from({ length: DEFAULT_DIM }, () => 0.01) })) as never)
  // tests/setup/isolate-home.ts defaults embeddings off; the parser path below must actually embed
  prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'true'
})

afterEach(() => {
  if (prevEmbeddingsEnv === undefined) delete process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
  else process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = prevEmbeddingsEnv
  setPipelineFnForTesting(null)
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const body = (name: string): string => Array.from({ length: 12 }, (_, i) => `export function ${name}${i}(): number { return ${i} }`).join('\n') + '\n'
const V1 = body('alpha')
const V2 = body('beta')

describe('upsertChunks against a file that was reindexed while it embedded', () => {
  it.skipIf(!vec0Working())('writes nothing and reports stale when files.sha moved on', async () => {
    const db = getDb(path.join(TMP, 'index.db'))
    const file = 'src/a.ts'
    db.prepare('INSERT INTO files (path, sha, mtime) VALUES (?, ?, 0)').run(file, 'sha-1')

    // Version 2 lands (worker reindexed) and its chunks are embedded first.
    db.prepare('UPDATE files SET sha = ? WHERE path = ?').run('sha-2', file)
    expect(await upsertChunks(db, chunkFile(file, V2), 'sha-2')).toBe('embedded')
    const v2Texts = () => (db.prepare('SELECT text FROM chunks WHERE file_path = ? ORDER BY id').pluck().all(file) as string[])
    const before = v2Texts()
    expect(before.join('\n')).toContain('beta')

    // The slower version-1 embed finishes last and tries to overwrite.
    const outcome = await upsertChunks(db, chunkFile(file, V1), 'sha-1')

    expect(outcome).toBe('stale')
    expect(v2Texts()).toEqual(before)
    expect(db.prepare('SELECT COUNT(*) FROM chunk_vectors').pluck().get()).toBe(before.length)
  })

  it.skipIf(!vec0Working())('indexFileEmbeddings passes its sha through, so a stale run leaves the newer chunks and stamp alone', async () => {
    const dbPath = path.join(TMP, 'index.db')
    const file = path.join(TMP, 'a.ts')
    const sha1 = fingerprintContent(Buffer.from(V1, 'utf8'))

    // The worker indexes and embeds version 2.
    fs.writeFileSync(file, V2)
    indexFileSync(file, dbPath)
    const sha2 = getFileEntry(file, dbPath)?.sha
    await indexFileEmbeddings(file, dbPath, sha2)
    const db = getDb(dbPath)
    const key = canonicalizeIndexPath(file)
    const texts = () => (db.prepare('SELECT text FROM chunks WHERE file_path = ? ORDER BY id').pluck().all(key) as string[])
    const before = texts()
    expect(before.join('\n')).toContain('beta')
    expect(getFileEntry(file, dbPath)?.embedSha).toBe(sha2)

    // A slower run that read version 1 finishes last, still keyed on version 1's sha.
    fs.writeFileSync(file, V1)
    await indexFileEmbeddings(file, dbPath, sha1)

    expect(texts()).toEqual(before)
    expect(getFileEntry(file, dbPath)?.embedSha).toBe(sha2)
  })
})
