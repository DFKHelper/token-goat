import { describe, it, expect, vi, afterEach } from 'vitest'
import type * as os from 'node:os'
import { spawnSync } from 'node:child_process'
import * as path from 'node:path'
import { dataDirForHome, dataDir, _resetDataDirCacheForTesting } from '../src/constants.js'
import { BUNDLE } from './helpers/bundle.js'

describe('dataDirForHome', () => {
  // Regression: dataDirForHome (used by `stats --home-dir` via stats.ts::getGlobalDb) used to
  // be a separately hand-rolled copy of defaultDataDir's platform branching that had drifted
  // out of sync -- on Windows it was missing the `AppData\Local` segment entirely, and on
  // Linux it never honoured the platform convention consistently. It must produce the exact
  // same platform-appropriate layout defaultDataDir() computes for the real home directory.
  it('matches the platform-specific layout for a synthetic home directory', () => {
    const platform = process.platform
    const home = platform === 'win32' ? 'C:\\Users\\someone' : '/home/someone'
    const expected =
      platform === 'win32'
        ? path.join(home, 'AppData', 'Local', 'dfk-helper', 'token-goat')
        : platform === 'darwin'
          ? path.join(home, 'Library', 'Application Support', 'token-goat')
          : path.join(home, '.local', 'share', 'token-goat')
    expect(dataDirForHome(home)).toBe(expected)
  })

  describe('agreement with dataDir()', () => {
    const savedLocalAppData = process.env['LOCALAPPDATA']
    const savedXdg = process.env['XDG_DATA_HOME']
    const savedAllowReal = process.env['VITEST_ALLOW_REAL_DATA_DIR']

    afterEach(() => {
      vi.doUnmock('node:os')
      vi.restoreAllMocks()
      vi.resetModules()
      if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = savedLocalAppData
      if (savedXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = savedXdg
      if (savedAllowReal === undefined) delete process.env['VITEST_ALLOW_REAL_DATA_DIR']
      else process.env['VITEST_ALLOW_REAL_DATA_DIR'] = savedAllowReal
    })

    // The test harness (tests/setup/isolate-home.ts) unconditionally pins LOCALAPPDATA/
    // XDG_DATA_HOME so tests never touch the developer's real global.db. To exercise the
    // "no env override" fallback -- the branch `dataDir()` takes on a real machine with HOME/
    // USERPROFILE set to some home and no platform env var override -- clear both, mock
    // os.homedir(), and re-import the module fresh so its module-load-time DATA_DIR cache
    // picks up the mocked home. `dataDirForHome(homeDir)` must resolve to the exact same path.
    // VITEST_ALLOW_REAL_DATA_DIR opts this test out of the homeFallbackOrGuard() guard below,
    // which otherwise refuses this exact clear-LOCALAPPDATA-and-fall-through shape inside a
    // Vitest worker (os.homedir() being mocked to a synthetic path is what makes this safe).
    it('produces the same path dataDir() resolves to when HOME/USERPROFILE is set to a given directory', async () => {
      const fakeHome = process.platform === 'win32' ? 'C:\\Users\\fakehome' : '/home/fakehome'
      delete process.env['LOCALAPPDATA']
      delete process.env['XDG_DATA_HOME']
      process.env['VITEST_ALLOW_REAL_DATA_DIR'] = '1'
      vi.resetModules()
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof os>('node:os')
        return { ...actual, homedir: () => fakeHome }
      })
      const fresh = await import('../src/constants.js')
      expect(fresh.dataDirForHome(fakeHome)).toBe(fresh.dataDir())
    })
  })

  // Regression: DATA_DIR is cached at module-load time (see the doc comment on
  // _resetDataDirCacheForTesting in constants.ts), so a test file that overrides
  // LOCALAPPDATA/XDG_DATA_HOME per-test (mirroring the already-established TOKEN_GOAT_HOME
  // per-test pattern used elsewhere in this suite) would otherwise see dataDir() keep returning
  // whatever value was cached the first time this module was imported in this worker process --
  // silently defeating the override with no error. _resetDataDirCacheForTesting must make
  // dataDir() pick up the new override immediately, without going through vi.resetModules()
  // (which this same describe block's other test documents as itself causing cross-file
  // pollution when used on this module).
  it('_resetDataDirCacheForTesting makes dataDir() pick up a fresh LOCALAPPDATA/XDG_DATA_HOME override', () => {
    const savedLocalAppData = process.env['LOCALAPPDATA']
    const savedXdg = process.env['XDG_DATA_HOME']
    try {
      const before = dataDir()
      const override = path.join(before, 'a-fresh-override-dir')
      process.env['LOCALAPPDATA'] = override
      process.env['XDG_DATA_HOME'] = override
      // Without the reset, dataDir() would still return `before` here -- the whole point under test.
      expect(dataDir()).toBe(before)
      _resetDataDirCacheForTesting()
      expect(dataDir()).not.toBe(before)
      if (process.platform === 'win32') {
        expect(dataDir()).toBe(path.join(override, 'dfk-helper', 'token-goat'))
      } else {
        // darwin honors XDG_DATA_HOME as its isolation-override escape hatch too (see
        // defaultDataDir()'s darwin branch in constants.ts) even though a real Mac
        // essentially never sets it -- same join shape as linux/BSD.
        expect(dataDir()).toBe(path.join(override, 'token-goat'))
      }
    } finally {
      if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = savedLocalAppData
      if (savedXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = savedXdg
      _resetDataDirCacheForTesting()
    }
  })

  // Regression: production config.toml was found on this developer's machine holding
  // large_file_skip_kb=1 and skip_dirs=["a"] -- unmistakable test-fixture values -- which
  // silently broke real indexing (every real source file over 1 KB became skip-eligible).
  // Root cause: something cleared LOCALAPPDATA/XDG_DATA_HOME without supplying a replacement,
  // so defaultDataDir() fell through to the real os.homedir() and wrote straight into the
  // developer's real data dir. homeFallbackOrGuard() now refuses that fallback inside a
  // Vitest-flagged process instead of silently corrupting real data.
  //
  // Spawned as a real child process (not an in-process `import()`), deliberately: constants.ts
  // computes its module-level DATA_DIR at top-level module evaluation, so triggering the guard
  // in-process means the dynamic import's top-level throw, which can leave that module
  // specifier's registry entry permanently errored for the rest of the worker -- proven to
  // cross-pollute unrelated later test files in this exact suite (cache_session_commands.test.ts
  // failing an unrelated assertion when run after an in-process version of this test). A real
  // subprocess has its own throwaway module registry, so this cannot happen.
  it('refuses to start rather than resolve DATA_DIR against the real home directory when LOCALAPPDATA/XDG_DATA_HOME are unset', () => {
    const env = { ...process.env }
    delete env['LOCALAPPDATA']
    delete env['XDG_DATA_HOME']
    delete env['VITEST_ALLOW_REAL_DATA_DIR']
    env['VITEST_WORKER_ID'] = '1'
    const result = spawnSync(process.execPath, [BUNDLE, 'config', 'get', 'indexing.large_file_skip_kb'], {
      env,
      encoding: 'utf8',
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refusing to resolve DATA_DIR')
  })

  // Regression, provable on any host OS by mocking process.platform: same bug as the
  // subprocess test below, but exercised in-process so it's actually red/green-provable on a
  // non-darwin dev machine (the subprocess variant below only runs its assertion for real on
  // an actual darwin runner). Before the fix, this threw "refusing to resolve DATA_DIR" even
  // with XDG_DATA_HOME set, because the darwin branch never looked at it.
  it('mocked as darwin: resolves DATA_DIR via XDG_DATA_HOME instead of throwing inside a Vitest worker', () => {
    const originalPlatform = process.platform
    const savedXdg = process.env['XDG_DATA_HOME']
    const savedLocalAppData = process.env['LOCALAPPDATA']
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const override = path.join(process.env['TMPDIR'] ?? '/tmp', 'tg-darwin-xdg-mock-test')
      process.env['XDG_DATA_HOME'] = override
      delete process.env['LOCALAPPDATA']
      expect(() => _resetDataDirCacheForTesting()).not.toThrow()
      expect(dataDir()).toBe(path.join(override, 'token-goat'))
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      if (savedXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = savedXdg
      if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = savedLocalAppData
      _resetDataDirCacheForTesting()
    }
  })

  // Regression: darwin's defaultDataDir() branch used to skip straight to
  // homeFallbackOrGuard() with no env-var override check at all (unlike win32's LOCALAPPDATA
  // check and linux's XDG_DATA_HOME check just above/below it), so it threw unconditionally
  // inside any Vitest worker even though tests/setup/isolate-home.ts unconditionally pins
  // XDG_DATA_HOME for every platform specifically to prevent that. This was invisible locally
  // and on win32/linux CI (their branches never reach the darwin code) and first surfaced when
  // a macOS CI job actually ran the suite: 179/260 test files failed with exactly this guard
  // error. Only meaningfully exercises the fixed branch on an actual darwin runner; on
  // win32/linux this assertion is inert (the subprocess isn't running as darwin), which is why
  // the macOS CI job -- not this test alone -- is what closes the coverage gap.
  it.skipIf(process.platform !== 'darwin')(
    'resolves DATA_DIR via an XDG_DATA_HOME override on darwin instead of throwing',
    () => {
      const env = { ...process.env }
      const override = path.join(process.env['TMPDIR'] ?? '/tmp', 'tg-darwin-xdg-override-test')
      delete env['LOCALAPPDATA']
      env['XDG_DATA_HOME'] = override
      env['VITEST_WORKER_ID'] = '1'
      const result = spawnSync(process.execPath, [BUNDLE, 'config', 'get', 'indexing.large_file_skip_kb'], {
        env,
        encoding: 'utf8',
      })
      expect(result.status).toBe(0)
      expect(result.stderr).not.toContain('refusing to resolve DATA_DIR')
    },
  )
})
