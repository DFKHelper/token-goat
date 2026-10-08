/** Tests for the stale-run-root sweep in tests/setup/build-bundle.ts. Test hygiene, not product behaviour: `tg-run-` appears nowhere in the shipped bundle. The globalSetup teardown that removes a run root only fires when the main vitest process exits normally, so every interrupted run (Ctrl-C, a killed agent, a crash) abandons its root; sweepStaleRunRoots() reclaims those on the next run. */
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
  // HAND-DERIVED: a daemon's heartbeat is a file queue/drain-heartbeat holding its pid (src/worker_lifecycle.ts::drainHeartbeatPathFor); a stand-in process is named by one here, and the contract is that a fresh heartbeat's pid is killed and a stale one's is not.
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

  function standIn(root: string, ageMs: number): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    spawned.push(child)
    const beat = path.join(root, 'tg-test-data-x', 'dfk-helper', 'token-goat', 'queue', 'drain-heartbeat')
    fs.mkdirSync(path.dirname(beat), { recursive: true })
    fs.writeFileSync(beat, `${child.pid}\n`)
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(beat, when, when)
    return child.pid as number
  }

  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('kills the pid a fresh heartbeat names, and leaves the pid a stale heartbeat names alone', async () => {
    const root = makeDir(`tg-run-killtest-${process.pid}-${Date.now()}`, 0)
    const live = standIn(root, 0)
    const staleRoot = makeDir(`tg-run-killtest-stale-${process.pid}-${Date.now()}`, 0)
    const reused = standIn(staleRoot, 5 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, 300))

    killDaemonsUnder(root)
    killDaemonsUnder(staleRoot)
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(isAlive(live), 'a daemon named by a fresh heartbeat survived').toBe(false)
    expect(isAlive(reused), 'a pid named only by a stale heartbeat was killed').toBe(true)
  })
})
