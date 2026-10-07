// The Codex, Kimi Code, OpenClaw and JetBrains uninstalls read a config they could not read or parse as one holding nothing of token-goat's (loop-ledger DL-47). CAPTURE on Windows (node 24.12.0, 2026-09-27): loop 72's isolated dogfood of the built bundle broke each config after a real install, and every `token-goat uninstall --<flag>` exited 0 printing "Removed token-goat <integration>", while the config, byte-identical, still named token-goat. Codex and Kimi lost their hook shim and the config's backup, Kimi its skill too, OpenClaw its plugin, the plugin's entry sidecar and the backup, and JetBrains its Copilot instructions file; an openclaw.json whose `plugins.load.paths` was a string was rewritten without that field. Each uninstall now reads its config the way install does and refuses one that is there but cannot be read or parsed by its path before it changes anything, so the file and everything it may still name are there when the user fixes it and runs uninstall again, as loop 71 made Claude Code, the Gemini CLI and Qwen Code do (DL-46).

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CodexConfigParseError, codexAgentsPath, codexConfigPath, codexHookScriptPath, installCodex, uninstallCodex } from '../src/bridges/codex_install.js'
import { installJetbrains, jetbrainsInstructionsPath, jetbrainsUserMcpPath, uninstallJetbrains } from '../src/bridges/jetbrains_install.js'
import { KimiConfigParseError, installKimi, kimiAgentsPath, kimiConfigPath, kimiHookScriptPath, kimiSkillPath, uninstallKimi } from '../src/bridges/kimi_install.js'
import { OpenclawConfigParseError, installOpenclaw, openclawConfigPath, openclawEntrySidecarPath, openclawPluginPath, uninstallOpenclaw } from '../src/bridges/openclaw_install.js'
import { _resetDataDirCacheForTesting } from '../src/constants.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TOKEN_GOAT_HOME', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS', 'KIMI_CODE_HOME'] as const

let saved: Record<string, string | undefined>
let base: string
let origCwd: string
let restoreEntry: () => void

/** Every home, config and data root pointed into `base`, Kimi Code's own among them, so neither this process nor a child it spawns can reach the developer's `~/.codex`, Kimi home, `~/.openclaw`, JetBrains config or ledger. */
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
    TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS: '0',
    KIMI_CODE_HOME: path.join(base, 'kimi'),
  }
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-uninstall-bridge-')))
  Object.assign(process.env, isolatedEnv())
  _resetDataDirCacheForTesting()
  origCwd = process.cwd()
  // JetBrains picks project scope for a directory holding `.idea`; `base` holds none, so both installs here and the bundle's uninstall take the user scope.
  process.chdir(base)
  // The installs below run in this process, so each bakes process.argv[1] into its entries as the bundle path, and an uninstall knows an entry for token-goat's by a `token-goat` path segment or `token-goat.mjs` in it. Vitest's worker entry has neither, so these tests passed only in a checkout whose own directory is named token-goat: CAPTURE, a clone at /home/gabe/tg-loop72-clone on WSL (node 24.14.0) kept all six Kimi hooks after the restored-config uninstall. An installed bundle's path, as pinInstalledEntry stubs it, carries both.
  restoreEntry = pinInstalledEntry(base)
})

afterEach(() => {
  restoreEntry()
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  _resetDataDirCacheForTesting()
  fs.rmSync(base, { recursive: true, force: true })
})

/** Every `<name>.bak.*` sibling of `p`, sorted. */
function backupsOf(p: string): string[] {
  const prefix = `${path.basename(p)}.bak.`
  return fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(prefix)).sort()
}

/** What is at `p` now: the file's bytes, or a marker for the directory standing in for an unreadable file. */
function contentAt(p: string): string {
  return fs.statSync(p).isDirectory() ? '<directory>' : fs.readFileSync(p, 'utf8')
}

/** The bytes of each file, or null for one that is not there. */
function snapshot(paths: string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((p) => [p, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null]))
}

type Breakage = [string, (p: string) => void]

