/** `onFailure: continue` on own entries only. FORMAT-DERIVED: code.claude.com/docs/en/hooks.md (2026-11-15). */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { claudeHookScriptPath, HOOK_ON_FAILURE, installHooks, settingsPath, uninstallHooks } from '../src/install.js'

import '../src/relay.js'

let TMP: string
const savedEnv: Record<string, string | undefined> = {}
const PINNED = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS', 'CODEX_HOME', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'APPDATA', 'XDG_CONFIG_HOME']

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-code-mode-install-'))
  for (const k of PINNED) savedEnv[k] = process.env[k]
  const home = path.join(TMP, 'home')
  fs.mkdirSync(home, { recursive: true })
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['CLAUDE_CONFIG_DIR'] = path.join(home, '.claude')
  process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
  // Other harnesses' homes, pinned so a repair run cannot reach a real Codex, Copilot or Kimi install.
  process.env['CODEX_HOME'] = path.join(home, '.codex')
  process.env['COPILOT_HOME'] = path.join(home, '.copilot')
  process.env['KIMI_CODE_HOME'] = path.join(home, '.kimi-code')
  process.env['APPDATA'] = path.join(home, 'AppData', 'Roaming')
  process.env['XDG_CONFIG_HOME'] = path.join(home, '.config')
})

afterEach(() => {
  for (const k of PINNED) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

interface Entry {
  type: string
  command?: string
  onFailure?: string
  [key: string]: unknown
}
interface Group {
  matcher?: string
  hooks: Entry[]
}
type Settings = { hooks: Record<string, Group[]>; [key: string]: unknown }

function readSettings(): Settings {
  return JSON.parse(fs.readFileSync(settingsPath('user'), 'utf8')) as Settings
}

function writeSettings(s: unknown): string {
  const p = settingsPath('user')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const text = JSON.stringify(s, null, 2) + '\n'
  fs.writeFileSync(p, text)
  return text
}

/** Every command entry under every event whose command runs the token-goat shim. */
function ownEntries(s: Settings): Entry[] {
  return Object.values(s.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => typeof h.command === 'string' && h.command.includes('token-goat-shim'))))
}

/** Exec-form entries: the command is just `node`, and the shim path sits in `args`. */
function execFormOwnEntries(s: Settings): Entry[] {
  const isOwn = (h: Entry): boolean => Array.isArray(h.args) && (h.args as unknown[]).some((a) => typeof a === 'string' && a.includes('token-goat-shim'))
  return Object.values(s.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.filter(isOwn)))
}

