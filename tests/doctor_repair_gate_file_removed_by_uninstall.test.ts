// `doctor --repair` created a project CLAUDE.md to hold the routing gate without recording that it had created it, so `install -p` found the block already there and `uninstall -p` stripped it and left an empty CLAUDE.md behind (round 12 dogfood of the built bundle). The repair now records a file it creates in the created-configs ledger, as install does, and uninstall removes it once it holds nothing.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { repairInstructionGates } from '../src/cli_doctor_guidance.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { installClaudeMd, uninstallClaudeMd } from '../src/install.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'COPILOT_HOME', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'TOKEN_GOAT_HOME'] as const

let saved: Record<string, string | undefined>
let base: string
let project: string
let origCwd: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-gate-ledger-')))
  // Every home, config and data root inside `base`, so neither the gate check nor the ledger reaches the developer's own files.
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
    COPILOT_HOME: path.join(base, 'copilot'),
    HOME: path.join(base, 'home'),
    USERPROFILE: path.join(base, 'home'),
    LOCALAPPDATA: path.join(base, 'share'),
    APPDATA: path.join(base, 'appdata'),
    XDG_DATA_HOME: path.join(base, 'share'),
    XDG_CONFIG_HOME: path.join(base, 'config'),
    TOKEN_GOAT_HOME: path.join(base, 'tghome'),
  })
  _resetDataDirCacheForTesting()
  project = path.join(base, 'project')
  fs.mkdirSync(project)
  origCwd = process.cwd()
  // Project scope resolves CLAUDE.md against the cwd, as `uninstall -p` run in the project does.
  process.chdir(project)
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

describe('a CLAUDE.md that doctor --repair created', () => {
  // HAND-DERIVED: an empty project with no gate anywhere, the case where the repair falls back to creating CLAUDE.md in the project root.
  it('is removed by a project-scope uninstall once the block is stripped', () => {
    const claudeMd = path.join(project, 'CLAUDE.md')
    const { repairs, errors } = repairInstructionGates(project)
    expect(errors).toEqual([])
    expect(repairs).toEqual(['Injected token-goat routing gate into CLAUDE.md'])
    expect(fs.existsSync(claudeMd)).toBe(true)

    expect(installClaudeMd('project').alreadyInstalled).toBe(true)
    expect(uninstallClaudeMd('project')).toBe(true)

    expect(fs.existsSync(claudeMd)).toBe(false)
    expect(fs.readdirSync(project)).toEqual([])
  })

  // HAND-DERIVED: the user's own CLAUDE.md, which the repair adds a block to and must never be deleted.
  it('that the user wrote first keeps their content after the uninstall', () => {
    const claudeMd = path.join(project, 'CLAUDE.md')
    fs.writeFileSync(claudeMd, '# Mine\n')
    expect(repairInstructionGates(project).errors).toEqual([])
    expect(fs.readFileSync(claudeMd, 'utf8')).toContain('token-goat')

    expect(uninstallClaudeMd('project')).toBe(true)

    expect(fs.readFileSync(claudeMd, 'utf8')).toBe('# Mine\n')
  })
})
