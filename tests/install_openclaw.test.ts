import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir (delegating to the real implementation by
// default) so each test below can point `~` at an isolated temp dir instead of
// touching the real `~/.openclaw/` (mirrors the pattern in install_gemini.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  OpenclawConfigParseError,
  installOpenclaw,
  isOpenclawInstalled,
  openclawConfigPath,
  openclawPluginPath,
  uninstallOpenclaw,
} from '../src/bridges/openclaw_install.js'
import { OPENCLAW_PLUGIN_SCRIPT } from '../src/bridges/openclaw.js'
import { HOOK_EVENTS } from '../src/types.js'

interface OpenclawSettingsShape {
  plugins?: {
    load?: { paths?: string[] }
    entries?: Record<string, { enabled?: boolean }>
  }
  [key: string]: unknown
}

function readSettings(): OpenclawSettingsShape {
  return JSON.parse(fs.readFileSync(openclawConfigPath(), 'utf8')) as OpenclawSettingsShape
}

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-openclaw-install-'))
  const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
  homedirMock.mockReturnValue(TMP)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('installOpenclaw', () => {
  it('drops the plugin file and registers it in openclaw.json on a fresh install', () => {
    const result = installOpenclaw()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.pluginPath)).toBe(true)
    expect(fs.readFileSync(result.pluginPath, 'utf8')).toBe(OPENCLAW_PLUGIN_SCRIPT)

    const settings = readSettings()
    expect(settings.plugins?.load?.paths).toContain(openclawPluginPath())
    expect(settings.plugins?.entries?.['token-goat']).toEqual({ enabled: true })

    expect(isOpenclawInstalled()).toBe(true)
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate the load path)', () => {
    installOpenclaw()
    const second = installOpenclaw()
    expect(second.alreadyInstalled).toBe(true)

    const settings = readSettings()
    const paths = settings.plugins?.load?.paths ?? []
    expect(paths.filter((p) => p === openclawPluginPath())).toHaveLength(1)
  })

  it('refreshes the plugin file in place when its content is stale', () => {
    const pluginPath = openclawPluginPath()
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true })
    fs.writeFileSync(pluginPath, '// stale content')

    const result = installOpenclaw()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(OPENCLAW_PLUGIN_SCRIPT)
  })

  it('preserves pre-existing unrelated openclaw.json keys and plugin entries', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          gateway: { port: 4141 },
          plugins: {
            load: { paths: ['/some/other/plugin.ts'] },
            entries: { 'other-plugin': { enabled: true } },
          },
        },
        null,
        2,
      ),
    )

    installOpenclaw()

    const settings = readSettings()
    expect(settings['gateway']).toEqual({ port: 4141 })
    expect(settings.plugins?.load?.paths).toContain('/some/other/plugin.ts')
    expect(settings.plugins?.load?.paths).toContain(openclawPluginPath())
    expect(settings.plugins?.entries?.['other-plugin']).toEqual({ enabled: true })
    expect(settings.plugins?.entries?.['token-goat']).toEqual({ enabled: true })
  })

  it('writes a timestamped .bak of openclaw.json before an in-place edit', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ gateway: { port: 4141 } }))

    installOpenclaw()

    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('openclaw.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const backupContent = fs.readFileSync(path.join(path.dirname(p), backups[0] as string), 'utf8')
    expect(backupContent).toBe(JSON.stringify({ gateway: { port: 4141 } }))
  })

  it('throws on an existing openclaw.json with invalid JSON, and leaves both the config and plugin file untouched', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Deliberately unparseable: a trailing comma before the closing brace.
    const corrupt = '{ "gateway": { "port": 4141 }, }'
    fs.writeFileSync(p, corrupt)

    expect(() => installOpenclaw()).toThrow(OpenclawConfigParseError)
    expect(() => installOpenclaw()).toThrow(/invalid JSON/)

    // installOpenclaw must never reach the config write (or the plugin-file
    // write, which is ordered after config parsing) when the config file
    // existed but failed to parse -- the corrupt-but-recoverable file must be
    // left exactly as the user left it, not silently clobbered.
    expect(fs.readFileSync(p, 'utf8')).toBe(corrupt)
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
  })

  it('throws on an existing openclaw.json whose top-level value is not an object, and leaves the file untouched', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const nonObject = '[1, 2, 3]'
    fs.writeFileSync(p, nonObject)

    expect(() => installOpenclaw()).toThrow(OpenclawConfigParseError)
    expect(() => installOpenclaw()).toThrow(/does not contain a JSON object/)
    expect(fs.readFileSync(p, 'utf8')).toBe(nonObject)
  })
})

