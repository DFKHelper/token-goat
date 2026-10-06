/** The Antigravity CLI (agy) installer writes a plugin directory of its own, `~/.gemini/config/plugins/token-goat/`, and nothing else under `~/.gemini`: the global hooks.json there belongs to the user and to other tools. These tests pin the on-disk shape, that a user's own entries and manifest survive both install and uninstall, and that uninstall takes back exactly what install created. Provenance: the hooks.json shape (`{ "<hook name>": { "<Event>": [{ "matcher", "hooks": [{ "type": "command", "command", "timeout" }] }] } }`) and the plugin.json `name` marker are FORMAT-DERIVED from https://atamel.dev/posts/2026/07-16_where_agy_hooks/ and were confirmed as a CAPTURE against agy 1.2.11 on Windows (a probe plugin in a workspace `.agents/plugins/` directory whose hooks fired). The Windows command form `.\token-goat-hook.cmd <event>` is also a CAPTURE from that probe: a quoted absolute path in the command string failed under agy's `cmd /c`, a bare `shim.cmd` failed, and `.\shim.cmd` ran with the plugin directory as its working directory. The "user's own" hooks and manifest values below are HAND-DERIVED. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted: homedir delegates to the real one by default and each test points it at a temp directory, so nothing here can touch a real ~/.gemini.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import {
  AntigravitySettingsParseError,
  antigravityHookCommand,
  antigravityHooksPath,
  antigravityPluginDir,
  installAntigravity,
  isAntigravityInstalled,
  uninstallAntigravity,
} from '../src/bridges/antigravity_install.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

type HooksFile = Record<string, Record<string, { matcher: string; hooks: { type: string; command: string; timeout: number }[] }[]>>

let TMP: string
let restoreEntry: () => void

function readHooks(): HooksFile {
  return JSON.parse(fs.readFileSync(antigravityHooksPath(), 'utf8')) as HooksFile
}

function manifestPath(): string {
  return path.join(antigravityPluginDir(), 'plugin.json')
}

function shimPath(): string {
  return path.join(antigravityPluginDir(), 'token-goat-hook.cmd')
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-agy-install-'))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(TMP)
  restoreEntry = pinInstalledEntry(TMP)
})

afterEach(() => {
  restoreEntry()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('antigravityHookCommand', () => {
  it('on Windows, runs the shim by a dot-relative name, since agy mangles quotes in the command string and cmd will not find a bare name in the working directory', () => {
    expect(antigravityHookCommand('pre_tool_use', 'win32')).toBe('.\\token-goat-hook.cmd pre_tool_use')
  })

  it('elsewhere, runs node and the entry by absolute, quoted path and names the harness as a flag', () => {
    const command = antigravityHookCommand('post_tool_use', 'linux')
    expect(command).toContain(process.argv[1])
    expect(command).toContain(process.execPath)
    expect(command.endsWith('hook post_tool_use --harness antigravity')).toBe(true)
  })

  it('quotes both paths, so an install under a directory with a space still runs', () => {
    process.argv[1] = path.join(TMP, 'my tools', 'token-goat.mjs')
    expect(antigravityHookCommand('post_tool_use', 'linux')).toBe(`"${process.execPath}" "${process.argv[1]}" hook post_tool_use --harness antigravity`)
  })
})

describe('installAntigravity', () => {
  it('creates the plugin manifest and a hooks.json with token-goat wired to PreToolUse and PostToolUse only', () => {
    const result = installAntigravity()

    expect(result).toEqual({ pluginDir: path.join(TMP, '.gemini', 'config', 'plugins', 'token-goat'), alreadyInstalled: false })
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))).toEqual({ name: 'token-goat' })
    const hooks = readHooks()
    expect(Object.keys(hooks)).toEqual(['token-goat'])
    expect(Object.keys(hooks['token-goat'] ?? {})).toEqual(['PreToolUse', 'PostToolUse'])
    expect(hooks['token-goat']?.['PreToolUse']).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: antigravityHookCommand('pre_tool_use'), timeout: 30 }] }])
    expect(hooks['token-goat']?.['PostToolUse']?.[0]?.hooks[0]?.command).toBe(antigravityHookCommand('post_tool_use'))
    // The global hooks file is the user's and is never created or edited.
    expect(fs.existsSync(path.join(TMP, '.gemini', 'config', 'hooks.json'))).toBe(false)
  })

  it.runIf(process.platform === 'win32')('writes a CRLF batch shim that carries the quoted absolute paths and doubles any % in them', () => {
    process.argv[1] = path.join(TMP, 'odd 100%dir', 'token-goat', 'dist', 'token-goat.mjs')

    installAntigravity()

    const shim = fs.readFileSync(shimPath(), 'utf8')
    expect(shim).toBe(`@"${process.execPath.replace(/%/g, '%%')}" "${process.argv[1].replace(/%/g, '%%')}" hook %1 --harness antigravity\r\n@exit /b %ERRORLEVEL%\r\n`)
    expect(shim).toContain('100%%dir')
  })

  it.runIf(process.platform !== 'win32')('writes no shim outside Windows, where sh -c takes the quoted command directly', () => {
    installAntigravity()
    expect(fs.existsSync(shimPath())).toBe(false)
  })

  it('reports an unchanged second install as already installed and rewrites nothing', () => {
    installAntigravity()
    const before = fs.statSync(antigravityHooksPath()).mtimeMs
    const hooksText = fs.readFileSync(antigravityHooksPath(), 'utf8')

    expect(installAntigravity().alreadyInstalled).toBe(true)
    expect(fs.readFileSync(antigravityHooksPath(), 'utf8')).toBe(hooksText)
    expect(fs.statSync(antigravityHooksPath()).mtimeMs).toBe(before)
  })

  it('replaces a stale token-goat entry from an older install and reports the change', () => {
    installAntigravity()
    const stale = readHooks()
    stale['token-goat'] = { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'old-token-goat hook pre_tool_use', timeout: 5 }] }] }
    fs.writeFileSync(antigravityHooksPath(), JSON.stringify(stale))

    expect(installAntigravity().alreadyInstalled).toBe(false)
    expect(readHooks()['token-goat']?.['PreToolUse']?.[0]?.hooks[0]?.command).toBe(antigravityHookCommand('pre_tool_use'))
    expect(Object.keys(readHooks()['token-goat'] ?? {})).toEqual(['PreToolUse', 'PostToolUse'])
  })

  it('keeps a user hook and a user manifest already in the directory', () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    const userManifest = { name: 'token-goat', description: 'my own notes' }
    fs.writeFileSync(manifestPath(), JSON.stringify(userManifest))
    const userHook = { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo done', timeout: 5 }] }] }
    fs.writeFileSync(antigravityHooksPath(), JSON.stringify({ mine: userHook }))

    installAntigravity()

    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))).toEqual(userManifest)
    expect(readHooks()['mine']).toEqual(userHook)
    expect(readHooks()['token-goat']).toBeDefined()
  })

  it.each([
    ['invalid JSON', '{ not json'],
    ['a top-level array', '[]'],
  ])('refuses a hooks.json holding %s and writes nothing at all', (_label, content) => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(antigravityHooksPath(), content)

    expect(() => installAntigravity()).toThrow(AntigravitySettingsParseError)
    expect(fs.readFileSync(antigravityHooksPath(), 'utf8')).toBe(content)
    expect(fs.existsSync(manifestPath())).toBe(false)
    expect(fs.existsSync(shimPath())).toBe(false)
  })

  it('refuses a hooks.json it cannot read at all, such as a directory in its place, and writes nothing', () => {
    fs.mkdirSync(antigravityHooksPath(), { recursive: true })

    expect(() => installAntigravity()).toThrow(AntigravitySettingsParseError)
    expect(() => installAntigravity()).toThrow(/exists but cannot be read/)
    expect(fs.existsSync(manifestPath())).toBe(false)
  })

  it('refuses an unreadable plugin.json before writing the hooks file', () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(manifestPath(), '{ nope')

    expect(() => installAntigravity()).toThrow(/plugin manifest .* invalid JSON/)
    expect(fs.existsSync(antigravityHooksPath())).toBe(false)
  })
})

describe('uninstallAntigravity', () => {
  it('takes back everything a fresh install created, down to the ~/.gemini it had to make', () => {
    installAntigravity()

    expect(uninstallAntigravity()).toBe(true)
    expect(fs.existsSync(path.join(TMP, '.gemini'))).toBe(false)
  })

  it('leaves ~/.gemini/config and its other contents when they were there before install', () => {
    const configDir = path.join(TMP, '.gemini', 'config')
    fs.mkdirSync(configDir, { recursive: true })
    const globalHooks = path.join(configDir, 'hooks.json')
    fs.writeFileSync(globalHooks, '{"orca":{}}')

    installAntigravity()
    uninstallAntigravity()

    expect(fs.readFileSync(globalHooks, 'utf8')).toBe('{"orca":{}}')
    expect(fs.existsSync(path.join(configDir, 'plugins'))).toBe(false)
  })

  it("removes only token-goat's entry and keeps the user's hooks file, manifest and directory", () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    const userManifest = { name: 'token-goat' }
    fs.writeFileSync(manifestPath(), JSON.stringify(userManifest))
    fs.writeFileSync(antigravityHooksPath(), JSON.stringify({ mine: {} }))
    installAntigravity()

    expect(uninstallAntigravity()).toBe(true)

    expect(readHooks()).toEqual({ mine: {} })
    // Identical to what token-goat would write, but the user wrote it first, so it stays.
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))).toEqual(userManifest)
    expect(fs.existsSync(shimPath())).toBe(false)
  })

  it("keeps the user's manifest even when it reads exactly like token-goat's and the hooks file is gone", () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(manifestPath(), JSON.stringify({ name: 'token-goat' }))
    installAntigravity()

    expect(uninstallAntigravity()).toBe(true)

    expect(fs.existsSync(antigravityHooksPath())).toBe(false)
    expect(JSON.parse(fs.readFileSync(manifestPath(), 'utf8'))).toEqual({ name: 'token-goat' })
  })

  it('keeps a hooks.json that existed before install even once it is empty', () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(antigravityHooksPath(), '{}')
    installAntigravity()

    uninstallAntigravity()

    expect(readHooks()).toEqual({})
  })

  it('leaves a same-named shim that is not token-goat\'s', () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(shimPath(), '@echo mine\r\n')

    expect(uninstallAntigravity()).toBe(false)
    expect(fs.readFileSync(shimPath(), 'utf8')).toBe('@echo mine\r\n')
  })

  it('reports nothing removed when nothing is installed', () => {
    expect(uninstallAntigravity()).toBe(false)
  })

  it('refuses an unparseable hooks.json and leaves it as it was', () => {
    installAntigravity()
    fs.writeFileSync(antigravityHooksPath(), '{ broken')

    expect(() => uninstallAntigravity()).toThrow(/Uninstall left it and its backups untouched/)
    expect(fs.readFileSync(antigravityHooksPath(), 'utf8')).toBe('{ broken')
  })
})

describe('isAntigravityInstalled', () => {
  it('is false on a clean home and true after install', () => {
    expect(isAntigravityInstalled()).toBe(false)
    installAntigravity()
    expect(isAntigravityInstalled()).toBe(true)
  })

  it('stays true for a stale entry from an older token-goat, because uninstall would still remove it', () => {
    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(antigravityHooksPath(), JSON.stringify({ 'token-goat': { PreToolUse: [] } }))

    expect(isAntigravityInstalled()).toBe(true)
  })

  it('is false after uninstall, and false for a hooks file holding only other hooks', () => {
    installAntigravity()
    uninstallAntigravity()
    expect(isAntigravityInstalled()).toBe(false)

    fs.mkdirSync(antigravityPluginDir(), { recursive: true })
    fs.writeFileSync(antigravityHooksPath(), JSON.stringify({ mine: {} }))
    expect(isAntigravityInstalled()).toBe(false)
  })
})
