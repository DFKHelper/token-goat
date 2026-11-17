/** `doctor` and `install` repair each harness bridge only when a rewrite is due, so a checkout run neither errors on nor writes to a healthy harness. Each row installs from the global entry, then repairs from a checkout entry: a stale file is rewritten (the guard refuses a checkout pin), an absent one is never created, and a current one is left byte-identical. Provenance: TEST. Every config home is pinned under a temp dir, so no real ~/.gemini, ~/.qwen, ~/.openclaw, ~/.pi or opencode config is read or written. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// Registers the hook handlers that Gemini's BeforeTool matchers are built from; without them none are desired.
import '../src/relay.js'
import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { geminiSettingsPath, installGemini } from '../src/bridges/gemini_install.js'
import { installOpencode, opencodeEntrySidecarPath } from '../src/bridges/opencode_install.js'
import { installQwen, qwenSettingsPath } from '../src/bridges/qwen_install.js'
import { installOpenclaw, openclawEntrySidecarPath, openclawPluginPath } from '../src/bridges/openclaw_install.js'
import { installPi, piExtensionPath } from '../src/bridges/pi_install.js'
import { antigravityHooksPath, installAntigravity } from '../src/bridges/antigravity_install.js'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'KIMI_CODE_HOME'] as const

let TMP: string
let origCwd: string
let origArgv1: string
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

/** A git checkout laid out like the repo: dist/token-goat.mjs beside .git. */
function makeCheckout(name: string): string {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'token-goat.mjs'), '// checkout build\n')
  fs.mkdirSync(path.join(root, '.git'))
  return path.join(root, 'dist', 'token-goat.mjs')
}

/** A global install laid out like npm's: no .git beside the bundle. */
function makeGlobalEntry(): string {
  const entry = path.join(TMP, 'global', 'token-goat', 'dist', 'token-goat.mjs')
  fs.mkdirSync(path.dirname(entry), { recursive: true })
  fs.writeFileSync(entry, '// global build\n')
  return entry
}

/** The hook command strings wired under one event key of a JSON settings file. */
function wiredCommands(settingsPath: string, event: string): string[] {
  const hooks = (JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as { hooks?: Record<string, { hooks?: { command?: string }[] }[]> }).hooks
  return (hooks?.[event] ?? []).flatMap((group) => (group.hooks ?? []).map((hook) => hook.command ?? ''))
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-doctor-rewrite-due-'))
  origCwd = process.cwd()
  origArgv1 = process.argv[1] ?? ''
  const home = path.join(TMP, 'home')
  fs.mkdirSync(home, { recursive: true })
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    COPILOT_HOME: path.join(home, '.copilot'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'),
  })
  delete process.env['XDG_CONFIG_HOME']
  process.chdir(TMP)
})

