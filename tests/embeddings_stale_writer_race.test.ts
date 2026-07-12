import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Regression: worker.ts's inFlightEmbeddings dedup only serializes concurrent
// indexFileEmbeddings calls WITHIN a single process. A slow foreground `token-goat index`
// embedding call can commit its files.embed_sha stamp AFTER a second process (e.g. the
// background daemon) has already reindexed and re-embedded the same file with fresher content --
// silently overwriting the fresher embed_sha stamp with a stale one, with no way to detect or
// self-heal the mismatch. stampEmbedSha's UPDATE now requires files.sha to still equal the sha
// the embed run started from, so a stale writer's stamp becomes a no-op once a fresher writer has
// already moved files.sha on.
import { closeAllDbs } from '../src/db.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { getFileEntry } from '../src/index_reader.js'
import { disabledEmbedSha, indexFileSync, indexFileEmbeddings } from '../src/parser.js'

describe('stampEmbedSha optimistic-concurrency guard (cross-process embed race)', () => {
  let TMP: string
  let dbPath: string
  let filePath: string
  let prevEmbeddingsEnv: string | undefined

  beforeEach(() => {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-embed-race-'))
    dbPath = path.join(TMP, 'index.db')
    filePath = path.join(TMP, 'race.ts')
    prevEmbeddingsEnv = process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED']
    // Deterministic, environment-independent path: the disabled-marker stamp still exercises
    // stampEmbedSha's real UPDATE statement (and its new sha-match guard) without depending on
    // the optional embeddings model / sqlite-vec being installed in the test environment.
    process.env['TOKEN_GOAT_EMBEDDINGS_ENABLED'] = 'false'
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

  it('does not let a stale embed run overwrite a fresher files.sha with its own stamp', async () => {
    const oldContent = 'export function oldVersion(): number {\n  return 1\n}\n'
    const newContent = 'export function newVersion(): number {\n  return 2\n}\n'
    const oldSha = fingerprintContent(Buffer.from(oldContent, 'utf8'))
    const newSha = fingerprintContent(Buffer.from(newContent, 'utf8'))

    // The stale writer's world: it read the file when it was still `oldContent` and started an
    // embed run keyed on oldSha.
    fs.writeFileSync(filePath, oldContent)
    indexFileSync(filePath, dbPath)
    expect(getFileEntry(filePath, dbPath)?.sha).toBe(oldSha)

    // A second, faster writer (e.g. the background daemon) reindexes the same file to newContent
    // BEFORE the stale writer's embed run commits its stamp -- files.sha has now moved on.
    fs.writeFileSync(filePath, newContent)
    indexFileSync(filePath, dbPath)
    expect(getFileEntry(filePath, dbPath)?.sha).toBe(newSha)

    // The stale writer's embed run finally commits, still keyed on the now-stale oldSha.
    await indexFileEmbeddings(filePath, dbPath, oldSha)

    // Pre-fix: stampEmbedSha's UPDATE matched on path alone and would have stamped
    // disabledEmbedSha(oldSha) regardless, clobbering the row with a marker for content that is
    // no longer current. Post-fix: the UPDATE's `AND sha = ?` guard means the stale writer's
    // stamp is a no-op because files.sha is newSha, not oldSha.
    const entry = getFileEntry(filePath, dbPath)
    expect(entry?.embedSha).not.toBe(disabledEmbedSha(oldSha))
    expect(entry?.embedSha).toBe('')
  })

  it('still stamps embed_sha normally in the non-racing single-writer case', async () => {
    const content = 'export function soleVersion(): number {\n  return 1\n}\n'
    const sha = fingerprintContent(Buffer.from(content, 'utf8'))
    fs.writeFileSync(filePath, content)
    indexFileSync(filePath, dbPath)
    expect(getFileEntry(filePath, dbPath)?.sha).toBe(sha)

    await indexFileEmbeddings(filePath, dbPath, sha)

    const entry = getFileEntry(filePath, dbPath)
    expect(entry?.embedSha).toBe(disabledEmbedSha(sha))
  })
})
