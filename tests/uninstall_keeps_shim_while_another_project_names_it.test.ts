// Fixture provenance: HAND-DERIVED; project settings are built here, hook entries come from the real installer.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { claudeHookScriptPath, installHooks, uninstallHooks } from '../src/install.js'

// Side-effect import: registers every hook handler before an install narrows its matchers, as cmdInstall does.
import '../src/relay.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TOKEN_GOAT_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const

let saved: Record<string, string | undefined>
let base: string
let origCwd: string
let projectA: string
let projectB: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shared-shim-')))
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
    HOME: path.join(base, 'home'),
    USERPROFILE: path.join(base, 'home'),
    LOCALAPPDATA: path.join(base, 'share'),
    APPDATA: path.join(base, 'appdata'),
    XDG_DATA_HOME: path.join(base, 'share'),
    XDG_CONFIG_HOME: path.join(base, 'config'),
    XDG_STATE_HOME: path.join(base, 'state'),
    XDG_CACHE_HOME: path.join(base, 'cache'),
    TOKEN_GOAT_HOME: path.join(base, 'tghome'),
    TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '0',
  })
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  projectA = path.join(base, 'projects', 'a')
  projectB = path.join(base, 'projects', 'b')
  fs.mkdirSync(projectA, { recursive: true })
  fs.mkdirSync(projectB, { recursive: true })
})

afterEach(() => {
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

/** Run `work` with `dir` as the project (cwd), the way `token-goat install --project` sees it. */
function inProject<T>(dir: string, work: () => T): T {
  process.chdir(dir)
  return work()
}

function namesShim(settingsFile: string): boolean {
  return fs.readFileSync(settingsFile, 'utf8').includes(path.basename(claudeHookScriptPath()))
}

describe('uninstall keeps the shared shim while another project config still names it', () => {
  it('a project whose settings.json the user already had: uninstalling the other project leaves the shim', () => {
    const aFile = path.join(projectA, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(aFile), { recursive: true })
    fs.writeFileSync(aFile, JSON.stringify({ model: 'opus' }))
    inProject(projectA, () => installHooks('project'))
    inProject(projectB, () => installHooks('project'))
    expect(fs.existsSync(claudeHookScriptPath()), 'premise: the installs wrote the shared shim').toBe(true)

    expect(inProject(projectB, () => uninstallHooks('project'))).toBe(true)

    expect(fs.existsSync(claudeHookScriptPath()), 'the shim project A still names was deleted').toBe(true)
    expect(namesShim(aFile), 'premise: project A still names the shim').toBe(true)

    expect(inProject(projectA, () => uninstallHooks('project'))).toBe(true)
    expect(fs.existsSync(claudeHookScriptPath()), 'the shim outlived the last project that named it').toBe(false)
    expect(JSON.parse(fs.readFileSync(aFile, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('a project settings.json token-goat created: uninstalling the other project leaves the shim', () => {
    inProject(projectA, () => installHooks('project'))
    inProject(projectB, () => installHooks('project'))
    inProject(projectB, () => uninstallHooks('project'))
    expect(fs.existsSync(claudeHookScriptPath()), 'the shim project A still names was deleted').toBe(true)
    inProject(projectA, () => uninstallHooks('project'))
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })

  it('a project config that cannot be read counts as still naming the shim', () => {
    const aFile = path.join(projectA, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(aFile), { recursive: true })
    fs.writeFileSync(aFile, JSON.stringify({ model: 'opus' }))
    inProject(projectA, () => installHooks('project'))
    inProject(projectB, () => installHooks('project'))
    fs.writeFileSync(aFile, '{ "hooks": ')
    inProject(projectB, () => uninstallHooks('project'))
    expect(fs.existsSync(claudeHookScriptPath()), 'the shim went while a recorded config could not be read').toBe(true)
  })

  it('a second uninstall of the same project does not forget the other project that names the shim', () => {
    const aFile = path.join(projectA, '.claude', 'settings.json')
    fs.mkdirSync(path.dirname(aFile), { recursive: true })
    fs.writeFileSync(aFile, JSON.stringify({ model: 'opus' }))
    inProject(projectA, () => installHooks('project'))
    inProject(projectB, () => installHooks('project'))
    inProject(projectB, () => uninstallHooks('project'))
    inProject(projectB, () => uninstallHooks('project'))
    expect(fs.existsSync(claudeHookScriptPath()), 'a repeated uninstall dropped project A\'s reference').toBe(true)
  })
})
