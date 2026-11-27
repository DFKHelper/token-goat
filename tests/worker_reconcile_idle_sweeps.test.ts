// Provenance: HAND-DERIVED fixtures (file contents, symbol names); the drain, sweep and clock spy are production or Date.now.

/** Reconcile requests sweep a repository at most once per window, and a file with no row is not re-reported. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'
import { closeAllDbs, getDb, MAX_TRANSIENT_RETRIES } from '../src/db.js'
import { appendDirtyQueuePaths, appendReconcileRequest, reconcileRequestPathFor } from '../src/dirty_queue.js'
import * as fingerprintModule from '../src/fingerprint.js'
import { querySymbols } from '../src/index_reader.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { normalizePath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'
import { SWEEP_MIN_INTERVAL_MS, drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
import { foldPath } from '../src/util.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { indexableDir } from './helpers/temp-config.js'

const OLD_SYMBOL = 'idleSweepOldSym'
const NEW_SYMBOL = 'idleSweepNewSym'
const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

const clock = { now: 1_700_000_000_000 }
const scratch: string[] = []

interface Fixture {
  dir: string
  dbPath: string
  repo: string
  lib: string
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
}

/** A data directory and a repository with an indexed `lib.ts` and a tracked `coverage.json` the indexer drops (it is skip-eligible, so it never gets a files row). The repository is registered as an indexed root, as a project the worker has indexed is. */
function fixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-idle-sweep-'))
  scratch.push(dir)
  const dbPath = path.join(dir, 'global.db')
  const repo = indexableDir()
  scratch.push(repo)
  const lib = path.join(repo, 'lib.ts')
  const coverage = path.join(repo, 'coverage.json')
  fs.writeFileSync(lib, fn(OLD_SYMBOL))
  fs.writeFileSync(coverage, '{"a":1}\n')
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  appendDirtyQueuePaths(dir, [lib, coverage])
  while (drainOnce(dir) > 0) { /* index what the queue names */ }
  recordIndexedRoot(repo, dbPath)
  return { dir, dbPath, repo, lib }
}

function drainAll(dir: string): void {
  while (drainOnce(dir) > 0) { /* drain */ }
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await pendingEmbeddings()
  closeAllDbs()
  for (const p of scratch.splice(0)) fs.rmSync(p, { recursive: true, force: true })
})

