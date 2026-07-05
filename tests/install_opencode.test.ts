import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.config/opencode/` or `%APPDATA%\opencode\` (mirrors
// the pattern in install_pi.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  installOpencode,
  isOpencodeInstalled,
  opencodePluginPath,
  uninstallOpencode,
} from '../src/bridges/opencode_install.js'
import { OPENCODE_PLUGIN_SCRIPT } from '../src/bridges/opencode.js'

const setPlatform = (p: string): void => {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

let TMP: string
let realPlatform: string
let origAppData: string | undefined

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-opencode-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(path.join(TMP, 'home'))

  realPlatform = process.platform
  origAppData = process.env['APPDATA']
  // Always sandbox APPDATA into TMP by default, regardless of host platform --
  // on a real Windows host, opencodeGlobalConfigDir()'s win32 branch reads
  // process.env.APPDATA directly, so without this every test here would read
  // and write the developer's real %APPDATA%\opencode\ (mirrors the homedir
  // mock above, which only isolates the non-Windows branch). Individual tests
  // below override this further where they need to exercise a specific branch.
  process.env['APPDATA'] = path.join(TMP, 'appdata')
})

afterEach(() => {
  setPlatform(realPlatform)
  if (origAppData === undefined) {
    delete process.env['APPDATA']
  } else {
    process.env['APPDATA'] = origAppData
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('opencodePluginPath', () => {
  it('resolves under ~/.config/opencode/plugins on non-Windows', () => {
    setPlatform('linux')
    expect(opencodePluginPath()).toBe(
      path.join(TMP, 'home', '.config', 'opencode', 'plugins', 'token-goat.ts'),
    )
  })

  it('resolves under %APPDATA%\\opencode\\plugins on Windows', () => {
    setPlatform('win32')
    process.env['APPDATA'] = path.join(TMP, 'appdata')
    expect(opencodePluginPath()).toBe(
      path.join(TMP, 'appdata', 'opencode', 'plugins', 'token-goat.ts'),
    )
  })

  it('falls back to ~/AppData/Roaming on Windows when APPDATA is unset', () => {
    setPlatform('win32')
    delete process.env['APPDATA']
    expect(opencodePluginPath()).toBe(
      path.join(TMP, 'home', 'AppData', 'Roaming', 'opencode', 'plugins', 'token-goat.ts'),
    )
  })
})

describe('installOpencode', () => {
  it('writes the plugin file with the exact embedded template on a fresh install', () => {
    const result = installOpencode()
    expect(result.alreadyInstalled).toBe(false)
    expect(result.pluginPath).toBe(opencodePluginPath())
    expect(fs.existsSync(result.pluginPath)).toBe(true)
    expect(fs.readFileSync(result.pluginPath, 'utf8')).toBe(OPENCODE_PLUGIN_SCRIPT)
    expect(isOpencodeInstalled()).toBe(true)
  })

  it('is idempotent: a second install reports alreadyInstalled and does not alter the file', () => {
    installOpencode()
    const second = installOpencode()
    expect(second.alreadyInstalled).toBe(true)
    expect(fs.readFileSync(second.pluginPath, 'utf8')).toBe(OPENCODE_PLUGIN_SCRIPT)
  })

  it('overwrites a hand-modified file wholesale instead of merging or warning', () => {
    // Design decision (documented in opencode_install.ts): the plugin is a
    // single generated artifact with no merge target -- opencode auto-discovers
    // whatever file sits in its plugins directory, so there is no config file
    // to merge into. install always reconciles it to the current template on
    // any content difference, with no .bak and no confirmation prompt (the
    // same reasoning as installPi/installCodex).
    const p = opencodePluginPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '// a user hand-edited this file\nexport const TokenGoatPlugin = async () => ({})\n')

    const result = installOpencode()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(p, 'utf8')).toBe(OPENCODE_PLUGIN_SCRIPT)
    // No backup file left behind for this single-file artifact.
    const siblings = fs.readdirSync(path.dirname(p))
    expect(siblings.some((f) => f.includes('.bak'))).toBe(false)
  })
})

describe('isOpencodeInstalled / uninstallOpencode', () => {
  it('isOpencodeInstalled is false before install, true after', () => {
    expect(isOpencodeInstalled()).toBe(false)
    installOpencode()
    expect(isOpencodeInstalled()).toBe(true)
  })

  it('uninstallOpencode removes the file and returns true', () => {
    const result = installOpencode()
    expect(uninstallOpencode()).toBe(true)
    expect(fs.existsSync(result.pluginPath)).toBe(false)
    expect(isOpencodeInstalled()).toBe(false)
  })

  it('uninstallOpencode returns false when nothing is installed', () => {
    expect(uninstallOpencode()).toBe(false)
  })
})
