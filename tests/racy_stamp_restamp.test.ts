/** A hash that proves a file unchanged is recorded, so the racy-clean gate stops hashing it on every sweep. Fixture provenance: HAND-DERIVED. Every mtime, index time and "now" below is computed from the racy rule `mtime + 2 <= indexed_at` (reconcile.ts::mtimeProvesUnchanged, the margin is this code's own; git's rule, Documentation/technical/racy-git.txt at tag v2.43.0, stops at same-or-newer); no wire format is involved. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../src/db.js'
import { appendDirtyQueuePaths } from '../src/dirty_queue.js'
import type * as FingerprintModule from '../src/fingerprint.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import { reconcileProject, restampVerifiedUnchanged } from '../src/reconcile.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { indexableDir } from './helpers/temp-config.js'
import { runTeardown } from './helpers/strict_teardown.js'

const hashed = vi.hoisted(() => ({ calls: 0 }))
vi.mock('../src/fingerprint.js', async (importOriginal) => {
  const actual = await importOriginal<typeof FingerprintModule>()
  return {
    ...actual,
    fingerprintFile: (filePath: string) => {
      hashed.calls++
      return actual.fingerprintFile(filePath)
    },
  }
})

const OLD = 1_000_000_000
const INDEXED = OLD + 10
const TOUCHED = OLD + 100
// An hour ahead of any clock this runs on: never at least one tick older than now, however slow the machine, so it stands for a file still being written.
const STILL_BEING_WRITTEN = Math.floor(Date.now() / 1000) + 3600
const SOURCE = 'export const value = 1\n'

let projectDir: string
let dataDir: string
let dbPath: string

function git(...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

/** Writes `name`, stamps it `mtimeSec`, indexes it, then says it was indexed at `indexedAtSec`, so a row can be racy or calm without a clock. */
function indexWith(name: string, mtimeSec: number, indexedAtSec: number): string {
  const file = path.join(projectDir, name)
  fs.writeFileSync(file, SOURCE)
  fs.utimesSync(file, mtimeSec, mtimeSec)
  git('add', '-A')
  indexFileSync(resolveIndexPath(name, projectDir), dbPath)
  getDb(dbPath).prepare('UPDATE files SET indexed_at = ? WHERE path LIKE ?').run(indexedAtSec, `%/${name}`)
  return file
}

function row(name: string): { mtime: number; indexed_at: number } {
  return getDb(dbPath).prepare('SELECT mtime, indexed_at FROM files WHERE path LIKE ?').get(`%/${name}`) as { mtime: number; indexed_at: number }
}

// Both sweeps run at a 0 ms budget so no clock decides the outcome: each test indexes one file, and the progress guarantee examines one file per sweep, so that file is always the one examined. The rows that assert a hash count of 0 follow a calibration row that asserts 1, so a file that went unexamined cannot pass them.
/** One sweep that writes nothing, returning how many files it hashed. */
function dryHashes(): number {
  hashed.calls = 0
  reconcileProject({ cwd: projectDir, dbPath, budgetMs: 0, dryRun: true, queueDir: dataDir })
  return hashed.calls
}

/** One sweep that may record what it proves, returning how many files it hashed. */
function recordingHashes(): number {
  hashed.calls = 0
  reconcileProject({ cwd: projectDir, dbPath, budgetMs: 0, queueDir: dataDir })
  return hashed.calls
}

beforeEach(() => {
  projectDir = indexableDir()
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-racy-stamp-data-'))
  dbPath = path.join(dataDir, 'global.db')
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
})

afterEach(() => {
  runTeardown([() => vi.restoreAllMocks(), () => getDb(dbPath).close(), () => fs.rmSync(dataDir, { recursive: true, force: true })])
})

