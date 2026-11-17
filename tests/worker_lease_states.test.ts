/** HAND-DERIVED from src/worker_lifecycle.ts (claimWorkerPidFile, reclaimStalePidFile, pidFileIsWithinStartupGrace, isWorkerRunning, stopWorkerDetailed, readDisplacedPids) and src/worker.ts (runWorkerLoop retire closures): each expectation is read off a branch condition in those symbols, none captured from a run. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type * as Reconcile from '../src/reconcile_requests.js'

// Counts whole loop cycles: the loop awaits drainReconcileRequestsAsync once per cycle, after its drain, so a test waits for N cycles instead of N milliseconds.
const cycles = vi.hoisted(() => ({ count: 0, waiters: [] as Array<{ at: number; resolve: () => void }> }))
vi.mock('../src/reconcile_requests.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Reconcile>()
  return {
    ...actual,
    drainReconcileRequestsAsync: (dir: string) => {
      cycles.count++
      for (const w of cycles.waiters) if (cycles.count >= w.at) w.resolve()
      cycles.waiters = cycles.waiters.filter((w) => cycles.count < w.at)
      return actual.drainReconcileRequestsAsync(dir)
    },
  }
})

import { closeDb } from '../src/db.js'
import { runWorkerLoop } from '../src/worker.js'
import {
  WORKER_STARTUP_GRACE_MS,
  claimWorkerPidFile,
  displacedWorkerPath,
  drainHeartbeatPathFor,
  isWorkerRunning,
  readDisplacedPids,
  stopWorkerDetailed,
  workerPidPath,
} from '../src/worker_lifecycle.js'
import { OWNER_VAR } from './helpers/shell_argv.js'
import { claimsToBeWorker } from './helpers/worker_identity.js'

const OWNER = `tg-lease-states-${process.pid}`
const UNUSED_PID = 999_999
const ONE_HOUR_MS = 3_600_000
const NOW = 1_900_000_000_000
const GRACE = WORKER_STARTUP_GRACE_MS

const dirs: string[] = []
const children: ChildProcess[] = []

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.push(dir)
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })
  return dir
}

/** A child this test starts, tagged with the owner token so a stray tree is findable, and killed in afterEach. */
function spawnChild(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, [OWNER_VAR]: OWNER },
  })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('exit', () => resolve()))
}

/** A pid this test started and reaped, so it names no live process. */
async function deadPid(): Promise<number> {
  const child = spawnChild('')
  await exited(child)
  return child.pid as number
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function writePid(dir: string, pid: number): void {
  fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
}

function writeHeartbeat(dir: string, pid: number): void {
  fs.writeFileSync(drainHeartbeatPathFor(dir), `${pid}\n`)
}

function ageFile(file: string, ageMs: number): void {
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(file, at, at)
}

/** Resolves 'running' after `n` more loop cycles, or 'stopped' as soon as the loop returns on its own. */
async function outcomeAfterCycles(loop: Promise<void>, n: number): Promise<'stopped' | 'running'> {
  const target = cycles.count + n
  return Promise.race([
    loop.then(() => 'stopped' as const),
    new Promise<'running'>((resolve) => cycles.waiters.push({ at: target, resolve: () => resolve('running') })),
  ])
}

async function withLoop(
  dir: string,
  retire: { pidFileGraceMs: number; idleExitMs: number },
  body: (loop: Promise<void>) => Promise<void>,
): Promise<void> {
  let stop = false
  const loop = runWorkerLoop(dir, 5, () => stop, retire)
  try {
    await body(loop)
  } finally {
    stop = true
    await loop
  }
}

afterEach(async () => {
  vi.useRealTimers()
  cycles.waiters = []
  for (const c of children.splice(0)) c.kill('SIGKILL')
  for (const d of dirs.splice(0)) {
    closeDb(path.join(d, 'global.db'))
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    } catch {
      // best-effort: a Windows handle may still hold the directory
    }
  }
})

interface ClaimRow {
  state: string
  setup: (dir: string) => Promise<void> | void
  claims: boolean
}

