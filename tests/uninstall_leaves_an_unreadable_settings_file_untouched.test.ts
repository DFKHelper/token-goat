// Uninstall read a harness settings.json it could not parse as one holding no token-goat hooks. The Claude Code uninstall then deleted the shared hook shim, reported the hooks removed and deleted the file's backups, while the file, left byte-identical, still wired hooks that run that shim: the loop 70 review's isolated dogfood of the built bundle left 8 `token-goat` mentions in such a file with the shim and its backup gone (loop-ledger DL-46). The Gemini CLI and Qwen Code uninstalls deleted their backups the same way. Each uninstall now reads the file the way install does, refuses by path one that is there but cannot be read or parsed, and changes nothing, so the file, the shim and the backups are all still there when the user fixes the file and runs uninstall again.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { GeminiSettingsParseError, geminiSettingsPath, installGemini, uninstallGemini } from '../src/bridges/gemini_install.js'
import { QwenSettingsParseError, installQwen, qwenSettingsPath, uninstallQwen } from '../src/bridges/qwen_install.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { SettingsParseError, claudeHookScriptPath, installHooks, settingsPath, uninstallHooks } from '../src/install.js'

// Side-effect import: registers every hook handler before an install narrows its matchers, as cmdInstall does.
import '../src/relay.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TOKEN_GOAT_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const

let saved: Record<string, string | undefined>
let base: string
let origCwd: string

/** Every home, config and data root pointed into `base`, so neither this process nor a child it spawns can reach the developer's own `~/.claude`, `~/.gemini`, `~/.qwen` or ledger. */
function isolatedEnv(): Record<(typeof ENV_KEYS)[number], string> {
  return {
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
    // String-form hooks, so an install never spawns whatever `claude` binary the machine running this has on PATH.
    TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '0',
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-unreadable-')))
  Object.assign(process.env, isolatedEnv())
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  // The Claude Code uninstall reads the project scope's settings.json from the cwd before it decides about the shared shim.
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
  error: new (message?: string) => Error
  /** Whether token-goat keeps a generated shim that this harness's hooks run. */
  shim: boolean
}

const HARNESSES: Harness[] = [
  { name: 'Claude Code', settings: () => settingsPath('user'), install: () => installHooks('user'), uninstall: () => uninstallHooks('user'), error: SettingsParseError, shim: true },
  { name: 'Gemini CLI', settings: geminiSettingsPath, install: installGemini, uninstall: uninstallGemini, error: GeminiSettingsParseError, shim: false },
  { name: 'Qwen Code', settings: qwenSettingsPath, install: installQwen, uninstall: uninstallQwen, error: QwenSettingsParseError, shim: false },
]

// HAND-DERIVED: a trailing comma before the closing brace, the typo a hand edit of a JSON settings file most often leaves; the file still holds every hook install wrote.
const withTrailingComma = (installed: string): string => `${installed.trimEnd().replace(/\}$/, ',}')}\n`

// HAND-DERIVED: three ways a settings file install wrote can be there and still not be a JSON object uninstall can read. A directory stands in for a file the process may not read, a permission or another process's lock, since reading a directory fails with EISDIR on every platform while a permission bit does not stop a read on Windows.
const BREAKAGES: Array<[string, (p: string) => void]> = [
  ['invalid JSON', (p) => fs.writeFileSync(p, withTrailingComma(fs.readFileSync(p, 'utf8')))],
  ['JSON whose top level is not an object', (p) => fs.writeFileSync(p, `[${fs.readFileSync(p, 'utf8')}]\n`)],
  ['a directory where the file should be', (p) => {
    fs.rmSync(p)
    fs.mkdirSync(p)
  }],
]

/** What is at `p` now: the file's bytes, or a marker for the directory standing in for an unreadable file. */
function contentAt(p: string): string {
  return fs.statSync(p).isDirectory() ? '<directory>' : fs.readFileSync(p, 'utf8')
}

describe('uninstall refuses a settings file it cannot read and changes nothing', () => {
  for (const h of HARNESSES) {
    for (const [breakage, breakIt] of BREAKAGES) {
      it(`${h.name}, ${breakage}`, () => {
        const p = h.settings()
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
        // CAPTURE: the real install wires its hooks and backs up the file it rewrote, under whatever names the shipping code gives them.
        h.install()
        const backups = backupsOf(p)
        expect(backups.length, 'install backed up nothing, so the test cannot see a backup deleted').toBeGreaterThan(0)
        if (h.shim) expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
        breakIt(p)
        const broken = contentAt(p)

        let thrown: unknown
        try {
          h.uninstall()
        } catch (e) {
          thrown = e
        }

        expect(thrown).toBeInstanceOf(h.error)
        expect((thrown as Error).message).toContain(`'${p}' is unreadable`)
        expect((thrown as Error).message).toContain('run uninstall again')
        expect(contentAt(p)).toBe(broken)
        expect(backupsOf(p)).toEqual(backups)
        if (h.shim) expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
      })
    }
  }

  it('Claude Code: once the file parses again, the same uninstall strips the hooks and removes the shim and the backups', () => {
    const p = settingsPath('user')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
    installHooks('user')
    const installed = fs.readFileSync(p, 'utf8')
    fs.writeFileSync(p, withTrailingComma(installed))
    expect(() => uninstallHooks('user')).toThrow(SettingsParseError)

    fs.writeFileSync(p, installed)

    expect(uninstallHooks('user')).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).not.toContain('token-goat')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
    expect(backupsOf(p)).toEqual([])
  })
})