afterEach(() => {
  process.argv[1] = origArgv1
  process.chdir(origCwd)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('repairHarnessHooks from a checkout with healthy harnesses', () => {
  it('reports no guard error and writes nothing for current Gemini and opencode wiring', () => {
    process.argv[1] = makeGlobalEntry()
    installOpencode()
    installGemini()
    const gemini = fs.readFileSync(geminiSettingsPath(), 'utf8')
    const sidecar = fs.readFileSync(opencodeEntrySidecarPath(), 'utf8')

    process.argv[1] = makeCheckout('healthy-checkout')
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual([])
    expect(fs.readFileSync(geminiSettingsPath(), 'utf8')).toBe(gemini)
    expect(fs.readFileSync(opencodeEntrySidecarPath(), 'utf8')).toBe(sidecar)
  })
})

describe('isOpencodeRewriteDue through repairHarnessHooks', () => {
  it('takes no action when the opencode plugin was never installed', () => {
    process.argv[1] = makeGlobalEntry()
    const result = repairHarnessHooks(TMP)
    expect(result.repairs).not.toContain('Repaired opencode plugin')
    expect(fs.existsSync(opencodeEntrySidecarPath())).toBe(false)
  })

  it('rewrites a stale opencode plugin, then leaves it alone', () => {
    process.argv[1] = makeGlobalEntry()
    const { pluginPath } = installOpencode()
    const current = fs.readFileSync(pluginPath, 'utf8')
    fs.writeFileSync(pluginPath, '// stale plugin\n')

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired opencode plugin'])
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(current)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('leaves a current opencode plugin untouched', () => {
    process.argv[1] = makeGlobalEntry()
    const { pluginPath } = installOpencode()
    const before = fs.readFileSync(pluginPath, 'utf8')
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
    expect(fs.readFileSync(pluginPath, 'utf8')).toBe(before)
  })
})

describe('isGeminiRewriteDue through repairHarnessHooks', () => {
  it('takes no action when no Gemini settings file exists', () => {
    process.argv[1] = makeGlobalEntry()
    expect(repairHarnessHooks(TMP).repairs).not.toContain('Repaired Gemini CLI hooks')
    expect(fs.existsSync(geminiSettingsPath())).toBe(false)
  })

  it('rewrites a legacy bare Gemini hook command, then goes quiet', () => {
    process.argv[1] = makeGlobalEntry()
    fs.mkdirSync(path.dirname(geminiSettingsPath()), { recursive: true })
    const legacy = { hooks: { BeforeTool: [{ matcher: '*', hooks: [{ type: 'command', command: 'token-goat hook pre_tool_use' }] }] } }
    fs.writeFileSync(geminiSettingsPath(), JSON.stringify(legacy))

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired Gemini CLI hooks'])
    const wired = wiredCommands(geminiSettingsPath(), 'BeforeTool')
    expect(wired).not.toContain('token-goat hook pre_tool_use')
    expect(wired.some((command) => command.endsWith(' hook pre_tool_use') && command.includes('token-goat.mjs'))).toBe(true)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })
})

describe('isQwenRewriteDue through repairHarnessHooks', () => {
  it('takes no action when no Qwen settings file exists', () => {
    process.argv[1] = makeGlobalEntry()
    expect(repairHarnessHooks(TMP).repairs).not.toContain('Repaired Qwen Code hooks')
    expect(fs.existsSync(qwenSettingsPath())).toBe(false)
  })

  it('rewrites a legacy bare Qwen hook command, then goes quiet', () => {
    process.argv[1] = makeGlobalEntry()
    fs.mkdirSync(path.dirname(qwenSettingsPath()), { recursive: true })
    const legacy = { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'token-goat hook pre_tool_use' }] }] } }
    fs.writeFileSync(qwenSettingsPath(), JSON.stringify(legacy))

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired Qwen Code hooks'])
    expect(wiredCommands(qwenSettingsPath(), 'PreToolUse')).not.toContain('token-goat hook pre_tool_use')
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('leaves a current Qwen hook untouched with no guard error', () => {
    process.argv[1] = makeGlobalEntry()
    installQwen()
    const before = fs.readFileSync(qwenSettingsPath(), 'utf8')

    process.argv[1] = makeCheckout('healthy-qwen-checkout')
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual([])
    expect(fs.readFileSync(qwenSettingsPath(), 'utf8')).toBe(before)
  })
})

describe('isOpenclawRewriteDue through repairHarnessHooks', () => {
  it('takes no action when the OpenClaw plugin was never installed', () => {
    process.argv[1] = makeGlobalEntry()
    expect(repairHarnessHooks(TMP).repairs).not.toContain('Repaired OpenClaw plugin')
    expect(fs.existsSync(openclawPluginPath())).toBe(false)
    expect(fs.existsSync(openclawEntrySidecarPath())).toBe(false)
  })

  it('rewrites a stale OpenClaw plugin, then leaves it alone', () => {
    process.argv[1] = makeGlobalEntry()
    installOpenclaw()
    const current = fs.readFileSync(openclawPluginPath(), 'utf8')
    fs.writeFileSync(openclawPluginPath(), '// stale plugin\n')

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired OpenClaw plugin'])
    expect(fs.readFileSync(openclawPluginPath(), 'utf8')).toBe(current)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('leaves a current OpenClaw plugin untouched with no guard error', () => {
    process.argv[1] = makeGlobalEntry()
    installOpenclaw()
    const before = fs.readFileSync(openclawPluginPath(), 'utf8')

    process.argv[1] = makeCheckout('healthy-openclaw-checkout')
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual([])
    expect(fs.readFileSync(openclawPluginPath(), 'utf8')).toBe(before)
  })
})

describe('isPiRewriteDue through repairHarnessHooks', () => {
  it('takes no action when no pi extension exists in either scope', () => {
    process.argv[1] = makeGlobalEntry()
    const { repairs } = repairHarnessHooks(TMP)
    expect(repairs).not.toContain('Repaired pi extension')
    expect(repairs).not.toContain('Repaired pi (project) extension')
    expect(fs.existsSync(piExtensionPath())).toBe(false)
    expect(fs.existsSync(piExtensionPath({ local: true }))).toBe(false)
  })

  it('rewrites a stale global pi extension, then leaves it alone', () => {
    process.argv[1] = makeGlobalEntry()
    installPi()
    const current = fs.readFileSync(piExtensionPath(), 'utf8')
    fs.writeFileSync(piExtensionPath(), '// stale extension\n')

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired pi extension'])
    expect(fs.readFileSync(piExtensionPath(), 'utf8')).toBe(current)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('rewrites a stale project-local pi extension even while the global scope is current', () => {
    process.argv[1] = makeGlobalEntry()
    installPi()
    installPi({ local: true })
    const current = fs.readFileSync(piExtensionPath({ local: true }), 'utf8')
    fs.writeFileSync(piExtensionPath({ local: true }), '// stale extension\n')

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired pi (project) extension'])
    expect(fs.readFileSync(piExtensionPath({ local: true }), 'utf8')).toBe(current)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('leaves current pi extensions in both scopes untouched with no guard error', () => {
    process.argv[1] = makeGlobalEntry()
    installPi()
    installPi({ local: true })
    const global = fs.readFileSync(piExtensionPath(), 'utf8')
    const local = fs.readFileSync(piExtensionPath({ local: true }), 'utf8')

    process.argv[1] = makeCheckout('healthy-pi-checkout')
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual([])
    expect(fs.readFileSync(piExtensionPath(), 'utf8')).toBe(global)
    expect(fs.readFileSync(piExtensionPath({ local: true }), 'utf8')).toBe(local)
  })
})

describe('isAntigravityRewriteDue through repairHarnessHooks', () => {
  it('takes no action when no Antigravity integration exists', () => {
    process.argv[1] = makeGlobalEntry()
    expect(repairHarnessHooks(TMP).repairs).not.toContain('Repaired Antigravity CLI integration')
    expect(fs.existsSync(antigravityHooksPath())).toBe(false)
  })

  it('rewrites an Antigravity integration missing a hook event, then leaves it alone', () => {
    process.argv[1] = makeGlobalEntry()
    installAntigravity()
    const current = fs.readFileSync(antigravityHooksPath(), 'utf8')
    const hooks = JSON.parse(current) as { 'token-goat': { PostToolUse?: unknown } }
    delete hooks['token-goat'].PostToolUse
    fs.writeFileSync(antigravityHooksPath(), `${JSON.stringify(hooks, null, 2)}\n`)

    expect(repairHarnessHooks(TMP).repairs).toEqual(['Repaired Antigravity CLI integration'])
    expect(fs.readFileSync(antigravityHooksPath(), 'utf8')).toBe(current)
    expect(repairHarnessHooks(TMP).repairs).toEqual([])
  })

  it('leaves a current Antigravity integration untouched with no guard error', () => {
    process.argv[1] = makeGlobalEntry()
    installAntigravity()
    const before = fs.readFileSync(antigravityHooksPath(), 'utf8')

    process.argv[1] = makeCheckout('healthy-antigravity-checkout')
    const result = repairHarnessHooks(TMP)
    expect(result.errors).toEqual([])
    expect(result.repairs).toEqual([])
    expect(fs.readFileSync(antigravityHooksPath(), 'utf8')).toBe(before)
  })
})
