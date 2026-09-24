/** Claude Code's hook schema accepts an `args` array alongside `command` (>= 2.1.139): the harness then spawns `command` directly with that argv instead of handing a single string to a shell, removing a shell process from the critical path of every hook call. `TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS` ('1'/'0') forces the choice deterministically in every test below, independent of whether the machine running the suite actually has a `claude` binary on PATH new enough to trigger it -- the real probe (`claudeExecFormHooksSupported` with no override) is exercised only by the dogfood run against the built bundle, not by this suite. The predicate that recognizes "is this entry ours" moved from a bare command-string compare to a (command, args) pair compare: under exec form, `command` is just the node binary and is identical across every event and across a stale entry pointing at a deleted shim, so a string-only compare would call a stale exec-form entry "already installed." */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeHookScriptPath, expectedHookEntryFor, installHooks, isInstalled, missingHookEvents, settingsPath, uninstallHooks } from '../src/install.js'
import { hookCommandFor, hookExecPartsFor } from '../src/util.js'

let TMP: string
let origCwd: string
let origHome: string | undefined
let origUserProfile: string | undefined
let origExecFormOverride: string | undefined

interface HookEntry {
  type: string
  command: string
  args?: string[]
}
interface SettingsShape {
  hooks?: Record<string, Array<{ matcher?: string; hooks: HookEntry[] }>>
  [key: string]: unknown
}

function readSettingsFile(p: string): SettingsShape {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as SettingsShape
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-execform-'))
  origCwd = process.cwd()
  process.chdir(TMP)
  origHome = process.env['HOME']
  origUserProfile = process.env['USERPROFILE']
  const fakeHome = path.join(TMP, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  origExecFormOverride = process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']
})

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  if (origUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = origUserProfile
  if (origExecFormOverride === undefined) delete process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS']
  else process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = origExecFormOverride
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('exec-form hook registration', () => {
  it('writes command/args (not a shell-quoted string) when exec form is available', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    installHooks('project')
    const settings = readSettingsFile(settingsPath('project'))
    const entry = settings.hooks?.['PreToolUse']?.[0]?.hooks[0]
    const expected = hookExecPartsFor(claudeHookScriptPath(), 'pre_tool_use')
    expect(entry?.command).toBe(expected.command)
    expect(entry?.args).toEqual(expected.args)
    // No shell quoting anywhere in an exec-form entry -- there is no shell to parse it.
    expect(entry?.command.includes('"')).toBe(false)
    expect(entry?.args?.some((a) => a.includes('"'))).toBe(false)
  })

  it('falls back to the string form when exec form is unavailable', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
    installHooks('project')
    const settings = readSettingsFile(settingsPath('project'))
    const entry = settings.hooks?.['PreToolUse']?.[0]?.hooks[0]
    expect(entry?.command).toBe(hookCommandFor(claudeHookScriptPath(), 'pre_tool_use'))
    expect(entry?.args).toBeUndefined()
  })

  it('isInstalled recognizes our own exec-form entry', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    installHooks('project')
    expect(isInstalled('project')).toBe(true)
  })

  it('isInstalled recognizes our own string-form entry', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
    installHooks('project')
    expect(isInstalled('project')).toBe(true)
  })

  it('a stale exec-form entry (same command, different args) is replaced, not treated as already installed', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    installHooks('project')
    const p = settingsPath('project')
    const before = readSettingsFile(p)
    const staleArgs = before.hooks?.['PreToolUse']?.[0]?.hooks[0]?.args
    expect(staleArgs).toBeDefined()
    // Simulate the shim having moved (reinstall elsewhere, node upgraded): same `command` ("node"), different `args`. A bare string compare on `command` alone would call this "already installed" and leave the hook pointing at a path that no longer exists.
    const mutated = readSettingsFile(p)
    const group = mutated.hooks?.['PreToolUse']?.[0]
    // Still recognizable as a token-goat entry (the shim marker survives), but pointing at a path that no longer exists -- the exact "baked absolute path has moved" staleness shape.
    if (group !== undefined) group.hooks[0]!.args = ['C:\\deleted\\token-goat-shim.js', 'pre_tool_use']
    fs.writeFileSync(p, `${JSON.stringify(mutated, null, 2)}\n`)

    const result = installHooks('project')
    expect(result.alreadyInstalled).toBe(false)

    const after = readSettingsFile(p)
    const group2 = after.hooks?.['PreToolUse']?.[0]
    expect(group2?.hooks).toHaveLength(1)
    expect(group2?.hooks[0]?.args).toEqual(staleArgs)
  })

  it('a foreign entry (unrelated command/args) is left alone, not recognized as ours', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'node', args: ['some-other-tool.js'] }] }],
        },
      }),
    )

    installHooks('project')

    const settings = readSettingsFile(p)
    const groups = settings.hooks?.['PreToolUse'] ?? []
    const allHooks = groups.flatMap((g) => g.hooks)
    expect(allHooks.some((h) => h.command === 'node' && h.args?.[0] === 'some-other-tool.js')).toBe(true)
    const expected = expectedHookEntryFor(claudeHookScriptPath(), 'pre_tool_use')
    expect(allHooks.some((h) => h.command === expected.command && JSON.stringify(h.args) === JSON.stringify(expected.args))).toBe(true)
  })

  it('upgrading from a string-form install to exec form replaces the entry instead of adding a second one', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
    installHooks('project')
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    installHooks('project')

    const settings = readSettingsFile(settingsPath('project'))
    const hooks = settings.hooks?.['PreToolUse']?.flatMap((g) => g.hooks) ?? []
    expect(hooks).toHaveLength(1)
    expect(hooks[0]?.args).toBeDefined()
  })

  it('install, install, uninstall round-trips the settings file back to its pre-install bytes', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    const p = settingsPath('project')
    const seed = { env: { FOO: 'bar' } }
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `${JSON.stringify(seed, null, 2)}\n`)
    const before = fs.readFileSync(p, 'utf8')

    installHooks('project')
    const afterFirstInstall = fs.readFileSync(p, 'utf8')
    installHooks('project')
    expect(fs.readFileSync(p, 'utf8')).toBe(afterFirstInstall)

    uninstallHooks('project')
    expect(fs.readFileSync(p, 'utf8')).toBe(before)
  })
})

