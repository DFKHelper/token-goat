import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { autoReclaimRow, runDoctorRepair } from '../src/cli_doctor.js'
import { checkDbExists, oversizeDbMessage } from '../src/cli_doctor_index.js'
import { getDb } from '../src/db.js'
import { reclaimIndex, indexSizeBytes, reclaimNotes, type ReclaimResult } from '../src/index_reclaim.js'
import { invalidateConfigCache } from '../src/config.js'
import { clearUpdateCheck, seedUpdateCheck } from './helpers/update-check.js'
import { writeRealDb } from './helpers/real-db.js'

describe('doctor index size threshold and auto-reclaim', () => {
  let tmpHome: string
  let prevHome: string | undefined

  beforeEach(() => {
    prevHome = process.env['TOKEN_GOAT_HOME']
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-thresh-'))
    process.env['TOKEN_GOAT_HOME'] = tmpHome
    // runDoctorRepair also checks the instruction gate in the user-level files and the project root, and writes the project when none is gated: keep both inside the scratch dir, never the real home or the checkout the suite runs from.
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(tmpHome, '.claude'))
    vi.stubEnv('COPILOT_HOME', path.join(tmpHome, '.copilot'))
    invalidateConfigCache()
    // Seeded so the update check in doctor reads the cache instead of asking a registry: the result would otherwise depend on the network and on the version npm serves that day.
    seedUpdateCheck()
  })

  afterEach(() => {
    clearUpdateCheck()
    vi.unstubAllEnvs()
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
    expect(msg).toContain('`token-goat doctor --repair` will automatically reclaim embedding vectors')
  })

  it('checkDbExists warns when global.db exceeds custom max_db_size_mb threshold', () => {
    const dbPath = path.join(tmpHome, 'global.db')
    // A real SQLite file of about 2 MB: doctor now runs quick_check, so a header followed by padding fails as malformed.
    writeRealDb(dbPath, 2 * 1024 * 1024)

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

    const project = path.join(tmpHome, 'project')
    fs.mkdirSync(project)
    const repairRes = await runDoctorRepair({ dataDir: tmpHome, rootDir: project })
    delete process.env['TOKEN_GOAT_INDEXING_AUTO_RECLAIM_EMBEDDINGS']
    delete process.env['TOKEN_GOAT_INDEXING_MAX_DB_SIZE_MB']
    invalidateConfigCache()

    expect(repairRes.errors).toEqual([])
    const row = repairRes.repairs.find((r) => r.includes('Auto-reclaimed embeddings'))
    expect(row?.startsWith('Auto-reclaimed embeddings from global.db (')).toBe(true)
    expect(row).not.toContain('and compacted')

    const chunkCount = (db.prepare('SELECT count(*) as c FROM chunks').get() as { c: number }).c
    expect(chunkCount).toBe(0)
  })
})

// Provenance: the first row is CAPTURE, the ReclaimResult that reclaimIndex(dbPath, { embeddingsOnly: true }) returned on this Windows machine on 2026-10-17 while a second node:sqlite connection held a read transaction on a global.db seeded with one 1.2 MB chunk (beforeBytes 1792208, afterBytes 3559240, beforeDbBytes 4096, afterDbBytes 1486848, checkpointBusy true, vacuumDeferred false); the others are HAND-DERIVED sizes in MiB.
describe('autoReclaimRow', () => {
  const MIB = 1024 * 1024
  const result = (over: Partial<ReclaimResult>): ReclaimResult => ({
    beforeBytes: 10 * MIB,
    afterBytes: 4 * MIB,
    beforeDbBytes: 10 * MIB,
    afterDbBytes: 4 * MIB,
    dropped: {},
    rebuilt: false,
    embeddingsOnly: true,
    checkpointBusy: false,
    vacuumDeferred: false,
    ...over,
  })

  it('says no space was released for the captured reader-blocked run, where DB+WAL grew', () => {
    const row = autoReclaimRow(result({ beforeBytes: 1792208, afterBytes: 3559240, beforeDbBytes: 4096, afterDbBytes: 1486848, checkpointBusy: true }))
    expect(row).toContain('no space was released')
    expect(row).not.toContain('compacted')
    expect(row).not.toContain('(reclaimed')
    expect(row).toContain('blocked WAL truncation')
  })

  it('reports the freed amount and compacted only when VACUUM ran and the checkpoint was not blocked', () => {
    const row = autoReclaimRow(result({}))
    expect(row).toBe('Auto-reclaimed embeddings from global.db (reclaimed 6.0 MB, compacted)')
  })

  it('does not say compacted when the checkpoint was blocked, even with space freed', () => {
    const row = autoReclaimRow(result({ checkpointBusy: true }))
    expect(row).toContain('reclaimed 6.0 MB')
    expect(row).not.toContain('compacted')
    expect(row).toContain(reclaimNotes(result({ checkpointBusy: true }), 'global.db')[0])
  })

  it('does not say compacted when VACUUM was skipped, and names the follow-up', () => {
    const row = autoReclaimRow(result({ vacuumDeferred: true, afterBytes: 10 * MIB, afterDbBytes: 10 * MIB }))
    expect(row).toContain('no space was released')
    expect(row).not.toContain('compacted')
    expect(row).toContain('VACUUM could not get an exclusive lock')
    expect(row).toContain('token-goat reclaim-index')
  })

  it('says no space was released, without compacted, for a clean run that freed nothing', () => {
    const row = autoReclaimRow(result({ afterBytes: 10 * MIB, afterDbBytes: 10 * MIB }))
    expect(row).toBe('Auto-reclaimed embeddings from global.db (no space was released)')
  })
})
