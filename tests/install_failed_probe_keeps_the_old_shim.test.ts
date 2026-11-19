// Fixture provenance: HAND-DERIVED; every earlier file is written here, so byte equality proves the restore.
import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted -- wrap homedir so the install resolves `~` to the temp dir, never a real home.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { codexHookScriptPath, installCodex } from '../src/bridges/codex_install.js'
import { grokHookScriptPath, installGrok } from '../src/bridges/grok_install.js'
import { LEGACY_SHIM_FILE } from '../src/bridges/shim_common.js'
import { HookSelftestError, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'
import { claudeHookScriptPath, installHooks, settingsPath } from '../src/install.js'
import { codexConfigPath, grokConfigPath } from '../src/purge.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

const PINNED_ENV = ['KIMI_CODE_HOME', 'COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const
const OLD_SHIM = '// earlier working shim\n'
const OLD_FORWARDER = '// earlier working forwarder\n'
const SETTINGS = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}\n'

let TMP: string
let restoreEntry: () => void
let origCwd: string
let origEnv: Record<string, string | undefined>

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-old-shim-'))
  const home = path.join(TMP, 'home')
  fs.mkdirSync(home, { recursive: true })
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(home)
  origEnv = Object.fromEntries(PINNED_ENV.map((k) => [k, process.env[k]]))
  for (const k of PINNED_ENV) delete process.env[k]
  restoreEntry = pinInstalledEntry(path.join(TMP, 'entry'))
  origCwd = process.cwd()
  process.chdir(TMP)
})

afterEach(() => {
  process.chdir(origCwd)
  restoreEntry()
  setHookSelftestRunnerForTesting(undefined)
  for (const k of PINNED_ENV) {
    if (origEnv[k] === undefined) delete process.env[k]
    else process.env[k] = origEnv[k]
  }
  process.exitCode = undefined
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
})

const save = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}
const forwarderOf = (shim: string): string => path.join(path.dirname(shim), LEGACY_SHIM_FILE)

interface Host {
  readonly name: string
  readonly shim: () => string
  readonly config: () => string
  readonly install: () => unknown
}

const hosts: Host[] = [
  {
    name: 'Claude Code',
    shim: claudeHookScriptPath,
    config: () => settingsPath('user'),
    install: () => installHooks('user'),
  },
  { name: 'Codex', shim: codexHookScriptPath, config: codexConfigPath, install: installCodex },
  { name: 'Grok', shim: grokHookScriptPath, config: grokConfigPath, install: installGrok },
]

describe.each(hosts)('$name: a reinstall over an existing registration', ({ shim, config, install }) => {
  const seed = (): void => {
    save(shim(), OLD_SHIM)
    save(forwarderOf(shim()), OLD_FORWARDER)
    save(config(), config().endsWith('.toml') ? '# mine\n' : SETTINGS)
  }

  it('keeps the earlier shim, forwarder and config when its probe fails', () => {
    seed()
    const configBefore = fs.readFileSync(config(), 'utf8')
    setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
    expect(() => install()).toThrow(HookSelftestError)
    expect(fs.readFileSync(shim(), 'utf8'), 'shim holds its earlier bytes').toBe(OLD_SHIM)
    const forwarder = fs.readFileSync(forwarderOf(shim()), 'utf8')
    expect(forwarder, 'forwarder holds its earlier bytes').toBe(OLD_FORWARDER)
    expect(fs.readFileSync(config(), 'utf8'), 'config unchanged').toBe(configBefore)
  })

  it('leaves a shim another program rewrote during the probe, and names it', () => {
    seed()
    setHookSelftestRunnerForTesting(() => {
      save(shim(), '// the second writer\n')
      return { status: 3, stdout: '', stderr: 'boom' }
    })
    let message = ''
    try {
      install()
    } catch (e) {
      message = (e as Error).message
    }
    expect(fs.readFileSync(shim(), 'utf8'), 'the second writer\'s shim').toBe('// the second writer\n')
    expect(message).toContain('changed by another program, left as found')
  })

  it('publishes the new shim and forwarder when the probe passes', () => {
    seed()
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}', stderr: '' }))
    install()
    expect(fs.readFileSync(shim(), 'utf8'), 'shim is the new one').not.toBe(OLD_SHIM)
    expect(fs.readFileSync(forwarderOf(shim()), 'utf8'), 'forwarder is the new one').not.toBe(OLD_FORWARDER)
  })
})
