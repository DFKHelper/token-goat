// Provenance: HAND-DERIVED for the file contents and symbol names (written here, read by the real parser); the request is written by the production writer (appendReconcileRequest), the sweep, the indexer and the read path are the production ones, and no callback is injected anywhere. The hung git is CAPTURE-backed: tests/git_gate.test.ts runs the gate against a real git.
/** The worker loop sweeps a reconcile request with async git after each dirty-queue drain: a request naming a repository whose file drifted ends with the new symbol in the index, and a git that does not answer holds only that sweep, not the process. Every test here drives `runWorkerLoop` itself on its default path, the path the shipping daemon takes, because a stage that only a hand-called function reaches would stay green while the daemon never ran it. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { appendReconcileRequest, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { drainOnce, pendingEmbeddings, runWorkerLoop } from '../src/worker.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { GIT_GATE_ENV_KEYS, openGitGate } from './helpers/git_gate.js'
import { indexableDir } from './helpers/temp-config.js'

/** The loop's own sleep between cycles; nothing in this file waits on it. */
const POLL_MS = 5
/** The most `shouldStop` checks a run makes before giving up: the loop makes two per cycle, so this is 50 cycles. A run that needs more than a handful has lost its request, and ending there turns that into a failed assertion instead of a test that never finishes. */
const MAX_CHECKS = 100

const OLD_SYMBOL = 'driftOldSym'
const NEW_SYMBOL = 'driftNewerSym'
const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`

const scratch: string[] = []

afterEach(async () => {
  await pendingEmbeddings()
  closeAllDbs()
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

interface Fixture {
  readonly dir: string
  readonly dbPath: string
  readonly repo: string
}

/** A worker data directory and a repository whose tracked `lib.ts` has drifted from the index: it was indexed defining {@link OLD_SYMBOL}, the project was marked indexed on purpose, and the file now defines {@link NEW_SYMBOL}. */
function driftedProject(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-e2e-'))
  scratch.push(dir)
  const dbPath = path.join(dir, 'global.db')
  const repo = indexableDir()
  const lib = path.join(repo, 'lib.ts')
  fs.writeFileSync(lib, fn(OLD_SYMBOL))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'old')
  indexFileSync(lib, dbPath)
  expect(querySymbols({ name: OLD_SYMBOL }, dbPath), 'calibration: the committed content is indexed').toHaveLength(1)
  recordIndexedRoot(repo, dbPath)
  fs.writeFileSync(lib, fn(NEW_SYMBOL))
  return { dir, dbPath, repo }
}

const resolves = (fx: Fixture, name: string): boolean => querySymbols({ name }, fx.dbPath).length > 0

function workerLog(fx: Fixture): string {
  try {
    return fs.readFileSync(workerErrorLogPath(fx.dir), 'utf8')
  } catch {
    return ''
  }
}

interface RunningLoop {
  readonly finished: Promise<void>
  /** How many times the loop has asked whether to stop: once at the top of a cycle and once before it sleeps. */
  readonly checks: () => number
}

/** Runs the real loop on `fx.dir` until `done` holds, or the check budget is spent. */
function runLoop(fx: Fixture, done: () => boolean): RunningLoop {
  let checks = 0
  const finished = runWorkerLoop(fx.dir, POLL_MS, () => {
    checks += 1
    return done() || checks > MAX_CHECKS
  })
  return { finished, checks: () => checks }
}

describe('a reconcile request through the worker loop (real default path)', () => {
  it('sweeps the repository the request names, and the drifted file reaches the index and the read path', async () => {
    const fx = driftedProject()
    expect(appendReconcileRequest(fx.dir, fx.repo)).toBe(true)

    await runLoop(fx, () => resolves(fx, NEW_SYMBOL)).finished

    expect(querySymbols({ name: NEW_SYMBOL }, fx.dbPath).map((s) => path.basename(s.filePath))).toEqual(['lib.ts'])
    expect(resolves(fx, OLD_SYMBOL), 'the old definition is still indexed').toBe(false)
    const request = reconcileRequestPathFor(fx.dir)
    expect(fs.existsSync(request), 'the request was not spent').toBe(false)
    expect(fs.existsSync(`${request}.draining`), 'the claim was not removed').toBe(false)
    expect(workerLog(fx)).toContain('swept')
  })

  it('leaves the sweep to the loop: one drainOnce does not claim a request', () => {
    const fx = driftedProject()
    expect(appendReconcileRequest(fx.dir, fx.repo)).toBe(true)

    const processed = drainOnce(fx.dir)

    const request = reconcileRequestPathFor(fx.dir)
    expect(fs.existsSync(request), 'drainOnce took the request').toBe(true)
    expect(fs.existsSync(`${request}.draining`)).toBe(false)
    expect(processed).toBe(0)
    expect(workerLog(fx)).not.toContain('swept')
  })

  it('keeps the process alive while git does not answer, and handles the request once it does', async () => {
    const fx = driftedProject()
    expect(appendReconcileRequest(fx.dir, fx.repo)).toBe(true)
    const gate = await openGitGate()
    const saved = GIT_GATE_ENV_KEYS.map((key) => [key, process.env[key]] as const)
    let stop = false
    let loop: RunningLoop | undefined
    try {
      Object.assign(process.env, gate.env)
      loop = runLoop(fx, () => stop || resolves(fx, NEW_SYMBOL))
      const ended = loop.finished.then(() => 'the loop ended before git was reached')
      // The gate is served by this process: that git reached it at all means the event loop was running while git was blocked, which a synchronous git call would have prevented.
      expect(await Promise.race([gate.reached.then(() => 'reached'), ended])).toBe('reached')
      // The loop is still inside its first cycle: it asked once at the top and has not got to the check before its sleep, so the sweep is awaited and not left running beside the next cycle (which would start a second sweep of the same claim every poll while git hung).
      expect(loop.checks(), 'the loop went on past the sweep while git was held').toBe(1)
      // The request is claimed, so the git being held is the sweep's own, and nothing has been swept.
      expect(fs.existsSync(`${reconcileRequestPathFor(fx.dir)}.draining`), 'the sweep had not claimed the request').toBe(true)
      expect(resolves(fx, NEW_SYMBOL)).toBe(false)
      expect(workerLog(fx)).not.toContain('swept')

      gate.release()
      await loop.finished

      expect(resolves(fx, NEW_SYMBOL), 'the request was not handled after git answered').toBe(true)
      expect(fs.existsSync(`${reconcileRequestPathFor(fx.dir)}.draining`)).toBe(false)
      expect(workerLog(fx)).toContain('swept')
    } finally {
      stop = true
      gate.release()
      await loop?.finished
      await gate.dispose()
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})
