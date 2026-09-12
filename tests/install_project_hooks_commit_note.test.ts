/**
 * A project-scope `install --vscode -p` or `install --copilot --local` warns that the generated hook files hold absolute paths for this machine and should not be committed; a user-scope install does not print it.
 *
 * Runs the built bundle, since the note is printed by the CLI command itself, in a fresh project dir with HOME, USERPROFILE, APPDATA, LOCALAPPDATA, XDG_*, COPILOT_HOME and TOKEN_GOAT_HOME all pointed into it.
 *
 * PROVENANCE: HAND-DERIVED. The expected file names are the ones installCopilotHooksFile (src/bridges/copilot_cli_install.ts) and installVscode (src/bridges/vscode_install.ts) write for project scope.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { BUNDLE } from './helpers/bundle.js'

const dirs: string[] = []

afterAll(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
})

function install(args: string[]): { stdout: string; project: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-note-'))
  dirs.push(root)
  const home = path.join(root, 'home')
  const project = path.join(root, 'project')
  fs.mkdirSync(home)
  fs.mkdirSync(project)
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    COPILOT_HOME: path.join(home, '.copilot'),
    TOKEN_GOAT_HOME: path.join(home, '.token-goat'),
    TOKEN_GOAT_EMBEDDINGS_ENABLED: '0',
  }
  const r = spawnSync(process.execPath, [BUNDLE, 'install', ...args], { cwd: project, env, encoding: 'utf8', timeout: 120_000 })
  expect(r.status, r.stderr).toBe(0)
  return { stdout: r.stdout, project }
}

const NOTE = /^Note: .*do not commit them: list them in \.git\/info\/exclude or \.gitignore\.$/m

describe('project-scope install warns against committing the machine-specific hook files', () => {
  it('install --vscode -p prints the note naming its three files', () => {
    const { stdout } = install(['--vscode', '-p'])
    const line = NOTE.exec(stdout)?.[0]
    expect(line).toBeDefined()
    expect(line).toContain(path.join('.vscode', 'mcp.json'))
    expect(line).toContain(path.join('.github', 'hooks', 'token-goat.json'))
    expect(line).toContain(path.join('.github', 'hooks', 'token-goat-shim.js'))
  })

  it('install --copilot --local prints the note naming its hook files', () => {
    const { stdout } = install(['--copilot', '--local'])
    const line = NOTE.exec(stdout)?.[0]
    expect(line).toBeDefined()
    expect(line).toContain(path.join('.github', 'hooks', 'token-goat.json'))
    expect(line).toContain(path.join('.github', 'hooks', 'token-goat-shim.js'))
  })

  it('user-scope install --vscode --user and install --copilot print no such note', () => {
    expect(install(['--vscode', '--user']).stdout).not.toMatch(NOTE)
    expect(install(['--copilot']).stdout).not.toMatch(NOTE)
  })
})
