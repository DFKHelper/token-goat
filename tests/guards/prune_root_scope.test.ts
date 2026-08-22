/**
 * Guards for the three ways index pruning can act on the wrong rows.
 *
 * Pruning deletes index rows for files that are gone from disk. Every one of these guards covers a
 * case where the code's own stated intent and its behaviour disagree, and where the disagreement is
 * silent: rows either vanish that should have stayed, or stay forever with nothing able to clear
 * them. None of them produces an error, so only an assertion on the surviving rows can see it.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb } from '../../src/db.js'
import { normalizePath } from '../../src/paths.js'
import { pruneDeletedFiles, sweepKnownRoots, recordKnownRoot, isTooShallowToPrune } from '../../src/index_prune.js'

// Built rather than written as a literal so no layer between here and the file on disk can
// quietly drop the backslash that is the entire point of the case.
const BACKSLASH_DRIVE_ROOT = 'C:' + String.fromCharCode(92)

let dir: string
let dbPath: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-prune-scope-'))
  dbPath = path.join(dir, 'global.db')
})

afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // Windows can hold the DB file open briefly after the handle is dropped.
  }
})

/** Insert one indexed file row plus a symbol, at a literal path string, without touching disk. */
function seedRow(p: string): void {
  const db = getDb(dbPath)
  db.prepare('INSERT OR REPLACE INTO files (path, sha, mtime, language, indexed_at) VALUES (?, ?, ?, ?, ?)').run(
    p,
    'sha',
    0,
    'typescript',
    0,
  )
  db.prepare(
    'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(p, 'seeded', 'function', 1, 1, 'body', '')
}

function rowsFor(p: string): number {
  const db = getDb(dbPath)
  const r = db.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(p) as { n: number }
  return r.n
}

describe('a root spelling that normalizes to a whole volume is refused', () => {
  // The guard splits the root into segments and refuses one that has none left after dropping a
  // drive letter. It read the RAW spelling, while the scan it guards normalizes first -- so `c:/`
  // and `C:` were refused and the backslash spelling was not, even though all three name the same drive. The row
  // seeded here is on that drive and its file does not exist, so a prune that accepts the root
  // deletes it. Seeded as a literal path string rather than a real file so the case means the same
  // thing on Linux and macOS, where no such path exists to create.
  it('refuses a backslash-spelled drive root', () => {
    seedRow('c:/some-other-project/file.ts')
    const pruned = pruneDeletedFiles(BACKSLASH_DRIVE_ROOT, dbPath)
    expect(pruned, 'a backslash drive root was accepted and pruned another project rows').toBe(0)
    expect(rowsFor('c:/some-other-project/file.ts')).toBe(1)
  })

  // Asserted on the predicate rather than on a prune outcome. A UNC path cannot be exercised
  // through pruneDeletedFiles on Windows without reaching the network: statSync on
  // //server/share/... stalls for seconds and then throws something that is not ENOENT, so the
  // prune declines to delete for that reason alone and the case stays green whether the guard
  // works or not. Calling the predicate is the only way to make this decide anything.
  it('refuses the root of a UNC network share', () => {
    expect(isTooShallowToPrune('//server/share'), 'a whole network share was accepted as a prune root').toBe(true)
    expect(isTooShallowToPrune('//server'), 'a bare UNC host was accepted as a prune root').toBe(true)
  })

  it('still allows a real project directory on a share', () => {
    expect(isTooShallowToPrune('//server/share/project'), 'a project on a share stopped being prunable').toBe(false)
  })

  // The UNC rule keys on two segments, and an ordinary POSIX path can have two segments as well.
  // Without this, rejecting every two-segment path would read as a passing guard while quietly
  // disabling pruning for a large class of perfectly normal roots.
  it('does not mistake an ordinary two-segment POSIX path for a share root', () => {
    expect(isTooShallowToPrune('/home/dev'), 'an ordinary directory was refused as too shallow').toBe(false)
  })

  // Without this the guard could pass by refusing everything, which would disable pruning entirely.
  it('non-firing case: a real project directory under a drive is still prunable', () => {
    const real = path.join(dir, 'proj')
    fs.mkdirSync(real)
    const gone = path.join(real, 'gone.ts').split(path.sep).join('/')
    seedRow(gone)
    expect(pruneDeletedFiles(real.split(path.sep).join('/'), dbPath), 'an ordinary root stopped being prunable').toBe(1)
  })
})

describe('what sits at a path decides whether the indexed file is still there', () => {
  it('prunes a file whose path is now occupied by a directory', () => {
    const p = path.join(dir, 'config.ts')
    fs.mkdirSync(p)
    const key = p.split(path.sep).join('/')
    seedRow(key)
    const pruned = pruneDeletedFiles(dir.split(path.sep).join('/'), dbPath)
    expect(pruned, 'a directory standing where the file used to be kept its rows indexed forever').toBe(1)
    expect(rowsFor(key)).toBe(0)
  })

  it('non-firing case: a file that is still a file is left alone', () => {
    const p = path.join(dir, 'live.ts')
    fs.writeFileSync(p, 'export const a = 1\n')
    const key = p.split(path.sep).join('/')
    seedRow(key)
    expect(pruneDeletedFiles(dir.split(path.sep).join('/'), dbPath), 'a live file was pruned').toBe(0)
    expect(rowsFor(key)).toBe(1)
  })
})

describe('a project root replaced by a regular file is gone, not reachable', () => {
  it('prunes it after the grace period instead of flagging it forever', () => {
    const root = path.join(dir, 'proj')
    fs.mkdirSync(root)
    // A project marker, so recordKnownRoot below resolves this directory as the root rather than
    // walking past it.
    fs.mkdirSync(path.join(root, '.git'))
    const seedFile = path.join(root, 'f0.ts')
    fs.writeFileSync(seedFile, 'export const a = 1')
    const rootKey = normalizePath(root)
    // Above the anomaly guard's minimum count, and every one of them missing once the directory
    // goes, so the ratio is 100%: exactly the shape the guard refuses to prune while it believes
    // the root is live.
    for (let i = 0; i < 25; i++) seedRow(`${rootKey}/f${i}.ts`)
    recordKnownRoot(normalizePath(seedFile), dbPath)

    fs.rmSync(root, { recursive: true, force: true })
    fs.writeFileSync(root, 'a regular file now sits where the project directory was')

    // First sweep records the root as missing; the second, past the grace window, prunes it.
    sweepKnownRoots(dbPath, { missingGraceMs: 0 })
    const result = sweepKnownRoots(dbPath, { missingGraceMs: 0 })

    expect(result.flaggedRoots, 'the root was flagged as a live-root anomaly and never pruned').not.toContain(rootKey)
    expect(rowsFor(`${rootKey}/f1.ts`), 'rows under a replaced root stayed indexed with nothing able to clear them').toBe(0)
  })
})