const claimRows: ClaimRow[] = [
  { state: 'no pid file yet (fresh data dir)', setup: () => {}, claims: true },
  { state: 'live owner inside its grace, no heartbeat', setup: (dir) => writePid(dir, process.pid), claims: false },
  {
    state: 'live owner with a fresh heartbeat naming it, pid file past the grace',
    setup: (dir) => {
      writePid(dir, process.pid)
      writeHeartbeat(dir, process.pid)
      ageFile(workerPidPath(dir), ONE_HOUR_MS)
    },
    claims: false,
  },
  { state: 'dead owner inside its grace', setup: async (dir) => writePid(dir, await deadPid()), claims: true },
  {
    state: 'dead owner past its grace',
    setup: async (dir) => {
      writePid(dir, await deadPid())
      ageFile(workerPidPath(dir), ONE_HOUR_MS)
    },
    claims: true,
  },
  {
    state: 'live pid with no heartbeat past the grace (reused pid number)',
    setup: (dir) => {
      writePid(dir, process.pid)
      ageFile(workerPidPath(dir), ONE_HOUR_MS)
    },
    claims: true,
  },
  {
    state: 'unreadable pid file',
    setup: (dir) => fs.writeFileSync(workerPidPath(dir), 'not-a-pid\n'),
    claims: true,
  },
]

describe('claim: the pid file slot states', () => {
  it.each(claimRows)('claim, state "$state": claims $claims', async (row) => {
    const dir = scratch('tg-lease-claim-')
    await row.setup(dir)
    const before = fs.existsSync(workerPidPath(dir)) ? fs.readFileSync(workerPidPath(dir), 'utf8').trim() : ''

    expect(claimWorkerPidFile(dir, UNUSED_PID), `claim state "${row.state}" must ${row.claims ? 'claim the slot' : 'be refused'}`).toBe(row.claims)
    expect(
      fs.readFileSync(workerPidPath(dir), 'utf8').trim(),
      `claim state "${row.state}" must leave the slot naming ${row.claims ? 'the claimant' : 'its owner'}`,
    ).toBe(row.claims ? String(UNUSED_PID) : before)
  })
})

describe('the startup grace edge, read through claimWorkerPidFile', () => {
  const edgeRows = [
    { ageMs: GRACE - 1, state: 'one ms inside the grace', claims: false },
    { ageMs: GRACE, state: 'exactly at the grace edge', claims: true },
    { ageMs: GRACE + 1, state: 'one ms past the grace', claims: true },
  ]

  it.each(edgeRows)('live owner, no heartbeat, pid file aged $ageMs ms ($state): claims $claims', (row) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    const dir = scratch('tg-lease-grace-')
    writePid(dir, process.pid)
    const at = new Date(NOW - row.ageMs)
    fs.utimesSync(workerPidPath(dir), at, at)

    expect(claimWorkerPidFile(dir, UNUSED_PID), `grace state "${row.state}" must ${row.claims ? 'let the claim through' : 'refuse the claim'}`).toBe(row.claims)
  })

  it.each([
    { state: 'entry written one ms before the cutoff', ageMs: GRACE - 1, kept: true },
    { state: 'entry exactly one grace old', ageMs: GRACE, kept: false },
    { state: 'entry stamped in the future', ageMs: -1, kept: false },
  ])('displaced note, $state: kept $kept', ({ ageMs, kept }) => {
    const dir = scratch('tg-lease-note-')
    const stamp = NOW - ageMs
    fs.writeFileSync(displacedWorkerPath(dir), `4242 ${stamp} ${dir}\n`)

    expect(readDisplacedPids(dir, NOW), `displaced note state must keep the pid ${kept ? '' : 'out'}`).toEqual(kept ? [4242] : [])
  })
})

interface StatusRow {
  state: string
  setup: (dir: string) => Promise<void> | void
  running: boolean
}

