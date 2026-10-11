import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { deleteFileEmbeddings } from '../src/embeddings.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-emb-novec-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('deleteFileEmbeddings tolerates a missing chunk_vectors table', () => {
  // Regression: chunk_vectors only exists when sqlite-vec loads, so on a platform without the binary the table is absent. The old body ran DELETE FROM chunk_vectors unconditionally, threw "no such table", and never reached the chunks delete - the file's chunk rows leaked. Simulate that install by dropping the table, then assert the delete neither throws nor leaves chunks behind.
  it('deletes chunks without throwing when chunk_vectors does not exist', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    db.prepare('DROP TABLE IF EXISTS chunk_vectors').run()
    const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    insert.run('c:/proj/x.ts', 1, 2, 'a', 'code')
    insert.run('c:/proj/x.ts', 3, 4, 'b', 'code')
    expect(() => deleteFileEmbeddings(db, 'c:/proj/x.ts')).not.toThrow()
    const left = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/x.ts') as { c: number }
    expect(left.c).toBe(0)
  })
})
