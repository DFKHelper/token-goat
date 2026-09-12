/**
 * `install --vscode` defaults to PROJECT scope -- against the REAL built bundle, not source.
 *
 * The defect this pins: VS Code resolves an agent hook's working directory from the hook FILE's own
 * location (`workspaceService.getWorkspaceFolder(hookFile.uri) ?? folders[0]`). A user-scope hooks
 * file lives in `~/.copilot/hooks`, which is inside no workspace folder, so every invocation is
 * pinned to `folders[0]` -- captured live against VS Code 1.137.0 on 2026-09-12
 * (`%TEMP%\tg-dblfire\armD_multiroot.jsonl`: the user copy reported `cwd=...\multiroot\rootA` for
 * an event raised in rootB, while a project copy in rootB reported `cwd=...\multiroot\rootB`).
 * Read hints, image shrinking and edit interception are therefore inert for every folder past the
 * first. Project scope is the fix, and it has to be the DEFAULT: an opt-in flag leaves every
 * existing install broken.
 *
 * So this asserts the literal set of files each scope writes, end to end, by walking both trees --
 * a `toContain` on one path would not have caught the migration leaving the old user-scope install
 * behind to double-fire beside the new one.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  VSCODE_PROJECT_SCOPE_COVERAGE_NOTE,
  VSCODE_USER_SCOPE_MIGRATED_NOTE,
  VSCODE_USER_SCOPE_MULTIROOT_NOTE,
} from '../src/cli_doctor.js'

import { BUNDLE } from './helpers/bundle.js'

let root: string
let project: string
let home: string
let env: NodeJS.ProcessEnv

function tg(args: string[], cwd = project): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, env, encoding: 'utf8', timeout: 120000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * Every file under `dir`, as forward-slash relative paths, sorted. Directories are not listed.
 *
 * Timestamped `.bak.<iso>` files are excluded: `writeGuidance` snapshots the guidance file on the
 * user-scope path, so their names are unstable run to run and they say nothing about scope, which
 * is what this file is about. Their behaviour is covered by
 * `tests/install_backs_up_preexisting_config_before_overwrite.test.ts`.
 */