// HAND-DERIVED: an unclosed table header, a typo a hand edit of a TOML file leaves; every hook install wrote is still in the file.
const TOML_SYNTAX: Breakage = ['invalid TOML', (p) => fs.appendFileSync(p, '\n[profiles.fast\n')]
// HAND-DERIVED: a trailing comma before the closing brace, the typo a hand edit of a JSON file most often leaves.
const JSON_SYNTAX: Breakage = ['invalid JSON', (p) => fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8').trimEnd().replace(/\}$/, ',}')}\n`)]
// HAND-DERIVED: a doubled comma before the closing brace; OpenClaw reads its config as JSON5 (https://docs.openclaw.ai/gateway/configuration), where a single trailing comma is valid, so its syntax breakage needs one JSON5 refuses too.
const JSON5_SYNTAX: Breakage = ['invalid JSON5', (p) => fs.writeFileSync(p, `${fs.readFileSync(p, 'utf8').trimEnd().replace(/\}$/, ',,}')}\n`)]
const JSON_NOT_OBJECT: Breakage =['JSON whose top level is not an object', (p) => fs.writeFileSync(p, `[${fs.readFileSync(p, 'utf8')}]\n`)]
// A directory stands in for a file the process may not read, a permission or another process's lock: reading a directory fails with EISDIR on every platform, while a permission bit does not stop a read on Windows.
const DIRECTORY: Breakage = ['a directory where the file should be', (p) => {
  fs.rmSync(p)
  fs.mkdirSync(p)
}]
// HAND-DERIVED: OpenClaw's `plugins.load.paths` hand-edited from the array install wrote to its one path as a bare string, a shape install already refuses.
const OPENCLAW_PATHS_STRING: Breakage = ['a plugins.load.paths that is not an array', (p) => {
  const config = JSON.parse(fs.readFileSync(p, 'utf8')) as { plugins: { load: { paths: string[] | string } } }
  config.plugins.load.paths = (config.plugins.load.paths as string[])[0] as string
  fs.writeFileSync(p, `${JSON.stringify(config, null, 2)}\n`)
}]

interface Bridge {
  name: string
  /** The uninstall flag, and the label the CLI reports a removal under. */
  flag: string
  label: string
  config: () => string
  /** What the user had in the config before install, so install backs the file up. HAND-DERIVED. */
  seed: string
  install: () => unknown
  uninstall: () => boolean
  error: new (message?: string) => Error
  /** The files install writes beside the config, all of which a completed uninstall removes or strips. */
  artifacts: () => string[]
  breakages: Breakage[]
}

const BRIDGES: Bridge[] = [
  {
    name: 'Codex',
    flag: '--codex',
    label: 'Codex CLI integration',
    config: codexConfigPath,
    seed: 'model = "o4-mini"\n',
    install: installCodex,
    uninstall: uninstallCodex,
    error: CodexConfigParseError,
    artifacts: () => [codexHookScriptPath(), codexAgentsPath()],
    breakages: [TOML_SYNTAX, DIRECTORY],
  },
  {
    name: 'Kimi Code',
    flag: '--kimi',
    label: 'Kimi Code integration',
    config: kimiConfigPath,
    seed: 'default_model = "kimi-k2"\n',
    install: installKimi,
    uninstall: uninstallKimi,
    error: KimiConfigParseError,
    artifacts: () => [kimiHookScriptPath(), kimiAgentsPath(), kimiSkillPath()],
    breakages: [TOML_SYNTAX, DIRECTORY],
  },
  {
    name: 'OpenClaw',
    flag: '--openclaw',
    label: 'OpenClaw integration',
    config: openclawConfigPath,
    seed: `${JSON.stringify({ gateway: { port: 18789 } }, null, 2)}\n`,
    install: installOpenclaw,
    uninstall: uninstallOpenclaw,
    error: OpenclawConfigParseError,
    artifacts: () => [openclawPluginPath(), openclawEntrySidecarPath()],
    breakages: [JSON5_SYNTAX, JSON_NOT_OBJECT, DIRECTORY, OPENCLAW_PATHS_STRING],
  },
  {
    name: 'JetBrains',
    flag: '--jetbrains',
    label: 'JetBrains MCP integration',
    config: jetbrainsUserMcpPath,
    seed: `${JSON.stringify({ mcpServers: { other: { command: 'other-server' } } }, null, 2)}\n`,
    install: () => installJetbrains(),
    uninstall: () => uninstallJetbrains(),
    // The JetBrains installer has no error class of its own; its install refuses a config it cannot use with a plain Error too, which the CLI reports and exits 1 on like any other.
    error: Error,
    artifacts: () => [jetbrainsInstructionsPath('user')],
    breakages: [JSON_SYNTAX, JSON_NOT_OBJECT, DIRECTORY],
  },
]

