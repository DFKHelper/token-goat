/**
 * Behavioral counterpart to `tests/guards/scoped_install_never_writes_claude_code_base.test.ts`.
 * The static guard catches the *declaration* drifting (a forbidden call creeping back into a
 * scoped branch); this test catches the *shipping path* actually writing, by running the real
 * built bundle (`dist/token-goat.mjs`, not source) against a disposable `HOME`/`USERPROFILE` and
 * inspecting the literal file list afterward -- the same class of gap CLAUDE.md documents
 * elsewhere: a feature can be 100% dead (or, here, 100% overreaching) in the shipping path while
 * every test that calls the handler directly supplies routing the real CLI never does.
 *
 * Real incident this guards: `token-goat install --vscode` run against a real machine also
 * silently rewrote `~/.claude/settings.json`, appended to the user's own `~/.claude/CLAUDE.md`,
 * and created `~/.claude/skills/token-goat/SKILL.md` -- none of which VS Code's own integration
 * needs (confirmed by reading `installVscode` in `src/bridges/vscode_install.ts`: it writes only
 * its own `mcp.json`, an instructions file, and the shared `~/.copilot/hooks` file).
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function envFor(home: string, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dataDir,
    XDG_DATA_HOME: dataDir,
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 30000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

beforeAll(() => {
  expect(fs.existsSync(BUNDLE), `${BUNDLE} must exist -- built by tests/setup/build-bundle.ts globalSetup`).toBe(true)
})

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('install --vscode against a disposable HOME never touches the Claude Code base', () => {
  it('writes VS Code files only, and none of ~/.claude/settings.json, ~/.claude/CLAUDE.md, ~/.claude/skills', () => {
    const home = mkIsolated('tg-behav-vscode-home-')
    const dataDir = mkIsolated('tg-behav-vscode-data-')
    const project = mkIsolated('tg-behav-vscode-proj-')
    const env = envFor(home, dataDir)

    const claudeSettings = path.join(home, '.claude', 'settings.json')
    const claudeMd = path.join(home, '.claude', 'CLAUDE.md')
    const claudeSkill = path.join(home, '.claude', 'skills', 'token-goat', 'SKILL.md')

    // None of the three exist before install -- the baseline this test's "still absent" claim needs.
    expect(fs.existsSync(claudeSettings)).toBe(false)
    expect(fs.existsSync(claudeMd)).toBe(false)
    expect(fs.existsSync(claudeSkill)).toBe(false)

    const r = run(['install', '--project', '--vscode'], env, project)
    expect(r.status, r.stderr).toBe(0)

    // Positive control: the run really did write VS Code's own files, so the "still absent" claims
    // below are a scoping result, not a project-root or env-wiring failure that wrote nothing at all.
    expect(fs.existsSync(path.join(project, '.vscode', 'mcp.json')), r.stdout).toBe(true)

    // The actual assertion: the three Claude-Code-owned files a --vscode-only install must not touch.
    expect(fs.existsSync(claudeSettings), 'install --vscode wrote ~/.claude/settings.json').toBe(false)
    expect(fs.existsSync(claudeMd), 'install --vscode wrote ~/.claude/CLAUDE.md').toBe(false)
    expect(fs.existsSync(claudeSkill), 'install --vscode wrote ~/.claude/skills/token-goat/SKILL.md').toBe(false)
    expect(fs.existsSync(path.join(home, '.claude')), 'install --vscode created ~/.claude/ at all').toBe(false)
  })

  it('a bare install (no harness flag) does write the Claude Code base, proving the check above is scoping, not a broken environment', () => {
    const home = mkIsolated('tg-behav-bare-home-')
    const dataDir = mkIsolated('tg-behav-bare-data-')
    const project = mkIsolated('tg-behav-bare-proj-')
    const env = envFor(home, dataDir)

    const r = run(['install', '--project'], env, project)
    expect(r.status, r.stderr).toBe(0)

    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'token-goat', 'SKILL.md'))).toBe(true)
  })
})