describe('reconcile requests sweep a repository at most once per window', () => {
  it('coalesces a burst into one sweep and holds a request inside the window until it passes', async () => {
    const fx = fixture()
    appendReconcileRequest(fx.dir, fx.repo)
    appendReconcileRequest(fx.dir, fx.repo)
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a burst of requests for one repository sweeps it once').toBe(1)
    clock.now += 1000
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a request inside the window is held, not swept').toBe(0)
    clock.now += SWEEP_MIN_INTERVAL_MS
    expect(await drainReconcileRequestsAsync(fx.dir), 'the held sweep fires once the window passes, with no new request').toBe(1)
    expect(await drainReconcileRequestsAsync(fx.dir), 'nothing is pending after the held sweep ran').toBe(0)
  })

  it('removes an empty request claim so a later request is still drained', async () => {
    const fx = fixture()
    const live = reconcileRequestPathFor(fx.dir)
    fs.writeFileSync(live, '')
    expect(await drainReconcileRequestsAsync(fx.dir), 'an empty request file sweeps nothing').toBe(0)
    expect(fs.existsSync(`${live}.draining`), 'the empty claim is removed, not left to be handed back first').toBe(false)
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a request after the empty claim is swept').toBe(1)
  })

  it('does not re-enqueue a skip-eligible file on every repeated sweep', () => {
    const fx = fixture()
    for (let sweep = 1; sweep <= 3; sweep++) {
      const r = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
      expect(r.added, `sweep ${sweep}: the skip-eligible coverage.json is not reported as an unindexed addition`).toEqual([])
      expect(r.enqueued, `sweep ${sweep}: nothing is enqueued when nothing changed`).toBe(0)
      drainAll(fx.dir)
    }
  })

  it('still sweeps a genuine change once after the window and indexes it', async () => {
    const fx = fixture()
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir)).toBe(1)
    fs.writeFileSync(fx.lib, fn(NEW_SYMBOL))
    clock.now += SWEEP_MIN_INTERVAL_MS
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a request after the window sweeps the changed repository').toBe(1)
    drainAll(fx.dir)
    await pendingEmbeddings()
    expect(querySymbols({ name: NEW_SYMBOL }, fx.dbPath), 'the genuine change reaches the index').toHaveLength(1)
  })

  it('enqueues a file added after a completed sweep on the first request past the window', async () => {
    const fx = fixture()
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the first request sweeps the repository').toBe(1)
    fs.writeFileSync(path.join(fx.repo, 'added.ts'), fn(NEW_SYMBOL))
    git(fx.repo, 'add', 'added.ts')
    clock.now += SWEEP_MIN_INTERVAL_MS
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a request past the window sweeps the repository with the new tracked file').toBe(1)
    drainAll(fx.dir)
    await pendingEmbeddings()
    expect(querySymbols({ name: NEW_SYMBOL }, fx.dbPath), 'the new tracked file reaches the index').toHaveLength(1)
  })

  it('keeps a request held in the window on disk, so a module reload still sweeps it', async () => {
    const fx = fixture()
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the first request sweeps the repository').toBe(1)
    clock.now += 1000
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a request inside the window is held').toBe(0)
    vi.resetModules()
    const reloaded = await import('../src/reconcile_requests.js')
    clock.now += SWEEP_MIN_INTERVAL_MS
    expect(await reloaded.drainReconcileRequestsAsync(fx.dir), 'the held request survives a reload and sweeps once the window passes').toBe(1)
    // The reloaded db module holds its own connection; close it so the afterEach cleanup can remove the directory.
    ;(await import('../src/db.js')).closeAllDbs()
  })

  it('rewrites a held request as one line per cycle and leaves no file once it is swept', async () => {
    const fx = fixture()
    const live = reconcileRequestPathFor(fx.dir)
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the first request sweeps the repository').toBe(1)
    clock.now += 1000
    for (let cycle = 1; cycle <= 3; cycle++) {
      appendReconcileRequest(fx.dir, fx.repo)
      expect(await drainReconcileRequestsAsync(fx.dir), `cycle ${cycle}: a held request is not swept`).toBe(0)
      const lines = fs.readFileSync(live, 'utf8').split('\n').filter((l) => l.trim() !== '')
      expect(lines, `cycle ${cycle}: the held request is kept as one line, not one per request`).toHaveLength(1)
    }
    clock.now += SWEEP_MIN_INTERVAL_MS
    expect(await drainReconcileRequestsAsync(fx.dir), 'the held request is swept once the window passes').toBe(1)
    expect(fs.existsSync(live), 'nothing is left on disk once the held request is swept').toBe(false)
  })

  it('does not hold the continuation of a sweep cut short by its budget for the window', async () => {
    const fx = fixture()
    // Each clock read advances 1 s, so the sweep's 1.5 s budget runs out on its second tracked file.
    vi.spyOn(Date, 'now').mockImplementation(() => (clock.now += 1000))
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the budget-cut sweep runs').toBe(1)
    expect(fs.existsSync(reconcileRequestPathFor(fx.dir)), 'the unfinished sweep is re-queued').toBe(true)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the continuation is swept at once, not held for the window').toBe(1)
  })

  it('treats a clock stepped backward as an expired window, not a held one', async () => {
    const fx = fixture()
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'the first request sweeps the repository').toBe(1)
    clock.now -= 5 * 60_000
    appendReconcileRequest(fx.dir, fx.repo)
    expect(await drainReconcileRequestsAsync(fx.dir), 'a backward clock step does not hold the sweep').toBe(1)
  })
})

// Provenance: row (c) is FORMAT-DERIVED from src/config_defaults.ts:203 (large_file_skip_kb 2048) read by src/parser.ts isParseSkipEligible; rows (b) and (d) are HAND-DERIVED (a path and NUL bytes chosen here, no producer output).
const NO_ROW_FILES: Array<[string, string, string | Buffer]> = [
  ['(b) a path under .claude/worktrees/ in the indexed repository', '.claude/worktrees/w1/worker.ts', fn('idleSweepWorktreeSym')],
  ['(c) a file over indexing.large_file_skip_kb', 'big_generated.ts', 'export const v = 1\n'.repeat(130_000)],
  ['(d) a binary file', 'blob.bin', Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x00, 0x42])],
]

