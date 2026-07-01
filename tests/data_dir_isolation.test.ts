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
})
