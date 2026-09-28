// A Claude Code uninstall took token-goat's shim, CLAUDE.md block and skill out of Claude Code's config directory and left behind the containers install had made to hold them: a CLAUDE.md with nothing in it, an empty `hooks` directory and an empty `skills` directory. Install now records each one it brings into being in the created-configs ledger, and uninstall removes it again once it is empty. Emptiness alone never decides it, because a user's own empty CLAUDE.md or `skills` directory looks exactly the same on disk: one install found already there stays, and so does one install made that the user has since put anything into.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { claudeHookScriptPath, claudeMdPath, installClaudeMd, installHooks, installSkill, skillDir, uninstallClaudeMd, uninstallHooks, uninstallSkill } from '../src/install.js'

// Side-effect import: registers every hook handler before an install narrows its matchers, as cmdInstall does.
import '../src/relay.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const

let saved: Record<string, string | undefined>
let base: string
let origCwd: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-created-')))
  // Claude Code's own config directory is there before token-goat is installed into it.
  fs.mkdirSync(path.join(base, 'claude'))
  process.env['CLAUDE_CONFIG_DIR'] = path.join(base, 'claude')
  process.env['HOME'] = path.join(base, 'home')
  process.env['USERPROFILE'] = path.join(base, 'home')
  process.env['LOCALAPPDATA'] = path.join(base, 'share')
  process.env['XDG_DATA_HOME'] = path.join(base, 'share')
  process.env['TOKEN_GOAT_HOME'] = path.join(base, 'tghome')
  // String-form hooks, so the install never spawns whatever `claude` binary the machine running this has on PATH.
  process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = '0'
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  // The uninstall reads the project scope's settings.json from the cwd before it removes the shared shim.
  process.chdir(base)
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

// CAPTURE: every file, directory and ledger entry below is written by the real base install, the three calls cmdInstall makes for Claude Code, and taken away by the three calls cmdUninstall makes, in its order.
function baseInstall(): void {
  installHooks('user')
  installClaudeMd()
  installSkill()
}

function baseUninstall(): void {
  uninstallHooks('user')
  uninstallClaudeMd()
  uninstallSkill()
}

const hooksDir = (): string => path.dirname(claudeHookScriptPath())
const skillsDir = (): string => path.dirname(skillDir())

describe('a user-scope uninstall removes the empty CLAUDE.md, hooks and skills its install created', () => {
  it('removes all three once nothing is left in them', () => {
    baseInstall()
    expect([claudeMdPath(), hooksDir(), skillsDir()].map((p) => fs.existsSync(p))).toEqual([true, true, true])

    baseUninstall()

    expect([claudeMdPath(), hooksDir(), skillsDir()].map((p) => fs.existsSync(p))).toEqual([false, false, false])
  })

  it('leaves the ones that were already there, however empty', () => {
    // HAND-DERIVED: an empty CLAUDE.md and empty hooks and skills directories a user, or Claude Code itself, made before token-goat was installed.
    fs.writeFileSync(claudeMdPath(), '')
    fs.mkdirSync(hooksDir())
    fs.mkdirSync(skillsDir())

    baseInstall()
    baseUninstall()

    expect(fs.readFileSync(claudeMdPath(), 'utf8')).toBe('')
    expect(fs.readdirSync(hooksDir())).toEqual([])
    expect(fs.readdirSync(skillsDir())).toEqual([])
  })

  it('leaves the ones it created that the user has since put something into', () => {
    baseInstall()
    // HAND-DERIVED: a user's own notes in CLAUDE.md, a script of theirs in hooks, and a second skill in the `skills/<name>/SKILL.md` layout Claude Code loads skills from, the one installSkill writes token-goat's into.
    fs.appendFileSync(claudeMdPath(), '\n# My notes\n')
    fs.writeFileSync(path.join(hooksDir(), 'my-hook.sh'), 'echo mine\n')
    fs.mkdirSync(path.join(skillsDir(), 'my-skill'))
    fs.writeFileSync(path.join(skillsDir(), 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: Mine.\n---\n')

    baseUninstall()

    expect(fs.readFileSync(claudeMdPath(), 'utf8')).toBe('# My notes\n')
    expect(fs.readdirSync(hooksDir())).toEqual(['my-hook.sh'])
    expect(fs.readdirSync(skillsDir())).toEqual(['my-skill'])
  })
})
