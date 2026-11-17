/** The Claude Code shim in `~/.claude/hooks` is shared by every project, so an uninstall from one project keeps it while another project's settings still name it. PROVENANCE: HAND-DERIVED from the failing session (a user-scope uninstall run from project B deleted the shim project A's `.claude/settings.json` still ran: `uv_spawn ENOENT`); settings and ledger shapes are what installHooks writes. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDir } from '../src/constants.js'
import { claudeHookScriptPath, installHooks, uninstallHooks } from '../src/install.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

let root: string
let projectA: string
let projectB: string
let origCwd: string
let origClaudeDir: string | undefined
let restoreEntry: () => void

beforeEach(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-shim-cross-scope-')))
  projectA = path.join(root, 'a')
  projectB = path.join(root, 'b')
  fs.mkdirSync(projectA, { recursive: true })
  fs.mkdirSync(projectB, { recursive: true })
  origCwd = process.cwd()
  origClaudeDir = process.env['CLAUDE_CONFIG_DIR']
  process.env['CLAUDE_CONFIG_DIR'] = path.join(root, 'claude')
  restoreEntry = pinInstalledEntry(root)
  fs.rmSync(path.join(dataDir(), 'created-configs.json'), { force: true })
})

afterEach(() => {
  process.chdir(origCwd)
  restoreEntry()
  if (origClaudeDir === undefined) delete process.env['CLAUDE_CONFIG_DIR']
  else process.env['CLAUDE_CONFIG_DIR'] = origClaudeDir
  fs.rmSync(path.join(dataDir(), 'created-configs.json'), { force: true })
  fs.rmSync(root, { recursive: true, force: true })
})

/** Project A installs, then the shared shim is the only thing both projects use. */
function installInA(): string {
  process.chdir(projectA)
  installHooks('project')
  const settings = path.join(projectA, '.claude', 'settings.json')
  expect(fs.readFileSync(settings, 'utf8')).toContain('token-goat-shim')
  expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  return settings
}

describe('uninstalling from another project', () => {
  it('keeps the shim while project A still names it', () => {
    installInA()
    process.chdir(projectB)
    uninstallHooks('user')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })

  it('keeps the shim when project A\'s settings file cannot be parsed', () => {
    const settings = installInA()
    fs.writeFileSync(settings, '{ "hooks": ')
    process.chdir(projectB)
    uninstallHooks('user')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })

  it('keeps the shim when the created-configs ledger cannot be parsed', () => {
    installInA()
    fs.writeFileSync(path.join(dataDir(), 'created-configs.json'), '[ "unterminated')
    process.chdir(projectB)
    uninstallHooks('user')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })

  it('is not pinned by a ledger entry whose config file is gone', () => {
    installInA()
    process.chdir(projectB)
    fs.rmSync(projectA, { recursive: true, force: true })
    uninstallHooks('user')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })
})