describe('the shared Claude Code shim outlives a project-scope uninstall while the user-scope file cannot be read', () => {
  it('a user-scope settings file that does not parse keeps the shim its hooks may run', () => {
    const user = settingsPath('user')
    installHooks('user')
    installHooks('project')
    const broken = withTrailingComma(fs.readFileSync(user, 'utf8'))
    fs.writeFileSync(user, broken)

    expect(uninstallHooks('project')).toBe(true)

    // Install created the project settings file, so uninstall removes it once it holds nothing.
    expect(fs.existsSync(settingsPath('project'))).toBe(false)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
    expect(fs.readFileSync(user, 'utf8')).toBe(broken)
  })

  it('with no user-scope settings file at all, the project-scope uninstall removes the shim', () => {
    installHooks('project')
    expect(fs.existsSync(settingsPath('user'))).toBe(false)

    expect(uninstallHooks('project')).toBe(true)

    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })
})

// Install reads each file through the same strict reader, so a file that is there but cannot be read now stops it too, by its path and before it writes anything, where it used to read as empty until backing the file up failed with a raw file-system error.
describe('install refuses a settings file it cannot read and writes nothing', () => {
  for (const h of HARNESSES) {
    it(`${h.name}, a directory where the file should be`, () => {
      const p = h.settings()
      fs.mkdirSync(p, { recursive: true })

      let thrown: unknown
      try {
        h.install()
      } catch (e) {
        thrown = e
      }

      expect(thrown).toBeInstanceOf(h.error)
      expect((thrown as Error).message).toContain(`'${p}' exists but cannot be read`)
      expect(contentAt(p)).toBe('<directory>')
      expect(fs.readdirSync(p)).toEqual([])
      expect(backupsOf(p)).toEqual([])
      if (h.shim) expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
    })
  }
})

describe('token-goat uninstall through the built bundle', () => {
  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const bundle = path.join(origCwd, 'dist', 'token-goat.mjs')
    const env = { ...process.env, ...isolatedEnv(), TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0' }
    const result = spawnSync(process.execPath, [bundle, ...args], { cwd: base, encoding: 'utf8', env })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('exits non-zero naming the settings file, and leaves the file, the shim and its backups where they were', () => {
    const p = settingsPath('user')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`)
    expect(run(['install']).status).toBe(0)
    const backups = backupsOf(p)
    expect(backups.length).toBeGreaterThan(0)
    const broken = withTrailingComma(fs.readFileSync(p, 'utf8'))
    fs.writeFileSync(p, broken)

    const { status, stdout, stderr } = run(['uninstall'])

    expect(status).toBe(1)
    expect(stderr).toContain(`settings file '${p}' is unreadable`)
    expect(stdout).not.toContain('Removed token-goat hooks')
    expect(fs.readFileSync(p, 'utf8')).toBe(broken)
    expect(backupsOf(p)).toEqual(backups)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })
})
