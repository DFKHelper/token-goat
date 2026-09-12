/**
 * `writeParseResult` must not throw away a file's `embed_sha` on a reparse whose content did not
 * change.
 *
 * The `files` row write inside `writeParseResult` used to (re-)INSERT `path, sha, mtime, language,
 * indexed_at, parser_sha` with no `embed_sha` column at all, which SQLite defaults to NULL on
 * INSERT OR REPLACE. Any reparse of an already-embedded file -- a parser-fingerprint bump (see
 * reconcile_parser_stale.test.ts), a touched mtime with unchanged bytes, or a manual `--force-
 * refresh` -- silently reset `embed_sha` to NULL even though the file's content, and therefore its
 * embedding, never changed. `isEmbedFresh`/the embedding pipeline then see a file with no recorded
 * embed_sha and redo the (expensive) embedding work for content that was already correctly
 * embedded. The fix carries the prior row's `embed_sha` forward whenever the new sha matches the
 * old one, and resets it (to null, so the embedding step recomputes) only when content actually
 * changed.
 *
 * Provenance: HAND-DERIVED. `fingerprintFile` is called directly to compute the expected sha
 * independently of `writeParseResult`'s own hashing, so this does not merely restate the
 * implementation.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { indexFileSync } from '../src/parser.js'
import { pathEqClause } from '../src/sql_path.js'
import { foldPath } from '../src/util.js'

let TMP: string
let dbPath: string
let filePath: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-sha-preserve-'))
  dbPath = path.join(TMP, 'index.db')
  filePath = path.join(TMP, 'widget.ts')
  fs.writeFileSync(filePath, 'export function widget(): number {\n  return 1\n}\n')
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function readEmbedSha(): string | null {
  const db = getDb(dbPath)
  const row = db.prepare(`SELECT embed_sha FROM files WHERE ${pathEqClause('path')}`).get(foldPath(filePath)) as
    | { embed_sha: string | null }
    | undefined
  return row?.embed_sha ?? null
}

describe('writeParseResult preserves embed_sha across a content-unchanged reparse', () => {
  it('calibration: a freshly indexed file has no embed_sha yet, so "preserved" below proves something', () => {
    indexFileSync(filePath, dbPath)
    expect(readEmbedSha(), 'a brand-new row already carried an embed_sha; the seeded value below would prove nothing').toBeNull()
  })

  it('carries a real embed_sha forward when the reparsed content is byte-identical', () => {
    indexFileSync(filePath, dbPath)
    const sha = fingerprintFile(filePath)
    expect(sha, 'fingerprintFile could not hash the fixture').not.toBeNull()

    // Seed the embed_sha a prior, successful embedding pass would have stamped -- the fixture's
    // real sha, not a placeholder, since the fix's condition is `priorRow.sha === sha`.
    const db = getDb(dbPath)
    db.prepare(`UPDATE files SET embed_sha = ? WHERE ${pathEqClause('path')}`).run(sha, foldPath(filePath))
    expect(readEmbedSha()).toBe(sha)

    // Reparse with identical bytes on disk (a parser-fingerprint bump, or a touched mtime).
    indexFileSync(filePath, dbPath)

    expect(readEmbedSha(), 'a reparse of unchanged content discarded the embed_sha, forcing a needless re-embed').toBe(sha)
  })

  it('resets embed_sha (does not carry a stale one forward) when the content actually changed', () => {
    indexFileSync(filePath, dbPath)
    const oldSha = fingerprintFile(filePath)
    const db = getDb(dbPath)
    db.prepare(`UPDATE files SET embed_sha = ? WHERE ${pathEqClause('path')}`).run(oldSha, foldPath(filePath))

    fs.writeFileSync(filePath, 'export function widget(): number {\n  return 2\n}\n')
    indexFileSync(filePath, dbPath)

    expect(
      readEmbedSha(),
      'embed_sha for the OLD content survived a reparse of genuinely different content -- it would read as already-embedded and skip re-embedding the new bytes',
    ).not.toBe(oldSha)
  })
})