describe('installer writes onFailure continue on token-goat entries', () => {
  it('writes the field on every entry of a fresh install', () => {
    installHooks('user')
    const own = ownEntries(readSettings())
    expect(own.length).toBeGreaterThan(5)
    for (const h of own) expect(h.onFailure, `entry ${h.command}`).toBe('continue')
    expect(HOOK_ON_FAILURE).toBe('continue')
  })

  it('a second install changes nothing and leaves one entry and one field per event', () => {
    installHooks('user')
    const first = fs.readFileSync(settingsPath('user'), 'utf8')
    const again = installHooks('user')
    expect(again.alreadyInstalled).toBe(true)
    expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(first)
    for (const [event, groups] of Object.entries(readSettings().hooks)) {
      const mine = groups.flatMap((g) => g.hooks).filter((h) => typeof h.command === 'string' && h.command.includes('token-goat-shim'))
      expect(mine.length, `entries under ${event}`).toBe(1)
    }
    expect((first.match(/"onFailure"/g) ?? []).length).toBe(ownEntries(readSettings()).length)
  })

  it('an entry written by an earlier build without the field gains it', () => {
    installHooks('user')
    const s = readSettings()
    for (const h of ownEntries(s)) delete h.onFailure
    writeSettings(s)
    expect(ownEntries(readSettings()).every((h) => h.onFailure === undefined)).toBe(true)
    const r = installHooks('user')
    expect(r.alreadyInstalled).toBe(false)
    for (const h of ownEntries(readSettings())) expect(h.onFailure).toBe('continue')
  })

  it('keeps an onFailure value already on a token-goat entry', () => {
    installHooks('user')
    const s = readSettings()
    const first = ownEntries(s)[0]!
    first.onFailure = 'block'
    writeSettings(s)
    installHooks('user')
    expect(ownEntries(readSettings())[0]!.onFailure).toBe('block')
  })

  it('a null hook entry beside a token-goat entry installs without throwing and is left as it was', () => {
    // HAND-DERIVED: a hand-edited group holds null beside an entry without onFailure, computed from the input.
    installHooks('user')
    const ours = ownEntries(readSettings())[0]!
    writeSettings({ hooks: { PreToolUse: [{ hooks: [null, { type: 'command', command: ours.command }] }] } })
    const r = installHooks('user')
    expect(r.alreadyInstalled).toBe(false)
    const group = readSettings().hooks['PreToolUse']![0]!
    expect(group.hooks).toHaveLength(2)
    expect(group.hooks[0]).toBeNull()
    expect(group.hooks[1]!.command).toBe(ours.command)
    expect(group.hooks[1]!.onFailure).toBe('continue')
  })

  it('leaves every user hook byte for byte as it was, including one sharing a group with ours', () => {
    installHooks('user')
    const s = readSettings()
    const userSolo: Group = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /home/me/guard.js', timeout: 5 }] }
    const userShared: Entry = { type: 'command', command: 'echo "shared  spacing"', async: true }
    s.hooks['PreToolUse'] = [userSolo, ...s.hooks['PreToolUse']!]
    const ours = s.hooks['PreToolUse']!.find((g) => g.hooks.some((h) => h.command?.includes('token-goat-shim')))!
    ours.hooks = [userShared, ...ours.hooks.map((h) => {
      const { onFailure: _drop, ...rest } = h
      return rest as Entry
    })]
    s.hooks['UserPromptSubmit'] = [...(s.hooks['UserPromptSubmit'] ?? []), { hooks: [{ type: 'command', command: 'echo prompt' }] }]
    writeSettings(s)
    installHooks('user')
    const after = readSettings()
    expect(after.hooks['PreToolUse']![0]).toEqual(userSolo)
    expect(JSON.stringify(after.hooks['PreToolUse']![0])).toBe(JSON.stringify(userSolo))
    const sharedAfter = after.hooks['PreToolUse']!.flatMap((g) => g.hooks).find((h) => h.command === userShared.command)!
    expect(JSON.stringify(sharedAfter)).toBe(JSON.stringify(userShared))
    expect('onFailure' in sharedAfter).toBe(false)
    expect(after.hooks['UserPromptSubmit']!.some((g) => g.hooks.some((h) => h.command === 'echo prompt' && !('onFailure' in h)))).toBe(true)
    expect(ownEntries(after).every((h) => h.onFailure === 'continue')).toBe(true)
  })

  it('replaces a legacy exec-form install with guarded entries with onFailure, once', () => {
    // HAND-DERIVED: an install from before guarded hooks wrote exec form; the guarded form replaces it.
    installHooks('user')
    const seeded = readSettings()
    for (const g of Object.values(seeded.hooks).flat()) {
      const legacy = { type: 'command', command: 'node', args: ['/old/token-goat-shim.cjs', 'x'] }
      g.hooks = g.hooks.map((h) => (String(h.command).includes('token-goat-shim') ? legacy : h))
    }
    writeSettings(seeded)
    expect(execFormOwnEntries(readSettings()).length).toBeGreaterThan(5)
    installHooks('user')
    const first = ownEntries(readSettings())
    expect(first.length).toBeGreaterThan(5)
    expect(execFormOwnEntries(readSettings())).toHaveLength(0)
    for (const h of first) expect(h.onFailure, `entry ${String(h.command)}`).toBe('continue')
    installHooks('user')
    expect(ownEntries(readSettings())).toHaveLength(first.length)
  })
})

describe('uninstall and repair match entries that carry onFailure', () => {
  let savedCwd: string

  beforeEach(() => {
    // Project scope resolves against the cwd, so a repair must not reach the repo's own .claude/settings.json.
    savedCwd = process.cwd()
    const project = path.join(TMP, 'proj')
    fs.mkdirSync(project, { recursive: true })
    process.chdir(project)
  })

  afterEach(() => {
    process.chdir(savedCwd)
  })

  it('uninstall removes every token-goat entry, each of which carries onFailure', () => {
    installHooks('user')
    expect(ownEntries(readSettings()).every((h) => h.onFailure === 'continue')).toBe(true)
    expect(uninstallHooks('user')).toBe(true)
    // Uninstall deletes a settings file it leaves empty, so an absent file means no token-goat entry is left.
    const left = fs.existsSync(settingsPath('user')) ? fs.readFileSync(settingsPath('user'), 'utf8') : ''
    expect(left).not.toContain('token-goat-shim')
  })

  it('repair restores a deleted shim and leaves one entry per event, not a second copy', () => {
    installHooks('user')
    const before = ownEntries(readSettings())
    fs.rmSync(claudeHookScriptPath())

    const result = repairHarnessHooks()
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual(['Repaired Claude Code (user) hooks and shim'])

    const after = readSettings()
    for (const [event, groups] of Object.entries(after.hooks)) {
      const mine = groups.flatMap((g) => g.hooks).filter((h) => typeof h.command === 'string' && h.command.includes('token-goat-shim'))
      expect(mine.length, `entries under ${event}`).toBe(1)
    }
    const repairedOwn = ownEntries(after)
    expect(repairedOwn).toHaveLength(before.length)
    for (const h of repairedOwn) expect(h.onFailure, `entry ${h.command}`).toBe('continue')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })
})
