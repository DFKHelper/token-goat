/** `repairHarnessHooks` runs at the end of every `token-goat install` and inside `doctor --repair`, and prints "Re-established hook: …" for each harness it rewrote. It reported a Claude Code repair on every run, right after install had wired every event: `hookEventGaps` returns `{missing: [], outdated: [], broken: []}` for a fully wired settings file, and the repair treated any non-null result as a gap. On the Node hook form (macOS, Linux, native hooks off) a second check also fired every time, because it expected the first word of each command to contain "token-goat" while that word is the node binary. Provenance: CAPTURE. The settings file under test is the one the real `installHooks('user')` writes into this sandbox, not a hand-written copy, so the test checks the repair against what install actually produces. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { installHooks, settingsPath } from '../src/install.js'

const ENV_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'COPILOT_HOME', 'KIMI_CODE_HOME', 'APPDATA', 'XDG_CONFIG_HOME', 'TOKEN_GOAT_NATIVE_HOOKS'] as const

let sandbox: string
let project: string
let savedCwd: string
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-repair-quiet-'))
  const home = path.join(sandbox, 'home')
  project = path.join(sandbox, 'proj')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  vi.mocked(os.homedir).mockReturnValue(home)
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k]
  Object.assign(process.env, {
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    CODEX_HOME: path.join(home, '.codex'),
    COPILOT_HOME: path.join(home, '.copilot'),
    KIMI_CODE_HOME: path.join(home, '.kimi-code'),
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    // The Node hook form: the one macOS and Linux get without a native client, and the one the first-word check misread.
    TOKEN_GOAT_NATIVE_HOOKS: '0',
  })
  // Project scope resolves against the cwd, so a repair can never reach this repository's own .claude/settings.json.
  savedCwd = process.cwd()
  process.chdir(project)
})

afterEach(() => {
  process.chdir(savedCwd)
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.mocked(os.homedir).mockReset()
  fs.rmSync(sandbox, { recursive: true, force: true })
})

describe('repairHarnessHooks after a fresh install', () => {
  it('reports no repair when install has just wired every Claude Code event', () => {
    installHooks('user')
    const first = repairHarnessHooks(project)
    expect(first.errors).toEqual([])
    expect(first.repairs).toEqual([])
    expect(repairHarnessHooks(project).repairs).toEqual([])
  })

  it('still repairs a user settings file that lost an event, then goes quiet', () => {
    installHooks('user')
    const file = settingsPath('user')
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> }
    expect(settings.hooks['PreCompact']).toBeDefined()
    delete settings.hooks['PreCompact']
    fs.writeFileSync(file, JSON.stringify(settings, null, 2))

    expect(repairHarnessHooks(project).repairs).toEqual(['Repaired Claude Code (user) hooks and shim'])
    const repaired = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> }
    expect(repaired.hooks['PreCompact']).toBeDefined()
    expect(repairHarnessHooks(project).repairs).toEqual([])
  })
})
