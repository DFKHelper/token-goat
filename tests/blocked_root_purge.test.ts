/** `token-goat project exclude <path>` stopped future indexing and left everything already indexed exactly where it was, so a directory excluded after a first index stayed fully readable through `symbol`. Existence-based pruning could never fix it: the files are still on disk, which is the point. Confirmed live before the fix -- exclude, reindex with --force, and the excluded body came straight back. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { findFilesUnderBlockedRoot, pruneBlockedRoot, sweepKnownRoots } from '../src/index_prune.js'
import { canonicalizeIndexPath, indexFileSync } from '../src/parser.js'

let root: string
let dbPath: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-blocked-'))
  dbPath = path.join(root, 'test.db')
})

afterEach(() => {
  // The sqlite handle keeps the file open on Windows, so close before removing the directory.
  closeAllDbs()
  fs.rmSync(root, { recursive: true, force: true })
})

/** Index one real file so the assertions run against rows the parser actually wrote. */
function seed(rel: string, source: string): string {
  const full = path.join(root, rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, source)
  indexFileSync(full, dbPath)
  return full
}

function indexedPaths(): string[] {
  return (getDb(dbPath).prepare('SELECT DISTINCT path FROM files').all() as Array<{ path: string }>).map((r) => r.path)
}

describe('pruneBlockedRoot', () => {
  it('removes rows for files that are still on disk, which existence-based pruning never would', () => {
    const secret = seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')

    const removed = pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(fs.existsSync(secret)).toBe(true)
    expect(removed.length).toBe(1)
    expect(indexedPaths()).toEqual([])
  })

  it('leaves everything outside the blocked root alone', () => {
    seed('keep.ts', 'export function keeper() { return 1 }\n')
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')

    pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(indexedPaths().map((p) => path.basename(p))).toEqual(['keep.ts'])
  })

  it('takes the symbol bodies with it, not just the file row', () => {
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk-live-42" }\n')
    const bodies = (): string[] =>
      (getDb(dbPath).prepare('SELECT body FROM symbols').all() as Array<{ body: string | null }>).map((r) => r.body ?? '')
    expect(bodies().join('')).toContain('sk-live-42')

    pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(bodies().join('')).not.toContain('sk-live-42')
  })

  // The embedding half of a stored file is a separate table and a separate delete. indexFileSync alone writes no chunks (embedding is a later pass), so the row is seeded here rather than pretending the parser produced it -- without this, dropping the embedding delete entirely leaves every other assertion in this file green.
  it('takes the embedding chunks with it too, not just the parsed rows', () => {
    const secret = seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')
    // Keyed on `canonicalizeIndexPath` rather than the raw `secret` spelling: the files row this chunk belongs to was written under the canonical key by `indexFileSync`, and `pruneBlockedRoot` deletes chunks by matching that same key, so a native-spelling insert here would never be found and the assertion below would pass for the wrong reason (nothing to delete).
    getDb(dbPath)
      .prepare('INSERT INTO chunks (file_path, start_line, end_line, text, kind) VALUES (?, 1, 1, ?, ?)')
      .run(canonicalizeIndexPath(secret), 'sk-live-42', 'code')
    const chunks = (): number =>
      (getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    expect(chunks()).toBe(1)

    pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(chunks()).toBe(0)
  })

  // A drive root would scope the delete across every project sharing the global DB.
  it('refuses a root shallow enough to span a drive', () => {
    seed('keep.ts', 'export function keeper() { return 1 }\n')

    expect(pruneBlockedRoot('c:/', dbPath)).toEqual([])
    expect(indexedPaths().length).toBe(1)
  })

  it('reports nothing to remove when the root was never indexed', () => {
    seed('keep.ts', 'export function keeper() { return 1 }\n')

    expect(pruneBlockedRoot(path.join(root, 'never-indexed'), dbPath)).toEqual([])
    expect(indexedPaths().length).toBe(1)
  })
})

describe('findFilesUnderBlockedRoot', () => {
  it('names what would go without removing any of it', () => {
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')

    const found = findFilesUnderBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(found.length).toBe(1)
    expect(indexedPaths().length).toBe(1)
  })

  it('refuses the same too-shallow root the prune refuses, so a dry run cannot promise a wipe', () => {
    seed('keep.ts', 'export function keeper() { return 1 }\n')

    expect(findFilesUnderBlockedRoot('c:/', dbPath)).toEqual([])
  })
})

// HAND-DERIVED: the key shapes come from reconcile.ts (a scan row keyed by the project root, a deletion-pass row keyed by the root, a NUL character and the word deletions); nothing here is read from a producer's output.
describe('reconcile cursors leave with the project', () => {
  const NUL = String.fromCharCode(0)
  const cursorRoots = (): string[] =>
    (getDb(dbPath).prepare('SELECT hex(root) AS h FROM reconcile_cursor').all() as Array<{ h: string }>).map((r) => Buffer.from(r.h, 'hex').toString('utf8')).sort()
  function putCursors(project: string): void {
    const ins = getDb(dbPath).prepare('INSERT INTO reconcile_cursor (root, last_scanned_path, updated_at) VALUES (?, ?, 0)')
    ins.run(project, `${project}/a.ts`)
    ins.run(`${project}${NUL}deletions`, `${project}/b.ts`)
  }

  it('project exclude purges the scan row and the deletion-pass row, and only that project\'s', () => {
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')
    const secret = canonicalizeIndexPath(path.join(root, 'secretdir'))
    const sibling = canonicalizeIndexPath(path.join(root, 'secretdir2'))
    const other = canonicalizeIndexPath(path.join(root, 'other'))
    putCursors(secret)
    putCursors(sibling)
    putCursors(other)

    pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)

    expect(cursorRoots()).toEqual([sibling, `${sibling}${NUL}deletions`, other, `${other}${NUL}deletions`].sort())
  })

  it('purges the cursor rows of a root that was never indexed too, since the cursor can outlive its files', () => {
    const gone = canonicalizeIndexPath(path.join(root, 'gone'))
    putCursors(gone)

    pruneBlockedRoot(path.join(root, 'gone'), dbPath)

    expect(cursorRoots()).toEqual([])
  })

  it('sweepKnownRoots purges both rows of a root unreachable past its grace, and a dry run keeps them', () => {
    const gone = canonicalizeIndexPath(path.join(root, 'gone'))
    const other = canonicalizeIndexPath(path.join(root, 'other'))
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, 0)').run(gone)
    putCursors(gone)
    putCursors(other)

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000, dryRun: true })
    expect(cursorRoots().length).toBe(4)

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
    expect(cursorRoots()).toEqual([other, `${other}${NUL}deletions`].sort())
  })
})
