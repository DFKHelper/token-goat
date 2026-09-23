/**
 * Indexing a file must register its project root in `known_roots`.
 *
 * `sweepKnownRoots` is the only thing that reclaims index rows for files that vanish from disk,
 * and it only ever scans roots that `known_roots` lists. Until the indexing seams recorded one,
 * the sole writer of that table was the edit hook, which made the sweepable set "roots you have
 * edited" rather than "roots you have indexed": a project indexed and read but never edited was
 * never registered, so its dead rows were unreachable by any sweep and stayed forever. Measured on
 * the live ledger before the fix: 233 of 235 dead rows (99.1%) sat outside every known root, and
 * 24.9% of all indexed files belonged to a root that had never been recorded. `token-goat project
 * prune` reported "nothing to do" against all of them, which is why this went unnoticed -- the
 * command whose job it was said it had none.
 *
 * Both covered seams sit at the orchestration layer rather than inside indexFileSync, for two
 * reasons that the last test below pins: a file whose content is already fresh is gated out
 * before indexFileSync is ever called, so a fully-indexed project would stay unregistered
 * indefinitely; and src/parser.ts is hashed whole into PARSER_FINGERPRINT, so bookkeeping there
 * would bill every existing install a full reparse for a change that cannot alter an extracted
 * symbol.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../src/db.js'
import { fingerprintFile } from '../src/fingerprint.js'
import { recordKnownRootThrottled } from '../src/known_roots.js'
import { indexFileSync } from '../src/parser.js'
import { indexFileSyncPinned } from '../src/read_commands.js'
import { normalizePath } from '../src/util.js'
import { makeIndexer } from '../src/worker.js'

let projectDir: string
let dbDir: string
let dbPath: string

beforeEach(() => {
  // A fresh directory per test also gives a fresh throttle-marker key, which is fingerprinted from the file's parent directory -- so recordKnownRootThrottled can never short-circuit here on a marker some earlier test or real edit left behind.
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-knownroot-'))
  fs.mkdirSync(path.join(projectDir, '.git'))
  // The database lives outside the project directory: better-sqlite3 keeps the file open for the
  // life of the process, and on Windows that makes the directory holding it undeletable.
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-knownroot-db-'))
  dbPath = path.join(dbDir, 'index.db')
})

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true })
})

function recordedRoots(): string[] {
  const rows = getDb(dbPath).prepare('SELECT root FROM known_roots').all() as Array<{ root: string }>
  return rows.map((r) => normalizePath(r.root))
}

function writeFile(name: string, body: string): string {
  const file = path.join(projectDir, name)
  fs.writeFileSync(file, body)
  return file
}

const UNREACHABLE =
  'the project root went unregistered, so sweepKnownRoots can never reclaim these rows once their ' +
  'files are deleted -- they are unreachable by every sweep and stay in the index permanently, ' +
  'while `project prune` reports nothing to do.'

describe('indexing registers the project root for sweeping', () => {
  it('records the root of a file the read path heals', () => {
    const file = writeFile('a.ts', 'export const a = 1\n')

    indexFileSyncPinned(file, dbPath)

    // The row this index wrote is what the sweep would later have to reclaim, so assert it landed:
    // a root recorded for a file that was never actually indexed would prove nothing.
    const indexed = getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }
    expect(indexed.n, 'the file was not indexed, so this test cannot say anything about its root').toBe(1)

    expect(recordedRoots(), UNREACHABLE).toContain(normalizePath(projectDir))
  })

  it('records the root of a file the worker drains', () => {
    const file = writeFile('b.ts', 'export const b = 2\n')

    makeIndexer(dbPath)(file, fingerprintFile(file) ?? '')

    expect(recordedRoots(), UNREACHABLE).toContain(normalizePath(projectDir))
  })

  it('does not throw when the root cannot be recorded', () => {
    // `:memory:` is a dbPath real callers hand to the indexing seams (runSkeleton's
    // --force-refresh reindex reaches indexFileSyncPinned with one), and resolveDbPath rejects it
    // outright. Recording is advisory bookkeeping for a later sweep, so a database that refuses
    // the write must cost one sweep window and nothing else. Before this was caught, adding the
    // recorder to those seams turned that dbPath into a thrown error on a path that had worked.
    const file = writeFile('d.ts', 'export const d = 4\n')

    expect(() => recordKnownRootThrottled(file, dbDir, ':memory:')).not.toThrow()
  })

  it('records a root whose files are all already fresh', async () => {
    // The case a recorder placed inside indexFileSync cannot reach at all: the drain gates the file
    // out as unchanged long before any parse happens. Writing the row through indexFileSync
    // directly reproduces the state an older build left behind -- rows present, no root recorded --
    // which is the majority of what the live measurement above found stranded, and it leaves no
    // throttle marker for the drain below to short-circuit on.
    const file = writeFile('c.ts', 'export const c = 3\n')
    indexFileSync(file, dbPath)
    expect(
      recordedRoots(),
      'indexFileSync recorded a root on its own, so this test no longer isolates the drain',
    ).toEqual([])

    // `indexed_at` is written only by writeParseResult, so an unchanged stamp across the drain is
    // the proof that no reparse ran -- which is what makes this a test of the skip path rather
    // than a second index in disguise. The drain's return value cannot carry that: a parse-fresh
    // file whose embeddings are still pending returns the embed promise, not the `false` a
    // fully-fresh file returns.
    const stampOf = (): unknown =>
      (getDb(dbPath).prepare('SELECT indexed_at FROM files').get() as { indexed_at: unknown }).indexed_at
    const before = stampOf()
    await makeIndexer(dbPath)(file, fingerprintFile(file) ?? '')

    expect(stampOf(), 'the file was reparsed, so this test says nothing about the skip path').toBe(before)
    expect(recordedRoots(), UNREACHABLE).toContain(normalizePath(projectDir))
  })
})
