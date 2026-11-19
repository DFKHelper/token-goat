/** A UTF-8 byte-order mark at the head of a host config (what Notepad, PowerShell 5 `Set-Content -Encoding UTF8` and Visual Studio's "UTF-8 with signature" write) must not make install, uninstall or doctor refuse the file or report a live entry as missing. PROVENANCE: HAND-DERIVED. The BOM is the three bytes EF BB BF (U+FEFF), https://www.rfc-editor.org/rfc/rfc8259#section-8.1 ("implementations MAY ignore the presence of a byte order mark"); each fixture is the user's own JSON with those bytes prepended, and each expectation is computed from that JSON, not from a reader. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { antigravityHooksPath, installAntigravity, isAntigravityInstalled, uninstallAntigravity } from '../src/bridges/antigravity_install.js'
import { cursorManagedEntry, cursorMcpPath, installCursor, uninstallCursor } from '../src/bridges/cursor_install.js'
import { copilotMcpConfigPath, installCopilotMcpServer, isCopilotMcpServerInstalled, uninstallCopilotMcpServer } from '../src/bridges/copilot_mcp_install.js'
import { grokConfigPath, installGrok, uninstallGrok, wiredGrokHookWords } from '../src/bridges/grok_install.js'
import { installJetbrains, jetbrainsProjectMcpPath, uninstallJetbrains } from '../src/bridges/jetbrains_install.js'
import { installVisualStudio, uninstallVisualStudio, visualStudioManagedEntry, visualStudioUserMcpPath } from '../src/bridges/visualstudio_install.js'
import { installVscode, uninstallVscode, vscodeMcpPath } from '../src/bridges/vscode_install.js'
import { installZed, uninstallZed, zedManagedEntry, zedSettingsPath } from '../src/bridges/zed_install.js'
import { codexConfigPath, installCodex, uninstallCodex } from '../src/bridges/codex_install.js'
import { geminiSettingsPath, installGemini, uninstallGemini } from '../src/bridges/gemini_install.js'
import { installKimi, kimiConfigPath, uninstallKimi } from '../src/bridges/kimi_install.js'
import { claudeMdPath, installClaudeMd, installHooks, isInstalled, settingsPath, uninstallClaudeMd, uninstallHooks } from '../src/install.js'
import { checkGlobalMcpConfig } from '../src/cli_doctor_platforms.js'
import { hasManagedServer } from '../src/bridges/mcp_servers_json.js'
import { parseJsonOrJsonc, stripBom } from '../src/jsonc_text.js'

const BOM = String.fromCharCode(0xfeff)
const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'KIMI_CODE_HOME'] as const

let saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>
let fakeHome: string

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), '.tg-bom-'))
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  process.env['APPDATA'] = path.join(fakeHome, 'AppData', 'Roaming')
  process.env['LOCALAPPDATA'] = path.join(fakeHome, 'AppData', 'Local')
  process.env['XDG_CONFIG_HOME'] = path.join(fakeHome, '.config')
  process.env['XDG_DATA_HOME'] = path.join(fakeHome, '.local', 'share')
  delete process.env['KIMI_CODE_HOME']
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  fs.rmSync(fakeHome, { recursive: true, force: true })
})

function writeBom(file: string, json: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, BOM + stripBom(json), 'utf8')
}

/** The file starts with exactly one byte-order mark. */
function expectOneBom(file: string): void {
  const raw = fs.readFileSync(file, 'utf8')
  expect(raw.startsWith(BOM)).toBe(true)
  expect(raw.startsWith(BOM + BOM)).toBe(false)
}

function readJson(file: string): Record<string, unknown> {
  const raw = fs.readFileSync(file, 'utf8')
  return JSON.parse(raw.startsWith(BOM) ? raw.slice(1) : raw) as Record<string, unknown>
}

const OTHER = { command: 'x' }

