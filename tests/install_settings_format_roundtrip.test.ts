/** Installing then uninstalling token-goat must hand the user's Claude settings.json back byte for byte, and every write in between must keep the file's line ending, indent unit and trailing-newline habit. A file that does not exist yet gets the default (two spaces, LF, trailing newline). PROVENANCE: HAND-DERIVED. Each fixture is written out line by line below in the layout Claude Code itself produces when a user edits settings.json in an editor set to CRLF and tabs, with its keys (model, permissions.allow, hooks.PreToolUse[].matcher/hooks[].type/command, hooks.Stop) taken from https://code.claude.com/docs/en/settings.md and https://code.claude.com/docs/en/hooks.md; the expected bytes are the fixture itself, never a reader's output. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installHooks, settingsPath, uninstallHooks } from '../src/install.js'
// Side-effect import: registers every hook handler, as cli_install.ts::cmdInstall does before installHooks.
import '../src/relay.js'

function layout(lines: string[], eol: string, trailingNewline: boolean): string {
  return lines.join(eol) + (trailingNewline ? eol : '')
}

const TAB_LINES = [
  '{',
  '\t"model": "opus",',
  '\t"permissions": {',
  '\t\t"allow": [',
  '\t\t\t"Bash(git status)"',
  '\t\t]',
  '\t},',
  '\t"hooks": {',
  '\t\t"PreToolUse": [',
  '\t\t\t{',
  '\t\t\t\t"matcher": "Bash",',
  '\t\t\t\t"hooks": [',
  '\t\t\t\t\t{',
  '\t\t\t\t\t\t"type": "command",',
  '\t\t\t\t\t\t"command": "echo user-pre-bash"',
  '\t\t\t\t\t}',
  '\t\t\t\t]',
  '\t\t\t}',
  '\t\t],',
  '\t\t"Stop": [',
  '\t\t\t{',
  '\t\t\t\t"hooks": [',
  '\t\t\t\t\t{',
  '\t\t\t\t\t\t"type": "command",',
  '\t\t\t\t\t\t"command": "echo user-stop"',
  '\t\t\t\t\t}',
  '\t\t\t\t]',
  '\t\t\t}',
  '\t\t]',
  '\t}',
  '}',
]

const FOUR_SPACE_LINES = TAB_LINES.map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)))

let TMP: string
let origCwd: string
let file: string
const SAVED = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR'] as const
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-settings-format-'))
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
  file = settingsPath('project')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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

describe('install then uninstall of project settings.json', () => {
  it.each([
    ['CRLF, tabs, trailing newline', layout(TAB_LINES, '\r\n', true)],
    ['CRLF, tabs, no trailing newline', layout(TAB_LINES, '\r\n', false)],
    ['LF, tabs, trailing newline', layout(TAB_LINES, '\n', true)],
    ['LF, four spaces, no trailing newline', layout(FOUR_SPACE_LINES, '\n', false)],
    ['CRLF, four spaces, trailing newline', layout(FOUR_SPACE_LINES, '\r\n', true)],
  ])('leaves a %s file byte-identical', (_label, original) => {
    fs.writeFileSync(file, original)
    installHooks('project')
    const installed = fs.readFileSync(file, 'utf8')
    expect(installed).not.toBe(original)
    // Every line break the install wrote is the file's own, and the indent is its own unit.
    expect(installed.replace(/\r\n/g, '').includes('\n')).toBe(original.includes('\r\n') ? false : true)
    expect(installed.endsWith('\n')).toBe(original.endsWith('\n'))
    expect(/^\t+"/m.test(installed)).toBe(original.includes('\t'))
    expect(uninstallHooks('project')).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(original)
  })

  it('writes a new file with two spaces, LF and a trailing newline', () => {
    expect(fs.existsSync(file)).toBe(false)
    installHooks('project')
    const text = fs.readFileSync(file, 'utf8')
    expect(text.startsWith('{\n  "hooks": {\n    "')).toBe(true)
    expect(text.endsWith('}\n')).toBe(true)
    expect(text.includes('\r')).toBe(false)
  })
})
