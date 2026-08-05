import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../src/bridges/claudecode.js'
import { claudeHookScriptPath, installHooks, isInstalled, settingsPath, uninstallHooks } from '../src/install.js'
import { normalizeDarwinSystemAlias } from '../src/paths.js'
import { hookCommandFor } from '../src/util.js'

let TMP: string
let origCwd: string
let origHome: string | undefined
let origUserProfile: string | undefined

/** The exact command installHooks is expected to wire for `eventArg`, derived rather than hard-coded: it bakes in this node binary, this shim path, and this entry path, none of which a literal string in a test can know. */
function expectedCommand(eventArg: string): string {
  return hookCommandFor(claudeHookScriptPath(), eventArg)
}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-'))
  origCwd = process.cwd()
  // Project scope resolves against process.cwd(); chdir into the temp dir so installs write to {TMP}/.claude/settings.json, never the real project.
  process.chdir(TMP)
  // installHooks now WRITES the generated shim under os.homedir(), and uninstallHooks DELETES it -- so without pinning the home dir this suite would clobber the developer's own installed ~/.claude/hooks/token-goat-shim.js on every run. os.homedir() reads USERPROFILE on Windows and HOME on POSIX at each call, so setting both isolates it in-process.
  origHome = process.env['HOME']
  origUserProfile = process.env['USERPROFILE']
  const fakeHome = path.join(TMP, 'home')
  fs.mkdirSync(fakeHome, { recursive: true })
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
})

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']
  else process.env['HOME'] = origHome
  if (origUserProfile === undefined) delete process.env['USERPROFILE']
  else process.env['USERPROFILE'] = origUserProfile
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
    expect(settings.hooks['PreToolUse']?.[0]?.hooks[0]?.command).toBe(expectedCommand('pre_tool_use'))
    expect(settings.hooks['PostToolUse']?.[0]?.hooks[0]?.command).toBe(expectedCommand('post_tool_use'))
    expect(settings.hooks['PreCompact']?.[0]?.hooks[0]?.command).toBe(expectedCommand('pre_compact'))
  })

  it('wires UserPromptSubmit and SubagentStop (regression: HOOK_EVENT_MAP omitted both, so the branch-context and hallucination-detection features were fully implemented but never invoked by Claude Code)', () => {
    const result = installHooks('project')
    const settings = JSON.parse(fs.readFileSync(result.settingsPath, 'utf8')) as {
      hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string }> }>>
    }
    expect(settings.hooks['UserPromptSubmit']?.[0]?.hooks[0]?.command).toBe(
      expectedCommand('user_prompt_submit'),
    )
    expect(settings.hooks['SubagentStop']?.[0]?.hooks[0]?.command).toBe(expectedCommand('subagent_stop'))
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
    expect(preCommands).toEqual([expectedCommand('pre_tool_use')])
    expect(postCommands).toEqual([expectedCommand('post_tool_use')])
  })

  it('collapses two stale entries under one event key (a pre-shim bare command plus a legacy alias) into exactly one current shim entry (regression: an early `continue` on finding a recognized entry skipped the strip pass for that key, leaving the dead one behind and breaking the docstring promise of "exactly one, working, entry per event key")', () => {
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
    expect(preCommands).toEqual([expectedCommand('pre_tool_use')])
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
    expect(commands).toContain(expectedCommand('pre_tool_use'))
  })

  it('still installs normally when settings.json does not exist yet (non-regression for the legitimate empty case)', () => {
    const p = settingsPath('project')
    expect(fs.existsSync(p)).toBe(false)

    const result = installHooks('project')

    expect(result.alreadyInstalled).toBe(false)
    expect(fs.existsSync(p)).toBe(true)
    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>>
    }
    const preCommands = settings.hooks['PreToolUse']?.flatMap((g) => g.hooks.map((h) => h.command)) ?? []
    expect(preCommands).toContain(expectedCommand('pre_tool_use'))
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
    // backupFile no-ops when the target doesn't exist yet, so exactly one call above actually
    // produces a backup file.
    expect(backups.length).toBe(1)
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
    // backupFile no-ops when the target doesn't exist yet, so exactly one call above actually
    // produces a backup file.
    expect(backups.length).toBe(1)
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
    expect(commands).not.toContain(expectedCommand('pre_tool_use'))
  })
})

