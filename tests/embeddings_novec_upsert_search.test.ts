import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { searchSemantic, upsertChunks } from '../src/embeddings.js'
import type { Chunk } from '../src/embeddings.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-novec-us-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// Regression: chunk_vectors exists only when sqlite-vec loads, but @xenova/transformers is an independent hard dependency, so isAvailable() (model-only) is true on a normal install even when the vec table is absent. upsertChunks ran INSERT INTO chunk_vectors and searchSemantic ran the KNN SELECT unconditionally, both throwing "no such table: chunk_vectors". Simulate the vec-absent install by dropping the table, then assert neither throws.
describe('upsertChunks and searchSemantic tolerate a missing chunk_vectors table', () => {
  const chunk: Chunk = { filePath: 'c:/proj/x.ts', startLine: 1, endLine: 2, text: 'hello world function foo', kind: 'code' }

  it('upsertChunks does not throw and inserts nothing when chunk_vectors is absent', async () => {
    const db = getDb(path.join(TMP, 'index.db'))
    db.prepare('DROP TABLE IF EXISTS chunk_vectors').run()
    await expect(upsertChunks(db, [chunk])).resolves.toBeUndefined()
    const left = db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }
    expect(left.c).toBe(0)
  })

  it('searchSemantic returns an empty array when chunk_vectors is absent', async () => {
    const db = getDb(path.join(TMP, 'index.db'))
    db.prepare('DROP TABLE IF EXISTS chunk_vectors').run()
    const hits = await searchSemantic(db, 'hello world')
    expect(hits).toEqual([])
  })
})