describe('parseJsonOrJsonc and stripBom', () => {
  it('drops one leading U+FEFF and nothing else', () => {
    expect(stripBom(BOM + '{}')).toBe('{}')
    expect(stripBom('{}')).toBe('{}')
    expect(stripBom(BOM + BOM + '{}')).toBe(BOM + '{}')
  })

  it('parses strict JSON and JSONC behind a BOM', () => {
    expect(parseJsonOrJsonc(BOM + '{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonOrJsonc(BOM + '{"a":1, // note\n}')).toEqual({ a: 1 })
  })
})

describe('install, doctor reads and uninstall on a BOM-prefixed MCP config', () => {
  it('Cursor', () => {
    const file = cursorMcpPath()
    writeBom(file, JSON.stringify({ mcpServers: { other: OTHER } }))
    installCursor()
    expect(Object.keys(readJson(file)['mcpServers'] as object).sort()).toEqual(['other', 'token-goat'])
    expect(cursorManagedEntry(file)).not.toBeNull()
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(cursorManagedEntry(file)).not.toBeNull()
    expect(uninstallCursor()).toBe(true)
    expect(readJson(file)['mcpServers']).toEqual({ other: OTHER })
  })

  it('Visual Studio', () => {
    const file = visualStudioUserMcpPath()
    writeBom(file, JSON.stringify({ servers: { other: OTHER } }))
    installVisualStudio()
    expect(Object.keys(readJson(file)['servers'] as object).sort()).toEqual(['other', 'token-goat'])
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(visualStudioManagedEntry(file)).not.toBeNull()
    expect(uninstallVisualStudio()).toBe(true)
    expect(readJson(file)['servers']).toEqual({ other: OTHER })
  })

  it('VS Code', () => {
    const file = vscodeMcpPath({ project: true, projectRoot: fakeHome })
    writeBom(file, JSON.stringify({ servers: { other: OTHER } }))
    installVscode({ project: true, projectRoot: fakeHome })
    expect(Object.keys(readJson(file)['servers'] as object).sort()).toEqual(['other', 'token-goat'])
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(hasManagedServer(file, 'VS Code')).toBe(true)
    expect(uninstallVscode({ project: true, projectRoot: fakeHome })).toBe(true)
    expect(readJson(file)['servers']).toEqual({ other: OTHER })
  })

  it('Zed', () => {
    const file = zedSettingsPath()
    writeBom(file, JSON.stringify({ theme: 'One Dark', context_servers: { other: OTHER } }))
    installZed()
    expect(Object.keys(readJson(file)['context_servers'] as object).sort()).toEqual(['other', 'token-goat'])
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(zedManagedEntry(file)).not.toBeNull()
    expect(uninstallZed()).toBe(true)
    expect(readJson(file)).toEqual({ theme: 'One Dark', context_servers: { other: OTHER } })
  })

  it('Copilot CLI MCP', () => {
    const file = copilotMcpConfigPath()
    writeBom(file, JSON.stringify({ mcpServers: { other: OTHER } }))
    installCopilotMcpServer()
    expect(Object.keys(readJson(file)['mcpServers'] as object).sort()).toEqual(['other', 'token-goat'])
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(isCopilotMcpServerInstalled()).toBe(true)
    expect(uninstallCopilotMcpServer()).toBe(true)
    expect(readJson(file)['mcpServers']).toEqual({ other: OTHER })
  })

  it('JetBrains', () => {
    const file = jetbrainsProjectMcpPath(fakeHome)
    writeBom(file, JSON.stringify({ mcpServers: { other: OTHER } }))
    installJetbrains({ project: true, projectRoot: fakeHome })
    expect(Object.keys(readJson(file)['mcpServers'] as object).sort()).toEqual(['other', 'token-goat'])
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(uninstallJetbrains({ project: true, projectRoot: fakeHome })).toBe(true)
    expect(readJson(file)['mcpServers']).toEqual({ other: OTHER })
  })

  it('doctor audits a BOM-prefixed global Copilot MCP config instead of reporting it unreadable', () => {
    const file = path.join(fakeHome, 'mcp-config.json')
    writeBom(file, JSON.stringify({ mcpServers: { other: OTHER } }))
    expect(checkGlobalMcpConfig(file).message).not.toContain('could not read')
  })
})

describe('hook configs behind a BOM', () => {
  it('Grok: reinstall keeps the user hooks file and doctor still sees the wired hooks', () => {
    const file = grokConfigPath()
    installGrok()
    const wired = wiredGrokHookWords().length
    expect(wired).toBeGreaterThan(0)
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(wiredGrokHookWords().length).toBe(wired)
    installGrok()
    expect(wiredGrokHookWords().length).toBe(wired)
    uninstallGrok()
    expect(wiredGrokHookWords()).toEqual([])
  })

  it('Claude Code settings.json: install merges next to the user keys and uninstall keeps them', () => {
    const file = settingsPath('user')
    writeBom(file, JSON.stringify({ model: 'opus' }))
    installHooks('user')
    expect(readJson(file)['model']).toBe('opus')
    expect(readJson(file)['hooks']).toBeDefined()
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(isInstalled('user')).toBe(true)
    expect(uninstallHooks('user')).toBe(true)
    expect(readJson(file)['model']).toBe('opus')
  })

  it('Antigravity: the hooks file is still recognised as installed', () => {
    installAntigravity()
    const file = antigravityHooksPath()
    writeBom(file, fs.readFileSync(file, 'utf8'))
    expect(isAntigravityInstalled()).toBe(true)
    expect(uninstallAntigravity()).toBe(true)
  })
})

describe('a rewrite keeps the byte-order mark the user saved the file with', () => {
  const MCP_HOSTS: ReadonlyArray<{ name: string; file: () => string; key: string; install: () => unknown; uninstall: () => unknown }> = [
    { name: 'Cursor', file: () => cursorMcpPath(), key: 'mcpServers', install: () => installCursor(), uninstall: () => uninstallCursor() },
    { name: 'Visual Studio', file: () => visualStudioUserMcpPath(), key: 'servers', install: () => installVisualStudio(), uninstall: () => uninstallVisualStudio() },
    { name: 'VS Code', file: () => vscodeMcpPath({ project: true, projectRoot: fakeHome }), key: 'servers', install: () => installVscode({ project: true, projectRoot: fakeHome }), uninstall: () => uninstallVscode({ project: true, projectRoot: fakeHome }) },
    { name: 'Zed', file: () => zedSettingsPath(), key: 'context_servers', install: () => installZed(), uninstall: () => uninstallZed() },
    { name: 'Copilot CLI MCP', file: () => copilotMcpConfigPath(), key: 'mcpServers', install: () => installCopilotMcpServer(), uninstall: () => uninstallCopilotMcpServer() },
    { name: 'JetBrains', file: () => jetbrainsProjectMcpPath(fakeHome), key: 'mcpServers', install: () => installJetbrains({ project: true, projectRoot: fakeHome }), uninstall: () => uninstallJetbrains({ project: true, projectRoot: fakeHome }) },
  ]

  for (const host of MCP_HOSTS) {
    it(`${host.name} MCP config`, () => {
      const file = host.file()
      writeBom(file, JSON.stringify({ [host.key]: { other: OTHER } }))
      host.install()
      expectOneBom(file)
      host.uninstall()
      expectOneBom(file)
      expect(readJson(file)[host.key]).toEqual({ other: OTHER })
    })
  }

  it('Claude Code settings.json', () => {
    const file = settingsPath('user')
    writeBom(file, JSON.stringify({ model: 'opus' }))
    installHooks('user')
    expectOneBom(file)
    uninstallHooks('user')
    expectOneBom(file)
  })

  it('Gemini settings.json', () => {
    const file = geminiSettingsPath()
    writeBom(file, JSON.stringify({ theme: 'Dracula' }))
    installGemini()
    expectOneBom(file)
    uninstallGemini()
    expectOneBom(file)
    expect(readJson(file)['theme']).toBe('Dracula')
  })

  it('Codex config.toml', () => {
    const file = codexConfigPath()
    writeBom(file, 'model = "o3"\n')
    installCodex()
    expectOneBom(file)
    uninstallCodex()
    expectOneBom(file)
    expect(fs.readFileSync(file, 'utf8')).toContain('model = "o3"')
  })

  // HAND-DERIVED: a static `PreToolUse = []` cannot be extended by an appended `[[hooks.PreToolUse]]` table, so install and uninstall both take the whole-file rewrite rather than the in-place block edit.
  it('Codex config.toml the delimited block cannot express', () => {
    const file = codexConfigPath()
    writeBom(file, 'model = "o3"\n\n[hooks]\nPreToolUse = []\n')
    installCodex()
    expectOneBom(file)
    expect(fs.readFileSync(file, 'utf8')).not.toContain('managed block')
    uninstallCodex()
    expectOneBom(file)
    expect(fs.readFileSync(file, 'utf8')).toContain('model = "o3"')
  })

  it('Kimi config.toml', () => {
    const file = kimiConfigPath()
    writeBom(file, 'default_model = "k2"\n')
    installKimi()
    expectOneBom(file)
    uninstallKimi()
    expectOneBom(file)
    expect(fs.readFileSync(file, 'utf8')).toContain('default_model = "k2"')
  })

  it('the CLAUDE.md guidance block', () => {
    const file = claudeMdPath('user')
    writeBom(file, '# My notes\n')
    installClaudeMd('user')
    expectOneBom(file)
    uninstallClaudeMd('user')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${BOM}# My notes\n`)
  })

  // HAND-DERIVED: JS `\s` matches U+FEFF, so trimming the text around the block takes a mark that nothing else precedes with it.
  it('a CLAUDE.md holding only the mark, with notes added after the block later', () => {
    const file = claudeMdPath('user')
    writeBom(file, '')
    installClaudeMd('user')
    expectOneBom(file)
    fs.appendFileSync(file, '\n# Added later\n', 'utf8')
    uninstallClaudeMd('user')
    expect(fs.readFileSync(file, 'utf8')).toBe(`${BOM}# Added later\n`)
  })

  it('a file saved without a mark is not given one', () => {
    const file = cursorMcpPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: OTHER } }), 'utf8')
    installCursor()
    expect(fs.readFileSync(file, 'utf8').startsWith(BOM)).toBe(false)
  })
})
