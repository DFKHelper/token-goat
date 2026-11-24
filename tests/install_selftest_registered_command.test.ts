/** Runs each registered hook command as its host does, with and without the native client. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { copilotCliHooksDir, installCopilotHooksFile } from '../src/bridges/copilot_cli_install.js'
import { HOOKS_CONFIG_FILE } from '../src/bridges/copilot_hooks_owners.js'
import { installCodex } from '../src/bridges/codex_install.js'
import { installGrok } from '../src/bridges/grok_install.js'
import { installKimi } from '../src/bridges/kimi_install.js'
import { installHooks, settingsPath, SettingsParseError } from '../src/install.js'
import { codexConfigPath, grokConfigPath, kimiConfigPath } from '../src/purge.js'
import { parseGuardedCommand } from '../src/hook_guard.js'
import { hookBrokenPath } from '../src/hook_pointer.js'
import {
  guardedCommandsInText,
  HookSelftestError,
  realShellRunner,
  selftestRegisteredCommands,
  setHookSelftestResultOverrideForTesting,
  setHookSelftestRunnerForTesting,
  type ShellRun,
} from '../src/hook_selftest.js'
import { useStubbedHookSelftest } from './helpers/hook_selftest_stub.js'
import { buildNative } from './helpers/native_bin.js'

const WIN = process.platform === 'win32'
/** Platforms this build ships a native client for; elsewhere install writes the Node form, with no guard. */
const NATIVE = WIN || process.platform === 'linux'

let built = ''
let root = ''
const realArgv1 = process.argv[1]
const realNativeFlag = process.env['TOKEN_GOAT_NATIVE_HOOKS']

beforeAll(() => {
  if (NATIVE) built = buildNative()
})

beforeEach(() => {
  // Setup isolates the Claude config dir per file: each test starts with none, inside the temp root only.
  const claudeDir = path.dirname(settingsPath('user'))
  if (!claudeDir.startsWith(os.tmpdir()))
    throw new Error(`the Claude config dir is outside the test root: ${claudeDir}`)
  fs.rmSync(claudeDir, { recursive: true, force: true })
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-install-')))
  const bundle = path.join(root, 'bundle')
  const target = path.join(bundle, 'native', `${process.platform}-${process.arch}`)
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(bundle, 'token-goat.mjs'), "process.stdout.write('{}')\n")
  if (NATIVE) fs.copyFileSync(built, path.join(target, WIN ? 'tg-hook.exe' : 'tg-hook'))
  process.argv[1] = path.join(bundle, 'token-goat.mjs')
  // The test setup turns native hooks off; this file is about the native registration.
  process.env['TOKEN_GOAT_NATIVE_HOOKS'] = '1'
})

afterEach(() => {
  process.argv[1] = realArgv1!
  if (realNativeFlag === undefined) delete process.env['TOKEN_GOAT_NATIVE_HOOKS']
  else process.env['TOKEN_GOAT_NATIVE_HOOKS'] = realNativeFlag
  setHookSelftestRunnerForTesting(undefined)
  setHookSelftestResultOverrideForTesting(undefined)
  fs.rmSync(root, { recursive: true, force: true })
})

interface Hook {
  type?: string
  command?: string
  args?: string[]
}
interface Settings {
  hooks?: Record<string, Array<{ matcher?: string; hooks: Hook[] }>>
  [key: string]: unknown
}

function readSettings(): Settings {
  return JSON.parse(fs.readFileSync(settingsPath('user'), 'utf8')) as Settings
}

function tokenGoatCommands(settings: Settings): string[] {
  return Object.values(settings.hooks ?? {}).flatMap((groups) =>
    groups.flatMap((g) =>
      g.hooks.flatMap((h) =>
        (h.command !== undefined && parseGuardedCommand(h.command) !== undefined ? [h.command] : []),
      ),
    ),
  )
}

/** The pre-guard string form of a registered command: the same words, quoted, no guard. */
function oldForm(command: string): string {
  const parsed = parseGuardedCommand(command)
  if (parsed?.kind !== 'v1') throw new Error(`not a guarded command: ${command}`)
  return parsed.native.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(' ')
}

