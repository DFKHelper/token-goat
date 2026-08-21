import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  claimWorkerPidFile,
  cleanupWorkerStateFiles,
  dirtyQueuePathFor,
  drainHeartbeatPathFor,
  drainOnce,
  ensureWorkerAlive,
  getDirtyPathsFor,
  isWorkerRunning,
  pendingEmbeddings,
  processDirtyBatch,
  resetTransientRetryCount,
  resolvePollIntervalMs,
  runWorkerLoop,
  stopWorker,
  workerPidPath,
} from '../src/worker.js'
import * as parserModule from '../src/parser.js'
import * as projectModule from '../src/project.js'
import { recordKnownRoot } from '../src/index_prune.js'
import { querySymbols, queryRefs, getFileEntry } from '../src/index_reader.js'
import { closeDb, getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { loadConfig } from '../src/config.js'
import { store } from '../src/snapshots.js'
import { foldPath } from '../src/util.js'
import { pathEqClause } from '../src/sql_path.js'
import { tokenGoatHome } from '../src/disk_cache.js'

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))

// tests/setup/isolate-home.ts pins TOKEN_GOAT_NO_WORKER_SPAWN='1' by default for the whole
// suite so an incidental ensureWorkerAlive call elsewhere never spawns a real daemon -- but this
// file's own tests deliberately exercise real startDetachedWorker/ensureWorkerAlive spawning
// (pid-file claiming, stale-pid replacement, real process lifecycle), so it opts back out here,
// same "a test that sets its own value wins" pattern documented in isolate-home.ts.
process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '0'

let DIR: string

function queueFile(dir: string): string {
  return path.join(dir, 'queue', 'dirty.txt')
}

function writeQueue(dir: string, lines: string[]): void {
  const qp = queueFile(dir)
  fs.mkdirSync(path.dirname(qp), { recursive: true })
  fs.writeFileSync(qp, lines.map((l) => `${l}\n`).join(''))
}

function writeWorkerHeartbeat(dir: string, pid = process.pid): void {
  const heartbeatPath = drainHeartbeatPathFor(dir)
  fs.mkdirSync(path.dirname(heartbeatPath), { recursive: true })
  fs.writeFileSync(heartbeatPath, `${pid}\n`)
}

// Reads files.retry_count for absPath the same way bumpRetryCount (worker.ts) writes it -- via
// normalizePath()/foldPath()/pathEqClause() -- so this observes the exact same row a real
// transient-failure requeue bumps, regardless of which textual form (backslash or normalized)
// the caller passes in.
function getRetryCount(dbPath: string, absPath: string): number {
  const db = getDb(dbPath)
  const row = db
    .prepare(`SELECT retry_count FROM files WHERE ${pathEqClause('path')}`)
    .get(foldPath(normalizePath(absPath))) as { retry_count: number | null } | undefined
  return row?.retry_count ?? 0
}

beforeEach(() => {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-'))
  // Permissive default so existing tests (which don't set blocked_roots) are unaffected;
  // individual tests override as needed. indexing.* size/skip_dirs fields are set generously
  // permissive too, so this fixture-sized test content never trips indexFileSync/
  // indexFileEmbeddings' size gates.
  vi.mocked(loadConfig).mockReturnValue({
    worker: { blocked_roots: [] },
    indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
  } as unknown as ReturnType<typeof loadConfig>)
})

afterEach(() => {
  // The retry-count DB helpers (bumpRetryCount/clearRetryCount in worker.ts) open a connection
  // to `${DIR}/global.db` as a side effect of any transient-read-failure requeue or successful
  // read, even for tests that inject a fake in-memory index callback and never otherwise touch
  // the DB. Close it before removing DIR, or the still-open WAL handle makes rmSync fail with
  // EPERM on Windows -- same pattern as the explicit closeDb(projectDb) calls elsewhere in this
  // file, just applied unconditionally here since any test may now trigger it indirectly.
  closeDb(path.join(DIR, 'global.db'))
  fs.rmSync(DIR, { recursive: true, force: true })
})

describe('isWorkerRunning', () => {
  it('returns false when no pid file exists', () => {
    expect(isWorkerRunning(DIR)).toBe(false)
  })

  it('returns false for a stale (dead) pid', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    expect(isWorkerRunning(DIR)).toBe(false)
  })

  it('returns true when the pid file names a live process', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    writeWorkerHeartbeat(DIR)
    expect(isWorkerRunning(DIR)).toBe(true)
  })

  it('rejects a live PID that has no worker heartbeat lease', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)

    expect(isWorkerRunning(DIR)).toBe(false)
  })

  // Regression-style coverage gap: pidAlive's EPERM branch (a pid that exists but is owned by
  // another user, so process.kill(pid, 0) throws EPERM rather than succeeding or throwing ESRCH)
  // was previously only asserted by inspecting the source's doc comment, not exercised by any
  // test -- mutating that branch's `=== 'EPERM'` to a hardcoded `false` left the full worker
  // test suite green. A process that exists but isn't ours must still read as alive (matching
  // Python's os.kill semantics this ports), otherwise isWorkerRunning would misreport a real,
  // running daemon as dead purely because of a permission boundary, and callers like
  // ensureWorkerAlive/claimWorkerPidFile would wrongly spawn a duplicate.
  it('treats a pid that exists but is not owned by this process (EPERM) as alive', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    writeWorkerHeartbeat(DIR)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    try {
      expect(isWorkerRunning(DIR)).toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })

  // Sibling to the EPERM case above: a genuinely dead pid raises ESRCH, which must read as not
  // alive -- confirms the two error codes are not conflated by the same branch.
  it('treats a pid that raises ESRCH (no such process) as not alive', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException
      err.code = 'ESRCH'
      throw err
    })
    try {
      expect(isWorkerRunning(DIR)).toBe(false)
    } finally {
      killSpy.mockRestore()
    }
  })
})

/**
 * Wait, briefly and synchronously, for a just-spawned detached daemon to become visible to
 * `pidAlive`. Returns true as soon as it is. On timeout it returns the worker's own error log
 * instead of false, so a real spawn failure reports its cause rather than collapsing into an
 * inscrutable boolean -- the assertion still fails either way, this only decides what it prints.
 * Busy-waits deliberately: the surrounding test is synchronous, and the loop exits on first success.
 */
function waitForWorkerAlive(dir: string, timeoutMs = 5000): true | string {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isWorkerRunning(dir)) return true
  }
  let log = '(no worker-errors.log written)'
  try {
    log = fs.readFileSync(path.join(dir, 'worker-errors.log'), 'utf8').trim() || log
  } catch {
    // The daemon never got far enough to write one; the default message already says so.
  }
  const pid = fs.existsSync(workerPidPath(dir)) ? fs.readFileSync(workerPidPath(dir), 'utf8').trim() : '(no pid file)'
  return `worker pid ${pid} never became visible within ${timeoutMs}ms; worker-errors.log: ${log}`
}

describe('ensureWorkerAlive (auto-heal regression)', () => {
  // Regression: before ensureWorkerAlive, startDetachedWorker was only ever invoked from the
  // `worker start` CLI command -- nothing anywhere restarted a daemon that died (crash, a manual
  // taskkill, a machine sleep/wake race, anything). A dead worker stayed dead indefinitely, with
  // no automatic recovery, until a human happened to notice and ran `worker start` by hand.

  // The helper's failure path runs only when something has already gone wrong, so nothing would
  // otherwise exercise it -- and a helper that threw while building its diagnostic would turn a
  // legible flake into an inscrutable crash. Drive it directly against a pid that will never be alive.
  it('waitForWorkerAlive reports the pid and the worker log instead of a bare false', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    const result = waitForWorkerAlive(DIR, 50)
    expect(result).not.toBe(true)
    expect(String(result)).toContain('999999999')
    expect(String(result)).toContain('never became visible')
    expect(String(result)).toContain('no worker-errors.log written')
  })

  it('does nothing when a live worker is already running', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    writeWorkerHeartbeat(DIR)
    ensureWorkerAlive(DIR)
    // The pid file must still name the already-live process -- no restart was attempted.
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe(String(process.pid))
    expect(isWorkerRunning(DIR)).toBe(true)
  })

  it('spawns a fresh worker when the recorded pid is stale/dead', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    ensureWorkerAlive(DIR)
    try {
      // Claiming the slot is synchronous in the parent, so it is the deterministic behavior this
      // source-level test covers. The built-bundle daemon E2E test verifies child initialization
      // and queue draining through the real CLI entrypoint.
      expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).not.toBe('999999999')
    } finally {
      // Stop the real spawned daemon before DIR is torn down in afterEach -- otherwise it keeps
      // polling a directory that no longer exists.
      stopWorker(DIR)
    }
  })

  it('rate-limits repeated checks so a burst of calls does not re-spawn on every one', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    // Simulate a healthcheck that already ran recently: a fresh marker file blocks the next
    // check from even looking at the pid file, let alone attempting a restart.
    fs.writeFileSync(path.join(DIR, 'worker-healthcheck.marker'), '')
    ensureWorkerAlive(DIR)
    // No restart was attempted -- the stale pid is untouched.
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe('999999999')
    expect(isWorkerRunning(DIR)).toBe(false)
  })

  // Regression: TOKEN_GOAT_NO_WORKER_SPAWN is pinned to '1' by tests/setup/isolate-home.ts for
  // the whole suite specifically so that any test exercising the postEditHandler hot path (e.g.
  // hooks_edit.test.ts) never spawns a REAL detached daemon process as an incidental side
  // effect of testing something unrelated -- but ensureWorkerAlive never actually read that env
  // var, so it was a dead no-op: every such test silently spawned (and orphaned, until the
  // daemon's own data-dir-deleted self-check eventually noticed and exited) a real child
  // process. This file overrides the var back to unset above so its own deliberate real-spawn
  // tests (this describe block, and the others above) are unaffected.
  it('does not spawn a real daemon when TOKEN_GOAT_NO_WORKER_SPAWN is set (test-isolation guard)', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    const prev = process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
    process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = '1'
    try {
      ensureWorkerAlive(DIR)
      // No real daemon was spawned -- the stale pid is untouched and nothing claimed the slot.
      expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe('999999999')
      expect(isWorkerRunning(DIR)).toBe(false)
    } finally {
      if (prev === undefined) delete process.env['TOKEN_GOAT_NO_WORKER_SPAWN']
      else process.env['TOKEN_GOAT_NO_WORKER_SPAWN'] = prev
    }
  })
})

describe('stopWorker', () => {
  it('returns false when no worker is running', () => {
    expect(stopWorker(DIR)).toBe(false)
  })

  it('removes a stale pid file and returns false', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    expect(stopWorker(DIR)).toBe(false)
    expect(fs.existsSync(workerPidPath(DIR))).toBe(false)
  })

  it('does not signal a live unrelated process with no worker heartbeat lease', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      expect(stopWorker(DIR)).toBe(false)
      expect(killSpy).toHaveBeenCalledWith(process.pid, 0)
      expect(killSpy).not.toHaveBeenCalledWith(process.pid)
      expect(fs.existsSync(workerPidPath(DIR))).toBe(false)
    } finally {
      killSpy.mockRestore()
    }
  })

  // Regression (double-daemon race): stopWorker used to delete the pid file unconditionally
  // after killing the pid it read, with no re-check. Race: between stopWorker's kill and its
  // rmSync, a concurrent `worker start` can observe the just-killed pid as dead, reclaim the
  // pid-file slot via claimWorkerPidFile, and write a NEW daemon's pid into that same file --
  // which the still-running stopWorker call then deletes anyway, orphaning the new daemon (no
  // pid file left for a later `worker stop` to find it by). A subsequent `worker start` would
  // then "fix" the missing pid file by spawning a THIRD daemon, leaving two live daemons
  // draining one queue. Simulate the race directly: after stopWorker's kill would have fired
  // (this test's own live pid stands in for "the process stopWorker just killed"), have a
  // concurrent claim overwrite the pid file with a different pid before stopWorker reaches its
  // cleanup step -- proven here by writing the pid file back to a different value between the
  // kill and the cleanup that the exit-handler-style guard must check.
  it('does not delete a pid file that a concurrent worker start already reclaimed for a new daemon', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    writeWorkerHeartbeat(DIR)

    // Stand in for the race window: monkey-patch fs.rmSync so that, at the exact moment
    // stopWorker is about to remove the pid file, we simulate a concurrent claimWorkerPidFile
    // call having already reclaimed the slot for a brand-new daemon pid. If stopWorker's guard
    // re-reads the pid file immediately before deleting (rather than deleting unconditionally),
    // it must see the new pid and skip the delete entirely.
    const originalWrite = fs.writeFileSync
    let reclaimed = false
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      if (!reclaimed && pid === process.pid && (signal === undefined || signal === 'SIGTERM')) {
        reclaimed = true
        originalWrite(workerPidPath(DIR), '424242\n')
      }
      return true
    })

    const alive = stopWorker(DIR)

    expect(alive).toBe(true)
    // The reclaimed pid file must survive stopWorker's cleanup untouched.
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe('424242')

    killSpy.mockRestore()
  })
})

