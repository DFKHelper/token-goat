/** Tests for the stale-run-root sweep in tests/setup/build-bundle.ts. Test hygiene, not product behaviour: `tg-run-` appears nowhere in the shipped bundle. The globalSetup teardown that removes a run root only fires when the main vitest process exits normally, so every interrupted run (Ctrl-C, a killed agent, a crash) abandons its root; sweepStaleRunRoots() reclaims those on the next run. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

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
  // The death condition of a stand-in that can outlive the test (one detached from the runner's process tree): it polls whether the vitest process that started it is still alive and exits once it is not. It never looks at its parent daemon, so a root-only kill of the daemon leaves the child running, as a real tree would be.
  const OWNER_PID_ENV = 'TG_STAND_IN_OWNER_PID'
  const OWNER_LIVENESS_SOURCE = `const owner = Number(process.env.${OWNER_PID_ENV}); setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 1000)`
  // HAND-DERIVED: a daemon with a child of its own; the child shares the daemon's stdout pipe (stdio inherit), so that pipe closes only once both are gone, and the daemon prints "ready <child pid>". On Windows the child is detached so that it is not in the job object libuv gives the daemon's non-detached children, which the OS closes, ending them, when the daemon dies: without that the child would die with a root-only kill and the test could not tell it from a tree kill. This is a stand-in for the process tree the real daemon leads, not a wire format.
  const STAND_IN_WITH_CHILD_SOURCE = `import { spawn } from 'node:child_process'
// owner: the vitest process that started this daemon (its pid is in ${OWNER_PID_ENV}); dies when that process is gone, found by the liveness check both processes run
const child = spawn(process.execPath, ['-e', ${JSON.stringify(OWNER_LIVENESS_SOURCE)}], { stdio: ['ignore', 'inherit', 'ignore'], windowsHide: true, detached: process.platform === 'win32' })
process.stdout.write('ready ' + child.pid + ' ')
${OWNER_LIVENESS_SOURCE}
`

  const spawned: ChildProcess[] = []
  // Pids of processes a stand-in daemon started itself, reaped by afterEach when the sweep under test did not end them.
  const grandchildPids: number[] = []
  afterEach(() => {
    for (const c of spawned.splice(0)) {
      try {
        if (c.pid !== undefined) process.kill(c.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
    for (const pid of grandchildPids.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  interface Started {
    pid: number
    /** Resolves once the process has started and rejects if it exits first. */
    ready: Promise<void>
    /** Resolves when the process has exited, by any cause. */
    exited: Promise<void>
    /** Resolves when the process has exited and every holder of its stdout pipe has closed it, a process it started and passed the pipe to included. */
    closed: Promise<void>
    /** Everything the process has printed so far. */
    output: () => string
  }

  /** Starts `node ...argv`, which must print "ready" once it is running. `detached` makes it lead its own process group, as the real daemon does, which is what a POSIX tree kill signals. */
  function start(argv: string[], options: { env?: NodeJS.ProcessEnv; detached?: boolean } = {}): Started {
    // owner: this test, whose afterEach kills it; dies when the vitest process is gone, because a stand-in started detached (the only kind that outlives the runner's tree) polls for that process and exits
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: options.env ?? process.env, detached: options.detached === true })
    spawned.push(child)
    let printed = ''
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout?.on('data', (chunk: Buffer) => {
        printed += chunk.toString()
        if (printed.includes('ready')) resolve()
      })
      child.once('exit', (code) => reject(new Error(`stand-in exited with ${String(code)} before it was ready`)))
    })
    // A stand-in killed by the test itself, or by afterEach, must not surface as an unhandled rejection.
    ready.catch(() => undefined)
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
    return { pid: child.pid as number, ready, exited, closed, output: () => printed }
  }

  /** A script a stand-in daemon runs as its launcher, in a directory removed after the test. */
  function launcherScript(label: string, source: string = STAND_IN_SOURCE): string {
    const dir = makeDir(`tg-run-killtest-${label}-${process.pid}-${Date.now()}`, 0)
    const script = path.join(dir, 'launcher.mjs')
    fs.writeFileSync(script, source)
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

  /** Sweeps `bystander` first, then `target` (named by `daemon`) and waits for `daemon`'s exit event: a kill wrongly sent for the bystander was issued before the daemon's, so once the daemon is seen exited that kill has been delivered too, and the bystander's survival is not a race against it. No clock bounds the wait: a sweep that never kills `daemon` ends only when vitest's testTimeout fires, and that failure reads "Test timed out" under the name of the test that ran this, which is the only place the cause is named. */
  async function sweepThenWaitForDaemon(bystander: string, target: string, daemon: Started, entryScript?: string): Promise<void> {
    await daemon.ready
    killDaemonsUnder(bystander, entryScript)
    killDaemonsUnder(target, entryScript)
    await daemon.exited
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

  it('ends the tree of the worker daemon it kills, not only the daemon', async () => {
    const launcher = launcherScript('tree', STAND_IN_WITH_CHILD_SOURCE)
    // owner: the vitest process, which passes its pid in the stand-in's environment; dies when that process is gone, because the launcher and its child poll for it
    const daemon = start([launcher, WORKER_DAEMON_FLAG], { detached: process.platform !== 'win32', env: { ...process.env, [OWNER_PID_ENV]: String(process.pid) } })
    const root = rootNaming('tree', daemon.pid, 0)
    await daemon.ready
    const childPid = Number(/ready (\d+) /.exec(daemon.output())?.[1])
    expect(Number.isInteger(childPid) && childPid > 0, `the daemon did not print its child's pid: ${daemon.output()}`).toBe(true)
    grandchildPids.push(childPid)

    killDaemonsUnder(root, launcher)
    await daemon.exited
    // The daemon's child holds the stdout pipe too, so the pipe closes only when the child is gone as well; a kill of the daemon alone leaves this unresolved until vitest's testTimeout fires.
    await daemon.closed
  })

  it.skipIf(process.platform !== 'win32')('kills a worker daemon whose command line spells the launcher with a different drive-letter case', async (ctx) => {
    const launcher = launcherScript('case')
    const drive = /^([A-Za-z]):/.exec(launcher)?.[1]
    if (drive === undefined) return ctx.skip()
    const flipped = (drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()) + launcher.slice(1)
    const daemon = start([flipped, WORKER_DAEMON_FLAG])
    const root = rootNaming('case', daemon.pid, 0)
    const noHeartbeats = makeDir(`tg-run-killtest-none-${process.pid}-${Date.now()}`, 0)
    await sweepThenWaitForDaemon(noHeartbeats, root, daemon, launcher)
    expect(isAlive(daemon.pid), 'a daemon whose launcher differs only in drive-letter case survived the sweep').toBe(false)
  })

  it('kills the real worker daemon of the built bundle with no launcher passed', async () => {
    const bundle = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'token-goat.mjs')
    const root = makeDir(`tg-run-killtest-real-${process.pid}-${Date.now()}`, 0)
    const dataDirectory = path.dirname(path.dirname(heartbeatPath(root)))
    // The queue directory too, so the watch below has a directory to watch before the daemon exists.
    fs.mkdirSync(path.dirname(heartbeatPath(root)), { recursive: true })
    // The daemon prints nothing, so its own heartbeat is the readiness signal, awaited by a directory watch and raced against the process exiting: no clock decides how long a cold boot may take.
    const child = spawn(process.execPath, [bundle, WORKER_DAEMON_FLAG], { stdio: 'ignore', windowsHide: true, env: { ...process.env, TG_WORKER_DATA_DIR: dataDirectory } })
    spawned.push(child)
    const exited = new Promise<'exited'>((resolve) => child.once('exit', () => resolve('exited')))
    const beat = heartbeatPath(root)
    let watcher: fs.FSWatcher | undefined
    const written = new Promise<'written'>((resolve) => {
      watcher = fs.watch(path.dirname(beat), () => {
        if (fs.existsSync(beat)) resolve('written')
      })
      if (fs.existsSync(beat)) resolve('written')
    })
    try {
      expect(await Promise.race([written, exited]), 'the real worker daemon exited before it wrote its heartbeat').toBe('written')
      expect(fs.readFileSync(beat, 'utf8').trim()).toBe(String(child.pid))

      killDaemonsUnder(root)
      await exited
    } finally {
      watcher?.close()
    }

    expect(child.exitCode !== null || child.signalCode !== null, 'the real worker daemon survived the sweep').toBe(true)
  })

  it('kills a worker daemon whose command line spells the launcher by its real path while the sweep is given a link to it', async (ctx) => {
    const launcher = fs.realpathSync.native(launcherScript('d'))
    const linkHome = makeDir(`tg-run-killtest-link-${process.pid}-${Date.now()}`, 0)
    const link = path.join(linkHome, 'link')
    try {
      // A junction on Windows, which needs no privilege; a directory symlink elsewhere.
      fs.symlinkSync(path.dirname(launcher), link, 'junction')
    } catch {
      return ctx.skip()
    }
    try {
      const daemon = start([launcher, WORKER_DAEMON_FLAG])
      const root = rootNaming('linked', daemon.pid, 0)
      const noHeartbeats = makeDir(`tg-run-killtest-none-${process.pid}-${Date.now()}`, 0)
      await sweepThenWaitForDaemon(noHeartbeats, root, daemon, path.join(link, path.basename(launcher)))
      expect(isAlive(daemon.pid), 'a daemon whose launcher is spelled by its real path survived a sweep given the link').toBe(false)
    } finally {
      // Removes the link, never what it points at: a junction is a directory entry to Windows, a symlink a file entry elsewhere.
      if (process.platform === 'win32') fs.rmdirSync(link)
      else fs.unlinkSync(link)
    }
  })
})
