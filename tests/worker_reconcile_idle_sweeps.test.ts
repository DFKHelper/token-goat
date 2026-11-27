// Provenance: HAND-DERIVED for the file contents and symbol names (written here, read by the real parser); coverage.json is named by the default indexing.skip_files list in src/config.ts; the request writer, the sweep, the drain and the indexer are the production ones, and the clock is a Date.now spy so the 30 s window is driven without waiting.
/** A reconcile request for a repository sweeps it at most once per window, a skip-eligible file a sweep cannot index is not re-queued by every sweep, and a genuine change still reaches the index after the window. Each test drives the real drain and sweep on a repository outside the OS temp dir, so the dirty queue accepts the paths it names. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { appendDirtyQueuePaths, appendReconcileRequest, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { reconcileProject } from '../src/reconcile.js'
import { SWEEP_MIN_INTERVAL_MS, drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
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
})
