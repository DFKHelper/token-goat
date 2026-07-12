import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { installHooks, isInstalled, settingsPath, uninstallHooks } from '../src/install.js'
import { normalizeDarwinSystemAlias } from '../src/paths.js'

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
    expect(p).toBe(path.join(normalizeDarwinSystemAlias(TMP), '.claude', 'settings.json'))
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

  it('wires UserPromptSubmit and SubagentStop (regression: HOOK_EVENT_MAP omitted both, so the branch-context and hallucination-detection features were fully implemented but never invoked by Claude Code)', () => {
    const result = installHooks('project')
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    expect(settings.hooks['UserPromptSubmit']?.[0]?.hooks[0]?.command).toBe(
      'token-goat hook user_prompt_submit',
    )
    expect(settings.hooks['SubagentStop']?.[0]?.hooks[0]?.command).toBe('token-goat hook subagent_stop')
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

  it('replaces legacy-branded and legacy Python-era hook commands with the current install instead of treating them as already installed', () => {
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
    expect(preCommands).toEqual(['token-goat hook pre_tool_use'])
    expect(postCommands).toEqual(['token-goat hook post_tool_use'])
  })

  it('strips a legacy entry that coexists with an already-current entry under the same event key (regression: matching the current-format entry caused a `continue` that skipped the legacy-strip pass entirely for that event key, so a dead legacy entry never got removed even though the docstring promises "exactly one, working, entry per event key")', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { matcher: '', hooks: [{ type: 'command', command: 'token-goat hook pre_tool_use' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'tokenwise hook pre_tool_use' }] },
          ],
        },
      }),
    )

    const result = installHooks('project')
    expect(result.alreadyInstalled).toBe(false)

    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const preCommands = settings.hooks['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    expect(preCommands).toEqual(['token-goat hook pre_tool_use'])
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

  it('still installs normally when settings.json does not exist yet (non-regression for the legitimate empty case)', () => {
    const p = settingsPath('project')
    expect(fs.existsSync(p)).toBe(false)

    const result = installHooks('project')

    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(p)).toBe(true)
    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as { hooks: Record<string, unknown> }
    expect(settings.hooks['PreToolUse']).toBeDefined()
  })

  it('throws on an existing settings.json with invalid JSON, and leaves the file byte-for-byte untouched', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    // Deliberately unparseable: a trailing comma before the closing brace.
    const corrupt = '{ "model": "opus", "hooks": {}, }'
    fs.writeFileSync(p, corrupt)

    expect(() => installHooks('project')).toThrow(/invalid JSON/)

    // installHooks must never reach atomicWriteText when the settings file
    // existed but failed to parse -- the corrupt-but-recoverable file must be
    // left exactly as the user left it, not silently clobbered with just the
    // newly-added hook groups.
    expect(fs.readFileSync(p, 'utf8')).toBe(corrupt)
  })

  it('throws on an existing settings.json whose top-level value is not an object, and leaves the file untouched', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    const nonObject = '[1, 2, 3]'
    fs.writeFileSync(p, nonObject)

    expect(() => installHooks('project')).toThrow(/does not contain a JSON object/)
    expect(fs.readFileSync(p, 'utf8')).toBe(nonObject)
  })
})

describe('isInstalled / uninstallHooks', () => {
  it('isInstalled is false before install, true after', () => {
    expect(isInstalled('project')).toBe(false)
    installHooks('project')
    expect(isInstalled('project')).toBe(true)
  })

  it('isInstalled is false when only legacy-branded/legacy Python-era hook commands are present, true after installHooks runs', () => {
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
          PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'tg-hook.cmd hook pre_compact' }] }],
        },
      }),
    )

    // Every mapped event key carries a legacy-only command here -- none of
    // them are a real, working install, so this must read as not installed.
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

  it('writes a timestamped .bak of settings.json before installHooks edits it', () => {
    const p = settingsPath('project')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify({ theme: 'dark' }))

    installHooks('project')

    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const backupContent = fs.readFileSync(path.join(path.dirname(p), backups[0] as string), 'utf8')
    expect(JSON.parse(backupContent)).toEqual({ theme: 'dark' })
  })

  it('writes a timestamped .bak of settings.json before uninstallHooks removes entries', () => {
    installHooks('project')

    const p = settingsPath('project')
    const before = fs.readFileSync(p, 'utf8')
    uninstallHooks('project')

    const dir = fs.readdirSync(path.dirname(p))
    const backups = dir.filter((f) => f.startsWith('settings.json.bak.'))
    expect(backups.length).toBeGreaterThanOrEqual(1)
    const backupContent = fs.readFileSync(path.join(path.dirname(p), backups[0] as string), 'utf8')
    expect(backupContent).toBe(before)
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