/** A real install over the seeded config, checked to have left a backup and every artifact, so no assertion below can pass on something that was never there. */
function installOver(b: Bridge): { p: string; backups: string[]; artifacts: Record<string, string | null> } {
  const p = b.config()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, b.seed)
  // CAPTURE: the real install writes its entries and backs up the file it rewrote, under whatever names the shipping code gives them.
  b.install()
  const backups = backupsOf(p)
  expect(backups.length, 'install backed up nothing, so the test cannot see a backup deleted').toBeGreaterThan(0)
  const artifacts = snapshot(b.artifacts())
  for (const [artifact, content] of Object.entries(artifacts)) expect(content, `install did not write ${artifact}`).not.toBeNull()
  return { p, backups, artifacts }
}

describe('uninstall refuses a bridge config it cannot read and changes nothing', () => {
  for (const b of BRIDGES) {
    for (const [breakage, breakIt] of b.breakages) {
      it(`${b.name}, ${breakage}`, () => {
        const { p, backups, artifacts } = installOver(b)
        breakIt(p)
        const broken = contentAt(p)

        let thrown: unknown
        try {
          b.uninstall()
        } catch (e) {
          thrown = e
        }

        expect(thrown).toBeInstanceOf(b.error)
        expect((thrown as Error).message).toContain(`"${p}" is unreadable`)
        expect((thrown as Error).message).toContain('run uninstall again')
        expect(contentAt(p)).toBe(broken)
        expect(backupsOf(p)).toEqual(backups)
        expect(snapshot(b.artifacts())).toEqual(artifacts)
      })
    }
  }
})

describe('once the config reads again, the same uninstall removes what install wrote', () => {
  for (const b of BRIDGES) {
    it(b.name, () => {
      const { p } = installOver(b)
      const installed = fs.readFileSync(p, 'utf8')
      b.breakages[0]![1](p)
      expect(() => b.uninstall()).toThrow(b.error)

      fs.writeFileSync(p, installed)

      expect(b.uninstall()).toBe(true)
      expect(fs.readFileSync(p, 'utf8')).not.toContain('token-goat')
      for (const artifact of b.artifacts()) expect(fs.existsSync(artifact) ? fs.readFileSync(artifact, 'utf8') : '', artifact).not.toContain('token-goat')
      // The config's backups are token-goat's own litter and leave with it. The JetBrains uninstall kept them, three after a clean install and uninstall, since it backed the file up twice before writing it and removed none; it now removes them as every other bridge does.
      expect(backupsOf(p)).toEqual([])
    })
  }
})

// Install reads each TOML or OpenClaw config through the same strict reader, so one that is there but cannot be read now stops it by its path, where it used to read as empty until backing the file up failed with a raw file-system error. The JetBrains install already refused one by its path.
describe('install refuses a bridge config it cannot read and leaves it as it was', () => {
  for (const b of BRIDGES.filter((x) => x.name !== 'JetBrains')) {
    it(`${b.name}, a directory where the file should be`, () => {
      const p = b.config()
      fs.mkdirSync(p, { recursive: true })

      let thrown: unknown
      try {
        b.install()
      } catch (e) {
        thrown = e
      }

      expect(thrown).toBeInstanceOf(b.error)
      expect((thrown as Error).message).toContain(`"${p}" exists but cannot be read`)
      expect(contentAt(p)).toBe('<directory>')
      expect(fs.readdirSync(p)).toEqual([])
      expect(backupsOf(p)).toEqual([])
    })
  }

  it('OpenClaw writes neither its plugin nor its sidecar before it refuses', () => {
    fs.mkdirSync(openclawConfigPath(), { recursive: true })
    expect(() => installOpenclaw()).toThrow(OpenclawConfigParseError)
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(false)
  })
})

describe('token-goat uninstall through the built bundle', () => {
  function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const bundle = path.join(origCwd, 'dist', 'token-goat.mjs')
    const env = { ...process.env, ...isolatedEnv(), TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0' }
    const result = spawnSync(process.execPath, [bundle, ...args], { cwd: base, encoding: 'utf8', env })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  for (const b of BRIDGES) {
    it(`${b.flag} exits 1 naming the config, and leaves the config, what it names and its backups where they were`, () => {
      const { p, backups, artifacts } = installOver(b)
      b.breakages[0]![1](p)
      const broken = contentAt(p)

      const { status, stdout, stderr } = run(['uninstall', b.flag])

      expect(status).toBe(1)
      expect(stderr).toContain(`"${p}" is unreadable`)
      expect(stdout).not.toContain(`Removed token-goat ${b.label}`)
      expect(contentAt(p)).toBe(broken)
      expect(backupsOf(p)).toEqual(backups)
      expect(snapshot(b.artifacts())).toEqual(artifacts)
    })
  }
})
