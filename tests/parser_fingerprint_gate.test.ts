/**
 * A parser change invalidates already-indexed files whose content never moved.
 *
 * `files.sha` was the only parse-freshness key, and it answers exactly one question: has this
 * file's content changed since we parsed it. It cannot answer the other one: has what we extract
 * from that content changed. So an extraction-logic change left every unedited file pinned to the
 * symbol set an older parser gave it, indefinitely, and `token-goat index` reported those files as
 * skipped rather than reparsed. Measured against a clean index built by the same binary, 37 of 237
 * source files in this repo disagreed, 180 surplus rows in all. `files.parser_sha` closes it, the
 * same way `files.embed_sha` already gates embedding freshness independently of parse freshness.
 *
 * Provenance: HAND-DERIVED. The stale fingerprints are written by this file, and the expectation
 * (rows are rebuilt vs. left alone) is computed from what a reparse means, not read back out of any
 * matcher in `src/`. The generated-constant case is CAPTURE: it spawns the real script and asserts
 * its exit code, so it fails on the actual drift a developer would ship.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import Database from '../src/sqlite_driver.js'
import { getDb, SCHEMA_VERSION } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { PARSER_FINGERPRINT } from '../src/parser_fingerprint.js'
import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/util.js'
import { makeIndexer } from '../src/worker.js'
import { clearModuleCaches } from '../src/reset.js'

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** Index one real file, then drop its symbol rows while leaving the `files` row in place. What the gate does next is the whole question: reparse rebuilds them, a skip leaves the table empty. */
function seedIndexedFileWithNoSymbols(dbPath: string, filePath: string): void {
  indexFileSync(filePath, dbPath)
  const db = getDb(dbPath)
  const before = db.prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }
  expect(before.n, 'the fixture must index at least one symbol, or emptiness proves nothing later').toBeGreaterThan(0)
  db.prepare('DELETE FROM symbols').run()
}

function symbolCount(dbPath: string): number {
  return (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM symbols').get() as { n: number }).n
}

describe('parser fingerprint freshness gate', () => {
  beforeEach(() => {
    clearModuleCaches()
  })

  it('reparses a file whose content is unchanged but whose rows came from a different parser', () => {
    const dir = tmpDir('tg-pfp-stale-')
    const file = normalizePath(path.join(dir, 'Widget.ts'))
    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\n')
    const dbPath = path.join(dir, 'idx.db')

    seedIndexedFileWithNoSymbols(dbPath, file)
    // The shape an upgraded binary meets: same bytes on disk, rows written by an older extractor.
    getDb(dbPath).prepare('UPDATE files SET parser_sha = ?').run('0000000000000000')

    const sha = fingerprintFile(file)
    expect(sha, 'a readable fixture must fingerprint, or the gate below is never reached').not.toBeNull()
    makeIndexer(dbPath)(file, sha as string)

    expect(symbolCount(dbPath), 'a parser-fingerprint mismatch must count as changed and rebuild the rows').toBeGreaterThan(0)
  })

  it('reparses a file carrying no parser fingerprint at all, which is what the migration leaves behind', () => {
    const dir = tmpDir('tg-pfp-null-')
    const file = normalizePath(path.join(dir, 'Widget.ts'))
    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\n')
    const dbPath = path.join(dir, 'idx.db')

    seedIndexedFileWithNoSymbols(dbPath, file)
    // v12 -> v13 adds the column without a backfill, so every pre-existing row reads NULL. That is
    // the truthful value (nobody recorded which parser wrote them) and it must read as stale.
    getDb(dbPath).prepare('UPDATE files SET parser_sha = NULL').run()

    const sha = fingerprintFile(file)
    makeIndexer(dbPath)(file, sha as string)

    expect(symbolCount(dbPath), 'a row predating the column has an unknown parser and must be reparsed once').toBeGreaterThan(0)
  })

  it('still skips a file whose content and parser fingerprint both match, so the gate did not simply stop gating', () => {
    const dir = tmpDir('tg-pfp-fresh-')
    const file = normalizePath(path.join(dir, 'Widget.ts'))
    fs.writeFileSync(file, 'export function widget(): number {\n  return 1\n}\n')
    const dbPath = path.join(dir, 'idx.db')

    seedIndexedFileWithNoSymbols(dbPath, file)
    // Control. indexFileSync already stamped the current fingerprint, so nothing here is stale and
    // the skip must hold. Without this case the two tests above would also pass on a gate that
    // reparsed unconditionally, which would be a different defect rather than the fix.
    const stamped = (getDb(dbPath).prepare('SELECT parser_sha AS p FROM files').get() as { p: string }).p
    expect(stamped, 'indexFileSync must stamp the fingerprint it parsed with').toBe(PARSER_FINGERPRINT)

    const sha = fingerprintFile(file)
    makeIndexer(dbPath)(file, sha as string)

    expect(symbolCount(dbPath), 'byte-identical content parsed by this same parser must not be reparsed').toBe(0)
  })

  it('migrates a v12 files table that predates the column, leaving existing rows unfingerprinted', () => {
    const dir = tmpDir('tg-pfp-mig-')
    const dbPath = path.join(dir, 'idx.db')

    // A files table shaped exactly like v12's SCHEMA_SQL, built against the raw file so the
    // "before" state does not depend on today's SCHEMA_SQL to construct itself.
    const raw = new Database(dbPath)
    raw.exec(
      'CREATE TABLE files (path TEXT PRIMARY KEY, sha TEXT, mtime REAL, language TEXT, indexed_at REAL, embed_sha TEXT, retry_count INTEGER NOT NULL DEFAULT 0);',
    )
    raw.prepare('INSERT INTO files (path, sha, language) VALUES (?, ?, ?)').run('a.ts', 'deadbeef', 'typescript')
    raw.pragma('user_version = 12')
    raw.close()

    const db = getDb(dbPath)
    expect(Number(db.pragma('user_version', { simple: true }))).toBe(SCHEMA_VERSION)
    const row = db.prepare('SELECT sha, parser_sha FROM files WHERE path = ?').get('a.ts') as {
      sha: string
      parser_sha: string | null
    }
    expect(row.sha, 'the pre-existing row must survive the ALTER TABLE').toBe('deadbeef')
    expect(row.parser_sha, 'no backfill: an unknown parser must not be recorded as the current one').toBeNull()
  })

  it('is consulted by both freshness gates, not just the one with behavioural coverage here', () => {
    // The tests above drive worker.ts's makeIndexer. `token-goat index` has its own copy of the
    // same gate in cli.ts, and it is the one that printed "Skipped 1 unchanged file(s)" for a file
    // whose rows were stale. A missing clause there is silent: the command still succeeds, it just
    // never reparses. Structural, because the alternative is a second full CLI harness for one line.
    for (const file of ['src/worker.ts', 'src/cli.ts']) {
      const text = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
      expect(
        /parserSha === PARSER_FINGERPRINT/.test(text),
        `${file} decides parse freshness and must compare parserSha against PARSER_FINGERPRINT, or a parser change stops invalidating anything on that path`,
      ).toBe(true)
    }
  })

  it('has a checked-in fingerprint that still matches the extraction sources', () => {
    // The forcing function. Editing src/parser.ts or any language adapter changes what a parse
    // extracts, so it must change the stamped fingerprint too, or the gate above silently stops
    // invalidating anything. Exit code, not stdout text.
    const run = spawnSync(process.execPath, ['scripts/parser-fingerprint.mjs', '--check'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    expect(run.status, `run \`npm run parser:fingerprint\` and say in the CHANGELOG that upgrading reindexes.\n${run.stderr}`).toBe(0)
  })
})
