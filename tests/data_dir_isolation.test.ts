// Regression guard: the test harness must resolve token-goat's DATA_DIR (global.db, config.toml) to an isolated temp location, never the developer's real %LOCALAPPDATA% / $XDG_DATA_HOME. Before tests/setup/isolate-home.ts isolated the data dir, every indexing test wrote token-goat's own symbols into the real global.db and raced the live worker daemon on it — a "database is locked" flake that passed on CI (no daemon) but failed locally. If a change drops the data-dir isolation from isolate-home.ts, dataDir()/globalDbPath() fall back to the real user data dir (under %LOCALAPPDATA% directly, not its Temp subdir) and these assertions fail.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { dataDir, globalDbPath } from '../src/constants.js'
import { indexableDir, tempDir } from './helpers/temp-config.js'
import { createRunRoot, INDEXABLE_TMP, sweepStaleRunRoots } from './setup/build-bundle.js'

describe('test data-dir isolation', () => {
  it('resolves dataDir() under the OS temp dir, not the real user data dir', () => {
    expect(dataDir().startsWith(os.tmpdir())).toBe(true)
  })

  it('resolves globalDbPath() under the OS temp dir so tests never touch the real index', () => {
    expect(globalDbPath().startsWith(os.tmpdir())).toBe(true)
  })

  // Both isolated directories are removed by a process.on("exit") handler in isolate-home.ts, and vitest
  // kills its workers rather than letting them exit, so that handler almost never fires. Created directly
  // in os.tmpdir() they therefore survived every run: 478,005 tg-test-data-* and 468,096 tg-test-home-*
  // directories had accumulated in one developer's %TEMP%, 67% of all 1,407,592 entries in it. globalSetup
  // now makes one root per run and deletes it from the main vitest process, which does exit normally, so
  // what the workers abandon goes with it -- but only while they are actually created inside that root.
  // Measured directly: three test files left 6 such directories before this, and 0 after.
  it('puts the isolated dirs inside the per-run root, so the run can clean up what killed workers abandon', () => {
    const runRoot = process.env['TG_TEST_RUN_ROOT']
    expect(runRoot).toBeTruthy()
    expect(dataDir().startsWith(String(runRoot))).toBe(true)
    expect(String(process.env['TOKEN_GOAT_HOME']).startsWith(String(runRoot))).toBe(true)
  })
})

// HAND-DERIVED: indexableDir() fixtures live under the repo's .tmp/ (the dirty queue refuses the OS temp dir), so the %TEMP% run root above never covered them, and each test file using one left a tg-test-cfg-* root with its files intact: 42 had built up in this checkout. Measured by running seven such files one at a time: each left exactly one.
describe('indexable fixture cleanup', () => {
  it('puts indexableDir() inside the run\'s own .tmp/ root, outside the OS temp dir', () => {
    const indexableRoot = process.env['TG_TEST_INDEXABLE_ROOT']
    expect(indexableRoot).toBeTruthy()
    expect(path.dirname(String(indexableRoot))).toBe(INDEXABLE_TMP)
    const dir = indexableDir()
    expect(dir.startsWith(String(indexableRoot) + path.sep)).toBe(true)
    expect(dir.startsWith(os.tmpdir())).toBe(false)
  })

  it('creates both run roots and removes both at teardown', () => {
    const saved = { run: process.env['TG_TEST_RUN_ROOT'], indexable: process.env['TG_TEST_INDEXABLE_ROOT'] }
    delete process.env['TG_TEST_RUN_ROOT']
    delete process.env['TG_TEST_INDEXABLE_ROOT']
    try {
      const teardown = createRunRoot()
      const run = String(process.env['TG_TEST_RUN_ROOT'])
      const indexable = String(process.env['TG_TEST_INDEXABLE_ROOT'])
      expect(typeof teardown).toBe('function')
      expect(path.dirname(indexable)).toBe(INDEXABLE_TMP)
      fs.writeFileSync(path.join(indexable, 'fixture.ts'), 'export const x = 1\n')
      expect(fs.existsSync(run) && fs.existsSync(indexable)).toBe(true)
      teardown?.()
      expect(fs.existsSync(run), 'the %TEMP% run root survived teardown').toBe(false)
      expect(fs.existsSync(indexable), 'the .tmp/ run root survived teardown').toBe(false)
    } finally {
      process.env['TG_TEST_RUN_ROOT'] = saved.run
      process.env['TG_TEST_INDEXABLE_ROOT'] = saved.indexable
    }
  })

  it('sweeps stale roots of each named prefix and nothing else', () => {
    const dir = tempDir()
    const old = (Date.now() - 7 * 60 * 60 * 1000) / 1000
    const make = (name: string, stale: boolean): string => {
      const full = path.join(dir, name)
      fs.mkdirSync(full)
      fs.writeFileSync(path.join(full, 'f'), 'x')
      if (stale) fs.utimesSync(full, old, old)
      return full
    }
    const staleRun = make('tg-run-a', true)
    const staleCfg = make('tg-test-cfg-b', true)
    const freshRun = make('tg-run-c', false)
    const staleOther = make('something-else', true)
    sweepStaleRunRoots(dir, ['tg-run-', 'tg-test-cfg-'])
    expect(fs.existsSync(staleRun)).toBe(false)
    expect(fs.existsSync(staleCfg)).toBe(false)
    expect(fs.existsSync(freshRun), 'a live run\'s root was swept').toBe(true)
    expect(fs.existsSync(staleOther), 'a directory with no run prefix was swept').toBe(true)
  })
})
