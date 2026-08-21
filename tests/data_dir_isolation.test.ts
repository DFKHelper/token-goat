// Regression guard: the test harness must resolve token-goat's DATA_DIR (global.db, config.toml) to an isolated temp location, never the developer's real %LOCALAPPDATA% / $XDG_DATA_HOME. Before tests/setup/isolate-home.ts isolated the data dir, every indexing test wrote token-goat's own symbols into the real global.db and raced the live worker daemon on it — a "database is locked" flake that passed on CI (no daemon) but failed locally. If a change drops the data-dir isolation from isolate-home.ts, dataDir()/globalDbPath() fall back to the real user data dir (under %LOCALAPPDATA% directly, not its Temp subdir) and these assertions fail.
import * as os from 'node:os'

import { describe, expect, it } from 'vitest'

import { dataDir, globalDbPath } from '../src/constants.js'

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