describe('claimWorkerPidFile (TOCTOU race regression)', () => {
  it('claims an empty pid-file slot and writes the pid', () => {
    expect(claimWorkerPidFile(DIR, 12345)).toBe(true)
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe('12345')
  })

  it('refuses and does NOT overwrite the pid file when a concurrent claim already recorded a live pid', () => {
    // Simulate the winning side of a race: a live process (this test process) claims the slot
    // first, exactly as the first of two near-simultaneous `worker start` invocations would.
    expect(claimWorkerPidFile(DIR, process.pid)).toBe(true)
    writeWorkerHeartbeat(DIR)

    // A second, near-simultaneous `worker start` attempt tries to claim with a different pid.
    // Before this fix, startDetachedWorker wrote the pid file with a plain fs.writeFileSync
    // (no exclusive-create flag), so this second write would have silently clobbered the first
    // daemon's pid file -- orphaning it with no pid file left for a later `worker stop` to find.
    expect(claimWorkerPidFile(DIR, 999999999)).toBe(false)

    // The file must still name the FIRST (live) pid, not the second writer's -- this is the
    // exact clobbering behavior the fix closes.
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe(String(process.pid))
  })

  it('reclaims a stale pid-file slot left by a dead process', () => {
    fs.writeFileSync(workerPidPath(DIR), '999999999\n')
    expect(claimWorkerPidFile(DIR, process.pid)).toBe(true)
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe(String(process.pid))
  })

  it('reclaims an old pid file when its live PID has no worker heartbeat lease', () => {
    fs.writeFileSync(workerPidPath(DIR), `${process.pid}\n`)
    const old = new Date(Date.now() - 11_000)
    fs.utimesSync(workerPidPath(DIR), old, old)

    expect(claimWorkerPidFile(DIR, 424242)).toBe(true)
    expect(fs.readFileSync(workerPidPath(DIR), 'utf8').trim()).toBe('424242')
  })
})

describe('getDirtyPathsFor', () => {
  it('returns [] when no queue file exists', () => {
    expect(getDirtyPathsFor(DIR)).toEqual([])
  })

  it('returns queued paths in order, deduplicated', () => {
    writeQueue(DIR, ['/a/one.ts', '/a/two.ts', '/a/one.ts', ''])
    expect(getDirtyPathsFor(DIR)).toEqual(['/a/one.ts', '/a/two.ts'])
  })

  it.skipIf(process.platform !== 'win32' && process.platform !== 'darwin')(
    'deduplicates paths with different case on case-insensitive systems',
    () => {
      // Regression: on Windows/macOS, queue entries that differ only in case should be deduplicated since NTFS and HFS+ are case-insensitive. Before the fix, getDirtyPathsFor would return both "c:/projects/File.ts" and "C:/PROJECTS/file.ts" as separate entries. Test with paths that will normalize but differ in case after normalization.
      writeQueue(DIR, ['c:/projects/File.ts', 'C:/PROJECTS/file.ts'])
      const result = getDirtyPathsFor(DIR)
      // Should be deduplicated to 1 entry (the first one encountered, normalized)
      expect(result.length).toBe(1)
    },
  )
})

describe('processDirtyBatch', () => {
  it('indexes existing files and prunes missing ones', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    const ghost = path.join(DIR, 'ghost.ts')
    const indexed: string[] = []
    const removed: string[] = []
    const count = processDirtyBatch(
      [real, ghost],
      (p) => indexed.push(p),
      (p) => removed.push(p),
    )
    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    // The vanished path is reconciled as a deletion, not silently skipped.
    expect(removed).toEqual([ghost])
  })

  // Regression: the returned count must reflect paths actually (re)indexed, not paths merely
  // visited. An index callback that signals a no-op (returns `false`, mirroring the default
  // indexer's sha-gate skip for byte-identical content) must not inflate the count.
  it('does not count a path whose index callback signals a no-op skip', () => {
    const real = path.join(DIR, 'unchanged.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    const count = processDirtyBatch([real], () => false)
    expect(count).toBe(0)
  })

  // Regression: worker.blocked_roots (set via `token-goat project exclude`) was validated from
  // TOML and reported by `token-goat ignores`/`doctor`, but processDirtyBatch never consulted
  // it -- a dirty-queued path under a blocked root was reindexed (or pruned) exactly like any
  // other path.
  it('skips a dirty path under a blocked root -- neither indexed nor pruned', () => {
    const blockedDir = path.join(DIR, 'vendor')
    fs.mkdirSync(blockedDir, { recursive: true })
    const blockedFile = path.join(blockedDir, 'lib.ts')
    fs.writeFileSync(blockedFile, 'export const x = 1\n')
    // Deliberately absent, so a pre-fix run would prune it via the remove callback.
    const blockedGhost = path.join(blockedDir, 'ghost.ts')

    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [blockedDir] },
    } as unknown as ReturnType<typeof loadConfig>)

    const indexed: string[] = []
    const removed: string[] = []
    const count = processDirtyBatch(
      [blockedFile, blockedGhost],
      (p) => indexed.push(p),
      (p) => removed.push(p),
    )

    expect(count).toBe(0)
    expect(indexed).toEqual([])
    expect(removed).toEqual([])
  })

  it('still indexes a path outside the blocked root in the same batch', () => {
    const blockedDir = path.join(DIR, 'vendor')
    fs.mkdirSync(blockedDir, { recursive: true })
    const blockedFile = path.join(blockedDir, 'lib.ts')
    fs.writeFileSync(blockedFile, 'export const x = 1\n')
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const y = 2\n')

    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [blockedDir] },
    } as unknown as ReturnType<typeof loadConfig>)

    const indexed: string[] = []
    const count = processDirtyBatch([blockedFile, real], (p) => indexed.push(p))

    expect(count).toBe(1)
    expect(indexed).toEqual([real])
  })

  // Regression: for every dirty path in a batch, processDirtyBatch re-ran a full findProject
  // ancestor-marker probe (9 markers x existsSync/lstat per level, plus isRepoContainer's own
  // readdirSync) purely to feed lastKnownProjectRoots -- a value only consulted once per
  // PRUNE_EVERY_N_DRAINS drains. Multiple dirty paths sharing the same directory in one batch
  // repeated that walk once per path for an identical result. Assert findProject is called at
  // most once per distinct dirname in the batch, not once per path.
  it('memoizes findProject per dirname within a batch instead of re-walking for every path', () => {
    fs.mkdirSync(path.join(DIR, '.git'))
    const a = path.join(DIR, 'a.ts')
    const b = path.join(DIR, 'b.ts')
    const c = path.join(DIR, 'c.ts')
    fs.writeFileSync(a, 'export const a = 1\n')
    fs.writeFileSync(b, 'export const b = 1\n')
    fs.writeFileSync(c, 'export const c = 1\n')

    const findProjectSpy = vi.spyOn(projectModule, 'findProject')

    const indexed: string[] = []
    processDirtyBatch([a, b, c], (p) => indexed.push(p))

    expect(indexed).toEqual([a, b, c])
    // All three paths share the same dirname (DIR) -- pre-fix this was called 3 times (once per
    // path); post-fix it must be called at most once for that one distinct dirname.
    expect(findProjectSpy.mock.calls.length).toBeLessThan(3)
    expect(findProjectSpy).toHaveBeenCalledTimes(1)
  })

  // Regression: processDirtyBatch is exported specifically for direct unit-test/caller use (see
  // its doc comment), so it cannot assume every caller pre-filters blank entries the way
  // parseDirtyQueueLines does for the real drain path. Without the `if (!p) continue` guard, an
  // empty-string entry reaches fs.existsSync('') (false) and falls through to the remove callback
  // with an empty path -- wasted work at best, and a surface a future remove() implementation
  // could mishandle. Assert neither the index nor the remove callback is ever invoked for it.
  it('skips a blank/empty-string entry in the batch instead of treating it as a deletion', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')

    const indexed: string[] = []
    const removed: string[] = []
    const count = processDirtyBatch(
      ['', real],
      (p) => indexed.push(p),
      (p) => removed.push(p),
      DIR,
    )

    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    expect(removed).toEqual([])
  })

  // Regression: a dirty path that exists (fs.existsSync true) but whose fingerprintFile call
  // returns null -- a transient read failure such as a lock held by an AV scanner/editor/OneDrive
  // sync, a permission error, or a race with an external writer -- used to be silently dropped:
  // `continue`d past with no log entry and no way to retry short of the file being touched again,
  // since drainOnce unconditionally clears the .draining marker right after this function
  // returns. Trigger the failure with a REAL, unmocked read error (a directory sitting at the
  // dirty-queued path, so fs.existsSync is true but fs.readFileSync throws EISDIR and
  // fingerprintFile returns null) rather than mocking fingerprintFile, exercising the actual
  // production call.
  it('logs and requeues a path whose fingerprintFile call fails despite the file existing', () => {
    const lockedPath = path.join(DIR, 'locked.ts')
    fs.mkdirSync(lockedPath) // exists (fs.existsSync true), but reading it as a file throws EISDIR
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')

    const indexed: string[] = []
    const removed: string[] = []
    const count = processDirtyBatch(
      [lockedPath, real],
      (p) => indexed.push(p),
      (p) => removed.push(p),
      DIR,
    )

    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    expect(removed).toEqual([])

    // Requeued into the live dirty queue for the next drain cycle.
    expect(getDirtyPathsFor(DIR)).toEqual([lockedPath])

    // Logged distinctly from an indexing failure.
    const log = fs.readFileSync(path.join(DIR, 'worker-errors.log'), 'utf8')
    expect(log).toContain(lockedPath)
    expect(log).toContain('transient read failure')
  })

  // Regression: bumpRetryCount/clearRetryCount used to fold the RAW absPath as given by the
  // caller instead of normalizing it first. The files.path column is always written in
  // normalizePath()'d (forward-slash) form by every real writer, so a caller that referenced
  // the same file via a native-separator (backslash) path on a second call would never match
  // the row written under the normalized form, silently falling into the INSERT branch instead
  // of incrementing the existing row's retry_count. Drive two real transient-read failures on
  // the SAME file, one queued in its native path.join() form and one in its normalizePath()'d
  // form, and confirm they share one counter (accumulates to 2) instead of each starting a
  // fresh row at 1.
  it('accumulates retry_count on one shared row across calls that reference the same file via different path forms (backslash vs normalized)', () => {
    const lockedPath = path.join(DIR, 'locked-crossform.ts')
    fs.mkdirSync(lockedPath) // exists, but reading it as a file throws EISDIR (transient failure)
    const lockedPathNormalized = normalizePath(lockedPath)
    const dbPath = path.join(DIR, 'global.db')

    processDirtyBatch([lockedPath], undefined, undefined, DIR)
    expect(getRetryCount(dbPath, lockedPath)).toBe(1)

    processDirtyBatch([lockedPathNormalized], undefined, undefined, DIR)
    expect(getRetryCount(dbPath, lockedPath)).toBe(2)
  })

  it('resetTransientRetryCount clears the counter even when called with a differently-formed path than the one that wrote it', () => {
    const lockedPath = path.join(DIR, 'locked-reset.ts')
    fs.mkdirSync(lockedPath)
    const dbPath = path.join(DIR, 'global.db')

    processDirtyBatch([lockedPath], undefined, undefined, DIR)
    expect(getRetryCount(dbPath, lockedPath)).toBe(1)

    resetTransientRetryCount(normalizePath(lockedPath), dbPath)
    expect(getRetryCount(dbPath, lockedPath)).toBe(0)
  })

  // Regression (worker requeueDirtyPath had no retry cap/backoff): a permanently stuck path
  // (e.g. a lock that never clears) used to be requeued into dirty.txt forever, every single
  // drain cycle, with no bound and no visibility into the fact that it was stuck. Drive the
  // REAL drain path (drainOnce -- the same call runWorkerLoop makes every ~2s) across many
  // cycles with a path that fails every single time via a REAL, unmocked read error (a
  // directory sitting at the dirty-queued path, same technique as the test above), and confirm
  // it is eventually dropped instead of requeued forever, exactly one throttled warning is
  // logged for it (not one per cycle), and a healthy path queued in the same initial batch is
  // indexed once and never starved or reprocessed just because it shares a batch with the
  // stuck path.
  it('caps transient-read-failure retries for a permanently stuck path without starving healthy paths', () => {
    const lockedPath = path.join(DIR, 'stuck.ts')
    fs.mkdirSync(lockedPath) // exists (fs.existsSync true), but reading it as a file throws EISDIR every time
    const healthy = path.join(DIR, 'healthy.ts')
    fs.writeFileSync(healthy, 'export const x = 1\n')
    writeQueue(DIR, [lockedPath, healthy])

    const indexed: string[] = []
    // Drive many real drain cycles -- comfortably more than any reasonable retry cap.
    for (let cycle = 0; cycle < 10; cycle++) {
      drainOnce(DIR, (p) => indexed.push(p))
    }

    // The healthy path was indexed on the very first cycle and never reprocessed again -- it
    // is not starved or repeatedly reprocessed just because the stuck path shares its batch.
    expect(indexed).toEqual([healthy])

    // The stuck path eventually stops being requeued -- the queue empties out instead of
    // holding it forever.
    expect(getDirtyPathsFor(DIR)).toEqual([])

    // Exactly one throttled "giving up" warning was logged for it, not one per cycle.
    const log = fs.readFileSync(path.join(DIR, 'worker-errors.log'), 'utf8')
    const giveUpLines = log
      .split('\n')
      .filter((l) => l.includes('giving up on') && l.includes(lockedPath))
    expect(giveUpLines.length).toBe(1)
  })

  // Regression: the retry count was cleared on a *successful* read (processDirtyBatch) but
  // never on a fresh edit re-dirtying the path -- so a path that once exhausted its retry
  // budget during a transient lock episode stayed permanently exhausted for the rest of the
  // daemon's lifetime, even after the file was edited again. The fix is
  // resetTransientRetryCount, called from appendDirtyPath (hooks_index.ts) whenever a path is
  // freshly dirtied by an edit. Pass this test's own DIR-scoped DB explicitly -- production
  // callers (appendDirtyPath) rely on the `dbPath` default (globalDbPath()), but a test using
  // an isolated dir must name the same DB drainOnce(DIR) itself reads, exactly as a real
  // hook-process/daemon-process pair would both resolve to the one shared global.db.
  it('gives a fresh retry budget to a path re-dirtied after exhausting its retry cap', () => {
    const lockedPath = path.join(DIR, 'stuck2.ts')
    fs.mkdirSync(lockedPath)
    writeQueue(DIR, [lockedPath])
    const dbPath = path.join(DIR, 'global.db')

    for (let cycle = 0; cycle < 10; cycle++) {
      drainOnce(DIR)
    }
    expect(getDirtyPathsFor(DIR)).toEqual([])
    const logAfterFirstExhaustion = fs.readFileSync(path.join(DIR, 'worker-errors.log'), 'utf8')
    const firstGiveUpCount = logAfterFirstExhaustion
      .split('\n')
      .filter((l) => l.includes('giving up on') && l.includes(lockedPath)).length
    expect(firstGiveUpCount).toBe(1)

    // Simulate the edit-driven re-dirty path: reset the retry count (what appendDirtyPath now
    // does) and re-queue the still-stuck path, as a fresh edit to it would.
    resetTransientRetryCount(lockedPath, dbPath)
    writeQueue(DIR, [lockedPath])

    for (let cycle = 0; cycle < 10; cycle++) {
      drainOnce(DIR)
    }
    expect(getDirtyPathsFor(DIR)).toEqual([])

    const logAfterSecondExhaustion = fs.readFileSync(path.join(DIR, 'worker-errors.log'), 'utf8')
    const secondGiveUpCount = logAfterSecondExhaustion
      .split('\n')
      .filter((l) => l.includes('giving up on') && l.includes(lockedPath)).length
    expect(secondGiveUpCount).toBe(2)
  })

  // Regression (the actual cross-process bug, not just the same-process behavior above): the
  // retry count used to live only in a worker.ts module-level Map, so resetTransientRetryCount
  // -- called from appendDirtyPath in the short-lived hook CLI process -- could never reach the
  // long-lived detached daemon's own copy of that Map. A same-process test calling
  // resetTransientRetryCount and then drainOnce in immediate succession would pass even with
  // that bug, because both calls shared the one process's Map (the "wrong-oracle" trap: the
  // test never actually exercised the missing cross-process link). This test instead closes
  // every cached DB connection (clearModuleCaches -> closeAllDbs) between each step, forcing
  // drainOnce/resetTransientRetryCount to open a brand-new connection object every time -- the
  // closest a single Node process can get to proving the persisted DB row, not any
  // process-local cache, is what carries the reset across. If retry state lived in memory
  // again, this would regress back to zero new "giving up" output after the reset.
  it('persists the retry-count reset through the DB even when every in-process DB connection is closed and reopened between steps (cross-process simulation)', () => {
    const lockedPath = path.join(DIR, 'stuck3.ts')
    fs.mkdirSync(lockedPath)
    writeQueue(DIR, [lockedPath])
    const dbPath = path.join(DIR, 'global.db')

    for (let cycle = 0; cycle < 10; cycle++) {
      drainOnce(DIR)
    }
    const logPath = path.join(DIR, 'worker-errors.log')
    const giveUpCount = (log: string): number =>
      log.split('\n').filter((l) => l.includes('giving up on') && l.includes(lockedPath)).length
    expect(giveUpCount(fs.readFileSync(logPath, 'utf8'))).toBe(1)

    // Close every cached DB connection -- simulates the daemon process (which just wrote
    // retry_count = 5 while giving up) exiting or being a wholly separate process from whatever
    // resets the count next.
    clearModuleCaches()

    // Simulates appendDirtyPath running in a fresh, short-lived hook CLI process: no shared
    // memory with whatever wrote the exhausted count, only DB access.
    resetTransientRetryCount(lockedPath, dbPath)
    writeQueue(DIR, [lockedPath])

    // Close the connection the reset just opened too, then simulate the daemon coming back
    // (its own fresh process/connection) to drain the re-queued path.
    clearModuleCaches()

    for (let cycle = 0; cycle < 10; cycle++) {
      drainOnce(DIR)
    }
    expect(getDirtyPathsFor(DIR)).toEqual([])
    expect(giveUpCount(fs.readFileSync(logPath, 'utf8'))).toBe(2)
  })
})

