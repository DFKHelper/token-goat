/**
 * The sharp edge of shipping a new embedding gate: every chunk row the gate would now reject was
 * written by a build that allowed it, and carries a perfectly valid `files.embed_sha`. The
 * freshness gate therefore reads all of them as current and skips them forever, so a gate shipped
 * on its own changes nothing at all for any index that already exists -- on one real machine-wide
 * index, 141,750 of 243,603 chunk rows.
 *
 * These tests pin the sweep that closes that: which rows it selects, that it deletes their vectors
 * and not only their chunk rows, that it leaves everything else alone, and that it runs once per
 * version rather than on every drain.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { BACKFILL_META_KEY, pruneUnembeddableChunks, selectUnembeddableChunkFiles } from '../src/embed_backfill.js'
import { deleteFileEmbeddings } from '../src/embeddings.js'
import { assetEmbedSha, isEmbedFresh, maxChunksEmbedSha } from '../src/parser.js'
import { VERSION } from '../src/version.js'
import type { SqliteDatabase } from '../src/sqlite_driver.js'

/** What both shipping call sites (src/worker.ts, src/cli.ts) pass, so these tests exercise the markers the product stamps rather than stand-ins of their own. */
const MARKERS = { asset: assetEmbedSha, maxChunks: maxChunksEmbedSha }

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-backfill-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

/**
 * PROVENANCE: FORMAT-DERIVED -- column list read off `chunks` as created by src/db.ts's
 * initConnection (the same DDL every real index is built with), so these rows are shaped exactly
 * like rows a real embed writes. The path spellings are HAND-DERIVED from the census of a real
 * index: `.jpg` and `.ttf` assets, an over-ceiling generated snapshot, and ordinary source.
 */
function seedChunks(db: SqliteDatabase, filePath: string, count: number): void {
  const insert = db.prepare('INSERT INTO chunks (file_path, start_line, end_line, kind, text) VALUES (?, ?, ?, ?, ?)')
  for (let i = 0; i < count; i++) insert.run(filePath, i + 1, i + 2, 'window', `chunk ${i} of ${filePath}`)
}

function chunkCount(db: SqliteDatabase, filePath: string): number {
  return (db.prepare('SELECT COUNT(*) c FROM chunks WHERE file_path = ?').get(filePath) as { c: number }).c
}

describe('pruneUnembeddableChunks backfills an index written before the gates existed', () => {
  it('selects exactly the asset files and the over-ceiling files, and no others', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/assets/photo.jpg', 118)
    seedChunks(db, 'c:/proj/assets/brand.ttf', 60)
    seedChunks(db, 'c:/proj/memory/kw-snap.json', 900)
    seedChunks(db, 'c:/proj/src/widget.ts', 12)
    seedChunks(db, 'c:/proj/docs/guide.md', 500)

    const selected = selectUnembeddableChunkFiles(db, 600)
    expect(selected.map((s) => s.filePath).sort()).toEqual([
      'c:/proj/assets/brand.ttf',
      'c:/proj/assets/photo.jpg',
      'c:/proj/memory/kw-snap.json',
    ])
    // The counts carried back are the real group sizes, which is what the caller reports as reclaimed.
    expect(selected.find((s) => s.filePath.endsWith('.jpg'))?.chunks).toBe(118)
  })

  it('deletes the selected files chunk rows and leaves the rest of the index untouched', () => {
    const dbPath = path.join(TMP, 'index.db')
    const db = getDb(dbPath)
    seedChunks(db, 'c:/proj/assets/photo.jpg', 118)
    seedChunks(db, 'c:/proj/memory/kw-snap.json', 900)
    seedChunks(db, 'c:/proj/src/widget.ts', 12)
    const before = (db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c
    expect(before).toBe(1030)

    const result = pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)

    expect(result.ran).toBe(true)
    expect(result.files).toBe(2)
    expect(result.chunks).toBe(1018)
    expect(chunkCount(db, 'c:/proj/assets/photo.jpg')).toBe(0)
    expect(chunkCount(db, 'c:/proj/memory/kw-snap.json')).toBe(0)
    // The survival anchor: a sweep that simply emptied the table would satisfy every "must be zero" assertion above.
    expect(chunkCount(db, 'c:/proj/src/widget.ts')).toBe(12)
    expect((db.prepare('SELECT COUNT(*) c FROM chunks').get() as { c: number }).c).toBe(12)
  })

  it('runs once per version: a second call on the same database sweeps nothing even after new rejectable rows arrive', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/assets/photo.jpg', 118)

    const first = pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)
    expect(first.ran).toBe(true)
    expect(first.chunks).toBe(118)
    expect((db.prepare('SELECT value FROM index_migrations WHERE key = ?').get(BACKFILL_META_KEY) as { value: string }).value).toBe(VERSION)

    // Rows that arrive after the sweep are the live gate's job, not the sweep's -- and re-scanning a quarter-million-row table on every worker drain is the cost the version key exists to avoid.
    seedChunks(db, 'c:/proj/assets/later.jpg', 40)
    const second = pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)
    expect(second.ran).toBe(false)
    expect(second.chunks).toBe(0)
    expect(chunkCount(db, 'c:/proj/assets/later.jpg')).toBe(40)
  })

  it('sweeps again once the recorded version moves, so a later release that widens a gate is backfilled by the same pass', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/assets/photo.jpg', 118)
    db.exec('CREATE TABLE IF NOT EXISTS index_migrations (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO index_migrations (key, value) VALUES (?, ?)').run(BACKFILL_META_KEY, '0.0.0-some-older-release')

    const result = pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)
    expect(result.ran).toBe(true)
    expect(result.chunks).toBe(118)
  })

  it('does not prune on a ceiling of 0, the partially-mocked-config fallback, so a missing config cannot empty an index', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/memory/kw-snap.json', 900)

    const result = pruneUnembeddableChunks(db, 0, deleteFileEmbeddings, MARKERS)
    expect(result.files).toBe(0)
    expect(chunkCount(db, 'c:/proj/memory/kw-snap.json')).toBe(900)
  })
})

