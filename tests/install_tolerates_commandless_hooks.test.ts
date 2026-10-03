/** Claude Code hook entries that run no command (`prompt`, `agent`, `http`, `mcp_tool`) carry no `command` field; install, uninstall, doctor's gap check and the shim-reference scan used to call string methods on that missing field and throw, so a user with one such hook could neither install nor remove token-goat. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { claudeHookScriptPath, hookEventGaps, installHooks, isInstalled, settingsPath, uninstallHooks, wiredClaudeHookWords } from '../src/install.js'
// Side-effect import: registers every hook handler, as cli_install.ts::cmdInstall does before installHooks. Without it toolMatcherFor returns null, nothing is ever narrowed, and the re-narrow test below passes against any implementation.
import '../src/relay.js'

// FORMAT-DERIVED: the handler shapes and field names come from Claude Code's hooks reference, https://code.claude.com/docs/en/hooks.md (the `mcp_tool` and `http` examples verbatim; `prompt` and `agent` built from the documented `prompt`/`model` fields), not from token-goat's own matcher.
const PROMPT_HOOK = { type: 'prompt', prompt: 'Evaluate whether this command is safe to run: $ARGUMENTS', model: 'claude-opus-5' }
const AGENT_HOOK = { type: 'agent', prompt: 'Verify the file modifications are correct: $ARGUMENTS' }
const HTTP_HOOK = { type: 'http', url: 'http://localhost:8080/hooks/pre-tool-use', timeout: 30 }
const MCP_TOOL_HOOK = { type: 'mcp_tool', server: 'my_server', tool: 'security_scan', input: { file_path: '${tool_input.file_path}' } }

/** The user's own groups: every commandless type, under a tool event token-goat also wires and an event it does not. */
function foreignHooks(): Record<string, unknown[]> {
  return {
    PreToolUse: [
      { matcher: 'Bash', hooks: [PROMPT_HOOK, HTTP_HOOK] },
      { matcher: 'Edit|Write', hooks: [MCP_TOOL_HOOK] },
    ],
    PostToolUse: [{ matcher: '', hooks: [AGENT_HOOK] }],
    Stop: [{ hooks: [AGENT_HOOK] }],
  }
}

interface Group {
  matcher?: string
  hooks?: Array<Record<string, unknown>>
}

function readHooks(p: string): Record<string, Group[]> {
  return (JSON.parse(fs.readFileSync(p, 'utf8')) as { hooks?: Record<string, Group[]> }).hooks ?? {}
}

/** Every group in `hooks` with a commandless entry, in file order: the user's data, which install and uninstall must carry through untouched. */
function commandlessGroups(hooks: Record<string, Group[]>): Array<[string, Group]> {
  const out: Array<[string, Group]> = []
  for (const [event, groups] of Object.entries(hooks)) {
    for (const g of groups) if ((g.hooks ?? []).some((h) => h['command'] === undefined)) out.push([event, g])
  }
  return out
}

function writeSettings(p: string, hooks: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, `${JSON.stringify({ model: 'opus', hooks }, null, 2)}\n`)
}

let TMP: string
let origCwd: string
const SAVED = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] as const
const saved: Partial<Record<(typeof SAVED)[number], string | undefined>> = {}

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-install-commandless-'))
  origCwd = process.cwd()
  for (const k of SAVED) saved[k] = process.env[k]
  const fakeHome = path.join(TMP, 'home')
  const project = path.join(TMP, 'project')
  fs.mkdirSync(fakeHome, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  process.chdir(project)
  process.env['HOME'] = fakeHome
  process.env['USERPROFILE'] = fakeHome
  delete process.env['CLAUDE_CONFIG_DIR']
})

afterEach(() => {
  for (const k of SAVED) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  process.chdir(origCwd)
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe.each(['0', '1'])('commandless Claude Code hooks (exec form %s)', (execForm) => {
  beforeEach(() => {
    process.env['TOKEN_GOAT_CLAUDE_EXEC_FORM_HOOKS'] = execForm
  })

  it('install wires token-goat beside them and leaves every one byte-identical', () => {
    const p = settingsPath('project')
    writeSettings(p, foreignHooks())
    const before = commandlessGroups(readHooks(p))

    const result = installHooks('project')

    expect(result.alreadyInstalled).toBe(false)
    const after = readHooks(p)
    expect(commandlessGroups(after)).toEqual(before)
    expect(wiredClaudeHookWords('project').length).toBeGreaterThan(0)
    expect(after['PreToolUse']?.some((g) => (g.hooks ?? []).some((h) => typeof h['command'] === 'string'))).toBe(true)
    expect(isInstalled('project')).toBe(true)
    expect(hookEventGaps('project')).toEqual({ missing: [], outdated: [], broken: [] })
    // A second run finds everything in place rather than throwing on the second pass over the user's groups.
    expect(installHooks('project').alreadyInstalled).toBe(true)
  })

  it('uninstall removes only token-goat and keeps them, including the event left with nothing of ours', () => {
    const p = settingsPath('project')
    writeSettings(p, foreignHooks())
    installHooks('project')

    expect(uninstallHooks('project')).toBe(true)

    expect(readHooks(p)).toEqual(foreignHooks())
    expect(wiredClaudeHookWords('project')).toEqual([])
    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
  })

  it('does not re-narrow a group the user shares with a commandless hook', () => {
    const p = settingsPath('project')
    installHooks('project')
    const hooks = readHooks(p)
    const ours = hooks['PreToolUse']?.[0]
    expect(ours).toBeDefined()
    // Precondition: install narrowed this group, so a widened copy is one install would narrow again if it still counted the group as its own.
    expect(ours?.matcher).not.toBe('')
    // The user widens the group and adds a prompt hook to it: it is no longer token-goat's alone, so install must leave its matcher as written.
    hooks['PreToolUse'] = [{ ...ours, matcher: '', hooks: [...(ours?.hooks ?? []), PROMPT_HOOK] }]
    writeSettings(p, hooks)

    expect(installHooks('project').alreadyInstalled).toBe(true)
    expect(readHooks(p)['PreToolUse']?.[0]?.matcher).toBe('')
  })

  it('a project uninstall reads a user scope holding them and still removes the shim nothing names', () => {
    writeSettings(settingsPath('user'), foreignHooks())
    installHooks('project')
    expect(fs.existsSync(claudeHookScriptPath())).toBe(true)

    expect(uninstallHooks('project')).toBe(true)

    expect(fs.existsSync(claudeHookScriptPath())).toBe(false)
    expect(readHooks(settingsPath('user'))).toEqual(foreignHooks())
  })
})

it('doctor-side readers report no install, rather than throwing, when only commandless hooks are present', () => {
  writeSettings(settingsPath('project'), foreignHooks())
  expect(hookEventGaps('project')).toBeNull()
  expect(isInstalled('project')).toBe(false)
  expect(wiredClaudeHookWords('project')).toEqual([])
  expect(uninstallHooks('project')).toBe(false)
  expect(readHooks(settingsPath('project'))).toEqual(foreignHooks())
})
