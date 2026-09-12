import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installZed, isZedInstalled, uninstallZed, zedSettingsPath, zedShimPath } from '../src/bridges/zed_install.js'
import { checkZed } from '../src/cli_doctor.js'

const savedAppData = process.env['APPDATA']
const savedXdgConfig = process.env['XDG_CONFIG_HOME']
const savedHome = process.env['HOME']
const savedUserProfile = process.env['USERPROFILE']
let userDir: string

// zedConfigDir() reads APPDATA directly on win32 and XDG_CONFIG_HOME/os.homedir() (HOME, with
// USERPROFILE as the win32 fallback) everywhere else, so every one of these needs isolating --
// same reasoning tests/install_vscode.test.ts documents for vscodeUserConfigDir().
function isolateZedConfigDir(dir: string): void {
  process.env['APPDATA'] = dir
  process.env['XDG_CONFIG_HOME'] = dir
  process.env['HOME'] = dir
  process.env['USERPROFILE'] = dir
}

beforeEach(() => {
  userDir = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-zed-userdir-'))
  isolateZedConfigDir(userDir)
})

afterEach(() => {
  if (savedAppData === undefined) delete process.env['APPDATA']
  else process.env['APPDATA'] = savedAppData
  if (savedXdgConfig === undefined) delete process.env['XDG_CONFIG_HOME']
  else process.env['XDG_CONFIG_HOME'] = savedXdgConfig
  if (savedHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = savedHome
  if (savedUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = savedUserProfile
  if (userDir && fs.existsSync(userDir)) fs.rmSync(userDir, { recursive: true, force: true })
})

describe('Zed install writes a context_servers entry and a shim script', () => {
  it('creates settings.json with only command and timeout on the token-goat entry', () => {
    const result = installZed()
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.settingsPath)).toBe(true)
    expect(fs.existsSync(result.shimPath)).toBe(true)

    const parsed = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')) as Record<string, unknown>
    const servers = parsed['context_servers'] as Record<string, unknown>
    const entry = servers['token-goat'] as Record<string, unknown>
    // Provenance: HAND-DERIVED from this file's own header docblock, which cites the live
    // process-tree trace (Zed.exe -> pwsh.exe -> cmd.exe -> node.exe mcp-serve) proving Zed
    // accepts and runs exactly this two-key shape.
    expect(Object.keys(entry).sort()).toEqual(['command', 'timeout'])
    expect(entry['command']).toBe(result.shimPath)
    expect(typeof entry['timeout']).toBe('number')
  })

  it('the shim script invokes the current Node binary and the bundled CLI with mcp-serve', () => {
    const result = installZed()
    const script = fs.readFileSync(result.shimPath, 'utf8')
    expect(script).toContain(process.execPath)
    expect(script).toContain('mcp-serve')
  })

  it('is idempotent: a second install reports alreadyInstalled and does not duplicate the entry', () => {
    installZed()
    const second = installZed()
    expect(second.alreadyInstalled).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(second.settingsPath, 'utf8')) as Record<string, unknown>
    const servers = parsed['context_servers'] as Record<string, unknown>
    expect(Object.keys(servers)).toEqual(['token-goat'])
  })

  it('isZedInstalled reflects install/uninstall state', () => {
    expect(isZedInstalled()).toBe(false)
    installZed()
    expect(isZedInstalled()).toBe(true)
    uninstallZed()
    expect(isZedInstalled()).toBe(false)
  })
})

