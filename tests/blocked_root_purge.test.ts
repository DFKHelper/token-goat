/** `token-goat project exclude <path>` stopped future indexing and left everything already indexed exactly where it was, so a directory excluded after a first index stayed fully readable through `symbol`. Existence-based pruning could never fix it: the files are still on disk, which is the point. Confirmed live before the fix -- exclude, reindex with --force, and the excluded body came straight back. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { invalidateConfigCache, loadPersistedConfig, saveConfig } from '../src/config.js'
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
    // A live project: a cursor row with no known_roots row and no directory is an orphan the sweep collects (see orphan_reconcile_cursors.test.ts).
    fs.mkdirSync(path.join(root, 'other'))
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, 0)').run(gone)
    putCursors(gone)
    putCursors(other)

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000, dryRun: true })
    expect(cursorRoots().length).toBe(4)

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
    expect(cursorRoots()).toEqual([other, `${other}${NUL}deletions`].sort())
  })

  // The refusal is raised by a trigger on the cursor delete rather than by a held lock: a lock refuses the first write of the transaction (the known_roots delete), never the later cursor purge this row is about. A trigger that aborts the delete is the same SqliteError out of the same statement, on an event the row controls.
  const refuseCursorDeletes = (): void => {
    getDb(dbPath).exec("CREATE TRIGGER refuse_cursor_delete BEFORE DELETE ON reconcile_cursor BEGIN SELECT RAISE(ABORT, 'database is locked'); END")
  }
  const allowCursorDeletes = (): void => {
    getDb(dbPath).exec('DROP TRIGGER refuse_cursor_delete')
  }
  const knownRoots = (): string[] => (getDb(dbPath).prepare('SELECT root FROM known_roots').all() as Array<{ root: string }>).map((r) => r.root)

  it('sweepKnownRoots keeps the known_roots row with its cursor rows when the purge is refused, and finishes once it is not', () => {
    const gone = canonicalizeIndexPath(path.join(root, 'gone'))
    const other = canonicalizeIndexPath(path.join(root, 'other'))
    // A live project: a cursor row with no known_roots row and no directory is an orphan the sweep collects (see orphan_reconcile_cursors.test.ts).
    fs.mkdirSync(path.join(root, 'other'))
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, 0)').run(gone)
    putCursors(gone)
    putCursors(other)
    refuseCursorDeletes()

    expect(() => sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 }), 'a refused cursor purge aborted the sweep').not.toThrow()
    expect(knownRoots(), 'the known_roots row went while its cursor rows stayed, so no later sweep can find them').toEqual([gone])
    expect(cursorRoots().length).toBe(4)

    allowCursorDeletes()
    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
    expect(knownRoots()).toEqual([])
    expect(cursorRoots()).toEqual([other, `${other}${NUL}deletions`].sort())
  })

  // A live root listed in worker.blocked_roots, with a known_roots row and cursor rows but no file rows: the state project exclude leaves when its cursor purge was refused. HAND-DERIVED from the control flow of sweepKnownRoots; no producer output is involved.
  function excludeInConfig(dir: string): () => void {
    const cfg = loadPersistedConfig()
    const before = cfg.worker.blocked_roots
    cfg.worker.blocked_roots = [...before, dir]
    saveConfig(cfg)
    invalidateConfigCache()
    return () => {
      const restored = loadPersistedConfig()
      restored.worker.blocked_roots = before
      saveConfig(restored)
      invalidateConfigCache()
    }
  }
  function liveRootWithCursors(name: string): string {
    const dir = path.join(root, name)
    fs.mkdirSync(dir)
    const project = canonicalizeIndexPath(dir)
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, NULL)').run(project)
    putCursors(project)
    return project
  }

  it('sweepKnownRoots clears the cursor rows and the registry row of a live excluded root, with no clock', () => {
    const project = liveRootWithCursors('excluded')
    const undo = excludeInConfig(path.join(root, 'excluded'))
    try {
      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(cursorRoots(), `the cursor rows of ${project} survived one sweep`).toEqual([])
      expect(knownRoots(), 'the registry row of an excluded root survived one sweep').toEqual([])
    } finally {
      undo()
    }
  })

  // HAND-DERIVED from the control flow of sweepKnownRoots: it reads worker.blocked_roots on every call (index_prune.ts:296), so a root removed from the list before the sweep is a plain live root, which has no file rows (:365) and keeps its registry row and cursor rows (the orphan pass skips a root with a registry row).
  it('keeps the registry row and the cursor rows of a root that was excluded and then re-included before the sweep', () => {
    const project = liveRootWithCursors('excluded')
    const dir = path.join(root, 'excluded')
    const undo = excludeInConfig(dir)
    try {
      expect(loadPersistedConfig().worker.blocked_roots, 'calibration: the exclusion was not written').toContain(dir)
      undo()
      expect(loadPersistedConfig().worker.blocked_roots, 'calibration: the re-inclusion was not written').not.toContain(dir)

      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(knownRoots(), 'the registry row of a re-included root was swept as if it were still excluded').toEqual([project])
      expect(cursorRoots().length, 'the scan progress of a re-included root was swept as if it were still excluded').toBe(2)
    } finally {
      undo()
    }
  })

  it('finishes a refused exclude purge on the next sweep, and keeps the registry row until it does', () => {
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')
    const project = canonicalizeIndexPath(path.join(root, 'secretdir'))
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, NULL)').run(project)
    putCursors(project)
    const undo = excludeInConfig(path.join(root, 'secretdir'))
    try {
      refuseCursorDeletes()
      pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)
      expect(cursorRoots().length, 'calibration: the refused purge left both cursor rows').toBe(2)
      expect(indexedPaths(), 'calibration: the file rows went before the refusal').toEqual([])

      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(cursorRoots().length, 'a sweep that was refused again dropped the cursor rows anyway').toBe(2)
      expect(knownRoots(), 'the registry row went while its cursor rows stayed, so no later sweep can retry').toEqual([project])

      allowCursorDeletes()
      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(cursorRoots(), 'the retry did not collect the cursor rows the refused purge left').toEqual([])
      expect(knownRoots()).toEqual([])
    } finally {
      undo()
    }
  })

  // The refusal here is on the file rows, not the cursor rows: the trigger aborts the delete from files, which removeFilesBestEffort swallows per file, so pruneBlockedRoot returns with the file rows still indexed. Its own cursor purge is a separate statement and still lands.
  it('keeps the registry row of an excluded root while file rows remain under it, and drops it once they are gone', () => {
    seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')
    const project = canonicalizeIndexPath(path.join(root, 'secretdir'))
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, NULL)').run(project)
    putCursors(project)
    const undo = excludeInConfig(path.join(root, 'secretdir'))
    try {
      getDb(dbPath).exec("CREATE TRIGGER refuse_file_delete BEFORE DELETE ON files BEGIN SELECT RAISE(ABORT, 'database is locked'); END")

      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(indexedPaths().length, 'calibration: the refused delete left the file row indexed').toBe(1)
      expect(knownRoots(), 'the registry row went while file rows remained under the excluded root, so nothing retries the purge').toEqual([project])
      expect(cursorRoots(), 'calibration: pruneBlockedRoot purges the cursor rows itself, so none are left for the transaction').toEqual([])

      getDb(dbPath).exec('DROP TRIGGER refuse_file_delete')
      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(indexedPaths(), 'the retry did not remove the file rows').toEqual([])
      expect(knownRoots(), 'the registry row survived the sweep that removed the last file row').toEqual([])
    } finally {
      undo()
    }
  })

  it('leaves a live root that is not excluded, and a dry run, alone', () => {
    liveRootWithCursors('kept')
    const dry = liveRootWithCursors('excluded')
    const undo = excludeInConfig(path.join(root, 'excluded'))
    try {
      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000, dryRun: true })
      expect(cursorRoots().length, 'a dry run wrote').toBe(4)
      expect(knownRoots().length).toBe(2)

      sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })
      expect(knownRoots().map((r) => path.basename(r)), `${dry} left, and the live project that is not excluded stays`).toEqual(['kept'])
      expect(cursorRoots().length, 'the live project that is not excluded lost its scan progress').toBe(2)
    } finally {
      undo()
    }
  })

  it('project exclude still reports what it removed when the cursor purge is refused', () => {
    const secret = seed(path.join('secretdir', 'creds.ts'), 'export function tokenValue() { return "sk" }\n')
    putCursors(canonicalizeIndexPath(path.join(root, 'secretdir')))
    refuseCursorDeletes()

    let removed: string[] = []
    expect(() => {
      removed = pruneBlockedRoot(path.join(root, 'secretdir'), dbPath)
    }, 'a refused cursor purge threw after the config was saved').not.toThrow()

    expect(fs.existsSync(secret)).toBe(true)
    expect(removed.length).toBe(1)
    expect(indexedPaths()).toEqual([])
  })
})
