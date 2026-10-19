// Provenance: HAND-DERIVED for the repository, the file contents and the request (written here, read by the real parser and swept by the production sweep); the git being held is real, on tests/helpers/git_gate.ts (CAPTURE, see its header and tests/git_gate.test.ts). Nothing is injected into the sweep.
/** A daemon inside a long reconcile-request sweep is making progress, so its drain heartbeat must keep advancing: `stopWorker` and `reclaimStalePidFile` judge the daemon by the heartbeat's age, and a sweep that stalls past the 60 s window on a slow git left a live daemon looking dead (`worker stop` returned without stopping it, and a second daemon could claim the slot). The test holds the sweep's own gits one at a time on two gates and asserts, at each step it reaches, that the heartbeat was rewritten after the git before it finished. It aged the heartbeat to an hour ago first, so the assertion is about whether it was rewritten, never about how long a step took. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { appendReconcileRequest } from '../src/dirty_queue.js'
import { recordIndexedRoot } from '../src/indexed_roots.js'
import { indexFileSync } from '../src/parser.js'
import { drainReconcileRequestsAsync } from '../src/reconcile_requests.js'
import { pendingEmbeddings } from '../src/worker.js'
import { drainHeartbeatPathFor, writeDrainHeartbeat } from '../src/worker_lifecycle.js'
import { GIT_GATE_ENV_KEYS, openGitGate } from './helpers/git_gate.js'
import { indexableDir } from './helpers/temp-config.js'

const fn = (name: string): string => `export function ${name}(): number {\n  return 1\n}\n`
/** An hour before the test started: far outside the 60 s freshness window, so a heartbeat newer than this was rewritten after it was aged. */
const AGED_MS = Date.now() - 3_600_000

const scratch: string[] = []

afterEach(async () => {
  await pendingEmbeddings()
  closeAllDbs()
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

/** A worker data directory and a repository indexed on purpose whose tracked file has drifted from the index, so the sweep has real work. */
function driftedProject(): { dir: string; repo: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sweep-heartbeat-'))
  scratch.push(dir)
  const dbPath = path.join(dir, 'global.db')
  const repo = indexableDir()
  const lib = path.join(repo, 'lib.ts')
  fs.writeFileSync(lib, fn('sweepHeartbeatOld'))
  git(repo, 'init', '-q')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'old')
  indexFileSync(lib, dbPath)
  recordIndexedRoot(repo, dbPath)
  fs.writeFileSync(lib, fn('sweepHeartbeatNew'))
  return { dir, repo }
}

/** Writes the heartbeat and sets its modification time to {@link AGED_MS}. */
function ageHeartbeat(dir: string): void {
  writeDrainHeartbeat(dir, true)
  const aged = new Date(AGED_MS)
  fs.utimesSync(drainHeartbeatPathFor(dir), aged, aged)
}

const heartbeatRewritten = (dir: string): boolean => fs.statSync(drainHeartbeatPathFor(dir)).mtimeMs - AGED_MS > 1000

describe('the drain heartbeat during a reconcile-request sweep (real git, held)', () => {
  it('is rewritten after each git of the sweep finishes, not only when the drain cycle ends', async () => {
    const fx = driftedProject()
    expect(appendReconcileRequest(fx.dir, fx.repo)).toBe(true)
    const first = await openGitGate()
    const second = await openGitGate()
    const saved = GIT_GATE_ENV_KEYS.map((key) => [key, process.env[key]] as const)
    const restoreEnv = (): void => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    let sweep: Promise<number> | undefined
    try {
      ageHeartbeat(fx.dir)
      // The sweep's first git (rev-parse) starts on the first gate.
      Object.assign(process.env, first.env)
      sweep = drainReconcileRequestsAsync(fx.dir)
      const ended = sweep.then(() => 'the sweep ended before git was reached')
      expect(await Promise.race([first.reached.then(() => 'reached'), ended])).toBe('reached')
      expect(heartbeatRewritten(fx.dir), 'calibration: nothing has finished yet').toBe(false)

      // Every git started from here on (the file listing) waits on the second gate; the one already held is on the first.
      Object.assign(process.env, second.env)
      first.release()
      expect(await Promise.race([second.reached.then(() => 'reached'), ended])).toBe('reached')
      expect(heartbeatRewritten(fx.dir), 'the heartbeat did not advance when the sweep got its first git answer').toBe(true)

      // The listing is the last git: let everything after it run free, then let it go.
      ageHeartbeat(fx.dir)
      restoreEnv()
      second.release()
      expect(await sweep).toBe(1)
      expect(heartbeatRewritten(fx.dir), 'the heartbeat did not advance when the sweep got its second git answer').toBe(true)
    } finally {
      restoreEnv()
      first.release()
      second.release()
      await sweep
      await first.dispose()
      await second.dispose()
    }
  })
})
