// A project-scope uninstall (`-p/--project`) must touch only project-scope files. Before this it also stripped the user ~/.claude/CLAUDE.md block and the user skill, and `--all` removed the Codex, Gemini, Qwen, Kimi, OpenClaw, opencode, Grok, Antigravity and Zed setups from the user's home. PROVENANCE: CAPTURE of the defect, 2026-10-03, built bundle with HOME, USERPROFILE, TOKEN_GOAT_HOME, LOCALAPPDATA, APPDATA and CLAUDE_CONFIG_DIR under a scratch dir: `install --all`, then `uninstall --all --project` from a separate project printed "Removed token-goat block from CLAUDE.md." and "Removed token-goat skill.", then "Removed ..." for Codex CLI, Gemini, Qwen, Kimi, OpenClaw, opencode, Grok CLI, Antigravity and Zed; afterwards ~/.codex, ~/.grok/hooks and ~/.config/opencode/plugins were gone and ~/.claude/CLAUDE.md had no token-goat text. The expectation (every user-scope file byte-identical before and after) is HAND-DERIVED from the documented scope split: `-p` means the project, so the user home is not its business.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { run } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'TOKEN_GOAT_HOME', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'APPDATA', 'CLAUDE_CONFIG_DIR', 'COPILOT_HOME'] as const

let base: string
let home: string
let claude: string
let roaming: string
let userProject: string
let otherProject: string
let origCwd: string
let saved: Record<string, string | undefined>
let stdout: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-scope-')))
  home = path.join(base, 'home')
  claude = path.join(base, 'claude')
  roaming = path.join(base, 'roaming')
  userProject = path.join(base, 'user-proj')
  otherProject = path.join(base, 'other-proj')
  for (const d of [home, claude, roaming, userProject, otherProject]) fs.mkdirSync(d)
  process.env['HOME'] = home
  process.env['USERPROFILE'] = home
  process.env['LOCALAPPDATA'] = path.join(base, 'local')
  process.env['XDG_DATA_HOME'] = path.join(base, 'local')
  process.env['APPDATA'] = roaming
  process.env['TOKEN_GOAT_HOME'] = path.join(base, 'tghome')
  process.env['CLAUDE_CONFIG_DIR'] = claude
  delete process.env['COPILOT_HOME']
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  process.chdir(userProject)
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, [])
})

afterEach(() => {
  // recordStat opens global.db under the scratch data dir; Windows will not delete the directory while the handle is open.
  closeAllDbs()
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<string> {
  const prev = process.exitCode
  process.exitCode = 0
  stdout.length = 0
  try {
    await run(['node', 'token-goat', ...argv])
    expect(process.exitCode).toBe(0)
    return stdout.join('')
  } finally {
    process.exitCode = prev
  }
}

/** Every file under the user-scope roots, path to content. */
function userScopeSnapshot(): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else files.set(full, fs.readFileSync(full, 'utf8'))
    }
  }
  for (const root of [home, claude, roaming]) walk(root)
  return files
}

describe('uninstall -p/--project leaves user-scope integrations alone', () => {
  it('uninstall --all --project keeps every user-scope file byte-identical', async () => {
    await runCli(['install', '--all', '--no-index'])
    const before = userScopeSnapshot()
    // The harness setups a user-scope `install --all` writes; if any of these were missing the comparison below would prove nothing about them.
    for (const rel of [path.join(claude, 'CLAUDE.md'), path.join(claude, 'settings.json')]) expect(before.has(rel)).toBe(true)
    expect([...before.keys()].some((f) => f.includes(`${path.sep}.codex${path.sep}`))).toBe(true)
    expect([...before.keys()].some((f) => f.includes(`${path.sep}skills${path.sep}`))).toBe(true)

    process.chdir(otherProject)
    const output = await runCli(['uninstall', '--all', '--project'])

    const after = userScopeSnapshot()
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [file, text] of before) expect(after.get(file), file).toBe(text)
    expect(output).not.toContain('Removed token-goat block from CLAUDE.md')
    expect(output).not.toContain('Removed token-goat skill')
    expect(output).not.toMatch(/Removed token-goat (Codex|Gemini|Qwen|Kimi|OpenClaw|opencode|Grok|Antigravity|Zed)/)
    expect(output).toContain('NOTE: the token-goat CLAUDE.md block and skill are user-scope and were not touched')
    expect(output).toContain('--codex, --gemini, --qwen, --kimi, --openclaw, --opencode, --grok, --antigravity, --zed are user-scope only')
    // One summary NOTE instead of a "still installed" line per skipped harness.
    expect(output).not.toContain('is still installed')
  })

  it('install then install -p then uninstall -p removes the project hooks and keeps the user gate block, skill and hooks', async () => {
    await runCli(['install', '--no-index'])
    await runCli(['install', '-p', '--no-index'])
    const projectSettings = path.join(userProject, '.claude', 'settings.json')
    expect(fs.readFileSync(projectSettings, 'utf8')).toContain('token-goat')
    const userSettingsBefore = fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')
    const claudeMdBefore = fs.readFileSync(path.join(claude, 'CLAUDE.md'), 'utf8')
    expect(claudeMdBefore).toContain('token-goat')
    const skillsBefore = fs.readdirSync(path.join(claude, 'skills'))
    expect(skillsBefore.length).toBeGreaterThan(0)

    await runCli(['uninstall', '-p'])

    expect(fs.existsSync(projectSettings) ? fs.readFileSync(projectSettings, 'utf8') : '').not.toContain('token-goat')
    expect(fs.readFileSync(path.join(claude, 'settings.json'), 'utf8')).toBe(userSettingsBefore)
    expect(fs.readFileSync(path.join(claude, 'CLAUDE.md'), 'utf8')).toBe(claudeMdBefore)
    expect(fs.readdirSync(path.join(claude, 'skills'))).toEqual(skillsBefore)
  })

  it('an explicitly named user-only harness is still removed alongside --all --project', async () => {
    await runCli(['install', '--all', '--no-index'])
    const codexDir = path.join(home, '.codex')
    expect(fs.existsSync(codexDir)).toBe(true)
    const geminiBefore = [...userScopeSnapshot().keys()].filter((f) => f.includes(`${path.sep}.gemini${path.sep}`))
    expect(geminiBefore.length).toBeGreaterThan(0)

    process.chdir(otherProject)
    const output = await runCli(['uninstall', '--all', '--project', '--codex'])

    expect(output).toContain('Removed token-goat Codex CLI integration')
    expect([...userScopeSnapshot().keys()].filter((f) => f.includes(`${path.sep}.gemini${path.sep}`))).toEqual(geminiBefore)
    expect(output).toContain('--gemini, --qwen')
    expect(output).not.toMatch(/--codex,/)
  })

  it('a user-scope uninstall still removes the CLAUDE.md block and skill', async () => {
    await runCli(['install', '--no-index'])
    const output = await runCli(['uninstall'])
    expect(output).toContain('Removed token-goat block from CLAUDE.md.')
    expect(output).toContain('Removed token-goat skill.')
    expect(fs.existsSync(path.join(claude, 'CLAUDE.md')) ? fs.readFileSync(path.join(claude, 'CLAUDE.md'), 'utf8') : '').not.toContain('token-goat')
  })
})