describe.runIf(NATIVE)('the install self-test', () => {
  useStubbedHookSelftest()

  it('runs every registered command on the exe route and the Node route in the real shell, and passes', () => {
    // This row asserts the real shell results, so it keeps the real runner the stub replaces.
    setHookSelftestRunnerForTesting(undefined)
    installHooks('user', { dev: true })
    const commands = tokenGoatCommands(readSettings())
    expect(commands.length).toBeGreaterThan(3)
    const outcome = selftestRegisteredCommands(commands)
    expect(outcome.failures).toEqual([])
    expect(outcome.tested).toBe(new Set(commands).size)
    expect(outcome.skipped).toEqual([])
    expect(realShellRunner('sh', ': ok', '')).not.toBeNull()
  })

  it('fails loudly on a broken command and keeps the previous registration byte for byte', () => {
    installHooks('user', { dev: true })
    const seeded = readSettings()
    for (const groups of Object.values(seeded.hooks ?? {})) {
      for (const g of groups)
        for (const h of g.hooks)
          if (h.command !== undefined && parseGuardedCommand(h.command) !== undefined)
            h.command = oldForm(h.command)
      groups.push({ hooks: [{ type: 'command', command: 'echo foreign' }] })
    }
    const before = JSON.stringify(seeded, null, 2) + '\n'
    fs.writeFileSync(settingsPath('user'), before)

    const sabotage = (run: ShellRun): void => setHookSelftestRunnerForTesting(() => run)
    sabotage({ status: 3, stdout: '', stderr: 'boom' })
    expect(() => installHooks('user', { dev: true })).toThrow(HookSelftestError)
    expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(before)

    sabotage({ status: 0, stdout: 'not json', stderr: '' })
    expect(() => installHooks('user', { dev: true })).toThrow(/not a valid answer/)
    expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(before)
  })

  it('fails when only the Node route is broken, naming it', () => {
    setHookSelftestRunnerForTesting(undefined)
    setHookSelftestResultOverrideForTesting((command, run) =>
      command.includes('no-such-dir') && run !== null ? { status: 0, stdout: '', stderr: '' } : run)
    try {
      expect(() => installHooks('user', { dev: true })).toThrow(/Node route/)
    } finally {
      setHookSelftestResultOverrideForTesting(undefined)
    }
    expect(fs.existsSync(settingsPath('user'))).toBe(false)
  })

  it('a refused install leaves no hook-broken notice in the data dir', () => {
    setHookSelftestRunnerForTesting(undefined)
    fs.rmSync(hookBrokenPath(), { force: true })
    // Every command answers text no host accepts: the self-test runs both routes, then refuses.
    fs.writeFileSync(path.join(root, 'bundle', 'token-goat.mjs'), "process.stdout.write('not json')\n")
    expect(() => installHooks('user', { dev: true })).toThrow(HookSelftestError)
    expect(fs.existsSync(settingsPath('user'))).toBe(false)
    expect(fs.existsSync(hookBrokenPath()), `notice left at ${hookBrokenPath()}`).toBe(false)
  })

  it('a hook-broken notice that existed before a failing self-test is byte-identical after it', () => {
    installHooks('user', { dev: true })
    const commands = tokenGoatCommands(readSettings())
    const before = Buffer.from('{"schema":1,"first":"t","last":"t","count":3,"events":[]}\n')
    fs.mkdirSync(path.dirname(hookBrokenPath()), { recursive: true })
    fs.writeFileSync(hookBrokenPath(), before)
    try {
      fs.writeFileSync(path.join(root, 'bundle', 'token-goat.mjs'), "process.stdout.write('not json')\n")
      setHookSelftestRunnerForTesting(undefined)
      const outcome = selftestRegisteredCommands(commands)
      expect(outcome.failures.length, 'the self-test should fail').toBeGreaterThan(0)
      const after = fs.readFileSync(hookBrokenPath())
      expect(after.equals(before), 'the self-test changed the existing notice').toBe(true)
    } finally {
      fs.rmSync(hookBrokenPath(), { force: true })
    }
  })

  it('does not run when nothing changed', () => {
    installHooks('user', { dev: true })
    setHookSelftestRunnerForTesting(() => ({ status: 9, stdout: '', stderr: 'must not run' }))
    expect(installHooks('user', { dev: true }).alreadyInstalled).toBe(true)
  })
})

