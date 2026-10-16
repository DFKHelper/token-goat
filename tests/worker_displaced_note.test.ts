/** The note a pid-file claim leaves for the daemon it installs (worker_lifecycle.ts::retireDisplacedWorker) names a pid the OS may have reused, so it must not outlive its claim, must not cross data dirs, must be dropped by a fresh claim, and must not lose a pid to a second claim. The real claimWorkerPidFile and retireDisplacedWorker run against a real data directory and real live node processes; only the command-line matcher is replaced (a decoy's launcher is not this install's), by a rule that accepts the `--worker-daemon` flag a decoy carries, and terminateProcessTree is wrapped to record its calls and still call through. Fixtures are HAND-DERIVED: the note line format `<pid> <epoch ms> <data dir>` is the one worker_lifecycle.ts::readDisplacedPids documents, and a pid file aged past WORKER_STARTUP_GRACE_MS with a heartbeat naming another pid is what hasFreshWorkerHeartbeat and pidFileIsWithinStartupGrace read as "no lease". */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as ResidentProcessModule from '../src/resident_process.js'

const spies = vi.hoisted(() => ({ terminate: vi.fn() }))

vi.mock('../src/resident_process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ResidentProcessModule>()
  spies.terminate.mockImplementation(actual.terminateProcessTree)
  return { ...actual, isResidentOfInstall: (cmd: string) => cmd.includes('--worker-daemon'), terminateProcessTree: spies.terminate }
})

const { WORKER_STARTUP_GRACE_MS, claimWorkerPidFile, displacedWorkerPath, readDisplacedPids, retireDisplacedWorker, workerPidPath } = await import('../src/worker_lifecycle.js')

let dir: string
let elsewhere: string
const decoys: ChildProcess[] = []

function startDecoy(): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'], { stdio: 'ignore', windowsHide: true })
  decoys.push(child)
  return child.pid!
}

function isUp(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

/** Resolves on the child's exit event; the test's own timeout is the hang backstop. */
function exited(pid: number): Promise<void> {
  const child = decoys.find((c) => c.pid === pid)!
  return isUp(child) ? new Promise((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
}

function terminatedPids(): number[] {
  return spies.terminate.mock.calls.map((call) => call[0] as number)
}

function noteLine(pid: number, atMs: number, forDir: string): string {
  return `${pid} ${atMs} ${forDir}\n`
}

/** A pid file that names `pid` with no lease: older than the startup grace, and a heartbeat naming another process. */
function leaseless(pid: number): void {
  fs.writeFileSync(workerPidPath(dir), `${pid}\n`)
  const aged = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(workerPidPath(dir), aged, aged)
  fs.writeFileSync(path.join(dir, 'queue', 'drain-heartbeat'), '1\n')
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-displaced-'))
  elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-displaced-other-'))
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })
  spies.terminate.mockClear()
})

afterEach(() => {
  for (const child of decoys.splice(0)) if (isUp(child)) child.kill('SIGKILL')
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  fs.rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('the displaced-worker note', () => {
  it('ends a lease-less daemon a fresh note for this data dir names', async () => {
    const holder = startDecoy()
    fs.writeFileSync(displacedWorkerPath(dir), noteLine(holder, Date.now(), dir))

    retireDisplacedWorker(dir)

    await exited(holder)
    expect(terminatedPids()).toEqual([holder])
    expect(fs.existsSync(displacedWorkerPath(dir))).toBe(false)
  }, 60_000)

  it('ignores a note older than one startup grace, though the pid is alive and looks like a daemon', () => {
    const holder = startDecoy()
    fs.writeFileSync(displacedWorkerPath(dir), noteLine(holder, Date.now() - WORKER_STARTUP_GRACE_MS - 1, dir))

    retireDisplacedWorker(dir)

    expect(terminatedPids(), 'a stale note must not end anything').toEqual([])
    expect(fs.existsSync(displacedWorkerPath(dir)), 'the stale note is consumed').toBe(false)
  }, 60_000)

  it('ignores a note written for another data dir', () => {
    const holder = startDecoy()
    fs.writeFileSync(displacedWorkerPath(dir), noteLine(holder, Date.now(), elsewhere))

    retireDisplacedWorker(dir)

    expect(terminatedPids()).toEqual([])
  }, 60_000)

  it('ignores a note in the old pid-only format', () => {
    const holder = startDecoy()
    fs.writeFileSync(displacedWorkerPath(dir), `${holder}\n`)

    retireDisplacedWorker(dir)

    expect(terminatedPids()).toEqual([])
  }, 60_000)

  it('is removed by a claim that creates the pid file fresh', () => {
    fs.writeFileSync(displacedWorkerPath(dir), noteLine(startDecoy(), Date.now(), dir))
    expect(fs.existsSync(workerPidPath(dir))).toBe(false)

    expect(claimWorkerPidFile(dir, process.pid)).toBe(true)

    expect(fs.existsSync(displacedWorkerPath(dir)), 'a fast-path claim displaced nobody').toBe(false)
  })

  it('stops at the total deadline and ends no later holder', () => {
    const holders = [startDecoy(), startDecoy()]
    fs.writeFileSync(displacedWorkerPath(dir), holders.map((pid) => noteLine(pid, Date.now(), dir)).join(''))

    retireDisplacedWorker(dir, { readCommandLine: () => 'node launcher.mjs --worker-daemon', deadlineMs: 0 })

    expect(terminatedPids(), 'a loop already past its deadline signals nobody').toEqual([])
  }, 60_000)

  it('keeps the first pid when a second claim lands before any daemon consumed the note, and ends both', async () => {
    const first = startDecoy()
    const second = startDecoy()
    leaseless(first)
    expect(claimWorkerPidFile(dir, second)).toBe(true)
    expect(readDisplacedPids(dir)).toEqual([first])

    // The daemon the first claim installed is gone before it read the note; the pid file names `second`, which holds no lease either.
    leaseless(second)
    expect(claimWorkerPidFile(dir, process.pid)).toBe(true)
    expect([...readDisplacedPids(dir)].sort((a, b) => a - b)).toEqual([first, second].sort((a, b) => a - b))

    // The query is injected: this test is about the list, and a real process-list query is slow on a loaded machine; the first test above runs the real one.
    retireDisplacedWorker(dir, { readCommandLine: () => 'node launcher.mjs --worker-daemon' })

    await Promise.all([exited(first), exited(second)])
    expect([...terminatedPids()].sort((a, b) => a - b)).toEqual([first, second].sort((a, b) => a - b))
  }, 60_000)
})
