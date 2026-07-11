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
  opencodeEntrySidecarPath,
  opencodePluginPath,
  uninstallOpencode,
} from '../src/bridges/opencode_install.js'
import { OPENCODE_PLUGIN_SCRIPT } from '../src/bridges/opencode.js'
import { HOOK_EVENTS } from '../src/types.js'

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

describe("installOpencode entry-path sidecar (PATH-hardening for the plugin's inner token-goat call)", () => {
  it('writes token-goat-entry.json next to the plugin file, containing the running entry (process.argv[1])', () => {
    expect(process.argv[1]).toBeDefined()
    const result = installOpencode()
    const sidecarPath = opencodeEntrySidecarPath()
    expect(sidecarPath).toBe(path.join(path.dirname(result.pluginPath), 'token-goat-entry.json'))
    expect(fs.existsSync(sidecarPath)).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as { entryPath: string }
    expect(sidecar.entryPath).toBe(process.argv[1])
  })

  it('uninstallOpencode removes the sidecar along with the plugin file', () => {
    installOpencode()
    expect(fs.existsSync(opencodeEntrySidecarPath())).toBe(true)
    uninstallOpencode()
    expect(fs.existsSync(opencodeEntrySidecarPath())).toBe(false)
    expect(fs.existsSync(opencodePluginPath())).toBe(false)
  })

  it('uninstallOpencode does not throw when no sidecar was ever written (an install predating this fix)', () => {
    installOpencode()
    fs.unlinkSync(opencodeEntrySidecarPath())
    expect(() => uninstallOpencode()).not.toThrow()
    expect(fs.existsSync(opencodePluginPath())).toBe(false)
  })
})

describe('OPENCODE_PLUGIN_SCRIPT speaks the real hook protocol', () => {
  it('every callHook(...) event-name literal is a real HOOK_EVENTS member', () => {
    const calls = [...OPENCODE_PLUGIN_SCRIPT.matchAll(/callHook\("([^"]+)"/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const eventName of calls) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })

  it('excludes glob from PRE_HOOK_TOOLS, since no pre_tool_use handler exists for it', () => {
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(OPENCODE_PLUGIN_SCRIPT)
    expect(match).not.toBeNull()
    expect(match?.[1]).not.toMatch(/"glob"/)
  })

  // Regression: callHook's inner spawnSync("token-goat", [...]) depended on PATH
  // resolution with no shell:true -- on Windows, a global npm install resolves
  // "token-goat" to a .cmd/.ps1 shim, which spawnSync cannot exec without
  // shell: true, so every hook call silently failed (r.error set, callHook
  // returning null). resolveEntryPath() reads an install-time sidecar (see
  // installOpencode in opencode_install.ts) so callHook can invoke the real
  // token-goat entry directly via process.execPath instead, mirroring pi.ts's
  // identical fix.
  it('reads the baked entry path via resolveEntryPath() before falling back to a bare PATH-resolved "token-goat"', () => {
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/function resolveEntryPath\(\)/)
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/token-goat-entry\.json/)
    // The spawnSync fallback now lives in callHookViaSpawn -- callHook itself tries the
    // in-process hook lib (resolveRelayInProcess) first, only calling callHookViaSpawn
    // when that's unavailable. See the "in-process hook call" describe block below for
    // coverage of the in-process path taking priority and never spawning a process.
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(OPENCODE_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    expect(body).toMatch(/resolveEntryPath\(\)/)
    expect(body).toMatch(/spawnSync\(process\.execPath, \[entryPath, "hook", event\]/)
    expect(body).toMatch(/spawnSync\("token-goat hook "/)
  })

  it('fallback spawnSync uses shell:true so it resolves .cmd shims on Windows', () => {
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(OPENCODE_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    const fallbackMatch = /: spawnSync\("token-goat hook "[\s\S]*?\}\)/.exec(body)
    expect(fallbackMatch).not.toBeNull()
    const fallbackBlock = fallbackMatch?.[0] ?? ''
    expect(fallbackBlock).toContain('shell: true')
    expect(fallbackBlock).toContain('token-goat hook')
  })

  // Regression: callHook used to spawnSync a whole second node process
  // (`token-goat hook <event>`) for every single tool call in this long-lived plugin
  // host. It now tries an in-process import() of the sibling dist/token-goat-hook.mjs
  // hook lib first, falling back to callHookViaSpawn only when that's unavailable.
  it('tries the in-process hook lib (resolveRelayInProcess) before ever calling callHookViaSpawn', () => {
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/function resolveRelayInProcess\(\)/)
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/token-goat-hook\.mjs/)
    expect(OPENCODE_PLUGIN_SCRIPT).toMatch(/await import\(pathToFileURL\(hookLibPath\)\.href\)/)
    const callHookMatch = /async function callHook\([\s\S]*?\n\}/.exec(OPENCODE_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    const inProcessIndex = body.indexOf('resolveRelayInProcess')
    const spawnFallbackIndex = body.indexOf('callHookViaSpawn')
    expect(inProcessIndex).toBeGreaterThanOrEqual(0)
    expect(spawnFallbackIndex).toBeGreaterThan(inProcessIndex)
  })
})
