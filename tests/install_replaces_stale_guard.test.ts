import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GUARD_VERSION, parseGuardedCommand } from '../src/hook_guard.js'
import { claudeHookScriptPath, expectedHookEntryFor, installHooks, settingsPath } from '../src/install.js'

interface Entry {
  type: string
  command: string
  [key: string]: unknown
}
interface Group {
  matcher?: string
  hooks: Entry[]
}
interface Settings {
  hooks: Record<string, Group[]>
}

let TMP: string
let origCwd: string
const saved: Record<string, string | undefined> = {}
const PINNED = ['HOME', 'USERPROFILE', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-stale-guard-'))
  origCwd = process.cwd()
  process.chdir(TMP)
  for (const k of PINNED) saved[k] = process.env[k]
  const fakeHome = path.join(TMP, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const k of PINNED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

function expectedCommand(eventArg: string): string {
  return expectedHookEntryFor(claudeHookScriptPath(), eventArg).command
}

/** `command` with one character of its guard text changed: same native argv, shell and guard version. */
function withOneGuardCharChanged(command: string): string {
  const changed = command.replace('exit 0', 'exit 3')
  expect(changed, 'the guard text carries an `exit 0` to change').not.toBe(command)
  const was = parseGuardedCommand(command)
  const now = parseGuardedCommand(changed)
  expect(was?.kind).toBe('v1')
  expect(now).toEqual(was)
  return changed
}

function readSettings(p: string): Settings {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Settings
}

/** Rewrite the PreToolUse command of a fresh install with `change`, returning the settings path. */
function installThenRewrite(change: (command: string) => string): string {
  installHooks('project')
  const p = settingsPath('project')
  const settings = readSettings(p)
  const entry = settings.hooks['PreToolUse']![0]!.hooks[0]!
  entry.command = change(entry.command)
  fs.writeFileSync(p, JSON.stringify(settings, null, 2))
  return p
}

function listing(dir: string): string[] {
  return fs.readdirSync(dir).sort()
}

describe('a reinstall replaces a stale guard of its own entry', () => {
  it('(a) rewrites an entry whose guard text differs by one character to the current text', () => {
    const p = installThenRewrite(withOneGuardCharChanged)
    const result = installHooks('project')
    expect(result.alreadyInstalled, 'the install reports it rewrote the entry').toBe(false)
    const commands = readSettings(p).hooks['PreToolUse']!.flatMap((g) => g.hooks.map((h) => h.command))
    expect(commands, 'the stale guard text was rewritten to the current text').toEqual([
      expectedCommand('pre_tool_use'),
    ])
  })

  it('(b) leaves the bytes and the backups of a file holding the current text untouched', () => {
    installHooks('project')
    const p = settingsPath('project')
    const before = fs.readFileSync(p)
    const filesBefore = listing(path.dirname(p))
    expect(installHooks('project').alreadyInstalled).toBe(true)
    expect(fs.readFileSync(p).equals(before), 'settings bytes after a current-text install').toBe(true)
    expect(listing(path.dirname(p)), 'no new backup beside the settings file').toEqual(filesBefore)
  })

  it('(c) keeps foreign hooks and groups byte-identical and in order around the replaced entry', () => {
    const foreignBefore: Entry = { type: 'command', command: 'echo before', timeout: 5 }
    const foreignAfter: Entry = { type: 'command', command: 'echo after' }
    const foreignGroup: Group = { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo edit' }] }
    const p = installThenRewrite(withOneGuardCharChanged)
    const settings = readSettings(p)
    const own = settings.hooks['PreToolUse']![0]!.hooks[0]!
    settings.hooks['PreToolUse'] = [
      { matcher: 'Bash', hooks: [foreignBefore, own, foreignAfter] },
      foreignGroup,
    ]
    fs.writeFileSync(p, JSON.stringify(settings, null, 2))
    installHooks('project')
    const groups = readSettings(p).hooks['PreToolUse']!
    expect(groups.length, 'no group added or dropped').toBe(2)
    expect(JSON.stringify(groups[0]!.hooks[0]), 'foreign entry before').toBe(JSON.stringify(foreignBefore))
    expect(groups[0]!.hooks[1]!.command, 'our entry stays where it was').toBe(expectedCommand('pre_tool_use'))
    expect(JSON.stringify(groups[0]!.hooks[2]), 'foreign entry after').toBe(JSON.stringify(foreignAfter))
    expect(groups[0]!.matcher).toBe('Bash')
    expect(JSON.stringify(groups[1]), 'foreign group').toBe(JSON.stringify(foreignGroup))
  })

  it('(d) a second install after a replacement changes zero bytes', () => {
    const p = installThenRewrite(withOneGuardCharChanged)
    installHooks('project')
    const after = fs.readFileSync(p)
    const files = listing(path.dirname(p))
    expect(installHooks('project').alreadyInstalled).toBe(true)
    expect(fs.readFileSync(p).equals(after), 'bytes of the second install').toBe(true)
    expect(listing(path.dirname(p))).toEqual(files)
  })

  it('replaces an installed version-1 guard and never keeps it as newer', () => {
    const p = installThenRewrite((c) => c.replace(`tg-guard-v${String(GUARD_VERSION)}`, 'tg-guard-v1'))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    installHooks('project')
    const commands = readSettings(p).hooks['PreToolUse']!.flatMap((g) => g.hooks.map((h) => h.command))
    expect(commands, 'the version-1 guard was replaced').toEqual([expectedCommand('pre_tool_use')])
    expect(stderr.mock.calls.map((c) => String(c[0])).join(''), 'no newer-guard notice').not.toContain('newer')
  })

  it('replaces an installed version-3 guard, from before the answer-shape rule', () => {
    const p = installThenRewrite((c) => c.replace(`tg-guard-v${String(GUARD_VERSION)}`, 'tg-guard-v3'))
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    installHooks('project')
    const commands = readSettings(p).hooks['PreToolUse']!.flatMap((g) => g.hooks.map((h) => h.command))
    expect(commands, 'the version-3 guard was replaced').toEqual([expectedCommand('pre_tool_use')])
  })

  it('leaves a guard of a higher version than this build alone', () => {
    const from = `tg-guard-v${String(GUARD_VERSION)}`
    const newer = (c: string): string => c.replace(from, `tg-guard-v${String(GUARD_VERSION + 1)}`)
    const p = installThenRewrite(newer)
    const before = fs.readFileSync(p)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    installHooks('project')
    const kept = readSettings(p).hooks['PreToolUse']!.flatMap((g) => g.hooks.map((h) => h.command))
    const only = [newer(expectedCommand('pre_tool_use'))]
    expect(kept, 'the newer guard stays the only PreToolUse entry').toEqual(only)
    expect(fs.readFileSync(p).equals(before), 'settings bytes untouched').toBe(true)
  })
})