// CAPTURE: on the maintainer's machine the global npm install is a directory link to the checkout, ~/.claude/settings.json held the exec-form entry `node.exe [shim, "pre_tool_use", "C:\Projects\token-goat\dist\token-goat.mjs"]`, and `token-goat doctor` launched through the npm shim (process.argv[1] = `...\npm\node_modules\token-goat\dist\token-goat.mjs`) reported all eight wired events as missing, while the same doctor launched by the checkout path reported none of them. The junction below reproduces that pair of spellings for one file.
describe('a bundle reached through a directory link is the same hook', () => {
  let origArgv1: string | undefined

  beforeEach(() => {
    origArgv1 = process.argv[1]
  })

  afterEach(() => {
    process.argv[1] = origArgv1!
  })

  function twoSpellingsOfOneBundle(): { real: string; linked: string } {
    const realDir = path.join(TMP, 'checkout')
    fs.mkdirSync(path.join(realDir, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(realDir, 'dist', 'token-goat.mjs'), '// bundle\n')
    const linkDir = path.join(TMP, 'npm-global-token-goat')
    fs.symlinkSync(realDir, linkDir, 'junction')
    return { real: path.join(realDir, 'dist', 'token-goat.mjs'), linked: path.join(linkDir, 'dist', 'token-goat.mjs') }
  }

  for (const form of ['1', '0'] as const) {
    it(`${form === '1' ? 'exec' : 'string'} form: installed by one spelling, checked by the other, every event is wired and nothing is rewritten`, () => {
      process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = form
      const { real, linked } = twoSpellingsOfOneBundle()
      process.argv[1] = real
      installHooks('project')
      const p = settingsPath('project')
      const installed = fs.readFileSync(p, 'utf8')

      process.argv[1] = linked
      expect(missingHookEvents('project')).toEqual([])
      expect(isInstalled('project')).toBe(true)
      expect(installHooks('project').alreadyInstalled).toBe(true)
      expect(fs.readFileSync(p, 'utf8')).toBe(installed)
    })
  }

  it('a bundle path naming a different existing file is still a stale entry', () => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '1'
    const { real } = twoSpellingsOfOneBundle()
    const other = path.join(TMP, 'other-token-goat.mjs')
    fs.writeFileSync(other, '// another bundle\n')
    process.argv[1] = other
    installHooks('project')

    process.argv[1] = real
    expect(missingHookEvents('project')).toContain('PreToolUse')
    expect(isInstalled('project')).toBe(false)
  })
})