/**
 * PROVENANCE: FORMAT-DERIVED -- the `files` column list is read off src/db.ts's SCHEMA_SQL, and the
 * expected stamp values come from the same `assetEmbedSha`/`maxChunksEmbedSha` the shipping gate
 * calls rather than from literals transcribed here, so a change to either marker's spelling moves
 * the product and the expectation together instead of pinning a dead string.
 */
function seedFile(db: SqliteDatabase, filePath: string, sha: string): void {
  db.prepare('INSERT INTO files (path, sha, embed_sha) VALUES (?, ?, ?)').run(filePath, sha, sha)
}

function storedEmbedSha(db: SqliteDatabase, filePath: string): string | null {
  return (db.prepare('SELECT embed_sha FROM files WHERE path = ?').get(filePath) as { embed_sha: string | null }).embed_sha
}

describe('the sweep restamps each pruned file with the verdict the live gate would have recorded', () => {
  it('replaces the bare sha that made the skip permanent with the threshold- and set-id-bearing markers', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/assets/photo.jpg', 118)
    seedFile(db, 'c:/proj/assets/photo.jpg', 'sha-jpg')
    seedChunks(db, 'c:/proj/memory/kw-snap.json', 900)
    seedFile(db, 'c:/proj/memory/kw-snap.json', 'sha-json')
    seedChunks(db, 'c:/proj/src/widget.ts', 12)
    seedFile(db, 'c:/proj/src/widget.ts', 'sha-ts')

    pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)

    // The asset test runs before anything counts chunks in indexFileEmbeddings, so a file that is both gets the asset marker.
    expect(storedEmbedSha(db, 'c:/proj/assets/photo.jpg')).toBe(assetEmbedSha('sha-jpg'))
    expect(storedEmbedSha(db, 'c:/proj/memory/kw-snap.json')).toBe(maxChunksEmbedSha('sha-json', 600))
    // The survival anchor: a sweep that restamped every row would satisfy both assertions above.
    expect(storedEmbedSha(db, 'c:/proj/src/widget.ts')).toBe('sha-ts')
  })

  it('leaves a pruned file re-examinable once the ceiling that refused it is raised, which a bare sha never was', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/memory/kw-snap.json', 900)
    seedFile(db, 'c:/proj/memory/kw-snap.json', 'sha-json')

    pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)
    const stored = storedEmbedSha(db, 'c:/proj/memory/kw-snap.json') ?? undefined

    // Settled while the ceiling holds: the file is not re-read into extraction on every drain.
    expect(isEmbedFresh(stored, 'sha-json', true, true, 500, 600)).toBe(true)
    // ...and re-opened the moment it moves, which is the whole reason the marker is threshold-bearing.
    expect(isEmbedFresh(stored, 'sha-json', true, true, 500, 10000)).toBe(false)
  })

  it('prunes a chunk row with no file row at all rather than failing on the missing stamp target', () => {
    const db = getDb(path.join(TMP, 'index.db'))
    seedChunks(db, 'c:/proj/assets/orphan.jpg', 40)

    const result = pruneUnembeddableChunks(db, 600, deleteFileEmbeddings, MARKERS)

    expect(result.chunks).toBe(40)
    expect(chunkCount(db, 'c:/proj/assets/orphan.jpg')).toBe(0)
  })
})