describe('isOpenclawInstalled / uninstallOpenclaw', () => {
  it('isOpenclawInstalled is false before install, true after', () => {
    expect(isOpenclawInstalled()).toBe(false)
    installOpenclaw()
    expect(isOpenclawInstalled()).toBe(true)
  })

  it('isOpenclawInstalled is false when only the plugin file or only the config entry is present', () => {
    installOpenclaw()

    // Remove just the config entry -- plugin file remains on disk.
    const p = openclawConfigPath()
    const settings = readSettings()
    delete settings.plugins?.entries?.['token-goat']
    fs.writeFileSync(p, JSON.stringify(settings, null, 2))
    expect(isOpenclawInstalled()).toBe(false)
  })

  it('uninstallOpenclaw removes the plugin file and config entries, returns true', () => {
    installOpenclaw()
    expect(uninstallOpenclaw()).toBe(true)
    expect(isOpenclawInstalled()).toBe(false)
    expect(fs.existsSync(openclawPluginPath())).toBe(false)

    const settings = readSettings()
    expect(settings.plugins?.load?.paths ?? []).not.toContain(openclawPluginPath())
    expect(settings.plugins?.entries?.['token-goat']).toBeUndefined()
  })

  it('uninstallOpenclaw returns false when nothing is installed', () => {
    expect(uninstallOpenclaw()).toBe(false)
  })

  it('uninstallOpenclaw collapses openclaw.json back to an empty object when nothing else was in it (no dangling empty plugins/load/entries)', () => {
    installOpenclaw()
    uninstallOpenclaw()

    const raw = fs.readFileSync(openclawConfigPath(), 'utf8')
    expect(JSON.parse(raw)).toEqual({})
  })

  it('uninstall leaves unrelated openclaw.json keys and plugin entries intact', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify(
        {
          gateway: { port: 4141 },
          plugins: {
            load: { paths: ['/some/other/plugin.ts'] },
            entries: { 'other-plugin': { enabled: true } },
          },
        },
        null,
        2,
      ),
    )

    installOpenclaw()
    uninstallOpenclaw()

    const settings = readSettings()
    expect(settings['gateway']).toEqual({ port: 4141 })
    expect(settings.plugins?.load?.paths).toContain('/some/other/plugin.ts')
    expect(settings.plugins?.load?.paths).not.toContain(openclawPluginPath())
    expect(settings.plugins?.entries?.['other-plugin']).toEqual({ enabled: true })
    expect(settings.plugins?.entries?.['token-goat']).toBeUndefined()
  })

  it('writes a timestamped .bak of openclaw.json before removing entries', () => {
    installOpenclaw()
    uninstallOpenclaw()

    const p = openclawConfigPath()
    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('openclaw.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
  })
})

describe('OPENCLAW_PLUGIN_SCRIPT speaks the real hook protocol', () => {
  it('every callHook(...) event-name literal is a real HOOK_EVENTS member', () => {
    const calls = [...OPENCLAW_PLUGIN_SCRIPT.matchAll(/callHook\("([^"]+)"/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    for (const eventName of calls) {
      expect(HOOK_EVENTS as readonly string[]).toContain(eventName)
    }
  })

  it('excludes Glob from PRE_HOOK_TOOLS, since no pre_tool_use handler exists for it', () => {
    const match = /const PRE_HOOK_TOOLS = new Set\(\[([^\]]+)\]\)/.exec(OPENCLAW_PLUGIN_SCRIPT)
    expect(match).not.toBeNull()
    expect(match?.[1]).not.toMatch(/"Glob"/)
  })
})