describe('generated hook shim (the shipping wiring, not a standalone script test)', () => {
  function commandsFor(p: string, eventKey: string): string[] {
    const settings = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      hooks?: Record<string, Array<{ hooks?: Array<{ command: string }> }>>
    }
    return settings.hooks?.[eventKey]?.flatMap((g) => (g.hooks ?? []).map((h) => h.command)) ?? []
  }

  it('writes the shim to disk and wires the settings command at it', () => {
    installHooks('project')
    const scriptPath = claudeHookScriptPath()
    expect(fs.existsSync(scriptPath)).toBe(true)
    // Byte-identical to the exported source, not merely "some file exists": the whole defect this closes was a fully-built shim that nothing ever wrote.
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(CLAUDECODE_HOOK_SCRIPT)
    expect(commandsFor(settingsPath('project'), 'PreToolUse')[0]).toContain(scriptPath)
  })

  it('refreshes a stale shim left by an older build even when the settings wiring is already correct, and reports that as a real install rather than a no-op', () => {
    installHooks('project')
    const scriptPath = claudeHookScriptPath()
    fs.writeFileSync(scriptPath, '// stale content from an older token-goat build\n')

    const second = installHooks('project')
    expect(fs.readFileSync(scriptPath, 'utf8')).toBe(CLAUDECODE_HOOK_SCRIPT)
    // Not a no-op: the file every hook depends on was just replaced. Telling a user running install-to-repair "already installed" would be a lie.
    expect(second.alreadyInstalled).toBe(false)
  })

  it('is a true no-op when both the shim and the wiring are already correct (the shim refresh must not make every install report a change)', () => {
    installHooks('project')
    const settingsBefore = fs.readFileSync(settingsPath('project'), 'utf8')
    const shimMtimeBefore = fs.statSync(claudeHookScriptPath()).mtimeMs

    expect(installHooks('project').alreadyInstalled).toBe(true)
    expect(fs.readFileSync(settingsPath('project'), 'utf8')).toBe(settingsBefore)
    // writeIfDifferent, not an unconditional write: identical content must not touch the file at all.
    expect(fs.statSync(claudeHookScriptPath()).mtimeMs).toBe(shimMtimeBefore)
  })

  it('replaces a shim command whose baked paths have gone stale, leaving exactly one entry (a node upgrade or a token-goat reinstall elsewhere moves every absolute path in the command)', () => {
    const p = settingsPath('project')
    const stale = `"/old/node" "${claudeHookScriptPath()}" pre_tool_use "/old/entry/token-goat.mjs"`
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(
      p,
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: stale }] }] } }),
    )

    const result = installHooks('project')
    expect(result.alreadyInstalled).toBe(false)
    expect(commandsFor(p, 'PreToolUse')).toEqual([expectedCommand('pre_tool_use')])
  })

  // The historical hazard here was a marker collision: LEGACY_COMMAND_MARKERS reserves `token-goat-hook`, so a marker-based "is this current?" test would classify a shim carrying that substring as dead cruft and strip it on every reinstall, reverting the wiring it had just applied. Deciding staleness by exact command equality instead of by marker removes that hazard structurally rather than by careful naming -- verified by mutation: renaming the shim and its marker to the colliding `token-goat-hook` spelling leaves this whole suite green. The naming is still deliberate (see SHIM_COMMAND_MARKER), but this test guards the property that actually matters and would survive a future refactor: repeated installs converge instead of oscillating.
  it('converges on repeated installs: alreadyInstalled latches true and the entry list stops changing', () => {
    installHooks('project')
    const p = settingsPath('project')
    const afterFirst = commandsFor(p, 'PreToolUse')

    // Three further installs: were the shim command classified as legacy, each pass would strip and re-add it, so alreadyInstalled would never latch true.
    for (let i = 0; i < 3; i++) {
      expect(installHooks('project').alreadyInstalled).toBe(true)
    }
    expect(commandsFor(p, 'PreToolUse')).toEqual(afterFirst)
    expect(afterFirst).toHaveLength(1)
  })

  it('reports not-installed when the shim file is missing even though the settings wiring is intact (a command pointing at a deleted shim cannot fire)', () => {
    installHooks('project')
    expect(isInstalled('project')).toBe(true)

    fs.rmSync(claudeHookScriptPath())
    expect(isInstalled('project')).toBe(false)
    // ...and the next install regenerates it rather than reporting a no-op.
    expect(installHooks('project').alreadyInstalled).toBe(false)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
  })

  it('removes the generated shim on uninstall', () => {
    installHooks('project')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
    expect(uninstallHooks('project')).toBe(true)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })

  it('keeps the shim when the OTHER scope is still wired to it (both scopes share one home-scoped shim, so a single-scope uninstall must not disable the other)', () => {
    installHooks('user')
    installHooks('project')
    expect(isInstalled('user')).toBe(true)

    expect(uninstallHooks('project')).toBe(true)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)
    // The surviving scope must still be fully functional, not merely still listed: its command points at a file that has to exist.
    expect(isInstalled('user')).toBe(true)
  })

  it('removes the shim once the last scope referencing it is uninstalled', () => {
    installHooks('user')
    installHooks('project')
    uninstallHooks('project')
    expect(uninstallHooks('user')).toBe(true)
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })

  it('writes a shim that actually runs: spawning the exact installed command returns parseable hook JSON on stdout', () => {
    installHooks('project')
    const command = commandsFor(settingsPath('project'), 'PreToolUse')[0]
    expect(command).toBeDefined()

    // Re-parse the command exactly as a shell would, then execute it directly -- this drives the real installed wiring end to end rather than a hand-built invocation that could diverge from what installHooks wrote.
    const parts = command!.match(/"[^"]*"|\S+/g)?.map((s) => s.replace(/^"|"$/g, '')) ?? []
    expect(parts.length).toBeGreaterThanOrEqual(3)
    const res = spawnSync(parts[0]!, parts.slice(1), {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 'install-e2e' }),
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(res.error).toBeUndefined()
    expect(res.status).toBe(0)
    expect(() => JSON.parse(res.stdout) as unknown).not.toThrow()
  })
})
