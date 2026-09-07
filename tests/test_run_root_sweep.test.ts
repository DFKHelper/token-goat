/**
 * Tests for the stale-run-root sweep in tests/setup/build-bundle.ts.
 *
 * Test hygiene, not product behaviour: `tg-run-` appears nowhere in the shipped bundle. The globalSetup teardown that removes a run root only fires when the main vitest process exits normally, so every interrupted run (Ctrl-C, a killed agent, a crash) abandons its root; sweepStaleRunRoots() reclaims those on the next run.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { sweepStaleRunRoots } from './setup/build-bundle.js'

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
