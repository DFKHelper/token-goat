// Fixture provenance: HAND-DERIVED; seeded configs are minimal files built here, the trees compared are real writes.
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

import { copilotCliUserHooksDir, installCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { recordCreatedConfig } from '../src/bridges/created_configs.js'
import { installKimi, kimiConfigPath, kimiHookScriptPath } from '../src/bridges/kimi_install.js'
import { cmdInstall } from '../src/cli_install.js'
import { dataDir } from '../src/constants.js'
import { HookSelftestError, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

const PINNED_ENV = ['KIMI_CODE_HOME', 'COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const

let TMP: string
let restoreEntry: () => void
let origCwd: string
let origEnv: Record<string, string | undefined>

/** Every directory and file under `root` with the file bytes, so two snapshots are equal only when nothing changed. */
function tree(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const rel = path.relative(root, full).split(path.sep).join('/')
      if (fs.statSync(full).isDirectory()) {
        out.push(`d ${rel}`)
        walk(full)
      } else {
        out.push(`f ${rel} ${fs.readFileSync(full).toString('base64')}`)
      }
    }
  }
  walk(root)
  return out
}

const ledger = (): string[] => {
  const file = path.join(dataDir(), 'created-configs.json')
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as string[]) : []
}

const failProbe = (): void => {
  setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-failed-probe-'))
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

describe('a Kimi install whose hooks fail their probe', () => {
  it('leaves the tree and the ledger as they were when a config of the user\'s was already there', () => {
    fs.mkdirSync(path.dirname(kimiConfigPath()), { recursive: true })
    fs.writeFileSync(kimiConfigPath(), '[[hooks]]\nevent = "Stop"\ncommand = "echo mine"\n')
    const before = tree(TMP)
    const ledgerBefore = ledger()
    failProbe()
    expect(() => installKimi()).toThrow(HookSelftestError)
    expect(tree(TMP)).toEqual(before)
    expect(ledger()).toEqual(ledgerBefore)
  })

  it('leaves no directory or ledger entry behind on a machine with no Kimi home at all', () => {
    const before = tree(TMP)
    const ledgerBefore = ledger()
    failProbe()
    expect(() => installKimi()).toThrow(HookSelftestError)
    expect(tree(TMP)).toEqual(before)
    expect(ledger()).toEqual(ledgerBefore)
  })

  it('keeps a shim another install already put there, and its ledger entry', () => {
    fs.mkdirSync(path.dirname(kimiHookScriptPath()), { recursive: true })
    fs.writeFileSync(kimiHookScriptPath(), '// an earlier install\n')
    recordCreatedConfig(kimiHookScriptPath())
    const ledgerBefore = ledger()
    failProbe()
    expect(() => installKimi()).toThrow(HookSelftestError)
    expect(fs.existsSync(kimiHookScriptPath())).toBe(true)
    expect(ledger()).toEqual(ledgerBefore)
  })
})

describe('a Copilot hooks file whose hooks fail their probe', () => {
  it('leaves the tree and the ledger as they were when a config was already there', () => {
    const hooksDir = copilotCliUserHooksDir()
    fs.mkdirSync(hooksDir, { recursive: true })
    fs.writeFileSync(path.join(hooksDir, 'token-goat.json'), '{ "version": 1, "hooks": {} }\n')
    const before = tree(TMP)
    const ledgerBefore = ledger()
    failProbe()
    expect(() => installCopilotHooksFile(hooksDir, 'copilot')).toThrow(HookSelftestError)
    expect(tree(TMP)).toEqual(before)
    expect(ledger()).toEqual(ledgerBefore)
  })

  it('leaves no directory or ledger entry behind when nothing was there', () => {
    const before = tree(TMP)
    const ledgerBefore = ledger()
    failProbe()
    expect(() => installCopilotHooksFile(copilotCliUserHooksDir(), 'copilot')).toThrow(HookSelftestError)
    expect(tree(TMP)).toEqual(before)
    expect(ledger()).toEqual(ledgerBefore)
  })
})

describe('install --codex --kimi when the Kimi hooks fail their probe', () => {
  it('installs Codex, names Kimi as not installed, prints no Kimi success line and exits 1', async () => {
    setHookSelftestRunnerForTesting((_shell, command) =>
      command.includes('.kimi-code') ? { status: 3, stdout: '', stderr: 'boom' } : { status: 0, stdout: '{}', stderr: '' })
    const stdout: string[] = []
    const stderr: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { stdout.push(String(chunk)); return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { stderr.push(String(chunk)); return true })
    const kimiBefore = fs.existsSync(path.dirname(kimiConfigPath()))

    await cmdInstall({ codex: true, kimi: true })

    const printed = stdout.join('')
    expect(printed, 'Codex is the other host and must still install').toContain('Installed token-goat Codex CLI integration')
    expect(printed).not.toContain('Kimi')
    expect(stderr.join('')).toContain('Kimi Code was not installed')
    expect(process.exitCode).toBe(1)
    expect(kimiBefore).toBe(false)
    expect(fs.existsSync(path.dirname(kimiConfigPath())), 'the failed Kimi install left its directory').toBe(false)
  })
})