describe('a file that keeps no row is not re-enqueued by repeated sweeps', () => {
  it.each(NO_ROW_FILES)('%s: sweeps 1-3 of an unchanged tree enqueue nothing', (_label, rel, content) => {
    const fx = fixture()
    const file = path.join(fx.repo, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    // coverage.json is removed so its own skip-eligible addition cannot stand in for the row under test.
    git(fx.repo, 'rm', '-q', 'coverage.json')
    git(fx.repo, 'add', '-f', rel)
    git(fx.repo, 'commit', '-qm', 'add a file that keeps no row')
    appendDirtyQueuePaths(fx.dir, [file])
    drainAll(fx.dir)
    for (let sweep = 1; sweep <= 3; sweep++) {
      const r = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
      expect(r.added, `sweep ${sweep}: the file is not reported as an unindexed addition`).toEqual([])
      expect(r.enqueued, `sweep ${sweep}: nothing is enqueued for an unchanged tree`).toBe(0)
      drainAll(fx.dir)
    }
  })

  it('does not report a tracked file deleted from disk without git rm as an addition', () => {
    const fx = fixture()
    const file = path.join(fx.repo, 'gone.ts')
    fs.writeFileSync(file, fn(NEW_SYMBOL))
    git(fx.repo, 'add', 'gone.ts')
    git(fx.repo, 'commit', '-qm', 'add a file, then delete it from disk')
    fs.rmSync(file)
    for (let sweep = 1; sweep <= 3; sweep++) {
      const r = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
      expect(r.added, `sweep ${sweep}: a tracked file absent from disk is not reported as an addition`).toEqual([])
      expect(r.enqueued, `sweep ${sweep}: nothing is enqueued for a file absent from disk`).toBe(0)
      drainAll(fx.dir)
    }
  })

  it('exempts a file under a skip_dirs ancestor exactly where the drain drops it', async () => {
    const cfg = defaultConfig()
    cfg.indexing.skip_dirs = ['vendored']
    saveConfig(cfg)
    try {
      const fx = fixture()
      const file = path.join(fx.repo, 'vendored', 'lib', 'x.ts')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, fn(NEW_SYMBOL))
      git(fx.repo, 'add', '-f', 'vendored/lib/x.ts')
      git(fx.repo, 'commit', '-qm', 'add a file under a skip_dirs ancestor')
      const r = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
      expect(r.added, 'the sweep does not report a file under a skip_dirs ancestor as an addition').toEqual([])
      appendDirtyQueuePaths(fx.dir, [file])
      drainAll(fx.dir)
      await pendingEmbeddings()
      expect(querySymbols({ name: NEW_SYMBOL }, fx.dbPath), 'the drain drops the same file, so it reaches no symbol row').toHaveLength(0)
    } finally {
      saveConfig(defaultConfig())
      invalidateConfigCache()
    }
  })

  it('does not re-report a file the drain gave up on until its mtime moves', () => {
    const fx = fixture()
    const file = path.join(fx.repo, 'unreadable.ts')
    fs.writeFileSync(file, fn(NEW_SYMBOL))
    git(fx.repo, 'add', 'unreadable.ts')
    git(fx.repo, 'commit', '-qm', 'add a file the drain cannot read')
    // Backdated past the timestamp tick so the give-up stamp is recorded (a file written this instant is racy-clean and never stamped).
    const aged = new Date('2000-01-01T00:00:00Z')
    fs.utimesSync(file, aged, aged)
    const target = foldPath(normalizePath(file))
    const realRead = fingerprintModule.fingerprintFileWithBytes
    // Injected read failure: the file exists, so only the drain's own read gives up on it, through its real retry bookkeeping.
    vi.spyOn(fingerprintModule, 'fingerprintFileWithBytes').mockImplementation((p) => (foldPath(normalizePath(p)) === target ? null : realRead(p)))
    appendDirtyQueuePaths(fx.dir, [file])
    for (let cycle = 0; cycle < 10; cycle++) drainOnce(fx.dir)
    expect(retryCountFor(fx.dbPath, target), 'the drain gave up after its retries').toBeGreaterThan(MAX_TRANSIENT_RETRIES)
    const first = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
    expect(first.added, 'sweep 1: a given-up file with no row is not re-reported').toEqual([])
    expect(first.enqueued, 'sweep 1: nothing is enqueued for a given-up file').toBe(0)
    const moved = new Date('2001-01-01T00:00:00Z')
    fs.utimesSync(file, moved, moved)
    const second = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
    expect(second.added, 'after its mtime moves the given-up file is reported again').toHaveLength(1)
  })

  it('suppresses a given-up file that keeps its row, so an edit it failed to read is not re-enqueued each sweep', () => {
    const fx = fixture()
    const file = path.join(fx.repo, 'stale-row.ts')
    fs.writeFileSync(file, fn(NEW_SYMBOL))
    git(fx.repo, 'add', 'stale-row.ts')
    git(fx.repo, 'commit', '-qm', 'add a file the drain indexes first')
    appendDirtyQueuePaths(fx.dir, [file])
    drainAll(fx.dir)
    // Edited to new content and backdated past the timestamp tick, so the drain's stamp is proven and the row's sha is stale.
    fs.writeFileSync(file, fn('givenUpRowEdit'))
    const edited = new Date('2001-01-01T00:00:00Z')
    fs.utimesSync(file, edited, edited)
    const target = foldPath(normalizePath(file))
    const realRead = fingerprintModule.fingerprintFileWithBytes
    vi.spyOn(fingerprintModule, 'fingerprintFileWithBytes').mockImplementation((p) => (foldPath(normalizePath(p)) === target ? null : realRead(p)))
    appendDirtyQueuePaths(fx.dir, [file])
    for (let cycle = 0; cycle < 10; cycle++) drainOnce(fx.dir)
    expect(retryCountFor(fx.dbPath, target), 'the drain gave up after its retries').toBeGreaterThan(MAX_TRANSIENT_RETRIES)
    for (let sweep = 1; sweep <= 3; sweep++) {
      const r = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
      expect(r.enqueued, `sweep ${sweep}: a given-up file that keeps its row is not re-enqueued`).toBe(0)
    }
    const moved = new Date('2002-01-01T00:00:00Z')
    fs.utimesSync(file, moved, moved)
    const afterMove = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
    expect(afterMove.enqueued, 'after its mtime moves the given-up file is enqueued again').toBeGreaterThan(0)
  })

  it('does not hide an edit that lands during the failed read behind the give-up stamp', () => {
    const fx = fixture()
    const file = path.join(fx.repo, 'edited-mid-read.ts')
    fs.writeFileSync(file, fn(NEW_SYMBOL))
    git(fx.repo, 'add', 'edited-mid-read.ts')
    git(fx.repo, 'commit', '-qm', 'add a file whose mtime moves during a failed read')
    const target = foldPath(normalizePath(file))
    const realRead = fingerprintModule.fingerprintFileWithBytes
    // Backdated before the attempts; the attempt that gives up has its mtime moved after its own pre-read stat, so the stamp must hold the pre-read mtime.
    const backdated = new Date('2001-01-01T00:00:00Z')
    fs.utimesSync(file, backdated, backdated)
    let reads = 0
    vi.spyOn(fingerprintModule, 'fingerprintFileWithBytes').mockImplementation((p) => {
      if (foldPath(normalizePath(p)) !== target) return realRead(p)
      reads += 1
      if (reads === MAX_TRANSIENT_RETRIES + 1) {
        const moved = new Date('2002-01-01T00:00:00Z')
        fs.utimesSync(file, moved, moved)
      }
      return null
    })
    appendDirtyQueuePaths(fx.dir, [file])
    for (let cycle = 0; cycle < 10; cycle++) drainOnce(fx.dir)
    expect(retryCountFor(fx.dbPath, target), 'the drain gave up after its retries').toBeGreaterThan(MAX_TRANSIENT_RETRIES)
    const sweep = reconcileProject({ cwd: fx.repo, dbPath: fx.dbPath, queueDir: fx.dir })
    expect(sweep.added, 'the moved mtime is not suppressed by a stamp taken before the moved read').toHaveLength(1)
  })
})

function retryCountFor(dbPath: string, folded: string): number {
  const rows = getDb(dbPath).prepare('SELECT path, retry_count FROM index_retries').all() as Array<{ path: string; retry_count: number }>
  return rows.find((r) => foldPath(normalizePath(r.path)) === folded)?.retry_count ?? 0
}
