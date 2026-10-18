// Provenance: HAND-DERIVED for the file contents and symbol names. The daemon is the built bundle started the way tests/worker_retire_e2e.test.ts starts it (`--worker-daemon`, poll interval and data directory in TG_WORKER_POLL_MS / TG_WORKER_DATA_DIR, the pid file written by the caller as startDetachedWorker does); the index and the indexed-on-purpose mark come from the bundle's own `index .`, and the request from the production writer.
/** The shipped worker sweeps a reconcile request. CLAUDE.md "Critical path": a release once shipped a worker that drained into a stub, with a green suite, because every worker test injected its own callback and nothing ran the built bundle. This runs `dist/token-goat.mjs --worker-daemon` on an isolated home against a repository whose file drifted, and waits for the drifted file's symbol to reach the index. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { appendReconcileRequest, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { querySymbols } from '../src/index_reader.js'
import { killProcessTree } from '../src/process_tree.js'
import { drainHeartbeatPathFor, workerErrorLogPath, workerPidPath } from '../src/worker_lifecycle.js'
import { BUNDLE, bundleTg, makeBundleProject } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { openGitGate, type GitGate } from './helpers/git_gate.js'
import { stopOwnedChild } from './helpers/stop_owned_child.js'
import { indexableDir } from './helpers/temp-config.js'

const OLD_SYMBOL = 'bundleDriftOldSym'
const NEW_SYMBOL = 'bundleDriftNewerSym'
/** Defined in a file that is committed after the index was built, so the index holds no row for it and only the sweep's listing of the tracked files can name it. */
const ADDED_SYMBOL = 'bundleDriftAddedSym'
const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

const roots: string[] = []
const daemons: ChildProcess[] = []
const gates: GitGate[] = []

/** A daemon still running when the test ends (its body threw, or the test timed out before the body's own stop ran) is ended with everything it started, and awaited, before the directory it holds open is removed. */
afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    killProcessTree(daemon.pid)
    await exited
  }
  for (const gate of gates.splice(0)) await gate.dispose()
  closeAllDbs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

/** The daemon's queue files: the live names and every claimed or quarantined variant of them (`.draining`, `.alt-<ts>`, `.corrupt-<ts>`). */
const QUEUE_FILE_PREFIXES = ['dirty.txt', 'reconcile.txt']

/** True while no file of the daemon's work queue is left: the request was claimed and spent, and every file it queued was drained. An unreadable queue directory is not settled. */
function queueSettled(dir: string): boolean {
  try {
    return !fs.readdirSync(path.join(dir, 'queue')).some((name) => QUEUE_FILE_PREFIXES.some((prefix) => name.startsWith(prefix)))
  } catch {
    return false
  }
}

/** The modification stamp of the drain heartbeat, which the daemon rewrites at the end of every drain cycle (src/worker.ts::drainOnce, read this run) whether or not anything was processed; null before the first write. */
function heartbeatStamp(dir: string): number | null {
  try {
    return fs.statSync(drainHeartbeatPathFor(dir)).mtimeMs
  } catch {
    return null
  }
}

interface WaitOptions {
  dir: string
  daemon: ChildProcess
  stderr: () => string
  ready: () => boolean
}

/** Resolves once `ready` holds, re-checking it on every change under `dir` (the daemon rewrites its queue, log and heartbeat files each cycle, and the database on every index). Rejects as soon as the daemon exits first, and as soon as the daemon has finished a drain cycle after the queue settled with `ready` still false: the request is spent and the next cycle ended with nothing left to index, so no later cycle can produce the symbol. The count of heartbeat rewrites, not a clock, decides; a daemon that is alive and silent leaves the wait to the test's own timeout. */
function untilReady({ dir, daemon, stderr, ready }: WaitOptions): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(dir, { recursive: true })
    let lastStamp = heartbeatStamp(dir)
    let beats = 0
    let settledAtBeat: number | null = null
    const finish = (error?: Error): void => {
      watcher.close()
      daemon.off('exit', onExit)
      if (error === undefined) resolve()
      else reject(error)
    }
    const check = (): void => {
      try {
        if (ready()) return finish()
        const stamp = heartbeatStamp(dir)
        if (stamp !== null && stamp !== lastStamp) beats++
        lastStamp = stamp
        if (!queueSettled(dir)) settledAtBeat = null
        else if (settledAtBeat === null) settledAtBeat = beats
        else if (beats > settledAtBeat) finish(new Error(`the daemon finished a drain cycle after the request was spent and the queue emptied, and the symbol is still not indexed; worker log: ${fs.readFileSync(workerErrorLogPath(dir), 'utf8')}`))
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(new Error(`the daemon exited (code ${code}, signal ${signal}) before the symbol was indexed: ${stderr()}`))
    }
    watcher.on('change', check)
    watcher.on('error', (error) => finish(error))
    daemon.once('exit', onExit)
    check()
  })
}

