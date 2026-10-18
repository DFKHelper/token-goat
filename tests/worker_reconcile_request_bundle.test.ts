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
import { workerErrorLogPath, workerPidPath } from '../src/worker_lifecycle.js'
import { BUNDLE, bundleTg, makeBundleProject } from './helpers/bundle.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { stopOwnedChild } from './helpers/stop_owned_child.js'
import { indexableDir } from './helpers/temp-config.js'

const OLD_SYMBOL = 'bundleDriftOldSym'
const NEW_SYMBOL = 'bundleDriftNewerSym'
const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

const roots: string[] = []
const daemons: ChildProcess[] = []

/** A daemon still running when the test ends (its body threw, or the test timed out before the body's own stop ran) is ended with everything it started, and awaited, before the directory it holds open is removed. */
afterEach(async () => {
  for (const daemon of daemons.splice(0)) {
    if (daemon.exitCode !== null || daemon.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => daemon.once('exit', () => resolve()))
    killProcessTree(daemon.pid)
    await exited
  }
  closeAllDbs()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

/** Resolves once `ready` holds, re-checking it on every change under `dir` (the daemon rewrites its queue, log and heartbeat files each cycle, and the database on every index), and rejects as soon as the daemon exits first. Nothing here measures time: a daemon that is alive and silent leaves the wait to the test's own timeout. */
function untilReady(dir: string, daemon: ChildProcess, stderr: () => string, ready: () => boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const watcher = fs.watch(dir, { recursive: true })
    const finish = (error?: Error): void => {
      watcher.close()
      daemon.off('exit', onExit)
      if (error === undefined) resolve()
      else reject(error)
    }
    const check = (): void => {
      try {
        if (ready()) finish()
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

describe('the built worker daemon sweeps a reconcile request', () => {
  it('indexes the drifted file the request names, awaited on the index changing', async () => {
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
    expect(appendReconcileRequest(dir, project)).toBe(true)

    const daemon = spawn(process.execPath, [BUNDLE, '--worker-daemon'], {
      cwd: os.tmpdir(),
      env: { ...env, TG_WORKER_DATA_DIR: dir },
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

      await untilReady(dir, daemon, () => stderr, () => querySymbols({ name: NEW_SYMBOL }, dbPath as string).length > 0)

      expect(querySymbols({ name: NEW_SYMBOL }, dbPath as string).map((s) => path.basename(s.filePath))).toEqual(['lib.ts'])
      expect(querySymbols({ name: OLD_SYMBOL }, dbPath as string), 'the old definition is still indexed').toEqual([])
      expect(fs.existsSync(reconcileRequestPathFor(dir)), 'the request was not spent').toBe(false)
      expect(fs.readFileSync(workerErrorLogPath(dir), 'utf8')).toContain('swept')
      succeeded = true
    } finally {
      await stopOwnedChild(daemon, { graceful: succeeded })
    }
  }, 60_000)
})
