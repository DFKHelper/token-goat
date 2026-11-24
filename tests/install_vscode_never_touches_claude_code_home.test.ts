/** Behavioral counterpart to `tests/guards/scoped_install_never_writes_claude_code_base.test.ts`. The static guard catches the *declaration* drifting (a forbidden call creeping back into a scoped branch); this test catches the *shipping path* actually writing, by running the CLI in-process (`src/cli.ts`, not the built bundle) against a disposable `HOME`/`USERPROFILE` and inspecting the literal file list afterward -- the same class of gap CLAUDE.md documents elsewhere: a feature can be 100% dead (or, here, 100% overreaching) in the shipping path while every test that calls the handler directly supplies routing the real CLI never does. Real incident this guards: `token-goat install --vscode` run against a real machine also silently rewrote `~/.claude/settings.json`, appended to the user's own `~/.claude/CLAUDE.md`, and created `~/.claude/skills/token-goat/SKILL.md` -- none of which VS Code's own integration needs (confirmed by reading `installVscode` in `src/bridges/vscode_install.ts`: it writes only its own `mcp.json`, an instructions file, and the shared `~/.copilot/hooks` file). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { run as runCli } from '../src/cli.js'
import { closeAllDbs } from '../src/db.js'

import { BUNDLE } from './helpers/bundle.js'
import { useStubbedHookSelftest } from './helpers/hook_selftest_stub.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let stdout: string[]
let stderr: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

useStubbedHookSelftest()

const tempDirs: string[] = []

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** The scope env one row applies; keys not listed are inherited from the test process. */
function envFor(home: string, dataDir: string): Record<string, string> {
  return {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: dataDir,
    XDG_DATA_HOME: dataDir,
  }
}

/** One CLI invocation in-process from `cwd` with `env` applied for the call only, restoring both afterwards. */
async function run(args: string[], env: Record<string, string>, cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const prevCwd = process.cwd()
  const prevExit = process.exitCode
  const prevEnv = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  process.chdir(cwd)
  _resetDataDirCacheForTesting()
  process.exitCode = 0
  stdout.length = 0
  stderr.length = 0
  try {
    await runCli(['node', 'token-goat', ...args])
    return { status: Number(process.exitCode), stdout: stdout.join(''), stderr: stderr.join('') }
  } finally {
    // The CLI opens the scratch global.db (recordStat); Windows will not delete the directory while the handle is open.
    closeAllDbs()
    process.chdir(prevCwd)
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetDataDirCacheForTesting()
    process.exitCode = prevExit
  }
}

beforeAll(() => {
  expect(fs.existsSync(BUNDLE), `${BUNDLE} must exist -- built by tests/setup/build-bundle.ts globalSetup`).toBe(true)
})

beforeEach(() => {
  stdout = []
  stderr = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, stderr)
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
})

afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('install --vscode against a disposable HOME never touches the Claude Code base', () => {
  it('writes VS Code files only, and none of ~/.claude/settings.json, ~/.claude/CLAUDE.md, ~/.claude/skills', async () => {
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

    const r = await run(['install', '--dev', '--project', '--vscode'], env, project)
    expect(r.status, r.stderr).toBe(0)

    // Positive control: the run really did write VS Code's own files, so the "still absent" claims below are a scoping result, not a project-root or env-wiring failure that wrote nothing at all.
    expect(fs.existsSync(path.join(project, '.vscode', 'mcp.json')), r.stdout).toBe(true)

    // The actual assertion: the three Claude-Code-owned files a --vscode-only install must not touch.
    expect(fs.existsSync(claudeSettings), 'install --vscode wrote ~/.claude/settings.json').toBe(false)
    expect(fs.existsSync(claudeMd), 'install --vscode wrote ~/.claude/CLAUDE.md').toBe(false)
    expect(fs.existsSync(claudeSkill), 'install --vscode wrote ~/.claude/skills/token-goat/SKILL.md').toBe(false)
    expect(fs.existsSync(path.join(home, '.claude')), 'install --vscode created ~/.claude/ at all').toBe(false)
  })

  it('a bare install (no harness flag) does write the Claude Code base, proving the check above is scoping, not a broken environment', async () => {
    const home = mkIsolated('tg-behav-bare-home-')
    const dataDir = mkIsolated('tg-behav-bare-data-')
    const project = mkIsolated('tg-behav-bare-proj-')
    const env = envFor(home, dataDir)

    const r = await run(['install', '--dev', '--project'], env, project)
    expect(r.status, r.stderr).toBe(0)

    expect(fs.existsSync(path.join(project, '.claude', 'settings.json'))).toBe(true)
    // `--project` scopes the gate block and the skill to the project too, so they land beside the project's settings rather than under the user home.
    expect(fs.existsSync(path.join(project, 'CLAUDE.md'))).toBe(true)
    expect(fs.existsSync(path.join(project, '.claude', 'skills', 'token-goat', 'SKILL.md'))).toBe(true)
    expect(fs.existsSync(path.join(home, '.claude', 'CLAUDE.md'))).toBe(false)
  })
})
