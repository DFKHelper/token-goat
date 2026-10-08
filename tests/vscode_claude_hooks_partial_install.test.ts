/** Regression: three disagreements around VS Code's `chat.useClaudeHooks` and doctor. (a) `claudeHooksInstalledAnyScope` asked `isInstalled`, which wants every event wired, so a partial install (one event left from an older release, which still fires) read as no hooks: install and repair left the setting on and the duplicate firing, and doctor said nothing. (b) the Cursor row repeated the inline user-or-project test instead of using that predicate. (c) doctor warned about a project-scope VS Code install that `doctor --repair` deliberately will not change, a warning no command could clear. Provenance: HAND-DERIVED. The scenarios are the reproduced ones (install, delete all but one event from settings.json, turn the setting on, run doctor and repair); the settings shape (`hooks` keyed by event name) is what Claude Code documents at https://code.claude.com/docs/en/hooks and what installHooks wrote into the scratch HOME in this run; the `chat.useClaudeHooks` key is FORMAT-DERIVED from VS Code's own configuration entry as cited on vscodeUsesClaudeHooks in src/bridges/vscode_install.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cursorMcpPath, installCursor } from '../src/bridges/cursor_install.js'
import { installVscode, vscodeUserSettingsPath } from '../src/bridges/vscode_install.js'
import { checkVscodeClaudeHooks } from '../src/cli_doctor_platforms.js'
import { printDoctorResults, runDoctor } from '../src/cli_doctor.js'
import { repairHarnessHooks } from '../src/cli_doctor_hooks.js'
import { claudeHooksInstalledAnyScope, installHooks, settingsPath } from '../src/install.js'

let home: string
let project: string
let originalCwd: string

const SETTING_ON = '{\n  "chat.useClaudeHooks": true\n}\n'

beforeEach(() => {
  originalCwd = process.cwd()
  home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-partial-home-')))
  project = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-vscode-partial-project-')))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('APPDATA', home)
  vi.stubEnv('COPILOT_HOME', path.join(home, '.copilot'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(home, '.claude'))
  process.chdir(project)
})

afterEach(() => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

/** Keep only the named event keys in the scope's settings.json, as a hand edit or an older release leaves them. */
function keepOnlyEvents(scope: 'user' | 'project', keep: string[]): void {
  const file = settingsPath(scope)
  const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: Record<string, unknown> }
  for (const key of Object.keys(settings.hooks)) if (!keep.includes(key)) delete settings.hooks[key]
  fs.writeFileSync(file, JSON.stringify(settings, null, 2))
}

function writeVscodeSettings(text: string): string {
  const file = vscodeUserSettingsPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text, 'utf8')
  return file
}

function rows(): Array<{ name: string; status: 'ok' | 'warn' | 'fail'; message: string }> {
  return runDoctor(path.join(home, 'data'), path.join(home, 'config.toml'), project, [])
}

describe('claudeHooksInstalledAnyScope', () => {
  it('is false with no hooks and true for a complete install in either scope', () => {
    expect(claudeHooksInstalledAnyScope()).toBe(false)
    installHooks('user')
    expect(claudeHooksInstalledAnyScope()).toBe(true)
  })

  it('is true for a partial install in the user scope, because the wired event still fires', () => {
    installHooks('user')
    keepOnlyEvents('user', ['PostToolUse'])
    expect(claudeHooksInstalledAnyScope()).toBe(true)
  })

  it('is true for a partial install in the project scope', () => {
    installHooks('project')
    keepOnlyEvents('project', ['PostToolUse'])
    expect(claudeHooksInstalledAnyScope()).toBe(true)
  })

  it('is false once the settings file holds no token-goat entry', () => {
    installHooks('user')
    keepOnlyEvents('user', [])
    expect(claudeHooksInstalledAnyScope()).toBe(false)
  })
})

describe('chat.useClaudeHooks over a partial install', () => {
  it('doctor warns and --repair turns the setting off when user-scope VS Code hooks sit beside one leftover event', () => {
    installHooks('user')
    keepOnlyEvents('user', ['PostToolUse'])
    installVscode()
    const settings = writeVscodeSettings(SETTING_ON)
    const row = rows().find((r) => r.name === 'VS Code hooks')
    expect(row?.status).toBe('warn')
    const result = repairHarnessHooks(project)
    expect(result.repairs.some((r) => r.includes('chat.useClaudeHooks'))).toBe(true)
    expect(fs.readFileSync(settings, 'utf8')).toContain('"chat.useClaudeHooks": false')
  })
})

describe('Cursor doctor row', () => {
  it('takes its hooks answer from the shared predicate: a partial install reads as installed', () => {
    installHooks('user')
    keepOnlyEvents('user', ['PostToolUse'])
    installCursor()
    const row = rows().find((r) => r.name === 'Cursor')
    expect(row?.status).toBe('ok')
    expect(row?.message).toContain('already installed')
    expect(cursorMcpPath()).toContain(home)
  })

  it('still says no hooks are installed when none are', () => {
    installCursor()
    expect(rows().find((r) => r.name === 'Cursor')?.message).toContain('none are installed there yet')
  })
})

describe('VS Code hooks doctor row and a project-scope VS Code install', () => {
  it('is a note, not a warning, when only project-scope VS Code hooks exist, and says why the setting is left alone', () => {
    installHooks('user')
    installVscode({ project: true, projectRoot: project })
    writeVscodeSettings(SETTING_ON)
    const row = rows().find((r) => r.name === 'VS Code hooks')
    expect(row?.status).toBe('ok')
    expect(row?.message).toContain('leaves the setting alone')
    expect(row?.message).toContain('"chat.useClaudeHooks": false')
  })

  it('does not count toward the warning tally or the verdict line', () => {
    const note = checkVscodeClaudeHooks(true, true, { user: false, project: true })
    expect(note).not.toBeNull()
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      printDoctorResults([note!])
      const out = spy.mock.calls.map((c) => c.map(String).join(' ')).join('\n')
      expect(out).toContain('All checks passed')
      expect(out).not.toContain('warning')
    } finally {
      spy.mockRestore()
    }
  })

  it('still warns when a user-scope VS Code install is there too, since --repair clears that', () => {
    expect(checkVscodeClaudeHooks(true, true, { user: true, project: true })?.status).toBe('warn')
    expect(checkVscodeClaudeHooks(true, true, { user: true, project: false })?.message).toContain('doctor --repair')
  })
})