describe.runIf(NATIVE)('migration of an older registration', () => {
  useStubbedHookSelftest()

  const FORMS: ReadonlyArray<readonly [string, (command: string) => Hook]> = [
    ['the string form without the guard', (c) => ({ type: 'command', command: oldForm(c) })],
    ['the exec form (command and args)', (c) => {
      const words = (parseGuardedCommand(c) as { native: string[] }).native
      return { type: 'command', command: words[0]!, args: words.slice(1) }
    }],
  ]
  for (const [name, toOld] of FORMS) {
    it(`rewrites ${name} to guarded form in place, keeps foreign hooks, a rerun changes no byte`, () => {
      installHooks('user', { dev: true })
      const seeded = readSettings()
      const reordered: Settings = { theme: 'dark', ...seeded, zzz: { keep: [1, 2] } }
      for (const groups of Object.values(reordered.hooks ?? {})) {
        for (const g of groups)
          g.hooks = g.hooks.map((h) =>
            (h.command !== undefined && parseGuardedCommand(h.command) !== undefined
              ? { ...toOld(h.command), onFailure: 'continue' }
              : h),
          )
        groups.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo foreign-first' }] })
      }
      fs.writeFileSync(settingsPath('user'), JSON.stringify(reordered, null, 2) + '\n')

      installHooks('user', { dev: true })
      const migrated = fs.readFileSync(settingsPath('user'), 'utf8')
      const after = JSON.parse(migrated) as Settings
      expect(Object.keys(after).slice(0, 2)).toEqual(['theme', 'hooks'])
      expect(after['zzz']).toEqual({ keep: [1, 2] })
      for (const [event, groups] of Object.entries(after.hooks ?? {})) {
        expect(groups[0]?.hooks[0]?.command, event).toBe('echo foreign-first')
        const own = groups
          .flatMap((g) => g.hooks)
          .filter((h) => h.command !== undefined && h.command !== 'echo foreign-first')
        expect(own.length, event).toBe(1)
        expect(parseGuardedCommand(own[0]!.command!)?.kind, event).toBe('v1')
        expect(own[0]!.args, event).toBeUndefined()
      }
      expect(installHooks('user', { dev: true }).alreadyInstalled).toBe(true)
      expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(migrated)
    })
  }

  it('leaves a settings file it cannot parse byte for byte as it was', () => {
    fs.mkdirSync(path.dirname(settingsPath('user')), { recursive: true })
    const broken = '{ "hooks": { "PreToolUse": [ oops'
    fs.writeFileSync(settingsPath('user'), broken)
    expect(() => installHooks('user', { dev: true })).toThrow(SettingsParseError)
    expect(fs.readFileSync(settingsPath('user'), 'utf8')).toBe(broken)
  })
})

interface HostRow {
  name: string
  install: () => unknown
  config: () => string
}

const HOSTS: HostRow[] = [
  { name: 'codex', install: installCodex, config: codexConfigPath },
  { name: 'grok', install: installGrok, config: grokConfigPath },
  // Kimi Code runs hooks through cmd.exe on Windows, which has no guard (residual risk, doctor reports it).
  { name: 'kimi', install: installKimi, config: kimiConfigPath },
  {
    name: 'copilot',
    install: () => installCopilotHooksFile(copilotCliHooksDir({}), 'copilot'),
    config: () => path.join(copilotCliHooksDir({}), HOOKS_CONFIG_FILE),
  },
]

describe.runIf(NATIVE)('the other hosts: self-test, migration and rollback', () => {
  useStubbedHookSelftest()

  for (const host of HOSTS) {
    it(`${host.name}: installs guarded commands, migrates old forms, a second run changes no byte`, () => {
      fs.rmSync(path.dirname(host.config()), { recursive: true, force: true })
      host.install()
      const first = fs.readFileSync(host.config(), 'utf8')
      const commands = guardedCommandsInText(first)
      expect(commands.length).toBeGreaterThan(0)
      let old = first
      for (const c of new Set(commands))
        old = old
          .split(JSON.stringify(c))
          .join(JSON.stringify(oldForm(c)))
          .split(`'${c}'`)
          .join(JSON.stringify(oldForm(c)))
      expect(old).not.toBe(first)
      fs.writeFileSync(host.config(), old)

      // Sabotaged: the previous (old-form) registration stays, byte for byte.
      setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
      expect(() => host.install()).toThrow(HookSelftestError)
      expect(fs.readFileSync(host.config(), 'utf8')).toBe(old)
      setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}', stderr: '' }))

      host.install()
      const migrated = fs.readFileSync(host.config(), 'utf8')
      expect(guardedCommandsInText(migrated).length).toBeGreaterThan(0)
      expect(migrated).not.toBe(old)
      host.install()
      expect(fs.readFileSync(host.config(), 'utf8')).toBe(migrated)
    })
  }
})