/** The daemon's worker log, empty while it has not written one. */
function workerLog(dir: string): string {
  try {
    return fs.readFileSync(workerErrorLogPath(dir), 'utf8')
  } catch {
    return ''
  }
}

/** Runs a bundle daemon over a project with a drifted file and a file added after the index was built, and waits for both symbols. With a `gate`, every git the daemon starts blocks on it: the daemon's own 5 s limit on its first `rev-parse` ends that git and logs that the project goes back for the next cycle, and only then is the gate released, so the symbols arrive only if the request survived the timeout. */
async function sweepsDriftedProject(gate?: GitGate): Promise<void> {
  const { root, env: base } = makeBundleProject('tg-reconcile-bundle-')
  // Outside the OS temp directory, which the worker does not enqueue files from (see tests/helpers/temp-config.ts::indexableDir); the home and data directories stay under the temp root.
  const project = indexableDir()
  roots.push(root)
  const env = { ...base, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TG_WORKER_POLL_MS: '200' }
  const lib = path.join(project, 'lib.ts')
  fs.writeFileSync(lib, fn(OLD_SYMBOL))
  git(project, 'init', '-q')
  git(project, 'add', '-A')
  git(project, 'commit', '-qm', 'old')
  const indexed = bundleTg(project, env, ['index', '.'])
  expect(indexed.status, `indexing failed: ${indexed.stderr}`).toBe(0)
  const dbPath = findGlobalDb(root)
  expect(dbPath, 'indexing left no global.db under the isolated home').not.toBeNull()
  const dir = path.dirname(dbPath as string)
  expect(querySymbols({ name: OLD_SYMBOL }, dbPath as string), 'calibration: the committed content is indexed').toHaveLength(1)
  fs.writeFileSync(lib, fn(NEW_SYMBOL))
  fs.writeFileSync(path.join(project, 'added.ts'), fn(ADDED_SYMBOL))
  git(project, 'add', 'added.ts')
  git(project, 'commit', '-qm', 'added')
  expect(appendReconcileRequest(dir, project)).toBe(true)

  const daemon = spawn(process.execPath, [BUNDLE, '--worker-daemon'], {
    cwd: os.tmpdir(),
    env: { ...env, ...gate?.env, TG_WORKER_DATA_DIR: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  daemons.push(daemon)
  let stderr = ''
  daemon.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })
  let succeeded = false
  try {
    expect(daemon.pid, 'spawning the bundle produced no pid').toBeDefined()
    // What startDetachedWorker does right after the spawn: without a pid file the daemon retires itself once its startup grace has passed.
    fs.writeFileSync(workerPidPath(dir), `${daemon.pid}\n`)

    if (gate !== undefined) {
      await gate.reached
      await untilReady({ dir, daemon, stderr: () => stderr, ready: () => workerLog(dir).includes('git did not answer in time, continuing next cycle') })
      gate.release()
    }
    await untilReady({ dir, daemon, stderr: () => stderr, ready: () => [NEW_SYMBOL, ADDED_SYMBOL].every((name) => querySymbols({ name }, dbPath as string).length > 0) })

    expect(querySymbols({ name: NEW_SYMBOL }, dbPath as string).map((s) => path.basename(s.filePath))).toEqual(['lib.ts'])
    expect(querySymbols({ name: ADDED_SYMBOL }, dbPath as string).map((s) => path.basename(s.filePath))).toEqual(['added.ts'])
    expect(querySymbols({ name: OLD_SYMBOL }, dbPath as string), 'the old definition is still indexed').toEqual([])
    expect(fs.existsSync(reconcileRequestPathFor(dir)), 'the request was not spent').toBe(false)
    expect(workerLog(dir)).toContain('swept')
    succeeded = true
  } finally {
    await stopOwnedChild(daemon, { graceful: succeeded })
  }
}

describe('the built worker daemon sweeps a reconcile request', () => {
  it('indexes the drifted file the request names, awaited on the index changing', async () => {
    await sweepsDriftedProject()
  }, 60_000)

  it('keeps the request when git does not answer in time, and sweeps it once git does', async () => {
    const gate = await openGitGate()
    gates.push(gate)
    await sweepsDriftedProject(gate)
  }, 120_000)
})
