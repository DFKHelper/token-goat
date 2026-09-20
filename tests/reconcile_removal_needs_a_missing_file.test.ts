/**
 * `reconcileProject`'s deletion pass must treat only "the file is gone" as a deletion, never "I could not find out".
 *
 * The pass stats every indexed row git did not enumerate, and whatever throws is a deletion candidate. That stat used to run on untracked rows inside a git repository only -- 228 of this repository's 1,628 rows -- and now runs on every row of a root git cannot enumerate, which is 100% of them. A `statSync` that fails for any reason other than absence (a permission-denied path, an unreachable network or removable drive, a handle the OS refuses) therefore hands a whole root's index to the removal queue in one sweep, and the next read has to rebuild it. `ENOENT` and `ENOTDIR` are the codes that mean gone; every other code means the row's fate is unknown and the row must survive.
 *
 * Provenance: CAPTURE for the deletion case -- the file is removed from disk and the error comes from the real OS through the real `reconcileProject`, nothing simulated. HAND-DERIVED for the per-code table: the codes are POSIX/Node `errno` names, chosen independently of the implementation, and injected at the `node:fs` boundary rather than at any seam inside token-goat, so the production call path is the one under test.
 */
import { spawnSync } from 'node:child_process'
import type * as fsType from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'

/** Set by a case to make `statSync` of exactly one path fail with exactly one errno; every other path, and every other `fs` call, goes to the real module. */
const statFailure: { target: string | null; code: string } = { target: null, code: 'EACCES' }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fsType>()
  const guardedStatSync = (target: fsType.PathLike, options?: unknown): unknown => {
    if (typeof target === 'string' && statFailure.target !== null && target.replace(/\\/g, '/') === statFailure.target) {
      throw Object.assign(new Error(`simulated ${statFailure.code} failure`), { code: statFailure.code })
    }
    return (actual.statSync as (t: fsType.PathLike, o?: unknown) => unknown)(target, options)
  }
  return { ...actual, statSync: guardedStatSync }
})

// Imported after the mock declaration purely for readability; `vi.mock` is hoisted above it either way.
import * as fs from 'node:fs'

let projectDir: string
let dbPath: string
let ghostPath: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-removal-'))
  dbPath = path.join(os.tmpdir(), `tg-reconcile-removal-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(projectDir, 'tracked.ts'), 'export const tracked = 1\n')
  git('add', '-A')
  git('commit', '-m', 'init')
  // Untracked on purpose: `seenOnDisk` is filled from `git ls-files`, so only a row git did not list reaches the stat that decides deletion. A tracked file never gets there, and a case built on one would pass whatever the stat did.
  fs.writeFileSync(path.join(projectDir, 'ghost.ts'), 'export const ghost = 2\n')
  ghostPath = resolveIndexPath('ghost.ts', projectDir)
  indexFileSync(resolveIndexPath('tracked.ts', projectDir), dbPath)
  indexFileSync(ghostPath, dbPath)
})

afterEach(() => {
  statFailure.target = null
  try {
    getDb(dbPath).close()
  } catch {
    // Already closed or never opened.
  }
  fs.rmSync(projectDir, { recursive: true, force: true })
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true })
  }
})

/** One full sweep against the fixture, reporting only -- the removal queue is the harm, and no case here needs to write to it to observe what the sweep decided. */
function sweep(): ReturnType<typeof reconcileProject> {
  return reconcileProject({ cwd: projectDir, dbPath, budgetMs: 30000, dryRun: true })
}

const basenames = (paths: string[]): string[] => paths.map((p) => path.basename(p))

describe('reconcileProject removal requires evidence the file is gone', () => {
  it('reports a file actually deleted from disk, with the error coming from the real filesystem', () => {
    fs.rmSync(path.join(projectDir, 'ghost.ts'))
    const r = sweep()
    expect(r.budgetExhausted, 'the sweep was truncated, which suppresses deletions outright; this case proves nothing').toBe(false)
    expect(basenames(r.removed), 'a file gone from disk kept its index row').toContain('ghost.ts')
  })

  it('leaves a live untracked row alone', () => {
    // Calibration in the other direction: the fixture must not report a deletion when nothing failed, or the per-code table below would be indistinguishable from a sweep that never removes anything.
    expect(sweep().removed, 'a live untracked file was reported as deleted').toEqual([])
  })

  for (const code of ['ENOENT', 'ENOTDIR']) {
    it(`treats a ${code} stat as the deletion it is`, () => {
      statFailure.target = ghostPath
      statFailure.code = code
      expect(basenames(sweep().removed), `a ${code} stat no longer counts as a deletion; the narrowing disabled the mechanism`).toContain('ghost.ts')
    })
  }

  for (const code of ['EACCES', 'EPERM', 'EBUSY', 'EIO', 'ENETUNREACH']) {
    it(`leaves the row alone when the stat fails with ${code}`, () => {
      statFailure.target = ghostPath
      statFailure.code = code
      const r = sweep()
      expect(r.removed, `a ${code} stat was read as a deletion, so an unreadable root's whole index would be queued for removal`).toEqual([])
    })
  }
})
