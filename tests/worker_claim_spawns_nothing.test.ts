/** A claim over a lease-less pid-file slot runs on a hook path (ensureWorkerAlive -> startDetachedWorker -> claimWorkerPidFile) under the reclaim lock, where a process-list query took 3 s on a cold machine and hooks have a 3 s budget: it must start no process, and leave the process the slot named to the daemon it installs (worker_lifecycle.ts::retireDisplacedWorker). The real claimWorkerPidFile runs against a real data directory and a real live process; the child_process functions are wrapped to count calls and still call through, so no seam replaces the code under test. Fixtures are HAND-DERIVED: a pid file aged past WORKER_STARTUP_GRACE_MS and a heartbeat naming another pid are what worker_lifecycle.ts::hasFreshWorkerHeartbeat and pidFileIsWithinStartupGrace read as "no lease". */

import type * as ChildProcessModule from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({ names: ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'] as const, fns: new Map<string, ReturnType<typeof vi.fn>>() }))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const name of spies.names) {
    const fn = vi.fn(actual[name] as (...args: unknown[]) => unknown)
    spies.fns.set(name, fn)
    wrapped[name] = fn
  }
  return { ...wrapped, default: wrapped }
})

const { spawn } = await vi.importActual<typeof ChildProcessModule>('node:child_process')
const { claimWorkerPidFile, readDisplacedPids, readPidFile, retireDisplacedWorker, workerPidPath } = await import('../src/worker_lifecycle.js')

let dir: string
let decoy: ReturnType<typeof spawn> | null = null

function processesStarted(): string[] {
  return [...spies.fns].filter(([, fn]) => fn.mock.calls.length > 0).map(([name]) => name)
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-claim-'))
  fs.mkdirSync(path.join(dir, 'queue'), { recursive: true })
  decoy = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--worker-daemon'], { stdio: 'ignore', windowsHide: true })
  for (const fn of spies.fns.values()) fn.mockClear()
})

afterEach(() => {
  if (decoy !== null && decoy.exitCode === null && decoy.signalCode === null) decoy.kill('SIGKILL')
  decoy = null
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('claiming a lease-less pid-file slot', () => {
  it('starts no process, takes the slot, and leaves the old holder alive for the new daemon to retire', () => {
    const holder = decoy!.pid!
    fs.writeFileSync(workerPidPath(dir), `${holder}\n`)
    const aged = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(workerPidPath(dir), aged, aged)
    fs.writeFileSync(path.join(dir, 'queue', 'drain-heartbeat'), '1\n')

    expect(claimWorkerPidFile(dir, process.pid)).toBe(true)

    expect(processesStarted(), 'a claim on a hook path must not start any process').toEqual([])
    expect(readPidFile(dir)).toBe(process.pid)
    expect(readDisplacedPids(dir)).toEqual([holder])
    expect(decoy!.exitCode === null && decoy!.signalCode === null, 'the claim itself must not signal the old holder').toBe(true)
  })
})

describe('retireDisplacedWorker', () => {
  it('drops the note and leaves a process that is not this install daemon alone', () => {
    const holder = decoy!.pid!
    fs.writeFileSync(`${workerPidPath(dir)}.displaced`, `${holder} ${Date.now()} ${dir}\n`)

    retireDisplacedWorker(dir)

    expect(fs.existsSync(`${workerPidPath(dir)}.displaced`)).toBe(false)
    expect(decoy!.exitCode === null && decoy!.signalCode === null, 'a node process carrying the flag but not the launcher must survive').toBe(true)
  })

  it('does nothing without a note', () => {
    expect(() => retireDisplacedWorker(dir)).not.toThrow()
  })
})
