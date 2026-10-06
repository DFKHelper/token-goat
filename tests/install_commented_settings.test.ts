/** Gemini CLI, Qwen Code and OpenClaw read their settings file through a parser that accepts comments, so install, uninstall and the installed check must keep a commented file readable and keep its comments. PROVENANCE: FORMAT-DERIVED. google-gemini/gemini-cli packages/cli/src/config/settings.ts parses with `JSON.parse(stripJsonComments(content))` (comments allowed, a trailing comma is not); QwenLM/qwen-code packages/cli/src/config/settings.ts does the same after stripping a BOM; docs.openclaw.ai/gateway/configuration says OpenClaw "reads an optional JSON5 config from ~/.openclaw/openclaw.json" (comments and trailing commas allowed). The file bodies below are HAND-DERIVED. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GeminiSettingsParseError, geminiSettingsPath, installGemini, isGeminiInstalled, uninstallGemini } from '../src/bridges/gemini_install.js'
import { installOpenclaw, isOpenclawInstalled, openclawConfigPath, uninstallOpenclaw } from '../src/bridges/openclaw_install.js'
import { installQwen, isQwenInstalled, qwenSettingsPath, uninstallQwen } from '../src/bridges/qwen_install.js'
import '../src/relay.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

const ENV_KEYS = ['HOME', 'USERPROFILE'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
let home: string
let restoreEntry: () => void

beforeEach(() => {
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-commented-settings-')))
  for (const k of ENV_KEYS) process.env[k] = home
  restoreEntry = pinInstalledEntry(home)
})

afterEach(() => {
  restoreEntry()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(home, { recursive: true, force: true })
})

const COMMENTED = '{\n  // my theme\n  "theme": "dark" /* keep */\n}\n'

function seed(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

const strictBridges = [
  { name: 'Gemini', file: geminiSettingsPath, install: installGemini, uninstall: uninstallGemini, installed: isGeminiInstalled },
  { name: 'Qwen', file: qwenSettingsPath, install: installQwen, uninstall: uninstallQwen, installed: isQwenInstalled },
]

describe.each(strictBridges)('$name settings with comments', ({ file, install, uninstall, installed }) => {
  it('installs keeping the comments, reports installed, and uninstalls back to the same bytes', () => {
    seed(file(), COMMENTED)
    install()
    const after = fs.readFileSync(file(), 'utf8')
    expect(after).toContain('// my theme')
    expect(after).toContain('/* keep */')
    expect(after).toContain('token-goat')
    expect(installed()).toBe(true)
    expect(uninstall()).toBe(true)
    expect(fs.readFileSync(file(), 'utf8')).toBe(COMMENTED)
    expect(installed()).toBe(false)
  })

  it('refuses a trailing comma, as the real CLI does', () => {
    const body = '{\n  "theme": "dark",\n}\n'
    seed(file(), body)
    expect(() => install()).toThrow(/invalid JSON/)
    expect(fs.readFileSync(file(), 'utf8')).toBe(body)
  })
})

describe('Gemini error type', () => {
  it('still throws GeminiSettingsParseError for a broken file', () => {
    seed(geminiSettingsPath(), '{ nope')
    expect(() => installGemini()).toThrow(GeminiSettingsParseError)
  })
})

describe('OpenClaw config with comments', () => {
  it('installs keeping the comments and trailing comma, and uninstalls back to the same bytes', () => {
    const body = '{\n  // gateway\n  "gateway": { "port": 1, },\n}\n'
    seed(openclawConfigPath(), body)
    installOpenclaw()
    const after = fs.readFileSync(openclawConfigPath(), 'utf8')
    expect(after).toContain('// gateway')
    expect(isOpenclawInstalled()).toBe(true)
    expect(uninstallOpenclaw()).toBe(true)
    expect(fs.readFileSync(openclawConfigPath(), 'utf8')).toContain('// gateway')
    expect(isOpenclawInstalled()).toBe(false)
  })
})
