import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { checkDbExists, oversizeDbMessage, runDoctorRepair } from '../src/cli_doctor.js'
import { getDb } from '../src/db.js'
import { reclaimIndex, indexSizeBytes } from '../src/index_reclaim.js'
import { invalidateConfigCache } from '../src/config.js'

describe('doctor index size threshold and auto-reclaim', () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-thresh-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    invalidateConfigCache()
  })

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
    else process.env['TOKEN_GOAT_HOME'] = prevHome
    invalidateConfigCache()
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  })

  it('oversizeDbMessage includes thresholdMb and auto-reclaim advice when enabled', () => {
    const msg = oversizeDbMessage(
      '/path/to/global.db',
      2000 * 1024 * 1024,
      100 * 1024 * 1024,
      0,
      [],
      [],
      1500,
      true,
    )
    expect(msg).toContain('threshold of 1500 MB')
    expect(msg).toContain("doctor --repair' will automatically reclaim embedding vectors")
  })

  it('checkDbExists warns when global.db exceeds custom max_db_size_mb threshold', () => {
    const dbPath = path.join(tmpHome, 'global.db')
    // Write valid sqlite header followed by padding to simulate 2 MB db
    const header = Buffer.from('SQLite format 3\0')
    const padding = Buffer.alloc(2 * 1024 * 1024 - header.length)
    fs.writeFileSync(dbPath, Buffer.concat([header, padding]))

    // With threshold 1 MB, it should warn
    const warnResult = checkDbExists(tmpHome, 1)
    expect(warnResult.status).toBe('warn')
    expect(warnResult.message).toContain('threshold of 1 MB')

    // With threshold 5 MB, it should be ok
    const okResult = checkDbExists(tmpHome, 5)
    expect(okResult.status).toBe('ok')
    expect(okResult.message).toContain('global.db exists')
  })

  it('reclaimIndex with embeddingsOnly drops chunk_vectors and chunks while preserving symbols', () => {
    const dbPath = path.join(tmpHome, 'global.db')
    const db = getDb(dbPath)

    // Seed tables
    db.prepare(`
      INSERT INTO files (path, sha, embed_sha) VALUES ('src/test.ts', 'sha123', 'embedsha123')
    `).run()
    db.prepare(`
      INSERT INTO symbols (file_path, name, kind, line_start, line_end, body)
      VALUES ('src/test.ts', 'mySymbol', 'function', 1, 10, 'function mySymbol() {}')
    `).run()
    db.prepare(`
      INSERT INTO chunks (file_path, start_line, end_line, text)
      VALUES ('src/test.ts', 1, 10, 'chunk text here')
    `).run()

    const result = reclaimIndex(dbPath, { embeddingsOnly: true })
    expect(result.embeddingsOnly).toBe(true)
    expect(result.rebuilt).toBe(false)
    expect(result.dropped['chunks']).toBe(1)

    // Verify symbols still exist
    const symbolCount = (db.prepare('SELECT count(*) as c FROM symbols').get() as { c: number }).c
    expect(symbolCount).toBe(1)

    // Verify chunks dropped
    const chunkCount = (db.prepare('SELECT count(*) as c FROM chunks').get() as { c: number }).c
    expect(chunkCount).toBe(0)

    // Verify files.embed_sha cleared
    const fileRow = db.prepare('SELECT embed_sha FROM files WHERE path = ?').get('src/test.ts') as { embed_sha: string | null }
    expect(fileRow.embed_sha).toBeNull()
  })

  it('runDoctorRepair auto-reclaims embeddings when auto_reclaim_embeddings is true and db exceeds threshold', async () => {
    process.env['TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS'] = 'true'
    process.env['TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB'] = '1'
    invalidateConfigCache()

    const dbPath = path.join(tmpHome, 'global.db')
    const db = getDb(dbPath)
    // Seed with large chunks to make db > 1 MB
    const largeChunk = 'x'.repeat(1200 * 1024)
    db.prepare(`
      INSERT INTO chunks (file_path, start_line, end_line, text)
      VALUES ('src/huge.ts', 1, 100, ?)
    `).run(largeChunk)

    const sizeBefore = indexSizeBytes(dbPath)
    expect(sizeBefore).toBeGreaterThan(1 * 1024 * 1024)

    const repairRes = await runDoctorRepair({ dataDir: tmpHome })
    delete process.env['TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS']
    delete process.env['TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB']
    invalidateConfigCache()

    expect(repairRes.errors).toEqual([])
    expect(repairRes.repairs.some((r) => r.includes('Auto-reclaimed embeddings'))).toBe(true)

    const chunkCount = (db.prepare('SELECT count(*) as c FROM chunks').get() as { c: number }).c
    expect(chunkCount).toBe(0)
  })
})
