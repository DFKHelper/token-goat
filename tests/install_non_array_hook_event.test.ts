/** A hand-edited settings.json can hold a string or an object where Claude Code expects an array of hook groups under `hooks.<Event>`. Install used to spread a string into single characters and throw on an object, and uninstall and doctor threw "groups is not iterable"; the user's value must survive every one of them untouched. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hookEventGaps, installHooks, isInstalled, settingsPath, uninstallHooks, wiredClaudeHookWords } from '../src/install.js'
// Side-effect import: registers every hook handler, as cli_install.ts::cmdInstall does before installHooks.
import '../src/relay.js'

// HAND-DERIVED: the two values are the shapes the finding reproduced (a bare string and an object where Claude Code's hooks reference, https://code.claude.com/docs/en/hooks.md, documents an array of matcher groups); the expected result is that they come back byte-identical, which needs no knowledge of our code.
const STRING_VALUE = 'echo hi'
const OBJECT_VALUE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }

let TMP: string
let origCwd: string
const SAVED = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-nonarray-'))
  origCwd = process.cwd()
  for (const k of SAVED) saved[k] = process.env[k]
  const fakeHome = path.join(TMP, 'home')
  const project = path.join(TMP, 'project')
  fs.mkdirSync(fakeHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  process.chdir(project)
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  delete process.env['CLAUDE_CONFIG_DIR']
})

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function writeSettings(hooks: unknown): string {
  const p = settingsPath('project')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify({ model: 'opus', hooks }, null, 2))
  return p
}

function hooksOnDisk(p: string): Record<string, unknown> {
  return (JSON.parse(fs.readFileSync(p, 'utf8')) as { hooks: Record<string, unknown> }).hooks
}

describe.each([
  ['a string', STRING_VALUE],
  ['an object', OBJECT_VALUE],
])('hooks.PreToolUse holding %s', (_label, value) => {
  it('install leaves the value as it was, wires the other events, and says which key it skipped', () => {
    const p = writeSettings({ PreToolUse: value })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)

    const result = installHooks('project')

    expect(hooksOnDisk(p)['PreToolUse']).toEqual(value)
    expect(Array.isArray(hooksOnDisk(p)['PostToolUse'])).toBe(true)
    expect(result.skippedEvents).toEqual(['PreToolUse'])
    const said = stderr.mock.calls.map((c) => String(c[0])).join('')
    expect(said).toContain(p)
    expect(said).toContain('hooks.PreToolUse')
    // A second run is stable: nothing further is written, the value is still there.
    installHooks('project')
    expect(hooksOnDisk(p)['PreToolUse']).toEqual(value)
  })

  it('uninstall, doctor and the installed checks do not throw and keep the value', () => {
    const p = writeSettings({ PreToolUse: value })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    installHooks('project')

    expect(() => hookEventGaps('project')).not.toThrow()
    expect(() => isInstalled('project')).not.toThrow()
    expect(() => wiredClaudeHookWords('project')).not.toThrow()
    expect(() => uninstallHooks('project')).not.toThrow()
    expect(hooksOnDisk(p)['PreToolUse']).toEqual(value)
  })

  it('uninstall of a file token-goat never wrote to does not throw', () => {
    const p = writeSettings({ PreToolUse: value })
    expect(() => uninstallHooks('project')).not.toThrow()
    expect(hooksOnDisk(p)['PreToolUse']).toEqual(value)
  })

  it('uninstall of one scope does not throw on the other scope holding the value', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    installHooks('user')
    const userPath = settingsPath('user')
    const doc = JSON.parse(fs.readFileSync(userPath, 'utf8')) as { hooks: Record<string, unknown> }
    doc.hooks['Stop'] = value
    fs.writeFileSync(userPath, JSON.stringify(doc))
    writeSettings({ PreToolUse: [] })
    expect(() => uninstallHooks('project')).not.toThrow()
    expect(hooksOnDisk(userPath)['Stop']).toEqual(value)
  })
})

describe('hooks itself not an object', () => {
  it('install and uninstall refuse and leave the file byte-identical', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const raw = JSON.stringify({ hooks: 'nope' })
    fs.writeFileSync(p, raw)
    expect(() => installHooks('project')).toThrow(/"hooks" value that is not a JSON object/)
    expect(() => uninstallHooks('project')).toThrow(/"hooks" value that is not a JSON object/)
    expect(fs.readFileSync(p, 'utf8')).toBe(raw)
    expect(() => hookEventGaps('project')).not.toThrow()
  })
})
