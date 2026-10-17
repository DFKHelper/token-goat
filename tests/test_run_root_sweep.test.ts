/** Tests for the stale-run-root sweep in tests/setup/build-bundle.ts. Test hygiene, not product behaviour: `tg-run-` appears nowhere in the shipped bundle. The globalSetup teardown that removes a run root only fires when the main vitest process exits normally, so every interrupted run (Ctrl-C, a killed agent, a crash) abandons its root; sweepStaleRunRoots() reclaims those on the next run. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { startWatchdog } from './helpers/stall_proof_watchdog.js'
import { killDaemonsUnder, sweepStaleRunRoots } from './setup/build-bundle.js'

// HAND-DERIVED: the directory names and ages are constructed here from the sweep's own contract (a `tg-run-` prefix and an mtime older than 6h), independently of the implementation's code. No wire format is involved.
const SEVEN_HOURS_MS = 7 * 60 * 60 * 1000

const made: string[] = []

function makeDir(name: string, ageMs: number): string {
  const full = path.join(os.tmpdir(), name)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, 'marker.txt'), 'x')
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(full, when, when)
  made.push(full)
  return full
}

afterEach(() => {
  for (const dir of made.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

describe('sweepStaleRunRoots', () => {
  it('removes an abandoned run root while leaving a live one and the shared compile cache alone', () => {
    const unique = `${process.pid}-${Date.now()}`
    const stale = makeDir(`tg-run-sweeptest-stale-${unique}`, SEVEN_HOURS_MS)
    const fresh = makeDir(`tg-run-sweeptest-fresh-${unique}`, 0)
    // The real compile cache is deliberately shared across runs and is in active use by this very run, so it is backdated past the age gate in place and never registered for deletion: only the `tg-run-` prefix keeps it alive.
    const cache = path.join(os.tmpdir(), 'tg-test-v8-compile-cache')
    const cacheExists = fs.existsSync(cache)
    const cacheMtime = cacheExists ? fs.statSync(cache).mtime : null
    if (cacheExists) {
      const when = new Date(Date.now() - SEVEN_HOURS_MS)
      fs.utimesSync(cache, when, when)
    }

    try {
      sweepStaleRunRoots()

      expect(fs.existsSync(stale)).toBe(false)
      expect(fs.existsSync(fresh)).toBe(true)
      if (cacheExists) expect(fs.existsSync(cache)).toBe(true)
    } finally {
      if (cacheMtime) {
        try {
          fs.utimesSync(cache, cacheMtime, cacheMtime)
        } catch {
          // best-effort
        }
      }
    }
  })

  it('does not throw when the temp directory holds no run roots to sweep', () => {
    expect(() => sweepStaleRunRoots()).not.toThrow()
  })
})


describe('killDaemonsUnder', () => {
  // FORMAT-DERIVED: a daemon's command line is `node <launcher> --worker-daemon`, read off its launch site src/worker_lifecycle.ts::startDetachedWorker (`spawn(process.execPath, [daemonEntryScript(), '--worker-daemon'])`), and its heartbeat is the file queue/drain-heartbeat holding its pid (src/worker_lifecycle.ts::drainHeartbeatPathFor, writeDrainHeartbeat). The stand-ins below are node processes given that argv shape; the real-bundle case runs the shipped launcher itself.
  const WORKER_DAEMON_FLAG = '--worker-daemon'
  const STAND_IN_SOURCE = 'process.stdout.write("ready"); setInterval(() => {}, 1000)'

  const spawned: ChildProcess[] = []
  afterEach(() => {
    for (const c of spawned.splice(0)) {
      try {
        if (c.pid !== undefined) process.kill(c.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  interface Started {
    pid: number
    /** Resolves once the process has started and rejects if it exits first. */
    ready: Promise<void>
  }

  /** Starts `node ...argv`, which must print "ready" once it is running. */
  function start(argv: string[], env: NodeJS.ProcessEnv = process.env): Started {
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env })
    spawned.push(child)
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('ready')) resolve()
      })
      child.once('exit', (code) => reject(new Error(`stand-in exited with ${String(code)} before it was ready`)))
    })
    // A stand-in killed by the test itself, or by afterEach, must not surface as an unhandled rejection.
    ready.catch(() => undefined)
    return { pid: child.pid as number, ready }
  }

  /** A script a stand-in daemon runs as its launcher, in a directory removed after the test. */
  function launcherScript(label: string): string {
    const dir = makeDir(`tg-run-killtest-${label}-${process.pid}-${Date.now()}`, 0)
    const script = path.join(dir, 'launcher.mjs')
    fs.writeFileSync(script, STAND_IN_SOURCE)
    return script
  }

  function heartbeatPath(root: string): string {
    return path.join(root, 'tg-test-data-x', 'dfk-helper', 'token-goat', 'queue', 'drain-heartbeat')
  }

  /** A fresh run root whose heartbeat names `pid`, last refreshed `ageMs` ago. */
  function rootNaming(label: string, pid: number, ageMs: number): string {
    const root = makeDir(`tg-run-killtest-${label}-${process.pid}-${Date.now()}`, 0)
    const beat = heartbeatPath(root)
    fs.mkdirSync(path.dirname(beat), { recursive: true })
    fs.writeFileSync(beat, `${pid}\n`)
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(beat, when, when)
    return root
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  /** Sweeps `bystander` first, then `target` (named by `daemon`) and waits until `daemon` is dead: a kill wrongly sent for the bystander was issued before the daemon's, so once the daemon is seen dead that kill has been delivered too, and the bystander's survival is not a race against it. */
  async function sweepThenWaitForDaemon(bystander: string, target: string, daemon: Started, entryScript?: string): Promise<void> {
    const watchdog = startWatchdog({ quietLimitMs: 20_000, label: 'kill stand-ins' })
    try {
      await Promise.race([daemon.ready, watchdog.failed])
      watchdog.progress('daemon started')
      killDaemonsUnder(bystander, entryScript)
      killDaemonsUnder(target, entryScript)
      while (isAlive(daemon.pid)) await Promise.race([sleep(25), watchdog.failed])
    } finally {
      watchdog.stop()
    }
  }

  it('kills the pid a fresh heartbeat names when it is a worker daemon of the launcher, and leaves the pid a stale heartbeat names alone', async () => {
    const launcher = launcherScript('a')
    const live = start([launcher, WORKER_DAEMON_FLAG])
    const reused = start([launcher, WORKER_DAEMON_FLAG])
    const root = rootNaming('live', live.pid, 0)
    const staleRoot = rootNaming('stale', reused.pid, 5 * 60_000)
    await reused.ready
    await sweepThenWaitForDaemon(staleRoot, root, live, launcher)

    expect(isAlive(live.pid), 'a daemon named by a fresh heartbeat survived').toBe(false)
    expect(isAlive(reused.pid), 'a pid named only by a stale heartbeat was killed').toBe(true)
  })

  it('leaves a live process that is not a worker daemon alone even when a fresh heartbeat names it', async () => {
    const launcher = launcherScript('b')
    const daemon = start([launcher, WORKER_DAEMON_FLAG])
    // The pid a daemon's heartbeat once named, now held by something else.
    const reusedPid = start(['-e', STAND_IN_SOURCE])
    const root = rootNaming('daemon', daemon.pid, 0)
    const reusedRoot = rootNaming('reused', reusedPid.pid, 0)
    await reusedPid.ready
    await sweepThenWaitForDaemon(reusedRoot, root, daemon, launcher)

    expect(isAlive(daemon.pid), 'the worker daemon survived the sweep').toBe(false)
    expect(isAlive(reusedPid.pid), 'a process that is not a worker daemon was killed because a heartbeat named its pid').toBe(true)
  })

  it('leaves a worker daemon of another launcher alone', async () => {
    const launcher = launcherScript('c')
    const otherLauncher = launcherScript('c-other')
    const ours = start([launcher, WORKER_DAEMON_FLAG])
    const theirs = start([otherLauncher, WORKER_DAEMON_FLAG])
    const root = rootNaming('ours', ours.pid, 0)
    const theirRoot = rootNaming('theirs', theirs.pid, 0)
    await theirs.ready
    await sweepThenWaitForDaemon(theirRoot, root, ours, launcher)

    expect(isAlive(ours.pid), 'the daemon of the launcher survived the sweep').toBe(false)
    expect(isAlive(theirs.pid), 'a worker daemon run from another launcher was killed').toBe(true)
  })

  it('kills the real worker daemon of the built bundle with no launcher passed', async () => {
    const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'token-goat.mjs')
    const root = makeDir(`tg-run-killtest-real-${process.pid}-${Date.now()}`, 0)
    const dataDirectory = path.dirname(path.dirname(heartbeatPath(root)))
    fs.mkdirSync(dataDirectory, { recursive: true })
    // The daemon prints nothing, so its own heartbeat is the readiness signal.
    const child = spawn(process.execPath, [bundle, WORKER_DAEMON_FLAG], { stdio: 'ignore', windowsHide: true, env: { ...process.env, TG_WORKER_DATA_DIR: dataDirectory } })
    spawned.push(child)
    let exited = false
    child.once('exit', () => {
      exited = true
    })
    const watchdog = startWatchdog({ quietLimitMs: 20_000, label: 'real worker daemon' })
    try {
      const beat = heartbeatPath(root)
      while (!fs.existsSync(beat)) {
        if (exited) throw new Error('the real worker daemon exited before it wrote its heartbeat')
        await Promise.race([sleep(25), watchdog.failed])
      }
      watchdog.progress('heartbeat written')
      expect(fs.readFileSync(beat, 'utf8').trim()).toBe(String(child.pid))

      killDaemonsUnder(root)
      while (!exited) await Promise.race([sleep(25), watchdog.failed])
    } finally {
      watchdog.stop()
    }

    expect(exited, 'the real worker daemon survived the sweep').toBe(true)
  })
})
