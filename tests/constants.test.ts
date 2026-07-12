import { describe, it, expect, vi, afterEach } from 'vitest'
import type * as os from 'node:os'
import * as path from 'node:path'
import { dataDirForHome } from '../src/constants.js'

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

    afterEach(() => {
      vi.doUnmock('node:os')
      vi.restoreAllMocks()
      vi.resetModules()
      if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA']
      else process.env['LOCALAPPDATA'] = savedLocalAppData
      if (savedXdg === undefined) delete process.env['XDG_DATA_HOME']
      else process.env['XDG_DATA_HOME'] = savedXdg
    })

    // The test harness (tests/setup/isolate-home.ts) unconditionally pins LOCALAPPDATA/
    // XDG_DATA_HOME so tests never touch the developer's real global.db. To exercise the
    // "no env override" fallback -- the branch `dataDir()` takes on a real machine with HOME/
    // USERPROFILE set to some home and no platform env var override -- clear both, mock
    // os.homedir(), and re-import the module fresh so its module-load-time DATA_DIR cache
    // picks up the mocked home. `dataDirForHome(homeDir)` must resolve to the exact same path.
    it('produces the same path dataDir() resolves to when HOME/USERPROFILE is set to a given directory', async () => {
      const fakeHome = process.platform === 'win32' ? 'C:\\Users\\fakehome' : '/home/fakehome'
      delete process.env['LOCALAPPDATA']
      delete process.env['XDG_DATA_HOME']
      vi.resetModules()
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof os>('node:os')
        return { ...actual, homedir: () => fakeHome }
      })
      const fresh = await import('../src/constants.js')
      expect(fresh.dataDirForHome(fakeHome)).toBe(fresh.dataDir())
    })
  })
})