describe('drainOnce', () => {
  it('reads dirty.txt, processes paths via the indexer, and clears the queue', () => {
    const real = path.join(DIR, 'real.ts')
    fs.writeFileSync(real, 'export const x = 1\n')
    writeQueue(DIR, [real])

    const indexed: string[] = []
    const count = drainOnce(DIR, (p) => indexed.push(p))

    expect(count).toBe(1)
    expect(indexed).toEqual([real])
    expect(fs.existsSync(queueFile(DIR))).toBe(false)
  })

  it('is a no-op (returns 0) when the queue is empty', () => {
    expect(drainOnce(DIR)).toBe(0)
  })

  // Regression: doctor's dirty-queue drain-heartbeat check (checkDirtyQueueHealth) distinguishes
  // a running-but-wedged worker from one actively draining by the recency of this marker's
  // mtime. It must be touched on EVERY cycle, including a no-op one (empty queue) -- a wedged
  // loop that stopped reaching the end of drainOnce is exactly what the check needs to catch,
  // and an empty-queue cycle is the most common steady-state case in a real project.
  it('touches the drain-heartbeat marker even on a no-op cycle', () => {
    const heartbeatPath = drainHeartbeatPathFor(DIR)
    expect(fs.existsSync(heartbeatPath)).toBe(false)

    drainOnce(DIR)

    expect(fs.existsSync(heartbeatPath)).toBe(true)
  })

  it('updates the drain-heartbeat marker mtime on each subsequent cycle', () => {
    const heartbeatPath = drainHeartbeatPathFor(DIR)
    drainOnce(DIR)
    const firstMtime = fs.statSync(heartbeatPath).mtimeMs
    // Back-date the marker so a second real drainOnce call is guaranteed to produce a
    // strictly later mtime even on filesystems with coarse mtime resolution.
    fs.utimesSync(heartbeatPath, new Date(firstMtime - 5000), new Date(firstMtime - 5000))

    drainOnce(DIR)

    const secondMtime = fs.statSync(heartbeatPath).mtimeMs
    expect(secondMtime).toBeGreaterThan(firstMtime - 5000)
  })

  // Regression: the shipping path is `runWorkerLoop -> drainOnce(dir)` with NO injected index callback. Before the fix, the default callback was a stub that wrote "would index" to stderr and never touched the DB, so every surgical-read command silently returned an empty index. This test drives the real default path (no callback) end-to-end and asserts the symbols table is actually populated — it fails against the stub (0 rows) and passes once the real indexer is wired in. The existing drainOnce/processDirtyBatch tests inject their own callback, so they never exercised this path.
  it('default path indexes drained files into global.db (no injected callback)', () => {
    const src = path.join(DIR, 'sample.ts')
    fs.writeFileSync(src, 'export function knownWorkerSymbol(): number {\n  return 42\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    // Real shipping path: drain with no index callback.
    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const all = querySymbols({ limit: 1000 }, projectDb)
      expect(all.length).toBe(1)
      const found = querySymbols({ name: 'knownWorkerSymbol', limit: 10 }, projectDb)
      expect(found.length).toBe(1)
      expect(found[0]?.name).toBe('knownWorkerSymbol')
    } finally {
      // Release the better-sqlite3 handle so afterEach can remove DIR on Windows.
      closeDb(projectDb)
    }
  })

  // Companion to the symbols regression above, for the refs table. The default drain path must populate refs (it was hard-coded to [] in the parser), with the enclosing caller in `context`, so `refs --callers` can resolve callers.
  it('default path populates the refs table from drained files (no injected callback)', () => {
    const src = path.join(DIR, 'callers.ts')
    fs.writeFileSync(
      src,
      'function knownCallee(): number {\n  return 1\n}\n' +
        'export function knownCaller(): number {\n  return knownCallee()\n}\n',
    )
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const refs = queryRefs({ name: 'knownCallee' }, projectDb)
      expect(refs.length).toBe(1)
      expect(refs[0]?.context).toBe('knownCaller')
    } finally {
      closeDb(projectDb)
    }
  })

  // End-to-end proof for the Terraform/HCL adapter (feature-queue #310): drives the real
  // shipping path (drainOnce with no injected index callback -> indexFileSync ->
  // extractTerraform) rather than calling extractTerraform directly, per CLAUDE.md's
  // injected-seam-trap warning -- a unit test on the extractor alone would never catch a
  // registration gap (missing Language union entry, missing EXTENSION_LANGUAGE mapping, or
  // missing NO_TREE_SITTER_EXTRACTORS wiring) that leaves .tf files unreachable via the real
  // drain -> index -> symbols table path even though the extractor itself works in isolation.
  it('default path indexes a real .tf file into global.db, resolving Terraform-addressed symbols (no injected callback)', () => {
    const src = path.join(DIR, 'main.tf')
    fs.writeFileSync(
      src,
      'resource "aws_instance" "web" {\n' +
        '  ami = "ami-123"\n' +
        '}\n' +
        '\n' +
        'variable "region" {\n' +
        '  default = "us-east-1"\n' +
        '}\n',
    )
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const resource = querySymbols({ name: 'aws_instance.web', limit: 10 }, projectDb)
      expect(resource.length).toBe(1)
      expect(resource[0]?.kind).toBe('tf_resource')
      expect(resource[0]?.lineStart).toBe(1)
      expect(resource[0]?.lineEnd).toBe(3)

      const variable = querySymbols({ name: 'var.region', limit: 10 }, projectDb)
      expect(variable.length).toBe(1)
      expect(variable[0]?.kind).toBe('tf_variable')
    } finally {
      closeDb(projectDb)
    }
  })

  // Same shipping-path proof as the .tf test above, for the bash adapter (feature-queue #332):
  // .sh/.bash already mapped to the 'bash' Language via EXTENSION_LANGUAGE, but had no entry in
  // NO_TREE_SITTER_EXTRACTORS, so every shell script indexed to zero symbols via the real
  // drain -> index -> symbols table path even though extractBash worked correctly in isolation.
  it('default path indexes a real .sh file into global.db, resolving bash function/var symbols (no injected callback)', () => {
    const src = path.join(DIR, 'deploy.sh')
    fs.writeFileSync(
      src,
      '#!/usr/bin/env bash\n' + 'export APP_NAME=myapp\n' + '\n' + 'deploy() {\n' + '  echo "$APP_NAME"\n' + '}\n',
    )
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const func = querySymbols({ name: 'deploy', limit: 10 }, projectDb)
      expect(func.length).toBe(1)
      expect(func[0]?.kind).toBe('function')
      expect(func[0]?.lineStart).toBe(4)

      const variable = querySymbols({ name: 'APP_NAME', limit: 10 }, projectDb)
      expect(variable.length).toBe(1)
      expect(variable[0]?.kind).toBe('variable')
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: the incremental drain must reconcile DELETIONS, not just edits. The shipping path is `drainOnce(dir)` with no injected callbacks; before the fix a dirty path whose file was gone was skipped, orphaning its symbol/ref rows forever. This drives the real default path: index a file, delete it, re-queue its path, drain again, and asserts the symbol is gone from the project's global.db. It fails pre-fix (row survives) and passes post-fix.
  it('default path prunes a deleted file\'s rows on re-drain (no injected callback)', () => {
    const src = path.join(DIR, 'doomed.ts')
    fs.writeFileSync(src, 'export function doomedWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      expect(
        querySymbols({ name: 'doomedWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)
      fs.rmSync(src)
      writeQueue(DIR, [norm])
      drainOnce(DIR)
      expect(querySymbols({ name: 'doomedWorkerSymbol', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: indexFileSync/cmdIndex's skip_dirs and large_file_skip_kb early-returns left
  // stale symbol/ref rows behind AND never cleared files.sha, so a file indexed while small/
  // allowed that later crosses the cap (or whose directory is newly added to skip_dirs) got
  // stuck in a self-perpetuating loop: the stale sha never matched current content, so every
  // subsequent drainOnce re-selected it as changed, re-called indexFileSync, which re-skipped
  // it again, forever, while the OLD rows kept resolving via symbol/read. This drives the real
  // default drain path end-to-end (no injected index callback): index a file normally, EDIT it
  // (so its sha changes and drainOnce's parseUnchanged gate does not skip the re-check) while
  // also lowering large_file_skip_kb below its new size, re-drain, and assert (a) the stale
  // symbol no longer resolves and (b) the files row is gone (sha cleared) so the file settles
  // into a stable not-indexed state instead of endlessly re-processing.
  it('default path clears stale rows and files.sha when a previously-indexed file becomes skip-eligible (no injected callback)', () => {
    const src = path.join(DIR, 'growable.ts')
    fs.writeFileSync(src, 'export function growableWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    // Index it once while comfortably under the (generously permissive) default cap.
    expect(drainOnce(DIR)).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      expect(
        querySymbols({ name: 'growableWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)
      expect(getFileEntry(norm, projectDb)).not.toBeNull()

      // Edit the file (sha changes, so the parseUnchanged gate in makeIndexer will not skip
      // the re-check) and simultaneously make it skip-eligible by lowering large_file_skip_kb
      // below its new size -- simulating the file crossing the cap (or its directory being
      // newly added to skip_dirs) on a real edit.
      fs.writeFileSync(
        src,
        'export function growableWorkerSymbol(): number {\n  return 2\n}\n// padding\n',
      )
      vi.mocked(loadConfig).mockReturnValue({
        worker: { blocked_roots: [] },
        indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 0, large_file_symbol_only_kb: 1048576 },
      } as unknown as ReturnType<typeof loadConfig>)
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)

      // The stale symbol must no longer resolve, and the files row (including sha) must be
      // cleared -- not just the symbols/refs rows -- so the file settles into a stable
      // not-indexed state instead of being endlessly re-selected as changed.
      expect(querySymbols({ name: 'growableWorkerSymbol', limit: 10 }, projectDb).length).toBe(0)
      expect(getFileEntry(norm, projectDb)).toBeNull()

      // A further re-queue+drain while still skip-eligible must settle at the same stable
      // state -- no stale rows resurrect and no error is thrown -- rather than looping forever.
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(querySymbols({ name: 'growableWorkerSymbol', limit: 10 }, projectDb).length).toBe(0)
      expect(getFileEntry(norm, projectDb)).toBeNull()
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: makeIndexer's parseUnchanged sha-gate ran indexFileSync ONLY when content
  // changed, so a file re-enqueued with BYTE-IDENTICAL content (same sha) after becoming
  // skip-eligible purely from a config change (skip_dirs/large_file_skip_kb, no edit at all)
  // never had indexFileSync called -- and the stale-row purge lives INSIDE indexFileSync -- so
  // its symbols/refs/files rows were never cleared, even though embeddings correctly purge via
  // their own independent wouldSkipFileEmbedding gate. This is the specific gap the sibling
  // "becomes skip-eligible" test above does NOT cover, since that test also edits the file
  // (changing its sha) to make parseUnchanged false, bypassing this exact code path. Drives the
  // real default drain path end-to-end (no injected index callback, no content change).
  it('default path clears stale rows for a skip-eligible file re-enqueued with unchanged content (parseUnchanged=true)', () => {
    const src = path.join(DIR, 'unchanged.ts')
    fs.writeFileSync(src, 'export function unchangedWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    // Index it once while comfortably under the (generously permissive) default cap.
    expect(drainOnce(DIR)).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      expect(
        querySymbols({ name: 'unchangedWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)
      expect(getFileEntry(norm, projectDb)).not.toBeNull()

      // Make the file skip-eligible via a CONFIG CHANGE ONLY -- content and sha are untouched,
      // so makeIndexer's parseUnchanged gate would evaluate true (entry.sha === sha), exactly
      // the gap this test targets.
      vi.mocked(loadConfig).mockReturnValue({
        worker: { blocked_roots: [] },
        indexing: { skip_dirs: [], skip_files: [], large_file_skip_kb: 0, large_file_symbol_only_kb: 1048576 },
      } as unknown as ReturnType<typeof loadConfig>)
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)

      // The stale symbol must no longer resolve, and the files row (including sha) must be
      // cleared -- consistent with the embeddings side, which already purges correctly
      // regardless of parseUnchanged via its own independent gate.
      expect(
        querySymbols({ name: 'unchangedWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBe(0)
      expect(getFileEntry(norm, projectDb)).toBeNull()
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: a rename/delete that never goes through the Edit hook path (git mv, a
  // directory rename, `git checkout <branch>`, `git clean`) never enqueues the old path, so
  // the dirty-queue reconciliation exercised by the sibling "prunes a deleted file's rows on
  // re-drain" test above never runs for it -- the row orphans in the index forever. drainOnce
  // now also runs an opportunistic pruneDeletedFiles sweep every PRUNE_EVERY_N_DRAINS (30)
  // cycles, scoped to the project root it learned from earlier dirty-queue traffic. This drives
  // the real default path end-to-end: index a file (learning the project root along the way),
  // delete it WITHOUT re-queuing its path, drive enough drain cycles to cross the periodic
  // threshold, and assert the stale row is gone. Fails pre-fix (row survives indefinitely,
  // since nothing else in the drain loop ever revisits it) and passes post-fix.
  it('prunes a stale row for a file renamed/deleted outside the Edit hook path once enough drain cycles cross the periodic threshold', () => {
    // A project marker so findProject(path.dirname(src)) resolves DIR as a real project root --
    // opportunistically learned by processDirtyBatch from the dirty paths it processes.
    fs.writeFileSync(path.join(DIR, 'package.json'), '{"name":"tg-worker-prune-test"}')

    const src = path.join(DIR, 'renamed-away.ts')
    fs.writeFileSync(src, 'export function prunedWorkerSymbol(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      expect(
        querySymbols({ name: 'prunedWorkerSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)

      // Simulate the git-mv/git-clean scenario: the file is gone from disk, but its old path
      // is never re-enqueued (unlike the sibling test above, which explicitly re-queues the
      // old path to exercise the ordinary dirty-queue reconciliation branch instead of this
      // one).
      fs.rmSync(src)

      // Empty-queue drain cycles: nothing for the normal dirty-queue path to reconcile each
      // time, so only the periodic prune sweep (using the project root learned by the very
      // first drainOnce call above) can catch the stale row.
      for (let i = 0; i < 30; i++) {
        drainOnce(DIR)
      }

      expect(querySymbols({ name: 'prunedWorkerSymbol', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: the real drain path must SHA-gate. makeIndexer is handed each file's fingerprint but the buggy version dropped it and reparsed every queued file on every drain. Drive the real default path (no injected callback): index a file, delete its symbol rows to prove a reindex would repopulate, then re-queue the UNCHANGED file. With the gate the stored files.sha matches the fingerprint so indexFileSync is skipped and the rows stay deleted; the buggy version reindexes and repopulates them.
  it('default path skips re-indexing a file whose content is unchanged (sha gate)', () => {
    const src = path.join(DIR, 'cached.ts')
    fs.writeFileSync(src, 'export function shaGatedSymbol(): number {\n  return 7\n}\n')
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')
    try {
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBe(1)

      // Corrupt the index: drop the file's symbol rows but leave its files row (and stored sha) intact.
      getDb(projectDb).prepare('DELETE FROM symbols WHERE file_path = ?').run(norm)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBe(0)

      // This test targets the PARSE-sha gate specifically (embedding freshness is gated
      // independently -- see the dedicated embed_sha regression tests below). Stamp embed_sha to
      // match the stored sha, simulating a prior successful embed, so a fully-skipped drain here
      // isolates the parse gate rather than being driven by the (unrelated) embed re-trigger.
      getDb(projectDb).prepare('UPDATE files SET embed_sha = sha WHERE path = ?').run(norm)

      // Re-queue the unchanged file and drain again; the sha gate must skip the reparse, and the
      // returned count must not include it (it was visited but not actually reindexed).
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(0)
      expect(querySymbols({ name: 'shaGatedSymbol', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: indexFileSync stored the SHA of the utf8-DECODED content string
  // (invalid byte sequences replaced with U+FFFD, then re-encoded), while
  // processDirtyBatch's gate SHA (fingerprintFile) hashes the RAW file bytes
  // directly. For a file containing an invalid-UTF-8 byte, those two hashes
  // could never match, so the sha gate above never engaged and the file was
  // fully reparsed on every single drain even when byte-for-byte unchanged.
  it('sha gate still skips an unchanged file whose raw bytes are not valid UTF-8', () => {
    const src = path.join(DIR, 'invalid-utf8.ts')
    const content = Buffer.concat([
      Buffer.from('// bad byte follows: ', 'ascii'),
      Buffer.from([0xff]),
      Buffer.from('\nexport function shaGatedInvalidUtf8(): number {\n  return 7\n}\n', 'ascii'),
    ])
    fs.writeFileSync(src, content)
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')
    try {
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(
        querySymbols({ name: 'shaGatedInvalidUtf8', limit: 10 }, projectDb).length,
      ).toBe(1)

      getDb(projectDb).prepare('DELETE FROM symbols WHERE file_path = ?').run(norm)
      expect(querySymbols({ name: 'shaGatedInvalidUtf8', limit: 10 }, projectDb).length).toBe(0)

      // Isolate the parse gate from the (independently gated) embed re-trigger -- see the
      // matching comment in the sha-gate test above.
      getDb(projectDb).prepare('UPDATE files SET embed_sha = sha WHERE path = ?').run(norm)

      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(0)
      expect(querySymbols({ name: 'shaGatedInvalidUtf8', limit: 10 }, projectDb).length).toBe(0)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: parseFile stripped a leading UTF-8 BOM (U+FEFF) before parsing, but
  // indexFileSync (the worker's real shipping path -- used by drainOnce) called
  // parseContent directly on the raw decoded content without stripping it first. Any
  // `^`-anchored regex extractor (markdown headings included) then has its line-1 match
  // fail, because the BOM sits before the `#`. This drives the real default drain path
  // (no injected callback) on a BOM'd markdown file and asserts the line-1 heading still
  // resolves as a symbol. It fails pre-fix (0 symbols) and passes once the BOM is stripped
  // inside parseContent itself, so both parseFile and indexFileSync inherit the fix.
  it('default path strips a leading UTF-8 BOM before parsing (indexFileSync path)', () => {
    const src = path.join(DIR, 'bom.md')
    fs.writeFileSync(src, '﻿# Known Bom Heading\n\nBody text.\n', 'utf8')
    const norm = normalizePath(src)
    writeQueue(DIR, [norm])

    const count = drainOnce(DIR)
    expect(count).toBe(1)

    const projectDb = path.join(DIR, 'global.db')
    try {
      const found = querySymbols({ name: 'Known Bom Heading', limit: 10 }, projectDb)
      expect(found.length).toBe(1)
      expect(found[0]?.lineStart).toBe(1)
    } finally {
      closeDb(projectDb)
    }
  })

  describe('drainOnce atomic rename-to-claim (lost-update regression)', () => {
    it('does not drop paths appended during a drain', () => {
      // Regression: drainOnce must not delete the entire queue without first claiming it atomically. A path appended by a concurrent appendDirtyPath during processDirtyBatch would be deleted without being indexed. The atomic rename-to-claim pattern fixes this.
      const A = path.join(DIR, 'a.ts')
      const B = path.join(DIR, 'b.ts')
      fs.writeFileSync(A, 'export const a = 1\n')
      fs.writeFileSync(B, 'export const b = 2\n')

      // Seed the queue with just A.
      writeQueue(DIR, [A])

      // The callback simulates concurrent appendDirtyPath calls that land during processDirtyBatch. When we process A, we append B to the queue to simulate a race.
      const indexedPaths: string[] = []
      drainOnce(DIR, (p) => {
        indexedPaths.push(p)
        if (p === A) {
          // Simulate concurrent appendDirtyPath(B) landing during our batch processing.
          fs.appendFileSync(path.join(DIR, 'queue', 'dirty.txt'), `${B}\n`)
        }
      })

      // After the drain, B should still be in the queue (was not deleted). Pre-fix: B would be deleted without being indexed. Post-fix: B is preserved in the fresh queue created after the rename.
      const remaining = getDirtyPathsFor(DIR)
      expect(remaining).toContain(B)
    })

    // Regression (mutation-testing gap): the post-claim re-read forwards only the *new suffix*
    // of the claimed file (recheck.slice(claimedContent.length)), not the whole re-read content,
    // to the live queue. This matters specifically for a write landing on the SAME renamed
    // claim-target file mid-batch (the FILE_SHARE_DELETE/rename-race window the doc comment
    // above describes) rather than a fresh dirty.txt recreated after the claim (the prior test).
    // Without the startsWith-slice, an already-processed path in the claimed content would be
    // re-forwarded into the live queue alongside the genuinely-new one, redundantly reprocessing
    // it on the next cycle instead of forwarding only what the race actually added.
    it('forwards only the new suffix of the claimed file to the live queue, not the whole re-read content, when a write lands on the claim target itself mid-batch', () => {
      const A = path.join(DIR, 'a2.ts')
      const G = path.join(DIR, 'g2.ts')
      fs.writeFileSync(A, 'export const a2 = 1\n')
      fs.writeFileSync(G, 'export const g2 = 1\n')
      writeQueue(DIR, [A])

      const claimTarget = path.join(DIR, 'queue', 'dirty.txt.draining')
      drainOnce(DIR, (p) => {
        if (p === A) {
          // Simulate a concurrent writer landing on the SAME claimed file (not a fresh dirty.txt).
          fs.appendFileSync(claimTarget, `${G}\n`)
        }
      })

      // Only G (the genuinely new suffix) is forwarded to the live queue -- A must not be
      // redundantly re-added just because the whole claimed file was re-read.
      expect(getDirtyPathsFor(DIR)).toEqual([G])
    })

    it('recovers from abandoned .draining file', () => {
      // Regression: if a previous drain process crashed, its .draining file would be abandoned. drainOnce must recover by reading and indexing it, so those paths are not lost.
      const C = path.join(DIR, 'c.ts')
      fs.writeFileSync(C, 'export const c = 3\n')

      // Simulate a crashed drain by creating a .draining file directly.
      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${C}\n`)

      // No live queue exists; only the .draining file.
      expect(fs.existsSync(queuePath)).toBe(false)

      // The drain should recover the .draining file, index C, and clean it up.
      const indexedPaths: string[] = []
      const count = drainOnce(DIR, (p) => {
        indexedPaths.push(p)
      })

      // C should have been recovered and indexed.
      expect(count).toBe(1)
      expect(indexedPaths).toContain(C)

      // The .draining file should be cleaned up.
      expect(fs.existsSync(drainingPath)).toBe(false)
    })

    // Regression (same-cycle retry double-bump): when a transient read failure happens while
    // recovering an abandoned .draining file in stage (a), the old requeueDirtyPath appended the
    // path straight to the LIVE dirty.txt -- which stage (b) of this SAME drainOnce call then
    // claims and reprocesses microseconds later, while the lock/condition that caused the
    // original failure has almost certainly not cleared yet. That silently bumped the transient
    // retry counter TWICE per drain cycle instead of once, roughly halving the effective
    // MAX_TRANSIENT_RETRIES budget (5 real failure cycles exhausted it in ~3 calls instead of 5).
    // No live dirty.txt exists before this call -- isolating the bug to exactly the stage
    // (a)-recovers/stage (b)-immediately-reclaims interaction, not any pre-existing queue content.
    it('bumps the transient-retry count only once per drainOnce call when stage (a) recovering an abandoned .draining file requeues a path stage (b) of the SAME cycle would otherwise immediately reclaim', () => {
      const lockedPath = path.join(DIR, 'stuck-samecycle.ts')
      fs.mkdirSync(lockedPath) // exists (fs.existsSync true), but reading it as a file throws EISDIR every time
      const dbPath = path.join(DIR, 'global.db')
      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${lockedPath}\n`)
      expect(fs.existsSync(queuePath)).toBe(false)

      drainOnce(DIR)

      // Exactly one bump for this single drainOnce call -- not two.
      expect(getRetryCount(dbPath, lockedPath)).toBe(1)

      // The path is still requeued for the next drain cycle either way -- the fix defers WHEN
      // the append lands in the live queue, not WHETHER it does.
      expect(getDirtyPathsFor(DIR)).toEqual([lockedPath])
    })

    it('recovers multiple abandoned .draining/.draining.alt-<ts> files in a single cycle', () => {
      // Regression: before listDrainingFiles, drainOnce only ever checked the single primary
      // `.draining` name. A `.draining.alt-<ts>` fallback file (left behind when stage (b) had
      // to claim under a fallback name because the primary was still occupied by a file a
      // previous cycle could not clean up) would then sit on disk forever, unprocessed, on
      // every future cycle -- listDrainingFiles must recover ALL of them, not just the first.
      const D = path.join(DIR, 'stuck-a.ts')
      fs.writeFileSync(D, 'export const stuckA = 1\n')
      const F = path.join(DIR, 'stuck-b.ts')
      fs.writeFileSync(F, 'export const stuckB = 2\n')

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      const altPath = `${drainingPath}.alt-1700000000000`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${D}\n`)
      fs.writeFileSync(altPath, `${F}\n`)

      const indexedPaths: string[] = []
      const count = drainOnce(DIR, (p) => {
        indexedPaths.push(p)
      })

      expect(count).toBe(2)
      expect(indexedPaths).toContain(D)
      expect(indexedPaths).toContain(F)
      expect(fs.existsSync(drainingPath)).toBe(false)
      expect(fs.existsSync(altPath)).toBe(false)
    })

    // Regression (mutation-testing gap): listDrainingFiles must exclude a `.draining.alt-<ts>`
    // file that was itself already quarantined (renamed to `...alt-<ts>.corrupt-<ts2>` by
    // drainOnce's own cleanup-failure fallback). Without the exclusion, a quarantined file's
    // name still matches the `.alt-` prefix check, so it would be picked back up and
    // reprocessed as live draining content on the very next cycle instead of being left alone
    // for cleanupWorkerStateFiles' age-based sweep to eventually remove it.
    it('does not reprocess an already-quarantined `.draining.alt-<ts>.corrupt-<ts2>` file', () => {
      const D = path.join(DIR, 'stuck-a.ts')
      fs.writeFileSync(D, 'export const stuckA = 1\n')

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      const altPath = `${drainingPath}.alt-1700000000000`
      const quarantinedAltPath = `${altPath}.corrupt-1700000000001`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${D}\n`)
      // Simulate an already-quarantined alt file left behind by a prior cycle -- its content
      // must never be treated as a real path to index.
      fs.writeFileSync(quarantinedAltPath, 'not a real path, deliberately corrupt content\n')

      const indexedPaths: string[] = []
      const count = drainOnce(DIR, (p) => {
        indexedPaths.push(p)
      })

      expect(count).toBe(1)
      expect(indexedPaths).toEqual([D])
      expect(fs.existsSync(drainingPath)).toBe(false)
      // The quarantined file is left untouched by drainOnce -- only cleanupWorkerStateFiles'
      // age-based sweep may eventually remove it.
      expect(fs.existsSync(quarantinedAltPath)).toBe(true)
    })
  })

  describe('drainOnce rm-after-process (crash-safety regression)', () => {
    it('does not lose claimed queue paths when processing crashes mid-batch (stage b)', () => {
      // Regression: drainOnce used to delete the claimed .draining file BEFORE running
      // processDirtyBatch, so a crash (simulated here as the index callback throwing) partway
      // through a batch already had the queue file deleted -- the paths were lost forever until
      // some unrelated future edit re-queued them. The fix defers the rm until after
      // processDirtyBatch completes successfully.
      const A = path.join(DIR, 'a.ts')
      const B = path.join(DIR, 'b.ts')
      fs.writeFileSync(A, 'export const a = 1\n')
      fs.writeFileSync(B, 'export const b = 2\n')
      writeQueue(DIR, [A, B])

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`

      expect(() =>
        drainOnce(DIR, (p) => {
          if (p === B) throw new Error('simulated crash mid-batch')
        }),
      ).toThrow('simulated crash mid-batch')

      // Pre-fix, the claimed .draining file was already removed before processDirtyBatch ran,
      // so it would be gone here even though the batch never finished.
      expect(fs.existsSync(drainingPath)).toBe(true)

      // A later drain (simulating a restart after the crash) must still recover both paths.
      const indexed: string[] = []
      const count = drainOnce(DIR, (p) => indexed.push(p))
      expect(count).toBe(2)
      expect(indexed).toEqual([A, B])
      expect(fs.existsSync(drainingPath)).toBe(false)
    })

    it('does not lose recovered .draining paths when processing crashes mid-batch (stage a)', () => {
      // Same regression as above, exercised via the crash-recovery path: an abandoned .draining
      // file (from a previous crashed drain) must also survive a crash during ITS OWN
      // processDirtyBatch run, rather than being deleted up front.
      const C = path.join(DIR, 'c.ts')
      const D = path.join(DIR, 'd.ts')
      fs.writeFileSync(C, 'export const c = 3\n')
      fs.writeFileSync(D, 'export const d = 4\n')

      const queuePath = path.join(DIR, 'queue', 'dirty.txt')
      const drainingPath = `${queuePath}.draining`
      fs.mkdirSync(path.dirname(drainingPath), { recursive: true })
      fs.writeFileSync(drainingPath, `${C}\n${D}\n`)

      expect(() =>
        drainOnce(DIR, (p) => {
          if (p === D) throw new Error('simulated crash mid-recovery-batch')
        }),
      ).toThrow('simulated crash mid-recovery-batch')

      expect(fs.existsSync(drainingPath)).toBe(true)

      const indexed: string[] = []
      const count = drainOnce(DIR, (p) => indexed.push(p))
      expect(count).toBe(2)
      expect(indexed).toEqual([C, D])
      expect(fs.existsSync(drainingPath)).toBe(false)
    })
  })
})

// Regression: makeIndexer's catch block used to swallow a genuine indexFileSync failure with
// zero logging anywhere, and the caught exception's implicit `undefined` return was `!== false`,
// so processDirtyBatch counted the failed file as successfully indexed and dequeued it from the
// dirty queue forever -- no error surfaced anywhere, and the file's index silently went stale
// for good. This drives the real shipping path: `drainOnce(DIR)` with NO injected index/remove
// callbacks, so the actual default `makeIndexer` -> `indexFileSync` pipeline runs. Only
// `indexFileSync` itself is mocked (genuinely throwing for one specific path, genuinely calling
// through to the real implementation for the other), which is the narrowest possible seam for
// deterministic failure injection -- the orchestration under test (makeIndexer,
// processDirtyBatch, drainOnce) is entirely real.
describe('makeIndexer failure handling (regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs a swallowed indexFileSync failure, does not count it as indexed, and still indexes the rest of the batch', () => {
    const realIndexFileSync = parserModule.indexFileSync
    const good = path.join(DIR, 'good.ts')
    const bad = path.join(DIR, 'bad.ts')
    fs.writeFileSync(good, 'export function knownGoodSymbol(): number {\n  return 1\n}\n')
    fs.writeFileSync(bad, 'export function neverIndexedSymbol(): number {\n  return 2\n}\n')
    writeQueue(DIR, [good, bad])

    vi.spyOn(parserModule, 'indexFileSync').mockImplementation((filePath, dbPath) => {
      if (filePath === bad) throw new Error('simulated parse failure')
      return realIndexFileSync(filePath, dbPath)
    })

    const projectDb = path.join(DIR, 'global.db')
    try {
      // (b) Batch isolation: one bad file must not abort the rest of the batch.
      const count = drainOnce(DIR)
      // (c) The failed file must not be counted as a successful index.
      expect(count).toBe(1)
      expect(
        querySymbols({ name: 'knownGoodSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)
      expect(querySymbols({ name: 'neverIndexedSymbol', limit: 10 }, projectDb).length).toBe(0)

      // (a) The swallowed failure must be surfaced somewhere discoverable: the worker's error
      // log, since the detached worker process's stdio is discarded (startDetachedWorker uses
      // `stdio: 'ignore'`) and nothing in this file otherwise logs anything.
      const logPath = path.join(DIR, 'worker-errors.log')
      expect(fs.existsSync(logPath)).toBe(true)
      const logContent = fs.readFileSync(logPath, 'utf8')
      expect(logContent).toContain(bad)
      expect(logContent).toContain('simulated parse failure')
    } finally {
      closeDb(projectDb)
    }
  })
})

// Regression: makeIndexer committed files.sha via indexFileSync, then fired
// indexFileEmbeddings without awaiting it (fire-and-forget). If the daemon died mid-embedding,
// or the embed call threw (previously swallowed with nothing to show for it), the sha was
// already stamped current, so the next touch of IDENTICAL content got sha-gate-skipped forever
// -- chunks stayed stale/missing permanently, with no way to recover short of deleting the
// index. files.embed_sha now tracks embedding freshness separately from files.sha (parse
// freshness): it is only stamped after indexFileEmbeddings actually commits successfully (see
// its doc comment in parser.ts), and makeIndexer's gate re-triggers embedding whenever
// embed_sha !== sha, even when the parse-sha gate above it skipped the reparse entirely. This
// drives the real default drain path (drainOnce(DIR), no injected index callback); only
// indexFileEmbeddings itself is mocked (throwing once to simulate the crash/error, then
// delegating to the real implementation), the narrowest seam for deterministic failure
// injection -- makeIndexer/processDirtyBatch/drainOnce and indexFileSync are entirely real.
describe('makeIndexer embed-freshness gate (regression)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries embedding on the next touch of unchanged content after a simulated embedding crash', async () => {
    const realIndexFileEmbeddings = parserModule.indexFileEmbeddings
    const src = path.join(DIR, 'embed-crash.ts')
    fs.writeFileSync(src, 'export function embedCrashSymbol(): number {\n  return 9\n}\n')
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')

    const embedSpy = vi
      .spyOn(parserModule, 'indexFileEmbeddings')
      .mockImplementationOnce(() => Promise.reject(new Error('simulated embedding crash')))

    try {
      // First drain: indexFileSync succeeds (real), but the embedding step throws. The
      // syntactic index must still succeed -- an embeddings-only failure never fails the
      // overall index -- and embed_sha must be left unstamped (stale/empty) rather than
      // wrongly marked current.
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(embedSpy).toHaveBeenCalledTimes(1)
      expect(
        querySymbols({ name: 'embedCrashSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)
      expect(getFileEntry(norm, projectDb)?.embedSha).toBe('')
      // Let the first (rejected) embed call's promise chain settle and clear itself from
      // worker.ts's per-file in-flight map (embedFileSerialized) before the second drain --
      // otherwise this second drain would be legitimately treated as overlapping the still
      // in-flight first call and chained behind it rather than dispatched immediately.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Second drain of the SAME, byte-identical file: the parse-sha gate alone would skip it
      // entirely (pre-fix behaviour), permanently losing the embedding retry. With the fix,
      // embed_sha (still empty) !== sha, so embedding must be retried even though the parse
      // step is correctly skipped.
      embedSpy.mockImplementation((filePath, dbPath, sha) => realIndexFileEmbeddings(filePath, dbPath, sha))
      writeQueue(DIR, [norm])
      drainOnce(DIR)
      expect(embedSpy).toHaveBeenCalledTimes(2)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression (#5): indexFileEmbeddings (parser.ts) returned before ever reaching the
  // embed_sha UPDATE when indexing.embeddings_enabled is false, so embed_sha was left stale/empty
  // forever. That meant embedUnchanged (this gate, above) could never hold for these files: every
  // re-touch of byte-identical content re-entered indexFileEmbeddings just to hit the same
  // early-return again, on every drain, for as long as embeddings stayed disabled -- harmless
  // correctness-wise, but wasted work.
  //
  // The fix stamps embed_sha with a disabled-marker form of the sha (disabledEmbedSha(sha), NOT
  // the bare sha) on the disabled early-return, and this gate now compares against that same
  // marker form while disabled. Stamping the bare sha directly (the naive fix) would have been
  // indistinguishable from a real successful embed: re-enabling embeddings later for the same
  // unchanged content would then wrongly look "already embedded" and permanently skip its real
  // first embed -- the second test below proves that scenario specifically. Drives the real
  // default drain path (drainOnce(DIR), no injected index callback); only indexFileEmbeddings is
  // spied (call-through, not mocked) to count invocations without altering its real behaviour.
  it('stamps a disabled-marker embed_sha while embeddings are disabled, so a second reindex of unchanged content short-circuits via the gate', () => {
    const src = path.join(DIR, 'embed-disabled.ts')
    fs.writeFileSync(src, 'export function embedDisabledSymbol(): number {\n  return 3\n}\n')
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')

    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [] },
      indexing: { embeddings_enabled: false, skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
    } as unknown as ReturnType<typeof loadConfig>)

    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')

    try {
      // First drain: symbols index normally; indexFileEmbeddings is invoked once but no-ops
      // (embeddings disabled) other than stamping the disabled-marker embed_sha.
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(embedSpy).toHaveBeenCalledTimes(1)
      expect(
        querySymbols({ name: 'embedDisabledSymbol', limit: 10 }, projectDb).length,
      ).toBe(1)

      const entry = getFileEntry(norm, projectDb)
      expect(entry?.sha).toBe('d2b91fcdbf299a026bf4785fc440ce1467c8707d6fb624de247f962a2a846d17')
      expect(entry?.embedSha).toBe(parserModule.disabledEmbedSha(entry?.sha ?? ''))
      // Never the bare sha: that would be indistinguishable from a real successful embed.
      expect(entry?.embedSha).not.toBe(entry?.sha)

      // Second drain of the SAME, byte-identical file, still disabled: parseUnchanged AND
      // embedUnchanged both now hold, so makeIndexer must short-circuit entirely without
      // invoking indexFileEmbeddings again.
      writeQueue(DIR, [norm])
      drainOnce(DIR)
      expect(embedSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeDb(projectDb)
    }
  })

  it('re-embeds unchanged content on the next touch after embeddings are re-enabled, instead of being masked by a disabled-marker embed_sha from an earlier disabled run (fail-on-buggy: stamping the bare sha while disabled would make this look "already embedded" forever)', async () => {
    const src = path.join(DIR, 'embed-reenabled.ts')
    fs.writeFileSync(src, 'export function embedReenabledSymbol(): number {\n  return 4\n}\n')
    const norm = normalizePath(src)
    const projectDb = path.join(DIR, 'global.db')

    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')

    try {
      // First drain with embeddings disabled: only the disabled-marker embed_sha gets stamped.
      vi.mocked(loadConfig).mockReturnValue({
        worker: { blocked_roots: [] },
        indexing: { embeddings_enabled: false, skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
      } as unknown as ReturnType<typeof loadConfig>)
      writeQueue(DIR, [norm])
      expect(drainOnce(DIR)).toBe(1)
      expect(embedSpy).toHaveBeenCalledTimes(1)
      const afterDisabled = getFileEntry(norm, projectDb)
      expect(afterDisabled?.embedSha).toBe(parserModule.disabledEmbedSha(afterDisabled?.sha ?? ''))
      // Let the first embed call's promise chain settle and clear itself from worker.ts's
      // per-file in-flight map (embedFileSerialized) before the second drain -- otherwise this
      // second drain would be legitimately treated as overlapping the still in-flight first
      // call and chained behind it rather than dispatched immediately.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      // Second drain of the SAME, byte-identical file, now with embeddings enabled: the gate
      // must NOT treat the disabled-marker embed_sha as a match for a real sha comparison --
      // indexFileEmbeddings must be invoked again so the file actually gets embedded.
      vi.mocked(loadConfig).mockReturnValue({
        worker: { blocked_roots: [] },
        indexing: { embeddings_enabled: true, skip_dirs: [], skip_files: [], large_file_skip_kb: 1048576, large_file_symbol_only_kb: 1048576 },
      } as unknown as ReturnType<typeof loadConfig>)
      writeQueue(DIR, [norm])
      drainOnce(DIR)
      expect(embedSpy).toHaveBeenCalledTimes(2)
    } finally {
      closeDb(projectDb)
    }
  })

  // Regression: two drains of a rapidly re-edited file could spawn two concurrent
  // indexFileEmbeddings promises for the same path (makeIndexer fires embedding off without
  // awaiting it, by design -- see its doc comment). If the OLDER call (started first, with
  // now-stale content) happened to finish AFTER the newer one, its stale chunks/vectors
  // silently overwrote the fresher ones -- last-writer-wins, self-correcting only on the NEXT
  // edit. The fix chains same-file embed calls onto one another so they always settle in
  // submission order. Drives the real default drain path (drainOnce(DIR), no injected index
  // callback -- makeIndexer's actual production wiring); only indexFileEmbeddings itself is
  // mocked, with each call's completion under this test's explicit control, so the assertions
  // prove the ORDER the production code dispatches and resolves the two calls in, not any
  // artifact of the mock's own timing.
  it('serializes concurrent embedding calls for the same file so a slower older call cannot overwrite a faster newer one', async () => {
    const src = path.join(DIR, 'embed-race.ts')
    fs.writeFileSync(src, 'export function embedRaceV1(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)

    const invocations: string[] = []
    const commits: string[] = []
    const pendingResolvers = new Map<string, () => void>()

    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')
    embedSpy.mockImplementation((_filePath, _dbPath, sha) => {
      const label = sha ?? ''
      invocations.push(label)
      return new Promise<void>((resolve) => {
        pendingResolvers.set(label, () => {
          commits.push(label)
          resolve()
        })
      })
    })

    // First drain: v1 content (sha1). Its embed call is dispatched but deliberately left
    // pending -- nothing resolves it yet. The dispatch itself is chained through a `.then()` (a
    // microtask, even off an already-resolved "no prior call" base promise), so flush one tick
    // before checking invocations.
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)
    await Promise.resolve()
    expect(invocations.length).toBe(1)
    const sha1 = invocations[0]

    // Second drain: rewrite to v2 content (a different sha) while the first embed call for
    // sha1 is still in flight -- simulates a rapid re-edit racing an in-flight embed of the
    // now-stale content.
    fs.writeFileSync(src, 'export function embedRaceV2(): number {\n  return 2\n}\n')
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)
    await Promise.resolve()
    await Promise.resolve()

    // With serialization, the second call must not even be dispatched to indexFileEmbeddings
    // yet -- it is chained behind the still-pending first call, not racing it concurrently.
    expect(invocations).toEqual([sha1])

    // Resolving the first (older) call is what unblocks the second -- proving a chain, not an
    // independent race, governs dispatch order.
    pendingResolvers.get(sha1)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(invocations.length).toBe(2)
    const sha2 = invocations[1]
    expect(sha2).not.toBe(sha1)

    pendingResolvers.get(sha2)!()
    await Promise.resolve()

    // Final commit order must be submission order: sha1 (older, submitted and resolved first)
    // then sha2 (newer, resolved last) -- never the reverse, which would mean the fresher
    // content lost to stale content.
    expect(commits).toEqual([sha1, sha2])
  })

  // Regression (mutation-testing gap): embedFileSerialized's cleanup only deletes the
  // inFlightEmbeddings map entry for a settling call when that call is STILL the current entry
  // -- an older call's cleanup running after a newer call has already replaced the map entry
  // must be a no-op, not an unconditional delete. Exercises a THREE-generation chain (the
  // two-generation test above cannot distinguish this: with only two calls, the older one's
  // cleanup fires after the test has already finished asserting). Here, call1 resolves while
  // call2 is still pending, which is exactly the point where call1's cleanup handler runs
  // against a map entry that already names call2 -- and a THIRD edit arriving right after must
  // still see call2 as `prior` and chain behind it, not race it, to prove the map entry for
  // call2 survived call1's cleanup.
  it('does not let an older call\'s cleanup delete a newer call\'s still-in-flight map entry out from under a third, later call', async () => {
    const src = path.join(DIR, 'embed-race3.ts')
    fs.writeFileSync(src, 'export function embedRace3V1(): number {\n  return 1\n}\n')
    const norm = normalizePath(src)

    const invocations: string[] = []
    const pendingResolvers = new Map<string, () => void>()
    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')
    embedSpy.mockImplementation((_filePath, _dbPath, sha) => {
      const label = sha ?? ''
      invocations.push(label)
      return new Promise<void>((resolve) => {
        pendingResolvers.set(label, resolve)
      })
    })

    // v1: dispatched immediately (no prior call).
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)
    await Promise.resolve()
    expect(invocations.length).toBe(1)
    const sha1 = invocations[0]

    // v2: chained behind v1, not yet dispatched.
    fs.writeFileSync(src, 'export function embedRace3V2(): number {\n  return 2\n}\n')
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)
    await Promise.resolve()
    expect(invocations).toEqual([sha1])

    // Resolve v1 -- this is what dispatches v2 AND fires v1's own cleanup handler. Flush
    // several ticks so both settle before the third edit arrives.
    pendingResolvers.get(sha1)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(invocations.length).toBe(2)
    const sha2 = invocations[1]

    // v3: v2 is still pending (unresolved). If v1's cleanup wrongly deleted the map entry for
    // v2, this third call would see no `prior` and dispatch immediately, racing v2 instead of
    // chaining behind it.
    fs.writeFileSync(src, 'export function embedRace3V3(): number {\n  return 3\n}\n')
    writeQueue(DIR, [norm])
    expect(drainOnce(DIR)).toBe(1)
    await Promise.resolve()
    await Promise.resolve()

    // v3 must NOT have been dispatched yet -- it is chained behind the still-pending v2, not
    // racing it concurrently.
    expect(invocations).toEqual([sha1, sha2])

    // Let v2 and v3 settle so this test's own promises don't dangle.
    pendingResolvers.get(sha2)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(invocations.length).toBe(3)
    pendingResolvers.get(invocations[2])!()
    await Promise.resolve()
  })

  // Regression (#250): inFlightEmbeddings above only serializes duplicate work on the SAME
  // file -- a dirty batch of N distinct changed files previously fired N concurrent
  // indexFileEmbeddings pipelines with no global cap at all. The fix routes every embed call
  // through a global slot counter honoring config.worker.max_pool_workers, queuing callers
  // beyond the cap instead of firing them all at once. Drives the real default drain path
  // (drainOnce(DIR), no injected index callback -- makeIndexer's actual production wiring);
  // only indexFileEmbeddings is mocked, with each call's completion under this test's explicit
  // control, so the assertions prove the production code never dispatches more than the
  // configured cap concurrently, not an artifact of the mock's own timing.
  it('caps concurrent embedding pipelines across different files at worker.max_pool_workers, queuing the rest', async () => {
    // Reset worker.ts's process-wide embed-slot counter: an earlier test in this file may have
    // dispatched a real (unresolved-by-test-end) embed call without awaiting it to settle,
    // which would otherwise leave activeEmbedSlots polluted going into this test.
    clearModuleCaches()
    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [], max_pool_workers: 2 },
    } as unknown as ReturnType<typeof loadConfig>)

    const files = ['cap-a.ts', 'cap-b.ts', 'cap-c.ts'].map((name, i) => {
      const p = path.join(DIR, name)
      fs.writeFileSync(p, `export function capFn${i}(): number {\n  return ${i}\n}\n`)
      return normalizePath(p)
    })

    const invoked: string[] = []
    const pendingResolvers = new Map<string, () => void>()
    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')
    embedSpy.mockImplementation((filePath) => {
      invoked.push(filePath)
      return new Promise<void>((resolve) => {
        pendingResolvers.set(filePath, resolve)
      })
    })

    writeQueue(DIR, files)
    expect(drainOnce(DIR)).toBe(3)

    // makeIndexer fires embedding fire-and-forget with no `await` in the drain loop, and
    // embedFileSerialized dispatches synchronously (no microtask hop) whenever a slot is
    // immediately free -- so with a cap of 2, only the first two of these three distinct files
    // are dispatched to indexFileEmbeddings inline within drainOnce itself. The third is
    // queued behind the cap, not fired concurrently, with no await needed to observe this.
    expect(invoked.length).toBe(2)
    expect(invoked).toEqual([files[0], files[1]])

    // Resolving one of the two in-flight calls frees a slot for the third, queued file.
    pendingResolvers.get(files[0])!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(invoked.length).toBe(3)
    expect(invoked).toContain(files[2])

    // Let the remaining in-flight calls settle so this test's own promises don't dangle.
    pendingResolvers.get(files[1])!()
    pendingResolvers.get(files[2])!()
    await Promise.resolve()
  })

  // Regression: the release closure attached to an already-dispatched embed survived the reset
  // that zeroed the counter it decrements. When that stale call settled it took the fresh counter
  // negative, and a negative count means `activeEmbedSlots < limit` stays true for one extra
  // caller per stale task -- so the global cap this gate exists to enforce was quietly loosened
  // for the rest of the process. Drives the real drain path with only indexFileEmbeddings spied.
  it('a pre-reset embed settling later does not loosen the cap for work dispatched after the reset', async () => {
    clearModuleCaches()
    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [], max_pool_workers: 1 },
    } as unknown as ReturnType<typeof loadConfig>)

    const files = ['epoch-a.ts', 'epoch-b.ts', 'epoch-c.ts'].map((name, i) => {
      const p = path.join(DIR, name)
      fs.writeFileSync(p, `export function epochFn${i}(): number {
  return ${i}
}
`)
      return normalizePath(p)
    })

    const invoked: string[] = []
    const pendingResolvers = new Map<string, () => void>()
    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')
    embedSpy.mockImplementation((filePath) => {
      invoked.push(filePath)
      return new Promise<void>((resolve) => {
        pendingResolvers.set(filePath, resolve)
      })
    })

    // One embed in flight, holding the only slot.
    writeQueue(DIR, [files[0] as string])
    expect(drainOnce(DIR)).toBe(1)
    expect(invoked).toEqual([files[0]])

    clearModuleCaches()

    // The stale call settles after the reset. Its release must be a no-op now.
    pendingResolvers.get(files[0] as string)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Two fresh files, cap of 1: exactly one may dispatch. A counter left at -1 by the stale
    // release would admit both.
    writeQueue(DIR, [files[1] as string, files[2] as string])
    expect(drainOnce(DIR)).toBe(2)
    expect(
      invoked.slice(1),
      'the cap admitted more than max_pool_workers after a pre-reset embed settled',
    ).toEqual([files[1]])

    pendingResolvers.get(files[1] as string)!()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(invoked.slice(1)).toEqual([files[1], files[2]])
    pendingResolvers.get(files[2] as string)!()
    await Promise.resolve()
  })

  // Regression: the reset registered beside the slot counter cleared the counter and the waiter
  // queue but not inFlightEmbeddings. A call queued behind the cap returns a promise whose only
  // way to settle is the closure sitting in that queue, so discarding the queue orphaned the
  // promise: its cleanup never ran, its map entry never cleared, and pendingEmbeddings() -- which
  // waits on exactly those values -- never resolved. A later test awaiting it hung until the
  // suite timeout, which reads as a flake rather than as this test leaving state behind. Drives
  // the real drain path, same as the cap test above; only indexFileEmbeddings is mocked.
  it('clearModuleCaches leaves pendingEmbeddings resolvable after discarding a queued embed call', async () => {
    clearModuleCaches()
    vi.mocked(loadConfig).mockReturnValue({
      worker: { blocked_roots: [], max_pool_workers: 1 },
    } as unknown as ReturnType<typeof loadConfig>)

    const files = ['reset-a.ts', 'reset-b.ts'].map((name, i) => {
      const p = path.join(DIR, name)
      fs.writeFileSync(p, `export function resetFn${i}(): number {
  return ${i}
}
`)
      return normalizePath(p)
    })

    const invoked: string[] = []
    const pendingResolvers = new Map<string, () => void>()
    const embedSpy = vi.spyOn(parserModule, 'indexFileEmbeddings')
    embedSpy.mockImplementation((filePath) => {
      invoked.push(filePath)
      return new Promise<void>((resolve) => {
        pendingResolvers.set(filePath, resolve)
      })
    })

    writeQueue(DIR, files)
    expect(drainOnce(DIR)).toBe(2)
    // With a cap of 1 the second file is queued, never dispatched -- exactly the state whose
    // tracking the reset has to drop along with the queue it depends on.
    expect(invoked).toEqual([files[0]])

    clearModuleCaches()

    const outcome = await Promise.race([
      pendingEmbeddings().then(() => 'resolved'),
      new Promise((resolve) => {
        setTimeout(() => resolve('hung'), 2000)
      }),
    ])
    expect(
      outcome,
      'pendingEmbeddings() never resolved: the reset dropped the waiter queue but kept the map entry waiting on it',
    ).toBe('resolved')

    pendingResolvers.get(files[0])!()
    await Promise.resolve()
  })
})

// Regression (mutation-testing gap): the loop body re-checks shouldStop() immediately after the
// drain/housekeeping work, BEFORE the setTimeout poll-interval sleep, so a stop request that
// arrives mid-cycle exits right away instead of waiting out one more full pollIntervalMs sleep
// for nothing. Without that second check, the loop always sleeps once more before the next
// `while (!shouldStop())` iteration catches it -- a real, measurable shutdown-latency regression
// for a caller (e.g. stopWorker's own SIGTERM-driven exit path) that wants the daemon to stop
// promptly. Uses a deliberately large pollIntervalMs and asserts on wall-clock elapsed time so a
// wasted sleep is unambiguous rather than lost in test-runner jitter.
describe('runWorkerLoop prompt-stop (mutation-testing gap)', () => {
  it('stops immediately after the loop body when told to, without waiting out one more poll interval', async () => {
    let calls = 0
    const shouldStop = (): boolean => {
      calls += 1
      return calls > 1
    }
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    let resolved = false
    // Await the loop's own promise chain (drainOnce + housekeeping are synchronous/microtask
    // work) without ever advancing real or fake time: if the second shouldStop() check is
    // skipped, the loop falls through to `setTimeout(resolve, pollIntervalMs)` and this would
    // never resolve without a 2000ms timer advance -- proving the behavior directly instead of
    // inferring it from a wall-clock bound.
    void runWorkerLoop(DIR, 2000, shouldStop).then(() => {
      resolved = true
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(resolved).toBe(true)
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })
})

// Regression: runWorkerLoop never checked whether its own data dir still existed, so a detached
// daemon spawned against an ephemeral/scratch directory (e.g. `index --walk` in a temp dir during
// dogfooding, or a test that never called `worker stop`) ran forever once that directory was
// deleted out from under it -- confirmed in practice as 524 stray `--worker-daemon` processes
// accumulated over two weeks. `shouldStop` here always returns false (mirroring a real daemon,
// which has no external stop signal until `worker stop` sends SIGTERM), so the only thing that
// can end this loop is the new self-existence check.
describe('runWorkerLoop self-terminates when its data dir is deleted (regression)', () => {
  it('exits on its own once the data dir no longer exists, even though shouldStop never fires', async () => {
    const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-worker-orphan-'))
    try {
      const loopPromise = runWorkerLoop(scratchDir, 5, () => false)
      // Give the loop one tick to start, then delete the directory it's polling.
      await new Promise<void>((resolve) => setTimeout(resolve, 15))
      // Both `lastSnapshotCleanupMs`/`lastKnownRootsSweepMs` start at 0, so the very first loop
      // iteration always fires the known-roots sweep too, which opens (and caches) a
      // better-sqlite3 connection to `${scratchDir}/global.db` -- release it first, same as this
      // file's own afterEach does for DIR, or the still-open native handle makes the directory
      // removal below fail with EPERM on Windows.
      closeDb(path.join(scratchDir, 'global.db'))
      // maxRetries/retryDelay: Windows can transiently EPERM a recursive rmSync on a directory
      // whose contents a background process (this test's own runWorkerLoop, still mid-cycle)
      // just touched -- retry rather than flake.
      fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })

      const timeout = new Promise<string>((resolve) =>
        setTimeout(() => resolve('timeout'), 2000),
      )
      const result = await Promise.race([loopPromise.then(() => 'stopped'), timeout])
      expect(result).toBe('stopped')
    } finally {
      // Best-effort: the test body above already removed scratchDir; a second removal attempt
      // can spuriously EPERM on Windows (transient AV/handle lock on an already-deleted temp
      // dir) and must not mask the assertion result above.
      try {
        fs.rmSync(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // ignore
      }
    }
  })
})

// Regression: cleanup_session/cleanup_stale existed in snapshots.ts but nothing ever called
// them -- session_snapshots/<sessionId>/ directories accumulated forever. runWorkerLoop now
// sweeps stale session snapshots on the same periodic loop as the dirty-queue drain. This drives
// the real default path (no injected cleanup callback, the shipping path) end-to-end: write a
// snapshot, backdate its mtime past cleanup_stale's 24h staleness window, run one real loop
// cycle, and assert the stale snapshot was actually removed from disk.
describe('runWorkerLoop stale-snapshot sweep (regression)', () => {
  it('sweeps a stale session snapshot via the default periodic loop', async () => {
    const result = store('worker-loop-stale-sweep', 'file.ts', Buffer.from('code'))
    expect(result).not.toBeNull()
    if (!result) return

    const staleTime = new Date(Date.now() - 25 * 3600 * 1000)
    fs.utimesSync(result.path, staleTime, staleTime)
    expect(fs.existsSync(result.path)).toBe(true)

    // Stop after the loop body (drain + sweep) has run exactly once, before it sleeps.
    let calls = 0
    const shouldStop = (): boolean => {
      calls += 1
      return calls > 1
    }
    await runWorkerLoop(DIR, 5, shouldStop)

    expect(fs.existsSync(result.path)).toBe(false)
  })
})

// Regression: worker-errors.log had no rotation mechanism -- it could grow unbounded over a
// project's index lifetime. runWorkerLoop now rotates it via cleanupWorkerStateFiles on the same
// periodic sweep as cleanup_stale above. This drives the real default path end-to-end: write an
// oversized worker-errors.log, run one real loop cycle, and assert it was actually rotated.
describe('runWorkerLoop worker state file rotation (regression)', () => {
  it('rotates an oversized worker-errors.log via the default periodic loop', async () => {
    const logPath = path.join(DIR, 'worker-errors.log')
    fs.writeFileSync(logPath, 'x'.repeat(6 * 1024 * 1024))

    let calls = 0
    const shouldStop = (): boolean => {
      calls += 1
      return calls > 1
    }
    await runWorkerLoop(DIR, 5, shouldStop)

    const statAfter = fs.statSync(logPath)
    expect(statAfter.size).toBeLessThan(6 * 1024 * 1024)
  })
})

// Regression (mutation-testing gap): cleanupWorkerStateFiles' `.corrupt-*` quarantine cleanup
// half had zero test coverage, even end-to-end -- only the worker-errors.log rotation half was
// exercised above. A mutation removing the `.corrupt-` filter entirely (so every file in the
// queue dir, corrupt-marked or not, becomes eligible for age-based deletion) still passed the
// full suite. That's a real production risk: cleanupWorkerStateFiles runs periodically inside
// runWorkerLoop, in the same directory as the live dirty queue and drain-heartbeat marker.
describe('cleanupWorkerStateFiles quarantine-file cleanup (mutation-testing gap)', () => {
  const queueDirFor = (dir: string): string => path.join(dir, 'queue')

  it('removes a `.corrupt-*` quarantine file older than the max age', () => {
    const queueDir = queueDirFor(DIR)
    fs.mkdirSync(queueDir, { recursive: true })
    const corruptPath = path.join(queueDir, 'dirty.txt.draining.corrupt-123')
    fs.writeFileSync(corruptPath, 'stale quarantined content')
    const oldTime = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(corruptPath, oldTime, oldTime)

    cleanupWorkerStateFiles(DIR)

    expect(fs.existsSync(corruptPath)).toBe(false)
  })

  it('keeps a `.corrupt-*` quarantine file younger than the max age', () => {
    const queueDir = queueDirFor(DIR)
    fs.mkdirSync(queueDir, { recursive: true })
    const corruptPath = path.join(queueDir, 'dirty.txt.draining.corrupt-456')
    fs.writeFileSync(corruptPath, 'recent quarantined content')

    cleanupWorkerStateFiles(DIR)

    expect(fs.existsSync(corruptPath)).toBe(true)
  })

  it('never removes a non-quarantine file in the queue dir, no matter how old', () => {
    const queueDir = queueDirFor(DIR)
    fs.mkdirSync(queueDir, { recursive: true })
    const liveQueuePath = dirtyQueuePathFor(DIR)
    fs.writeFileSync(liveQueuePath, '/still/live/file.ts\n')
    const oldTime = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000
    fs.utimesSync(liveQueuePath, oldTime, oldTime)

    cleanupWorkerStateFiles(DIR)

    expect(fs.existsSync(liveQueuePath)).toBe(true)
  })
})

// Regression: before this, pruneDeletedFiles only ever ran via the manual `token-goat index`
// CLI command -- nothing periodic pruned the shared global.db, so it could accumulate dead file
// rows indefinitely. runWorkerLoop now runs sweepKnownRoots on the same periodic-sweep
// mechanism as the snapshot cleanup above. Drives the real default path end-to-end: index a
// file, record its project root as known, delete the file, run one real loop cycle, and assert
// its rows were actually pruned.
describe('runWorkerLoop known-roots auto-prune sweep (regression)', () => {
  it('prunes dead rows for a known root via the default periodic loop', async () => {
    fs.mkdirSync(path.join(DIR, '.git'))
    const dbPath = path.join(DIR, 'global.db')
    const aPath = path.join(DIR, 'a.ts')
    fs.writeFileSync(aPath, 'export const a = 1\n')
    const aKey = normalizePath(aPath)
    parserModule.indexFileSync(aKey, dbPath)
    recordKnownRoot(aKey, dbPath)
    fs.rmSync(aPath)

    const db = getDb(dbPath)
    const symbolCountFor = (key: string): number =>
      (db.prepare('SELECT COUNT(*) AS n FROM symbols WHERE file_path = ?').get(key) as { n: number }).n
    expect(symbolCountFor(aKey)).toBe(1)

    let calls = 0
    const shouldStop = (): boolean => {
      calls += 1
      return calls > 1
    }
    await runWorkerLoop(DIR, 5, shouldStop)

    expect(symbolCountFor(aKey)).toBe(0)
  })
})

describe('resolvePollIntervalMs', () => {
  const saved = process.env['TG_WORKER_POLL_MS']
  afterEach(() => {
    if (saved === undefined) delete process.env['TG_WORKER_POLL_MS']
    else process.env['TG_WORKER_POLL_MS'] = saved
  })

  it('prefers an explicit caller value over the environment', () => {
    process.env['TG_WORKER_POLL_MS'] = '777'
    expect(resolvePollIntervalMs(123)).toBe(123)
  })

  // The regression: startDetachedWorker skipped the env entirely and wrote the default straight
  // into the child's environment, so TG_WORKER_POLL_MS was inert on the one path that starts a
  // real daemon, even though the daemon itself reads that exact variable.
  it('falls back to TG_WORKER_POLL_MS when the caller passed nothing', () => {
    process.env['TG_WORKER_POLL_MS'] = '777'
    expect(resolvePollIntervalMs()).toBe(777)
  })

  it('falls back to the 2000ms default when the variable is unset', () => {
    delete process.env['TG_WORKER_POLL_MS']
    expect(resolvePollIntervalMs()).toBe(2000)
  })

  it.each(['', '   ', 'soon', '0', '-1', 'NaN'])(
    'ignores %j rather than polling at a nonsense interval',
    (raw) => {
      process.env['TG_WORKER_POLL_MS'] = raw
      expect(resolvePollIntervalMs()).toBe(2000)
    },
  )
})

// Regression: the id-keyed disk caches had no automatic reaper. storeBlob prunes the subdir it
// just wrote, but session state is written outside that funnel (session_store.ts writes through
// sessionPath, not storeBlob), so ~/.token-goat/sessions grew without any bound -- 83k files on
// the author's machine, which every hook that lists sibling session states then had to readdir
// past. runWorkerLoop now calls sweepCacheRoots on the same periodic sweep as the snapshot
// cleanup. This drives the real default path end-to-end (no injected sweep callback): write a
// stale session blob, run one real loop cycle, and assert it was actually removed from disk.
describe('runWorkerLoop cache sweep (regression)', () => {
  it('ages out a stale session blob via the default periodic loop', async () => {
    const sessionsDir = path.join(tokenGoatHome(), 'sessions')
    fs.mkdirSync(sessionsDir, { recursive: true })
    const stalePath = path.join(sessionsDir, 'worker-loop-stale-session.json')
    const freshPath = path.join(sessionsDir, 'worker-loop-live-session.json')
    fs.writeFileSync(stalePath, '{}')
    fs.writeFileSync(freshPath, '{}')
    const staleTime = new Date(Date.now() - 25 * 3600 * 1000)
    fs.utimesSync(stalePath, staleTime, staleTime)

    // Stop after the loop body (drain + sweep) has run exactly once, before it sleeps.
    let calls = 0
    const shouldStop = (): boolean => {
      calls += 1
      return calls > 1
    }
    await runWorkerLoop(DIR, 5, shouldStop)

    expect(fs.existsSync(stalePath)).toBe(false)
    // A live session's blob is rewritten on every hook, so a fresh mtime means the conversation is
    // still going: the sweep must never take it.
    expect(fs.existsSync(freshPath)).toBe(true)
  })
})