describe('the worker restamp of a touched file whose bytes did not change', () => {
  it('drives drain, index, restamp and a sweep that does not hash the file again', async () => {
    const file = indexWith('touched.ts', OLD, INDEXED)
    expect(dryHashes(), 'calibration: the unmoved calm row should cost no hash').toBe(0)
    fs.utimesSync(file, TOUCHED, TOUCHED)
    expect(dryHashes(), 'calibration: the touched file is hashed once, so the next assertion is not vacuous').toBe(1)

    appendDirtyQueuePaths(dataDir, [resolveIndexPath('touched.ts', projectDir)])
    // The daemon's own drain: no injected callbacks, so makeIndexer is the production default.
    drainOnce(dataDir)
    await pendingEmbeddings()

    expect(row('touched.ts').mtime, 'the drain did not record the moved mtime').toBe(TOUCHED)
    expect(dryHashes(), 'a restamped file was hashed again; the row still reads as racy').toBe(0)
  })

  it('keeps a file still being written racy: a touched file whose mtime is not a tick older than now is hashed on the next sweep', async () => {
    const file = indexWith('writing.ts', OLD, INDEXED)
    fs.utimesSync(file, STILL_BEING_WRITTEN, STILL_BEING_WRITTEN)

    appendDirtyQueuePaths(dataDir, [resolveIndexPath('writing.ts', projectDir)])
    drainOnce(dataDir)
    await pendingEmbeddings()

    expect(row('writing.ts').indexed_at, 'the drain gave a file still being written an index time').toBe(INDEXED)
    expect(dryHashes(), 'a file still being written was treated as calm; the racy guard is weakened').toBe(1)
  })
})

describe('the reconcile record of a clean hash', () => {
  it('does not hash a racy file again on the sweep after the one that proved it clean', () => {
    indexWith('racy.ts', OLD, OLD)

    expect(recordingHashes(), 'calibration: the racy file is hashed by the first sweep').toBe(1)

    expect(row('racy.ts').indexed_at, 'the clean hash left the index time where it was').toBeGreaterThan(OLD + 2)
    expect(dryHashes(), 'a racy file whose hash came back clean was hashed again').toBe(0)
  })

  it('records the proof for an indexed file git does not list too', () => {
    indexWith('loose.ts', OLD, OLD)
    git('rm', '-q', '--cached', '-f', 'loose.ts')

    expect(recordingHashes(), 'calibration: the untracked racy file is hashed by the first sweep').toBe(1)
    expect(dryHashes(), 'an untracked racy file whose hash came back clean was hashed again').toBe(0)
  })

  it('writes nothing on a dry run', () => {
    indexWith('dry.ts', OLD, OLD)

    expect(dryHashes()).toBe(1)
    expect(dryHashes(), 'a dry run recorded what it proved').toBe(1)
    expect(row('dry.ts').indexed_at).toBe(OLD)
  })

  it('still hashes a file whose mtime is not a tick older than now, sweep after sweep', () => {
    indexWith('fresh.ts', STILL_BEING_WRITTEN, STILL_BEING_WRITTEN)

    expect(recordingHashes()).toBe(1)
    expect(row('fresh.ts').indexed_at, 'a file still being written was given a new index time').toBe(STILL_BEING_WRITTEN)
    expect(recordingHashes(), 'a file still being written was treated as calm; the racy guard is weakened').toBe(1)
  })
})

describe('restampVerifiedUnchanged at the tick boundary', () => {
  const NOW = OLD + 1000

  it('stamps both columns when the mtime is exactly one tick older than now', () => {
    indexWith('edge.ts', OLD, OLD)
    const stored = row('edge.ts')
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files WHERE path LIKE ?').get('%/edge.ts') as { path: string }).path
    const sha = (getDb(dbPath).prepare('SELECT sha FROM files WHERE path = ?').get(indexedPath) as { sha: string }).sha

    restampVerifiedUnchanged(dbPath, [{ indexedPath, sha, rowMtime: stored.mtime, statMtimeSec: NOW - 2 }], NOW)

    expect(row('edge.ts')).toEqual({ mtime: NOW - 2, indexed_at: NOW })
  })

  it('records only a moved mtime when the mtime is less than a tick older than now', () => {
    indexWith('young.ts', OLD, OLD)
    const stored = row('young.ts')
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files WHERE path LIKE ?').get('%/young.ts') as { path: string }).path
    const sha = (getDb(dbPath).prepare('SELECT sha FROM files WHERE path = ?').get(indexedPath) as { sha: string }).sha

    restampVerifiedUnchanged(dbPath, [{ indexedPath, sha, rowMtime: stored.mtime, statMtimeSec: NOW - 1.9 }], NOW)

    expect(row('young.ts')).toEqual({ mtime: NOW - 1.9, indexed_at: OLD })
  })

  it('leaves a row whose sha moved on as it was', () => {
    indexWith('moved.ts', OLD, OLD)
    const stored = row('moved.ts')
    const indexedPath = (getDb(dbPath).prepare('SELECT path FROM files WHERE path LIKE ?').get('%/moved.ts') as { path: string }).path

    restampVerifiedUnchanged(dbPath, [{ indexedPath, sha: 'not-the-row-sha', rowMtime: stored.mtime, statMtimeSec: NOW - 100 }], NOW)

    expect(row('moved.ts')).toEqual(stored)
  })
})
