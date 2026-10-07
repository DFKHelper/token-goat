/** Regression: `install --vscode` and `doctor --repair` turned VS Code's user-wide `chat.useClaudeHooks` off whenever it was on, even with no token-goat Claude Code hooks installed (so there was no duplicate to prevent, only the user's own Claude hooks to stop), even from a project-scope install, and `uninstall --vscode` never put it back. Now the flip needs token-goat's Claude Code hooks (the same test doctor's row uses), happens only for a user-scope install or repair, is recorded in token-goat's created-configs ledger, and `uninstall --vscode` turns the setting back on while it still reads false. Every case drives the real CLI (`run`) or the real repair step against an isolated HOME/USERPROFILE/APPDATA. Provenance: the `chat.useClaudeHooks` key is FORMAT-DERIVED from VS Code's own configuration entry in workbench.desktop.main.js (1.136.0), as cited on vscodeUsesClaudeHooks in src/bridges/vscode_install.ts; the settings.json bodies are HAND-DERIVED, written for this test with a comment so the comment-keeping write path is exercised. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installVscode, vscodeUserSettingsPath } from '../src/bridges/vscode_install.js'
import { run } from '../src/cli.js'
import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { installHooks } from '../src/install.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let home: string
let project: string
let originalCwd: string
let stdout: string[]
let stdoutSpy: WriteSpy
let stderrSpy: WriteSpy

// HAND-DERIVED: a user settings file with the setting on and a comment that must survive every write.
const SETTING_ON = '{\n  // my own setting\n  "chat.useClaudeHooks": true,\n  "editor.fontSize": 14\n}\n'

beforeEach(() => {
  originalCwd = process.cwd()
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-claude-hooks-home-'))
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-claude-hooks-project-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('APPDATA', home)
  vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
  process.chdir(project)
  stdout = []
  stdoutSpy = spyOnWrite(process.stdout, stdout)
  stderrSpy = spyOnWrite(process.stderr, [])
})

afterEach(() => {
  stdoutSpy.mockRestore()
  stderrSpy.mockRestore()
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

async function runCli(argv: string[]): Promise<{ code: number | undefined; output: string }> {
  const prev = process.exitCode
  process.exitCode = 0
  stdout.length = 0
  try {
    await run(['node', 'token-goat', ...argv])
    return { code: process.exitCode, output: stdout.join('') }
  } finally {
    process.exitCode = prev
  }
}

function writeSettings(text: string): string {
  const settings = vscodeUserSettingsPath()
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, text, 'utf8')
  return settings
}

function settingValue(settings: string): string {
  const match = /"chat\.useClaudeHooks":\s*(\w+)/.exec(fs.readFileSync(settings, 'utf8'))
  return match?.[1] ?? 'absent'
}

describe('install --vscode and chat.useClaudeHooks', () => {
  it('leaves the setting on when token-goat has no Claude Code hooks installed, so there is nothing to duplicate', async () => {
    const settings = writeSettings(SETTING_ON)
    const { code, output } = await runCli(['install', '--vscode', '--user'])
    expect(code).toBe(0)
    expect(settingValue(settings)).toBe('true')
    expect(output).not.toContain('chat.useClaudeHooks')
  })

  it('turns it off for a user-scope install over token-goat Claude Code hooks, says it covers every Claude hook, and uninstall puts it back', async () => {
    installHooks('user')
    const settings = writeSettings(SETTING_ON)

    const install = await runCli(['install', '--vscode', '--user'])
    expect(install.code).toBe(0)
    expect(settingValue(settings)).toBe('false')
    expect(install.output).toContain('covers every Claude hook in VS Code')
    expect(install.output).toContain('"chat.useClaudeHooks": true')

    const uninstall = await runCli(['uninstall', '--vscode', '--user'])
    expect(uninstall.code).toBe(0)
    expect(settingValue(settings)).toBe('true')
    expect(uninstall.output).toContain('Turned chat.useClaudeHooks back on')
    const after = fs.readFileSync(settings, 'utf8')
    expect(after).toContain('// my own setting')
    expect(after).toContain('"editor.fontSize": 14')

    // The marker went with the restore: turning it off by hand afterwards is the user's choice, and a second uninstall leaves it.
    fs.writeFileSync(settings, SETTING_ON.replace('true', 'false'), 'utf8')
    const again = await runCli(['uninstall', '--vscode', '--user'])
    expect(again.output).not.toContain('Turned chat.useClaudeHooks back on')
    expect(settingValue(settings)).toBe('false')
  })

  it('leaves the user-wide setting alone for a project-scope install and names the setting to change', async () => {
    installHooks('user')
    const settings = writeSettings(SETTING_ON)
    const { code, output } = await runCli(['install', '--vscode'])
    expect(code).toBe(0)
    expect(settingValue(settings)).toBe('true')
    expect(output).toContain('left it alone')
    expect(output).toContain('set "chat.useClaudeHooks": false in your VS Code user settings')
  })

  it('does not restore a value the user changed after token-goat turned it off', async () => {
    installHooks('user')
    const settings = writeSettings(SETTING_ON)
    await runCli(['install', '--vscode', '--user'])
    expect(settingValue(settings)).toBe('false')
    // HAND-DERIVED: the user removed the key by hand.
    fs.writeFileSync(settings, '{\n  "editor.fontSize": 14\n}\n', 'utf8')
    const { output } = await runCli(['uninstall', '--vscode', '--user'])
    expect(output).not.toContain('Turned chat.useClaudeHooks back on')
    expect(settingValue(settings)).toBe('absent')
  })

  it('never turns on a false the user set themselves', async () => {
    const settings = writeSettings(SETTING_ON.replace('true', 'false'))
    await runCli(['install', '--vscode', '--user'])
    const { output } = await runCli(['uninstall', '--vscode', '--user'])
    expect(output).not.toContain('Turned chat.useClaudeHooks back on')
    expect(settingValue(settings)).toBe('false')
  })

  it('keeps it off through the user-to-project migration and restores it when the project install is uninstalled', async () => {
    installHooks('user')
    const settings = writeSettings(SETTING_ON)
    await runCli(['install', '--vscode', '--user'])
    expect(settingValue(settings)).toBe('false')

    const migrate = await runCli(['install', '--vscode'])
    expect(migrate.code).toBe(0)
    expect(settingValue(settings)).toBe('false')

    const uninstall = await runCli(['uninstall', '--vscode'])
    expect(uninstall.code).toBe(0)
    expect(settingValue(settings)).toBe('true')
  })

  it('keeps it off while user-scope VS Code hooks are still installed after a project-scope uninstall', async () => {
    installHooks('user')
    const settings = writeSettings(SETTING_ON)
    await runCli(['install', '--vscode', '--user'])
    await runCli(['uninstall', '--vscode'])
    expect(settingValue(settings)).toBe('false')
  })
})

describe('doctor --repair and chat.useClaudeHooks', () => {
  it('does not turn it off without token-goat Claude Code hooks, even with VS Code hooks installed', () => {
    installVscode()
    const settings = writeSettings(SETTING_ON)
    const result = repairHarnessHooks(project)
    expect(result.repairs.some((r) => r.includes('chat.useClaudeHooks'))).toBe(false)
    expect(settingValue(settings)).toBe('true')
  })

  it('does not change the user-wide setting for a project-scope VS Code install', () => {
    installHooks('user')
    installVscode({ project: true, projectRoot: project })
    const settings = writeSettings(SETTING_ON)
    const result = repairHarnessHooks(project)
    expect(result.repairs.some((r) => r.includes('chat.useClaudeHooks'))).toBe(false)
    expect(settingValue(settings)).toBe('true')
  })

  it('turns it off for a user-scope install over token-goat Claude Code hooks, records it, and uninstall --vscode --user restores it', async () => {
    installHooks('user')
    installVscode()
    const settings = writeSettings(SETTING_ON)
    const result = repairHarnessHooks(project)
    const repair = result.repairs.find((r) => r.includes('chat.useClaudeHooks'))
    expect(repair).toContain('every Claude hook in VS Code')
    expect(settingValue(settings)).toBe('false')

    const uninstall = await runCli(['uninstall', '--vscode', '--user'])
    expect(uninstall.output).toContain('Turned chat.useClaudeHooks back on')
    expect(settingValue(settings)).toBe('true')
  })
})
