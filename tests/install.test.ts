import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installHooks, isInstalled, settingsPath, uninstallHooks } from '../src/install.js'

let TMP: string
let origCwd: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-'))
  origCwd = process.cwd()
  // Project scope resolves against process.cwd(); chdir into the temp dir so installs write to {TMP}/.claude/settings.json, never the real project.
  process.chdir(TMP)
})

afterEach(() => {
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('settingsPath', () => {
  it('user scope ends in settings.json under ~/.claude', () => {
    const p = settingsPath('user')
    expect(p.endsWith(path.join('.claude', 'settings.json'))).toBe(true)
    expect(p.startsWith(os.homedir())).toBe(true)
  })

  it('project scope ends in settings.json under cwd/.claude', () => {
    const p = settingsPath('project')
    expect(p).toBe(path.join(TMP, '.claude', 'settings.json'))
  })
})

describe('installHooks', () => {
  it('creates settings.json with the token-goat hook entries', () => {
    const result = installHooks('project')
    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(result.settingsPath)).toBe(true)

    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    expect(settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toBe('token-goat hook pre_tool_use')
    expect(settings.hooks['PostToolUse']?.[0]?.hooks[0]?.command).toBe('token-goat hook post_tool_use')
    expect(settings.hooks['PreCompact']?.[0]?.hooks[0]?.command).toBe('token-goat hook pre_compact')
  })

  it('is idempotent (second call reports alreadyInstalled and does not duplicate)', () => {
    installHooks('project')
    const second = installHooks('project')
    expect(second.alreadyInstalled).toBe(true)

    const settings = JSON.parse(fs.readFileSync(settingsPath('project'), 'utf8')) as {
      hooks: Record<string, unknown[]>
    }
    expect(settings.hooks['PreToolUse']).toHaveLength(1)
  })

  it('recognizes legacy-branded and legacy Python-era hook commands as already installed, without appending duplicates', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'tokenwise hook pre_tool_use' }] }],
          PostToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'pythonw -m token_goat.cli hook post_tool_use' }] },
          ],
        },
      }),
    )

    installHooks('project')

    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const preCommands = settings.hooks['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    const postCommands = settings.hooks['PostToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    expect(preCommands).toEqual(['tokenwise hook pre_tool_use'])
    expect(postCommands).toEqual(['pythonw -m token_goat.cli hook post_tool_use'])
  })

  it('preserves pre-existing unrelated settings and hooks', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        model: 'opus',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }],
        },
      }),
    )
    installHooks('project')

    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      model: string
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    expect(settings.model).toBe('opus')
    const commands = settings.hooks['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    expect(commands).toContain('my-own-hook')
    expect(commands).toContain('token-goat hook pre_tool_use')
  })
})

describe('isInstalled / uninstallHooks', () => {
  it('isInstalled is false before install, true after', () => {
    expect(isInstalled('project')).toBe(false)
    installHooks('project')
    expect(isInstalled('project')).toBe(true)
  })

  it('uninstallHooks removes the hooks and returns true', () => {
    installHooks('project')
    expect(uninstallHooks('project')).toBe(true)
    expect(isInstalled('project')).toBe(false)
  })

  it('uninstallHooks strips legacy-branded and legacy Python-era hook commands', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'tokenwise hook pre_tool_use' }] }],
          PostToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'pythonw -m token_goat.cli hook post_tool_use' }] },
          ],
        },
      }),
    )

    expect(uninstallHooks('project')).toBe(true)

    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as { hooks?: Record<string, unknown> }
    expect(settings.hooks?.['PreToolUse']).toBeUndefined()
    expect(settings.hooks?.['PostToolUse']).toBeUndefined()
  })

  it('uninstallHooks returns false when nothing is installed', () => {
    expect(uninstallHooks('project')).toBe(false)
  })

  it('uninstall leaves unrelated user hooks intact', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook' }] }],
        },
      }),
    )
    installHooks('project')
    uninstallHooks('project')

    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const commands =
      settings.hooks?.['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    expect(commands).toContain('my-own-hook')
    expect(commands).not.toContain('token-goat hook pre_tool_use')
  })
})
