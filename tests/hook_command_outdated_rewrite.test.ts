import * as fs from 'node:fs'
import * as path from 'node:path'

import type * as NodeOs from 'node:os'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.mock is hoisted: `~` points at a temp dir per test, so no real harness config is read or written.
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import * as os from 'node:os'

import { parse, stringify } from 'smol-toml'

import { codexConfigPath, codexHookScriptPath, computeCodexHookHash, installCodex, isCodexInstalled, wiredCodexHookWords } from '../src/bridges/codex_install.js'
import { copilotCliConfigPath, copilotCliScriptPath, installCopilotCli, wiredCopilotHookWords } from '../src/bridges/copilot_cli_install.js'
import { grokConfigPath, grokHookScriptPath, installGrok, wiredGrokHookWords } from '../src/bridges/grok_install.js'
import { checkNativeHooks } from '../src/cli_doctor_native.js'

/** Hook entries the previous build wrote on Windows read back as not current, which doctor's native rows report as outdated rather than as missing or fine, and a reinstall rewrites every one of them in place. FORMAT-DERIVED: the old command lines are the formulas of commit 0c01d686 (`git show 0c01d686:src/bridges/codex_install.ts` codexHookCommandFor, `:src/bridges/grok_install.ts` grokHookCommandFor, `:src/bridges/copilot_cli_install.ts` hookPowershellCommandFor, `:src/util.ts` hookCommandFor and hookPowershellCommand), typed out here rather than produced by today's source: Codex `& "node" "shim" event "entry"`, Grok's cmd-style `"node" "shim" event "entry"`, which PowerShell rejects as a ParserError, and Copilot's `powershell` field `& 'node' 'shim' event 'entry'` with no exit suffix. */

const WIN_EXIT_SUFFIX = '; if (Get-Variable LASTEXITCODE -ErrorAction Ignore) { exit (Get-Variable LASTEXITCODE -ValueOnly) }; exit 1'
const realPlatform = process.platform
let TMP: string