describe('Zed install merges surgically into an existing settings.json', () => {
  it('preserves a user comment, unrelated keys, and another context server entry', () => {
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    // Provenance: CAPTURE -- this is the exact byte shape dogfooded live against a real Zed
    // settings.json during this feature's manual verification pass (comment + theme + a second
    // context_servers entry alongside token-goat's).
    const before = ['{', '  // user\'s own theme choice', '  "theme": "One Dark",', '  "context_servers": {', '    "some-other-server": {', '      "command": "/usr/local/bin/other-mcp",', '      "timeout": 5000', '    }', '  }', '}', ''].join('\n')
    fs.writeFileSync(settingsPath, before)

    installZed()

    const after = fs.readFileSync(settingsPath, 'utf8')
    expect(after).toContain("user's own theme choice")
    expect(after).toContain('"theme": "One Dark"')
    expect(after).toContain('/usr/local/bin/other-mcp')
    const parsed = JSON.parse(after.replace(/\/\/.*$/gm, '')) as Record<string, unknown>
    const servers = parsed['context_servers'] as Record<string, unknown>
    expect(Object.keys(servers).sort()).toEqual(['some-other-server', 'token-goat'])
  })

  it('uninstall removes only the token-goat entry, leaving the user file and its other server intact', () => {
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const before = JSON.stringify({ theme: 'One Dark', context_servers: { 'some-other-server': { command: '/usr/local/bin/other-mcp', timeout: 5000 } } }, null, 2) + '\n'
    fs.writeFileSync(settingsPath, before)

    installZed()
    expect(uninstallZed()).toBe(true)

    expect(fs.existsSync(settingsPath), 'uninstall deleted a file token-goat never created').toBe(true)
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>
    expect(after['theme']).toBe('One Dark')
    const servers = after['context_servers'] as Record<string, unknown>
    expect(Object.keys(servers)).toEqual(['some-other-server'])
  })
})

describe('Zed uninstall leaves no residue when token-goat created the file', () => {
  it('deletes settings.json and the shim once nothing of the user is left', () => {
    installZed()
    const settingsPath = zedSettingsPath()
    const shimPath = zedShimPath()
    expect(uninstallZed()).toBe(true)
    expect(fs.existsSync(settingsPath), 'uninstall left behind a file holding nothing but an empty context_servers object').toBe(false)
    expect(fs.existsSync(shimPath)).toBe(false)
  })

  it('uninstall on a clean system does nothing and returns false', () => {
    expect(uninstallZed()).toBe(false)
  })
})

describe('checkZed doctor report', () => {
  it('reports null when nothing is installed', () => {
    expect(checkZed(zedSettingsPath())).toBeNull()
  })

  it('reports ok when the entry and shim both exist and resolve', () => {
    installZed()
    const result = checkZed(zedSettingsPath())
    expect(result?.status).toBe('ok')
    expect(result?.message).toContain(zedSettingsPath())
  })

  it('reports warn when the shim script has been deleted out from under the entry', () => {
    installZed()
    fs.rmSync(zedShimPath(), { force: true })
    const result = checkZed(zedSettingsPath())
    expect(result?.status).toBe('warn')
    expect(result?.message).toContain(zedShimPath())
  })

  it('reports warn when the shim references a node/bundle path that no longer exists', () => {
    installZed()
    fs.writeFileSync(zedShimPath(), '@echo off\r\n"C:\\definitely\\does\\not\\exist\\node.exe" "C:\\also\\missing\\token-goat.mjs" mcp-serve\r\n')
    const result = checkZed(zedSettingsPath())
    expect(result?.status).toBe('warn')
    expect(result?.message).toContain('does')
  })
})

describe('Zed install refuses to clobber a foreign token-goat entry', () => {
  it('throws and leaves the file byte-for-byte unchanged', () => {
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    const before = JSON.stringify({ context_servers: { 'token-goat': { command: '/not/ours', timeout: 1 } } }, null, 2) + '\n'
    fs.writeFileSync(settingsPath, before)

    expect(() => installZed()).toThrow(/already has a "token-goat" context server entry/)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  it('throws before writing on a malformed settings.json', () => {
    const settingsPath = zedSettingsPath()
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
    fs.writeFileSync(settingsPath, '{ not valid json')
    expect(() => installZed()).toThrow()
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{ not valid json')
  })
})