const statusRows: StatusRow[] = [
  {
    state: 'alive with a fresh heartbeat naming it',
    setup: (dir) => {
      writePid(dir, process.pid)
      writeHeartbeat(dir, process.pid)
    },
    running: true,
  },
  {
    state: 'alive, heartbeat older than its stale bound',
    setup: (dir) => {
      writePid(dir, process.pid)
      writeHeartbeat(dir, process.pid)
      ageFile(drainHeartbeatPathFor(dir), ONE_HOUR_MS)
    },
    running: false,
  },
  {
    state: 'alive, heartbeat names another pid',
    setup: (dir) => {
      writePid(dir, process.pid)
      writeHeartbeat(dir, UNUSED_PID)
    },
    running: false,
  },
  {
    state: 'alive, no heartbeat, pid file fresh inside the grace (status has no grace)',
    setup: (dir) => writePid(dir, process.pid),
    running: false,
  },
  {
    state: 'dead pid with a fresh heartbeat naming it',
    setup: async (dir) => {
      const pid = await deadPid()
      writePid(dir, pid)
      writeHeartbeat(dir, pid)
    },
    running: false,
  },
  { state: 'no pid file', setup: () => {}, running: false },
]

describe('isWorkerRunning: status states', () => {
  it.each(statusRows)('state "$state": running $running', async (row) => {
    const dir = scratch('tg-lease-status-')
    await row.setup(dir)

    expect(isWorkerRunning(dir), `status state "${row.state}" must read ${row.running ? 'running' : 'not running'}`).toBe(row.running)
  })
})

describe('stopWorkerDetailed: stop states', () => {
  it('no pid file: reports nothing stopped and nothing left running', () => {
    const dir = scratch('tg-lease-stop-none-')

    expect(stopWorkerDetailed(dir), 'stop state "no pid file" must report neither stopped nor left running').toEqual({ stopped: false, leftRunning: null })
  })

  it('dead pid: reports nothing stopped and clears the pid file that names it', async () => {
    const dir = scratch('tg-lease-stop-dead-')
    const pid = await deadPid()
    writePid(dir, pid)
    writeHeartbeat(dir, pid)

    expect(stopWorkerDetailed(dir), 'stop state "dead pid" must report nothing stopped').toEqual({ stopped: false, leftRunning: null })
    expect(fs.existsSync(workerPidPath(dir)), 'stop state "dead pid" must clear the pid file naming the dead pid').toBe(false)
  })

  it('live pid with no lease proof: neither signalled nor unnamed', () => {
    const dir = scratch('tg-lease-stop-unleased-')
    const child = spawnChild('setInterval(() => {}, 1000)')
    writePid(dir, child.pid as number)
    ageFile(workerPidPath(dir), ONE_HOUR_MS)

    expect(stopWorkerDetailed(dir), 'stop state "live pid with no lease proof" must report nothing stopped').toEqual({ stopped: false, leftRunning: null })
    expect(alive(child.pid as number), 'stop state "live pid with no lease proof" must leave the process running').toBe(true)
    expect(fs.existsSync(workerPidPath(dir)), 'stop state "live pid with no lease proof" must keep the pid file').toBe(true)
  })

  it('live leased pid that is not this install worker: ends nothing, clears its pid file', () => {
    const dir = scratch('tg-lease-stop-other-')
    const child = spawnChild('setInterval(() => {}, 1000)')
    writePid(dir, child.pid as number)
    writeHeartbeat(dir, child.pid as number)

    expect(stopWorkerDetailed(dir), 'stop state "leased, not a worker" must report nothing stopped').toEqual({ stopped: false, leftRunning: null })
    expect(alive(child.pid as number), 'stop state "leased, not a worker" must leave the process running').toBe(true)
    expect(fs.existsSync(workerPidPath(dir)), 'stop state "leased, not a worker" must clear the pid file').toBe(false)
  })

  it('expected pid mismatch: another hook already took the slot, so nothing is touched', () => {
    const dir = scratch('tg-lease-stop-mismatch-')
    const child = spawnChild('setInterval(() => {}, 1000)')
    writePid(dir, child.pid as number)
    writeHeartbeat(dir, child.pid as number)

    expect(stopWorkerDetailed(dir, UNUSED_PID), 'stop state "expected pid mismatch" must report nothing stopped').toEqual({ stopped: false, leftRunning: null })
    expect(fs.readFileSync(workerPidPath(dir), 'utf8').trim(), 'stop state "expected pid mismatch" must keep the pid file').toBe(String(child.pid))
    expect(alive(child.pid as number), 'stop state "expected pid mismatch" must leave the process running').toBe(true)
  })

  it('live leased worker (confirmed by its command line): ended with its tree, pid file cleared', async () => {
    const dir = scratch('tg-lease-stop-worker-')
    const child = spawnChild('setInterval(() => {}, 1000)')
    const pid = child.pid as number
    writePid(dir, pid)
    writeHeartbeat(dir, pid)

    expect(stopWorkerDetailed(dir, undefined, claimsToBeWorker()), 'stop state "confirmed worker" must report stopped').toEqual({ stopped: true, leftRunning: null })
    await exited(child)
    expect(alive(pid), 'stop state "confirmed worker" must end the process').toBe(false)
    expect(fs.existsSync(workerPidPath(dir)), 'stop state "confirmed worker" must clear the pid file').toBe(false)
  })
})

