/**
 * User-scope `install --vscode` writes its routing guidance to a personal instructions file under the home directory and never touches the current directory; `-p` keeps `.github/copilot-instructions.md`.
 *
 * A user-scope install used to write `.github/copilot-instructions.md` into whatever directory it ran from, editing an unrelated project. These run both in-process (install/uninstall semantics) and through the built bundle from inside a scratch project (the real CLI path), with HOME, USERPROFILE, APPDATA and the data dirs all isolated.
 *
 * PROVENANCE: FORMAT-DERIVED. VS Code 1.136.0's workbench.desktop.main.js lists `{path:"~/.copilot/instructions",source:"copilot-personal",storage:"user"}` among its instruction locations (on by default in chat.instructionsFilesLocations), classifies a file as instructions when its name ends in `.instructions.md`, and its instructions matcher treats an applyTo of `**` as matching every file. File contents are HAND-DERIVED.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installVscode, uninstallVscode } from '../src/bridges/vscode_install.js'
import { BUNDLE } from './helpers/bundle.js'

const ENV_KEYS = ['APPDATA', 'HOME', 'USERPROFILE'] as const
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
const savedCwd = process.cwd()
let root: string
let home: string
let project: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-user-instr-')))
  home = path.join(root, 'home')
  project = path.join(root, 'project')
  fs.mkdirSync(home)
  fs.mkdirSync(project)
  // The project already has content of its own, so byte-identical means something.
  fs.writeFileSync(path.join(project, 'README.md'), '# my project\n')
  for (const k of ENV_KEYS) process.env[k] = home
})

afterEach(() => {
  process.chdir(savedCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8')
    }
  }
  walk(dir)
  return out
}

const personalFile = (): string => path.join(home, '.copilot', 'instructions', 'token-goat.instructions.md')

describe('user-scope install --vscode', () => {
  it('leaves the current project byte-identical, writes the personal instructions file, and uninstall removes it', () => {
    process.chdir(project)
    const before = snapshot(project)
    const result = installVscode()
    expect(result.scope).toBe('user')
    expect(result.instructionsPath).toBe(personalFile())
    expect(snapshot(project)).toEqual(before)
    expect(fs.existsSync(path.join(project, '.github'))).toBe(false)
    const text = fs.readFileSync(personalFile(), 'utf8')
    expect(text.startsWith("---\ndescription: 'token-goat: when to use its MCP tools and CLI instead of reading whole files'\napplyTo: '**'\n---\n")).toBe(true)
    expect(text).toContain('<!-- token-goat-vscode-begin -->')
    expect(text).toContain('retrieve_text')
    // Idempotent: a second install changes nothing.
    expect(installVscode().alreadyInstalled).toBe(true)
    expect(fs.readFileSync(personalFile(), 'utf8')).toBe(text)
    expect(uninstallVscode()).toBe(true)
    expect(fs.existsSync(personalFile())).toBe(false)
    expect(snapshot(project)).toEqual(before)
  })

  it('merges into a personal file the user already wrote and leaves their text on uninstall', () => {
    fs.mkdirSync(path.dirname(personalFile()), { recursive: true })
    const mine = "---\napplyTo: '**/*.py'\n---\nPrefer pytest.\n"
    fs.writeFileSync(personalFile(), mine)
    installVscode()
    const text = fs.readFileSync(personalFile(), 'utf8')
    expect(text.startsWith(mine.trimEnd())).toBe(true)
    expect(text).toContain('<!-- token-goat-vscode-end -->')
    uninstallVscode()
    expect(fs.readFileSync(personalFile(), 'utf8')).toBe(mine)
  })

  it('-p still writes .github/copilot-instructions.md in the project and nothing under ~/.copilot/instructions', () => {
    const result = installVscode({ project: true, projectRoot: project })
    expect(result.instructionsPath).toBe(path.join(project, '.github', 'copilot-instructions.md'))
    expect(fs.readFileSync(result.instructionsPath, 'utf8')).toContain('<!-- token-goat-vscode-begin -->')
    expect(fs.existsSync(personalFile())).toBe(false)
    uninstallVscode({ project: true, projectRoot: project })
    expect(fs.readFileSync(result.instructionsPath, 'utf8')).not.toContain('token-goat-vscode-begin')
  })
})

describe('the built CLI, run from inside a project', () => {
  it('install --vscode then uninstall --vscode leave the project byte-identical', () => {
    const before = snapshot(project)
    const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CONFIG_HOME: path.join(home, '.config'), COPILOT_HOME: path.join(home, '.copilot'), TOKEN_GOAT_HOME: path.join(home, '.token-goat'), TOKEN_GOAT_EMBEDDINGS_ENABLED: '0' }
    const install = spawnSync(process.execPath, [BUNDLE, 'install', '--vscode'], { cwd: project, env, encoding: 'utf8', timeout: 120_000 })
    expect(install.status, install.stderr).toBe(0)
    expect(install.stdout).toContain(personalFile())
    expect(snapshot(project)).toEqual(before)
    expect(fs.existsSync(personalFile())).toBe(true)
    const uninstall = spawnSync(process.execPath, [BUNDLE, 'uninstall', '--vscode'], { cwd: project, env, encoding: 'utf8', timeout: 120_000 })
    expect(uninstall.status, uninstall.stderr).toBe(0)
    expect(fs.existsSync(personalFile())).toBe(false)
    expect(snapshot(project)).toEqual(before)
  })
})