/** The event argument of a command this build wrote: the word after the shim path. */
function eventArgOf(command: string): string {
  const m = /token-goat-shim\.cjs['"] (\S+)/.exec(command)
  if (m?.[1] === undefined) throw new Error(`no event argument in ${command}`)
  return m[1]
}

const entry = (): string => process.argv[1] ?? ''
const oldCodexCommand = (ev: string): string => `& "${process.execPath}" "${codexHookScriptPath()}" ${ev} "${entry()}"`
const oldGrokCommand = (ev: string): string => `"${process.execPath}" "${grokHookScriptPath()}" ${ev} "${entry()}"`
const oldCopilotPowershell = (ev: string): string => `& '${process.execPath}' '${copilotCliScriptPath()}' ${ev} '${entry()}'`

function doctorRow(label: string): { status: string; message: string } {
  const row = checkNativeHooks(path.join(TMP, 'no-stats.db')).find((r) => r.name === `Native hooks (${label})`)
  if (row === undefined) throw new Error(`no Native hooks (${label}) row`)
  return { status: row.status, message: row.message }
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-outdated-'))
  ;(os.homedir as unknown as ReturnType<typeof vi.fn>).mockReturnValue(path.join(TMP, 'home'))
  vi.stubEnv('COPILOT_HOME', '')
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(TMP, 'home', '.claude'))
  vi.stubEnv('TOKEN_GOAT_NATIVE_HOOKS', '0')
  // The Windows command shapes are what changed; faking the platform exercises them on every CI runner.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  vi.unstubAllEnvs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('hook entries an older build wrote are rewritten by a reinstall', () => {
  it('Codex: the unsuffixed PowerShell Node form reads as outdated, and a reinstall writes the suffixed form with a trust hash for it at the same positions', () => {
    installCodex()
    const configPath = codexConfigPath()
    const config = parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, unknown> }
    const state: Record<string, { trusted_hash: string }> = {}
    let total = 0
    for (const [event, groups] of Object.entries(config.hooks)) {
      if (event === 'state') continue
      ;(groups as Array<{ matcher?: string; hooks: Array<{ command: string }> }>).forEach((g, gi) => {
        g.hooks.forEach((h, hi) => {
          const ev = eventArgOf(h.command)
          h.command = oldCodexCommand(ev)
          state[`${configPath}:${ev}:${gi}:${hi}`] = { trusted_hash: computeCodexHookHash(ev, h.command, g.matcher) }
          total++
        })
      })
    }
    config.hooks['state'] = state
    fs.writeFileSync(configPath, stringify(config))
    expect(isCodexInstalled()).toBe(false)
    expect(wiredCodexHookWords().map((e) => e.current)).toEqual(Array(total).fill(false))
    const before = doctorRow('Codex')
    expect(before.status).toBe('warn')
    expect(before.message).toContain(`${total} of ${total} hook entries are not the command this build writes; run 'token-goat install --codex' to rewrite them`)

    expect(installCodex().alreadyInstalled).toBe(false)

    const after = parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, unknown> }
    const afterState = after.hooks['state'] as Record<string, { trusted_hash: string }>
    let rewritten = 0
    for (const [event, groups] of Object.entries(after.hooks)) {
      if (event === 'state') continue
      ;(groups as Array<{ matcher?: string; hooks: Array<{ command: string }> }>).forEach((g, gi) => {
        g.hooks.forEach((h, hi) => {
          expect(h.command.startsWith('& ')).toBe(true)
          expect(h.command.endsWith(WIN_EXIT_SUFFIX)).toBe(true)
          const ev = eventArgOf(h.command)
          expect(afterState[`${configPath}:${ev}:${gi}:${hi}`]?.trusted_hash).toBe(computeCodexHookHash(ev, h.command, g.matcher))
          rewritten++
        })
      })
    }
    expect(rewritten).toBe(total)
    expect(isCodexInstalled()).toBe(true)
    expect(wiredCodexHookWords().every((e) => e.current === true)).toBe(true)
    expect(doctorRow('Codex').status).toBe('ok')
  })

  it("Grok: the cmd-style Node form PowerShell cannot parse reads as outdated, and a reinstall writes the PowerShell call, one entry per event", () => {
    installGrok()
    const configPath = grokConfigPath()
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    const events = Object.keys(config.hooks)
    for (const groups of Object.values(config.hooks)) for (const g of groups) for (const h of g.hooks) h.command = oldGrokCommand(eventArgOf(h.command))
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    expect(wiredGrokHookWords().map((e) => e.current)).toEqual(Array(events.length).fill(false))
    const before = doctorRow('Grok CLI')
    expect(before.status).toBe('warn')
    expect(before.message).toContain(`${events.length} of ${events.length} hook entries are not the command this build writes; run 'token-goat install --grok' to rewrite them`)

    expect(installGrok().alreadyInstalled).toBe(false)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> }
    expect(Object.keys(after.hooks)).toEqual(events)
    for (const groups of Object.values(after.hooks)) {
      const commands = groups.flatMap((g) => g.hooks.map((h) => h.command))
      expect(commands).toHaveLength(1)
      expect(commands[0]!.startsWith('& ')).toBe(true)
      expect(commands[0]!.endsWith(WIN_EXIT_SUFFIX)).toBe(true)
    }
    expect(wiredGrokHookWords().every((e) => e.current === true)).toBe(true)
    expect(doctorRow('Grok CLI').status).toBe('ok')
  })

  it("Copilot CLI: a powershell field without the exit suffix reads as outdated, and a reinstall rewrites it, one entry per event", () => {
    installCopilotCli()
    const configPath = copilotCliConfigPath()
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, Array<{ command: string; powershell: string }>> }
    const events = Object.keys(config.hooks)
    for (const [event, entries] of Object.entries(config.hooks)) for (const h of entries) h.powershell = oldCopilotPowershell(event)
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    expect(wiredCopilotHookWords().map((e) => e.current)).toEqual(Array(events.length).fill(false))
    const before = doctorRow('Copilot CLI (user)')
    expect(before.status).toBe('warn')
    expect(before.message).toContain(`${events.length} of ${events.length} hook entries are not the command this build writes; run 'token-goat install --copilot' to rewrite them`)

    expect(installCopilotCli().alreadyInstalled).toBe(false)

    const after = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hooks: Record<string, Array<{ powershell: string }>> }
    expect(Object.keys(after.hooks)).toEqual(events)
    for (const [event, entries] of Object.entries(after.hooks)) {
      expect(entries).toHaveLength(1)
      expect(entries[0]!.powershell).toBe(`${oldCopilotPowershell(event)}${WIN_EXIT_SUFFIX}`)
    }
    expect(wiredCopilotHookWords().every((e) => e.current === true)).toBe(true)
    expect(doctorRow('Copilot CLI (user)').status).toBe('ok')
  })
})