describe('the retire closures inside runWorkerLoop, default path', () => {
  const NEVER = { pidFileGraceMs: 60_000, idleExitMs: 60_000 }

  it('owner state: a daemon whose pid file names its own pid keeps running', async () => {
    const dir = scratch('tg-lease-loop-owner-')
    writePid(dir, process.pid)
    await withLoop(dir, NEVER, async (loop) => {
      expect(await outcomeAfterCycles(loop, 3), 'retire state "owner" must keep the loop running').toBe('running')
    })
  })

  it('owner state, pid file gone inside the grace: keeps running', async () => {
    const dir = scratch('tg-lease-loop-absent-grace-')
    writePid(dir, process.pid)
    await withLoop(dir, NEVER, async (loop) => {
      expect(await outcomeAfterCycles(loop, 1), 'retire state "owner" must be running before the removal').toBe('running')
      fs.rmSync(workerPidPath(dir))
      expect(await outcomeAfterCycles(loop, 3), 'retire state "absent inside the grace" must keep the loop running').toBe('running')
    })
  })

  it('owner state, pid file names another process: retires at once, with no grace', async () => {
    const dir = scratch('tg-lease-loop-takeover-')
    writePid(dir, process.pid)
    await withLoop(dir, NEVER, async (loop) => {
      expect(await outcomeAfterCycles(loop, 1), 'retire state "owner" must be running before the takeover').toBe('running')
      writePid(dir, UNUSED_PID)
      expect(await outcomeAfterCycles(loop, 3), 'retire state "taken over" must retire the loop without waiting for the grace').toBe('stopped')
    })
  })

  it('owner state, pid file emptied mid-replacement: not a retirement', async () => {
    const dir = scratch('tg-lease-loop-empty-')
    writePid(dir, process.pid)
    await withLoop(dir, { pidFileGraceMs: 0, idleExitMs: 60_000 }, async (loop) => {
      expect(await outcomeAfterCycles(loop, 1), 'retire state "owner" must be running before the empty read').toBe('running')
      fs.writeFileSync(workerPidPath(dir), '')
      expect(await outcomeAfterCycles(loop, 3), 'retire state "empty pid file" must keep the loop running').toBe('running')
    })
  })

  it('absent state past the grace, slot never claimed: retires', async () => {
    const dir = scratch('tg-lease-loop-absent-past-')
    await withLoop(dir, { pidFileGraceMs: 0, idleExitMs: 60_000 }, async (loop) => {
      expect(await outcomeAfterCycles(loop, 50), 'retire state "absent past the grace" must retire the loop').toBe('stopped')
    })
  })

  it('never-owned state, other pid, inside the grace: keeps running', async () => {
    const dir = scratch('tg-lease-loop-unowned-grace-')
    writePid(dir, UNUSED_PID)
    await withLoop(dir, NEVER, async (loop) => {
      expect(await outcomeAfterCycles(loop, 3), 'retire state "never owned, inside the grace" must keep the loop running').toBe('running')
    })
  })

  it('never-owned state, other pid, past the grace: retires', async () => {
    const dir = scratch('tg-lease-loop-unowned-past-')
    writePid(dir, UNUSED_PID)
    await withLoop(dir, { pidFileGraceMs: 0, idleExitMs: 60_000 }, async (loop) => {
      expect(await outcomeAfterCycles(loop, 50), 'retire state "never owned, past the grace" must retire the loop').toBe('stopped')
    })
  })
})
