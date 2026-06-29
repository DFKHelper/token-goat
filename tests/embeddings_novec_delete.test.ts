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

  // When chunk_vectors IS present (the normal install), the chunks delete still removes exactly the target file's rows and leaves other files intact.
  it('still removes only the target file\'s chunks when chunk_vectors is present', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, ?, ?, ?, ?)')
    insert.run('c:/proj/a.ts', 1, 2, 'x', 'code')
    insert.run('c:/proj/a.ts', 3, 4, 'y', 'code')
    insert.run('c:/proj/b.ts', 1, 2, 'z', 'code')
    deleteFileEmbeddings(db, 'c:/proj/a.ts')
    const a = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/a.ts') as { c: number }
    const b = db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get('c:/proj/b.ts') as { c: number }
    expect(a.c).toBe(0)
    expect(b.c).toBe(1)
  })
})
