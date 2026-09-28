// Uninstall deletes the timestamped backups token-goat made of a harness's settings.json, and the Claude Code, Gemini CLI and Qwen Code uninstalls ran that cleanup only on the path that had just stripped token-goat's entries. A settings file with no `hooks` map, or with only the user's own hooks, returned before it: the entries are already gone when the user took them out by hand or an earlier uninstall did, and every backup install had made stayed in a directory the user had been told the product was gone from. The Claude Code uninstall also left its generated shim behind on the no-`hooks` path. Codex and OpenClaw already cleaned up whatever they found; these three now do too, and still delete nothing but what the created-configs ledger says token-goat wrote.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { geminiSettingsPath, installGemini, uninstallGemini } from '../src/bridges/gemini_install.js'
import { installQwen, qwenSettingsPath, uninstallQwen } from '../src/bridges/qwen_install.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { claudeHookScriptPath, installHooks, settingsPath, uninstallHooks } from '../src/install.js'

// Side-effect import: registers every hook handler before an install narrows its matchers, as cmdInstall does.
import '../src/relay.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'TOKEN_GOAT_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const

let saved: Record<string, string | undefined>
let base: string
let origCwd: string

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-backups-')))
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
  // The Claude Code uninstall reads the project scope's settings.json from the cwd before it removes the shared shim.
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

/** Every `settings.json.bak.*` sibling of `p`, sorted. */
function backupsOf(p: string): string[] {
  const prefix = `${path.basename(p)}.bak.`
  return fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(prefix)).sort()
}

interface Harness {
  name: string
  settings: () => string
  install: () => unknown
  uninstall: () => boolean
  /** A hook the user wired themselves, in the harness's own settings.json shape. */
  userHooks: Record<string, unknown>
}

const HARNESSES: Harness[] = [
  // HAND-DERIVED: a user's own PreToolUse hook in the `hooks: { <Event>: [{ matcher, hooks: [{ type, command }] }] }` shape install.ts reads and writes for Claude Code.
  { name: 'Claude Code', settings: () => settingsPath('user'), install: () => installHooks('user'), uninstall: () => uninstallHooks('user'), userHooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo checked' }] }] } },
  // FORMAT-DERIVED: Gemini CLI's hook reference (https://geminicli.com/docs/hooks/reference/, cited in gemini_install.ts) names the event BeforeTool and matches on its own tool ids.
  { name: 'Gemini CLI', settings: geminiSettingsPath, install: installGemini, uninstall: uninstallGemini, userHooks: { BeforeTool: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo checked' }] }] } },
  // FORMAT-DERIVED: Qwen Code's hooks doc (QwenLM/qwen-code docs/users/features/hooks.md, cited in qwen_install.ts) mirrors Claude Code's event names and nesting.
  { name: 'Qwen Code', settings: qwenSettingsPath, install: installQwen, uninstall: uninstallQwen, userHooks: { PreToolUse: [{ matcher: 'run_shell_command', hooks: [{ type: 'command', command: 'echo checked' }] }] } },
]

// HAND-DERIVED: what the user's settings.json holds before install and again after they take token-goat's entries out by hand, once with no `hooks` map at all and once with only hooks of their own.
const SHAPES: Array<[string, (h: Harness) => Record<string, unknown>]> = [
  ['no hooks map', () => ({ theme: 'dark' })],
  ["only the user's own hooks", (h) => ({ theme: 'dark', hooks: h.userHooks })],
]

describe('uninstall deletes the backups token-goat made of a settings file its entries are already gone from', () => {
  for (const h of HARNESSES) {
    for (const [shape, userSettings] of SHAPES) {
      it(`${h.name}, ${shape}`, () => {
        const p = h.settings()
        const original = `${JSON.stringify(userSettings(h), null, 2)}\n`
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, original)
        // CAPTURE: the real install backs up the file it is about to rewrite, and records the backup, under whatever name the shipping code gives it.
        h.install()
        const ours = backupsOf(p)
        expect(ours.length, 'install backed up nothing, so there is nothing for uninstall to clean').toBeGreaterThan(0)
        // HAND-DERIVED: the user takes token-goat's entries out by hand, and keeps a copy of their own under a name install never records.
        fs.writeFileSync(p, original)
        fs.writeFileSync(`${p}.bak.keep`, original)

        h.uninstall()

        expect(backupsOf(p)).toEqual([`${path.basename(p)}.bak.keep`])
        expect(fs.readFileSync(p, 'utf8')).toBe(original)
      })
    }
  }

  it('Claude Code, no hooks map: the generated shim leaves with the backups', () => {
    const p = settingsPath('user')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '{"theme":"dark"}\n')
    installHooks('user')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
    fs.writeFileSync(p, '{"theme":"dark"}\n')

    uninstallHooks('user')

    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })
})
