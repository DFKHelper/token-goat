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
  openclawEntrySidecarPath,
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
    // Regression: the entry-path sidecar used to be written unconditionally
    // BEFORE the strict config parse, so a corrupt openclaw.json still left
    // a stray token-goat-entry.json behind even though the install as a
    // whole aborted and the plugin config was never touched. The sidecar
    // write must now happen only after the strict parse succeeds.
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(false)
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

  it('throws on plugins.load.paths being a bare string instead of an array, and leaves the file untouched', () => {
    // Regression: readOpenclawConfig cast the parsed JSON straight to OpenclawSettings with no
    // validation of the nested plugins.load.paths shape. A hand-edited config with a bare
    // string there made installOpenclaw's `[...(plugins.load?.paths ?? [])]` spread the string
    // into individual characters and silently persist that garbage back to disk.
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const malformed = JSON.stringify({ plugins: { load: { paths: 'not-an-array' } } })
    fs.writeFileSync(p, malformed)

    expect(() => installOpenclaw()).toThrow(OpenclawConfigParseError)
    expect(() => installOpenclaw()).toThrow(/plugins\.load\.paths.*isn't a JSON array/)
    expect(fs.readFileSync(p, 'utf8')).toBe(malformed)
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

  it('uninstallOpenclaw and isOpenclawInstalled do not throw when plugins.load.paths is a bare string (non-strict read drops the malformed field instead of crashing)', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ plugins: { load: { paths: 'not-an-array' } } }))

    expect(() => isOpenclawInstalled()).not.toThrow()
    expect(isOpenclawInstalled()).toBe(false)
    expect(() => uninstallOpenclaw()).not.toThrow()
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

describe("installOpenclaw entry-path sidecar (PATH-hardening for the plugin's inner token-goat call)", () => {
  it('writes token-goat-entry.json next to the plugin file, containing the running entry (process.argv[1])', () => {
    expect(process.argv[1]).toBeDefined()
    const result = installOpenclaw()
    const sidecarPath = openclawEntrySidecarPath()
    expect(sidecarPath).toBe(path.join(path.dirname(result.pluginPath), 'token-goat-entry.json'))
    expect(fs.existsSync(sidecarPath)).toBe(true)
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8')) as { entryPath: string }
    expect(sidecar.entryPath).toBe(process.argv[1])
  })

  it('uninstallOpenclaw removes the sidecar along with the plugin file', () => {
    installOpenclaw()
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(true)
    uninstallOpenclaw()
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(false)
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
  })

  it('uninstallOpenclaw does not throw when no sidecar was ever written (an install predating this fix)', () => {
    installOpenclaw()
    fs.unlinkSync(openclawEntrySidecarPath())
    expect(() => uninstallOpenclaw()).not.toThrow()
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
  })

  it('does not write the sidecar when openclaw.json exists but fails the strict parse (regression: the sidecar used to be written unconditionally before the strict config parse, so a corrupt config still left a stray token-goat-entry.json on disk even though installOpenclaw() aborted before touching the plugin config)', () => {
    const p = openclawConfigPath()
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const corrupt = '{ "gateway": { "port": 4141 }, }'
    fs.writeFileSync(p, corrupt)

    expect(() => installOpenclaw()).toThrow(OpenclawConfigParseError)
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(false)
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
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

  // Regression: the after_tool_call handler built its post_tool_use payload with
  // session_id/tool_name/tool_input/cwd but never forwarded tool_response, so
  // extractReadOutput (src/hooks_read.ts) and hooks_bash's truncation-marker/
  // exit-code extraction always saw undefined tool_response for OpenClaw, even
  // though the equivalent forwarding works for opencode.ts and pi.ts.
  it('forwards event.result as tool_response in the post_tool_use payload, mirroring opencode.ts/pi.ts', () => {
    const match = /api\.on\("after_tool_call",[\s\S]*?\n {4}\}\);/.exec(OPENCLAW_PLUGIN_SCRIPT)
    expect(match).not.toBeNull()
    const handlerBody = match?.[0] ?? ''
    expect(handlerBody).toMatch(/tool_response/)
    expect(handlerBody).toMatch(/event\.result/)
  })

  // Regression: callHook's inner spawnSync("token-goat", [...]) depended on PATH
  // resolution with no shell:true -- on Windows, a global npm install resolves
  // "token-goat" to a .cmd/.ps1 shim, which spawnSync cannot exec without
  // shell: true, so every hook call silently failed (r.error set, callHook
  // returning null). resolveEntryPath() reads an install-time sidecar (see
  // installOpenclaw in openclaw_install.ts) so callHook can invoke the real
  // token-goat entry directly via process.execPath instead, mirroring pi.ts's
  // identical fix.
  it('reads the baked entry path via resolveEntryPath() before falling back to a bare PATH-resolved "token-goat"', () => {
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/function resolveEntryPath\(\)/)
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/token-goat-entry\.json/)
    // The spawnSync fallback now lives in callHookViaSpawn -- callHook itself tries the
    // in-process hook lib (resolveRelayInProcess) first, only calling callHookViaSpawn
    // when that's unavailable. See the "in-process hook call" describe block below for
    // coverage of the in-process path taking priority and never spawning a process.
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(OPENCLAW_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    expect(body).toMatch(/resolveEntryPath\(\)/)
    expect(body).toMatch(/spawnSync\(process\.execPath, \[entryPath, "hook", event\]/)
    expect(body).toMatch(/spawnSync\("token-goat hook "/)
  })

  it('fallback spawnSync uses shell:true so it resolves .cmd shims on Windows', () => {
    const callHookMatch = /function callHookViaSpawn\([\s\S]*?\n\}/.exec(OPENCLAW_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    const fallbackMatch = /: spawnSync\("token-goat hook "[\s\S]*?\}\)/.exec(body)
    expect(fallbackMatch).not.toBeNull()
    const fallbackBlock = fallbackMatch?.[0] ?? ''
    expect(fallbackBlock).toContain('shell: true')
    expect(fallbackBlock).toContain('token-goat hook')
  })

  // Regression: callHook used to spawnSync a whole second node process
  // (`token-goat hook <event>`) for every single tool call in this long-lived gateway
  // process. It now tries an in-process import() of the sibling dist/token-goat-hook.mjs
  // hook lib first, falling back to callHookViaSpawn only when that's unavailable.
  it('tries the in-process hook lib (resolveRelayInProcess) before ever calling callHookViaSpawn', () => {
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/function resolveRelayInProcess\(\)/)
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/token-goat-hook\.mjs/)
    expect(OPENCLAW_PLUGIN_SCRIPT).toMatch(/await import\(pathToFileURL\(hookLibPath\)\.href\)/)
    const callHookMatch = /async function callHook\([\s\S]*?\n\}/.exec(OPENCLAW_PLUGIN_SCRIPT)
    expect(callHookMatch).not.toBeNull()
    const body = callHookMatch?.[0] ?? ''
    const inProcessIndex = body.indexOf('resolveRelayInProcess')
    const spawnFallbackIndex = body.indexOf('callHookViaSpawn')
    expect(inProcessIndex).toBeGreaterThanOrEqual(0)
    expect(spawnFallbackIndex).toBeGreaterThan(inProcessIndex)
  })
})
