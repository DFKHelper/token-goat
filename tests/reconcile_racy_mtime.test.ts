/** An equal mtime proves a file unchanged only when it is at least 2 s older than the row's indexed_at (TIMESTAMP_TICK_SEC in src/reconcile.ts::mtimeProvesUnchanged); a file stamped within that tick of it, or after it, is verified by content (git's racy-clean rule, https://git-scm.com/docs/racy-git). Provenance of every mtime below: HAND-DERIVED. FUTURE (4000000000 s, year 2096) is not older than any indexed_at a real run writes, OLD (1000000000 s, year 2001) is older than all of them, and `utimes` sets them, so no test reads a clock. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import type * as FingerprintModule from '../src/fingerprint.js'
import { reconcileProject } from '../src/reconcile.js'
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

const FUTURE = 4_000_000_000
const OLD = 1_000_000_000
const BEFORE = 'export const value = 1\n'
const AFTER = 'export const value = 2\n'

let projectDir: string
let dbPath: string

function git(...args: string[]): void {
  spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
}

/** Writes `name`, stamps it, and indexes it, so the row records that mtime. */
function indexWith(name: string, content: string, mtimeSec: number): void {
  const file = path.join(projectDir, name)
  fs.writeFileSync(file, content)
  fs.utimesSync(file, mtimeSec, mtimeSec)
  indexFileSync(resolveIndexPath(name, projectDir), dbPath)
}

/** Rewrites `name` in place and restores the mtime the row recorded, as an edit inside one timestamp tick of indexing leaves it. */
function rewriteKeepingMtime(name: string, content: string, mtimeSec: number): void {
  const file = path.join(projectDir, name)
  fs.writeFileSync(file, content)
  fs.utimesSync(file, mtimeSec, mtimeSec)
}

/** Sets the time `name`'s row says it was indexed at, so a row can sit exactly `n` seconds after its mtime without a clock. */
function stampIndexedAt(name: string, indexedAtSec: number): void {
  getDb(dbPath).prepare('UPDATE files SET indexed_at = ? WHERE path LIKE ?').run(indexedAtSec, `%/${name}`)
}

function sweep(): ReturnType<typeof reconcileProject> {
  hashed.calls = 0
  return reconcileProject({ cwd: projectDir, dbPath, budgetMs: 30_000, dryRun: true })
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-racy-'))
  dbPath = path.join(os.tmpdir(), `tg-reconcile-racy-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  fs.writeFileSync(path.join(projectDir, 'seed.ts'), 'export const seed = 0\n')
  git('add', '-A')
  git('commit', '-m', 'init')
})

afterEach(() => {
  runTeardown([
    () => vi.restoreAllMocks(),
    () => getDb(dbPath).close(),
    () => fs.rmSync(projectDir, { recursive: true, force: true }),
    () => {
      for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })
    },
  ])
})

describe('reconcileProject racy-clean mtime gate', () => {
  it('reports a tracked file whose content changed under the mtime its row recorded, when that mtime is not older than the index time', () => {
    indexWith('racy.ts', BEFORE, FUTURE)
    git('add', '-A')
    rewriteKeepingMtime('racy.ts', AFTER, FUTURE)

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).toContain('racy.ts')
  })

  it('does not hash a tracked file whose mtime is unchanged and older than the index time', () => {
    indexWith('calm.ts', BEFORE, OLD)
    git('add', '-A')

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).not.toContain('calm.ts')
    expect(hashed.calls, 'an unambiguous file was hashed; the cheap gate no longer skips it').toBe(0)
  })

  it('hashes an ambiguous tracked file whose bytes did not change, and does not call it a moved timestamp', () => {
    indexWith('same.ts', BEFORE, FUTURE)
    git('add', '-A')

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).not.toContain('same.ts')
    expect(result.mtimeOnly).toBe(0)
    expect(hashed.calls).toBe(1)
  })

  it('reports a changed file whose mtime is one second older than its index time, inside one timestamp tick', () => {
    indexWith('tick.ts', BEFORE, OLD)
    git('add', '-A')
    stampIndexedAt('tick.ts', OLD + 1)
    rewriteKeepingMtime('tick.ts', AFTER, OLD)

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).toContain('tick.ts')
  })

  it('does not hash a file whose mtime is a full timestamp tick older than its index time', () => {
    indexWith('edge.ts', BEFORE, OLD)
    git('add', '-A')
    stampIndexedAt('edge.ts', OLD + 2)

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).not.toContain('edge.ts')
    expect(hashed.calls, 'a file a full tick older than its index time was hashed').toBe(0)
  })

  it('reports an untracked indexed file changed under an ambiguous mtime', () => {
    indexWith('loose.ts', BEFORE, FUTURE)
    rewriteKeepingMtime('loose.ts', AFTER, FUTURE)

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).toContain('loose.ts')
  })

  it('does not hash an untracked indexed file whose mtime is unchanged and older than the index time', () => {
    indexWith('loose.ts', BEFORE, OLD)

    const result = sweep()

    expect(result.changed.map((p) => path.basename(p))).not.toContain('loose.ts')
    expect(hashed.calls, 'an unambiguous untracked file was hashed').toBe(0)
  })
})