function tree(dir: string): string[] {
  const out: string[] = []
  const walk = (cur: string, prefix: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`
      if (e.isDirectory()) walk(path.join(cur, e.name), rel)
      else if (!/\.bak\.\d{4}-/.test(e.name)) out.push(rel)
    }
  }
  walk(dir, '')
  return out.sort()
}

/** The user-scope VS Code config file, wherever this platform puts it, relative to `home`. */
const USER_MCP_REL =
  process.platform === 'win32'
    ? 'AppData/Roaming/Code/User/mcp.json'
    : process.platform === 'darwin'
      ? 'Library/Application Support/Code/User/mcp.json'
      : '.config/Code/User/mcp.json'

const PROJECT_FILES = [
  '.github/copilot-instructions.md',
  '.github/hooks/token-goat-shim.js',
  '.github/hooks/token-goat.json',
  '.github/hooks/token-goat.owners',
  '.vscode/mcp.json',
]

const USER_FILES = [
  USER_MCP_REL,
  '.copilot/hooks/token-goat-shim.js',
  '.copilot/hooks/token-goat.json',
  '.copilot/hooks/token-goat.owners',
  '.copilot/instructions/token-goat.instructions.md',
].sort()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-scope-'))
  project = path.join(root, 'project')
  home = path.join(root, 'home')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  env = {
    ...process.env,
    TOKEN_GOAT_HOME: path.join(root, 'tg-home'),
    LOCALAPPDATA: path.join(root, 'data'),
    XDG_DATA_HOME: path.join(root, 'data'),
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('install --vscode scope, against the built bundle', () => {
  it('writes the project install and touches nothing in the home directory by default', () => {
    const r = tg(['install', '--vscode'])
    expect(r.status, r.stderr).toBe(0)
    expect(tree(project)).toEqual(PROJECT_FILES)
    // The whole point of the flip: no hooks file lands where VS Code would pin it to folders[0].
    expect(tree(home)).toEqual([])
    expect(r.stdout).toContain(VSCODE_PROJECT_SCOPE_COVERAGE_NOTE)
    expect(r.stdout).not.toContain(VSCODE_USER_SCOPE_MULTIROOT_NOTE)
    // The hooks file is the one that actually decides the working directory, so it is named
    // explicitly in the commit note rather than left for the reader to infer.
    expect(r.stdout).toContain('.github')
  })

  it('writes the user install, and only the user install, under --user', () => {
    const r = tg(['install', '--vscode', '--user'])
    expect(r.status, r.stderr).toBe(0)
    expect(tree(home)).toEqual(USER_FILES)
    expect(tree(project)).toEqual([])
    // The opt-out has to state the limitation it is opting into.
    expect(r.stdout).toContain(VSCODE_USER_SCOPE_MULTIROOT_NOTE)
    expect(r.stdout).not.toContain(VSCODE_PROJECT_SCOPE_COVERAGE_NOTE)
  })

  it('migrates an existing user-scope install to the project instead of double-firing beside it', () => {
    expect(tg(['install', '--vscode', '--user']).status).toBe(0)
    expect(tree(home)).toEqual(USER_FILES)

    // The first post-upgrade run of the command every existing user already types.
    const migrate = tg(['install', '--vscode'])
    expect(migrate.status, migrate.stderr).toBe(0)
    expect(migrate.stdout).toContain(VSCODE_USER_SCOPE_MIGRATED_NOTE)

    expect(tree(project)).toEqual(PROJECT_FILES)
    // The user-scope hooks file is GONE, not merely superseded: VS Code runs every hooks file it
    // finds, in both scopes, so leaving it would fire every hook twice for the rest of the session.
    const homeAfter = tree(home)
    expect(homeAfter).not.toContain('.copilot/hooks/token-goat.json')
    expect(homeAfter).not.toContain('.copilot/hooks/token-goat-shim.js')
    // And the user-scope MCP entry is deregistered, whether or not the file itself survives.
    const userMcp = path.join(home, USER_MCP_REL)
    if (fs.existsSync(userMcp)) expect(fs.readFileSync(userMcp, 'utf8')).not.toContain('token-goat')
  })

  it('leaves the shared ~/.copilot hooks in place when install --copilot still owns them', () => {
    expect(tg(['install', '--copilot']).status).toBe(0)
    expect(tg(['install', '--vscode', '--user']).status).toBe(0)
    expect(tg(['install', '--vscode']).status).toBe(0)
    // Copilot CLI's own install is the other owner of ~/.copilot/hooks; migrating VS Code out of
    // user scope releases token-goat's vscode claim, it does not uninstall Copilot CLI.
    expect(fs.existsSync(path.join(home, '.copilot', 'hooks', 'token-goat.json'))).toBe(true)
    expect(fs.readFileSync(path.join(home, '.copilot', 'hooks', 'token-goat.owners'), 'utf8').trim().split(/\r?\n/)).toEqual([
      'copilot',
    ])
  })

  it('still refuses the user-scope install when the project one already exists', () => {
    expect(tg(['install', '--vscode']).status).toBe(0)
    const r = tg(['install', '--vscode', '--user'])
    // The error wall is relaxed in the user -> project direction only. The reverse still duplicates
    // the server registration in this workspace, so it stays an error with a way out.
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('already registered in VS Code project scope')
    expect(`${r.stdout}${r.stderr}`).toContain('uninstall --vscode --project')
  })

  it('surfaces a lingering user-scope install through doctor, and stops once it is migrated', () => {
    expect(tg(['install', '--vscode', '--user']).status).toBe(0)
    const before = tg(['doctor'])
    // A check that runDoctor never calls is a check that never fires; only the real command proves
    // the wiring, which is why this runs `doctor` rather than the exported function.
    expect(`${before.stdout}${before.stderr}`).toContain('VS Code hooks scope')
    expect(`${before.stdout}${before.stderr}`).toContain('FIRST folder')

    expect(tg(['install', '--vscode']).status).toBe(0)
    const after = tg(['doctor'])
    expect(`${after.stdout}${after.stderr}`).not.toContain('VS Code hooks scope')
  })

  it('rejects -p and --user together rather than silently preferring one', () => {
    const r = tg(['install', '--vscode', '--project', '--user'])
    expect(r.status).not.toBe(0)
    expect(`${r.stdout}${r.stderr}`).toContain('not both')
    expect(tree(project)).toEqual([])
    expect(tree(home)).toEqual([])
  })

  it('uninstalls the project scope by default and the user scope under --user', () => {
    expect(tg(['install', '--vscode']).status).toBe(0)
    expect(tg(['uninstall', '--vscode']).status).toBe(0)
    expect(tree(project)).not.toContain('.github/hooks/token-goat.json')
    expect(tree(project)).not.toContain('.vscode/mcp.json')

    expect(tg(['install', '--vscode', '--user']).status).toBe(0)
    expect(tree(home)).toEqual(USER_FILES)
    expect(tg(['uninstall', '--vscode', '--user']).status).toBe(0)
    expect(tree(home)).not.toContain('.copilot/hooks/token-goat.json')
  })
})
