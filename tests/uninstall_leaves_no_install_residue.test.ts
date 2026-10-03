/** A fresh home round-trips through install and uninstall to no leftover file or directory, and a file or directory the user already had survives. PROVENANCE: the failing scenario is CAPTURE: `install --codex --gemini --qwen --kimi --opencode --openclaw --copilot --grok --cursor --zed --pi` then `uninstall` with the same flags, from a fresh isolated home on Windows 11, left `.gemini/settings.json`, `.qwen/settings.json` and `.openclaw/openclaw.json` holding `{}`, `.kimi-code/config.toml` holding one newline, a 0-byte `.kimi-code/AGENTS.md`, 0-byte `.codex/AGENTS.md` and `.codex/config.toml`, and empty `.codex/hooks`, `.kimi-code/hooks`, `.kimi-code/skills`, `.openclaw/plugins`, `.grok/hooks`, `.config/opencode/plugins`, `.pi/agent/extensions`, `.cursor` and `Zed` directories. Config locations are FORMAT-DERIVED from each bridge module's own doc comment (Gemini `~/.gemini/settings.json`, Qwen `~/.qwen/settings.json`, OpenClaw `~/.openclaw/openclaw.json`, Kimi Code `~/.kimi-code/config.toml`, opencode `$XDG_CONFIG_HOME/opencode/plugins`). The user-owned fixtures (a settings file with `theme`, a pre-made empty directory) are HAND-DERIVED. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return { ...original, homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)) }
})

import * as os from 'node:os'

import { dataDir } from '../src/constants.js'
import { installCodex, uninstallCodex } from '../src/bridges/codex_install.js'
import { installCursor, uninstallCursor } from '../src/bridges/cursor_install.js'
import { geminiSettingsPath, installGemini, uninstallGemini } from '../src/bridges/gemini_install.js'
import { installGrok, uninstallGrok } from '../src/bridges/grok_install.js'
import { installKimi, uninstallKimi } from '../src/bridges/kimi_install.js'
import { installOpencode, uninstallOpencode } from '../src/bridges/opencode_install.js'
import { installOpenclaw, uninstallOpenclaw } from '../src/bridges/openclaw_install.js'
import { installPi, uninstallPi } from '../src/bridges/pi_install.js'
import { installQwen, qwenSettingsPath, uninstallQwen } from '../src/bridges/qwen_install.js'
import { installZed, uninstallZed } from '../src/bridges/zed_install.js'
import '../src/relay.js'

const ENV_KEYS = ['KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'APPDATA'] as const

let TMP: string
let HOME: string
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

const BRIDGES: Array<{ name: string; install: () => unknown; uninstall: () => unknown }> = [
  { name: 'codex', install: installCodex, uninstall: uninstallCodex },
  { name: 'gemini', install: installGemini, uninstall: uninstallGemini },
  { name: 'qwen', install: installQwen, uninstall: uninstallQwen },
  { name: 'kimi', install: installKimi, uninstall: uninstallKimi },
  { name: 'openclaw', install: installOpenclaw, uninstall: uninstallOpenclaw },
  { name: 'opencode', install: installOpencode, uninstall: uninstallOpencode },
  { name: 'pi', install: () => installPi(), uninstall: () => uninstallPi() },
  { name: 'grok', install: installGrok, uninstall: uninstallGrok },
  { name: 'cursor', install: () => installCursor(), uninstall: () => uninstallCursor() },
  { name: 'zed', install: installZed, uninstall: uninstallZed },
]

beforeEach(() => {
  TMP = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-residue-')))
  HOME = path.join(TMP, 'home')
  fs.mkdirSync(HOME, { recursive: true })
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(HOME)
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  delete process.env['KIMI_CODE_HOME']
  process.env['XDG_CONFIG_HOME'] = path.join(HOME, '.config')
  // Not created: a fresh machine has no per-user config root either, and the Zed bridge makes it.
  process.env['APPDATA'] = path.join(TMP, 'appdata')
  fs.rmSync(path.join(dataDir(), 'created-configs.json'), { force: true })
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** Every file and directory under `root`, as root-relative paths. */
function listTree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      out.push(path.relative(TMP, full).split(path.sep).join('/'))
      if (entry.isDirectory()) walk(full)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out.sort()
}

describe('uninstall in a fresh home', () => {
  for (const bridge of BRIDGES) {
    it(`${bridge.name}: install then uninstall leaves nothing behind`, () => {
      bridge.install()
      expect(listTree(TMP).length).toBeGreaterThan(0)
      bridge.uninstall()
      expect(listTree(TMP)).toEqual(['home'])
    })
  }

  it('every bridge installed together round-trips to an empty home, and a second install is idempotent', () => {
    for (const bridge of BRIDGES) bridge.install()
    for (const bridge of BRIDGES) bridge.install()
    for (const bridge of BRIDGES) bridge.uninstall()
    expect(listTree(TMP)).toEqual(['home'])
  })
})

describe('uninstall with files the user already had', () => {
  it('keeps a Gemini settings file that holds user content, and the directory around it', () => {
    const settings = geminiSettingsPath()
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }, null, 2) + '\n')
    installGemini()
    uninstallGemini()
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ theme: 'dark' })
  })

  it('keeps a Qwen settings file the user created empty, and the directory around it', () => {
    const settings = qwenSettingsPath()
    fs.mkdirSync(path.dirname(settings), { recursive: true })
    fs.writeFileSync(settings, '{}\n')
    installQwen()
    uninstallQwen()
    expect(fs.existsSync(settings)).toBe(true)
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({})
  })

  it('keeps a directory the user made, even once the integration inside it is gone', () => {
    const dir = path.join(HOME, '.kimi-code')
    fs.mkdirSync(dir, { recursive: true })
    installKimi()
    uninstallKimi()
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('keeps an OpenClaw config the user had, with their own keys, and removes only the entries token-goat added', () => {
    const config = path.join(HOME, '.openclaw', 'openclaw.json')
    fs.mkdirSync(path.dirname(config), { recursive: true })
    fs.writeFileSync(config, JSON.stringify({ agent: 'mine' }, null, 2) + '\n')
    installOpenclaw()
    uninstallOpenclaw()
    expect(JSON.parse(fs.readFileSync(config, 'utf8'))).toEqual({ agent: 'mine' })
    expect(fs.readdirSync(path.dirname(config))).toEqual(['openclaw.json'])
  })

  it('keeps a file the user adds to a directory token-goat created', () => {
    installGemini()
    const settings = geminiSettingsPath()
    const mine = path.join(path.dirname(settings), 'GEMINI.md')
    fs.writeFileSync(mine, '# mine\n')
    uninstallGemini()
    expect(fs.existsSync(mine)).toBe(true)
    expect(fs.existsSync(settings)).toBe(false)
  })

  it('keeps settings the user added to a file token-goat created', () => {
    installQwen()
    const settings = qwenSettingsPath()
    const current = JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>
    fs.writeFileSync(settings, JSON.stringify({ ...current, theme: 'light' }, null, 2) + '\n')
    uninstallQwen()
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual({ theme: 'light' })
  })
})
