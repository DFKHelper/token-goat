// Fixture provenance: HAND-DERIVED; every file is written here, so byte equality proves who wrote what.
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
import { HOOKS_CONFIG_FILE } from '../src/bridges/copilot_hooks_owners.js'
import { installKimi, kimiConfigPath } from '../src/bridges/kimi_install.js'
import { HookSelftestError, setHookSelftestRunnerForTesting } from '../src/hook_selftest.js'
import { pinInstalledEntry } from './helpers/installed_entry.js'

const PINNED_ENV = ['KIMI_CODE_HOME', 'COPILOT_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'] as const
const MINE = '[[hooks]]\nevent = "Stop"\ncommand = "echo mine"\n'
const SECOND_WRITER = '[[hooks]]\nevent = "Stop"\ncommand = "echo the second writer"\n'

let TMP: string
let restoreEntry: () => void
let origCwd: string
let origEnv: Record<string, string | undefined>

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-second-writer-'))
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

/** A failing probe that, while it runs, lets `during` act as a second program saving files. */
const failProbeWhile = (during: () => void): void => {
  setHookSelftestRunnerForTesting(() => {
    during()
    return { status: 3, stdout: '', stderr: 'boom' }
  })
}

const save = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

interface Host {
  readonly name: string
  readonly config: () => string
  readonly install: () => unknown
}

const hosts: Host[] = [
  { name: 'Kimi', config: kimiConfigPath, install: installKimi },
  {
    name: 'Copilot',
    config: () => path.join(copilotCliUserHooksDir(), HOOKS_CONFIG_FILE),
    install: () => installCopilotHooksFile(copilotCliUserHooksDir(), 'copilot'),
  },
]

describe.each(hosts)('$name: a failed install and a second writer', ({ config, install }) => {
  it('leaves the second writer\'s bytes when it replaced a config that was there, and names the path', () => {
    save(config(), MINE)
    failProbeWhile(() => save(config(), SECOND_WRITER))
    let message = ''
    try {
      install()
    } catch (e) {
      expect(e).toBeInstanceOf(HookSelftestError)
      message = (e as Error).message
    }
    expect(fs.readFileSync(config(), 'utf8')).toBe(SECOND_WRITER)
    expect(message).toContain(config())
    expect(message).toContain('changed by another program, left as found')
  })

  it('leaves the file a second writer created when none was there at the start', () => {
    failProbeWhile(() => save(config(), SECOND_WRITER))
    expect(() => install()).toThrow(HookSelftestError)
    expect(fs.existsSync(config()), 'the second writer\'s file').toBe(true)
    expect(fs.readFileSync(config(), 'utf8')).toBe(SECOND_WRITER)
  })

  it('puts the earlier bytes back when nobody else wrote', () => {
    save(config(), MINE)
    failProbeWhile(() => undefined)
    expect(() => install()).toThrow(HookSelftestError)
    expect(fs.readFileSync(config(), 'utf8')).toBe(MINE)
  })

  it('does not write or remove a staged config it never published', () => {
    save(config(), MINE)
    const old = new Date(2020, 0, 1)
    fs.utimesSync(config(), old, old)
    const was = fs.statSync(config())
    failProbeWhile(() => undefined)
    expect(() => install()).toThrow(HookSelftestError)
    const now = fs.statSync(config())
    expect(now.mtimeMs, 'mtime of the untouched config').toBe(was.mtimeMs)
    expect(now.ino, 'the file was not replaced').toBe(was.ino)
    expect(fs.readFileSync(config(), 'utf8')).toBe(MINE)
  })
})
