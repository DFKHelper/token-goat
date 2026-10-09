/** Codex and Copilot CLI through the real hook entry of the built bundle: the Claude Code command-line gate (src/rewrite_permission.ts decideRewrite, scoped to harness 'claudecode') must change nothing for them, whatever Claude environment they inherit. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { BUNDLE } from './helpers/bundle.js'

let box: string
let codexHome: string

/** A claude session's environment as a terminal CLI leaves it in a child shell, naming a process that does not exist, so a gate that read it would find a command line it cannot read and stop every rewrite. */
const INHERITED_CLAUDE_ENV: NodeJS.ProcessEnv = { TERM_PROGRAM: 'claude-code', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '2147483646', CLAUDE_CODE_SESSION_ID: 'inherited-from-a-claude-terminal' }
const CLAUDE_KEYS = ['TERM_PROGRAM', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_VERSION', 'CLAUDECODE', 'CLAUDE_PROJECT_DIR', 'TOKEN_GOAT_BASH_COMPRESS', 'TOKEN_GOAT_HARNESS_OVERRIDE']

function envFor(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: box, LOCALAPPDATA: box, XDG_DATA_HOME: box, CODEX_HOME: codexHome }
  for (const key of CLAUDE_KEYS) delete env[key]
  return { ...env, ...extra }
}

beforeAll(() => {
  box = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hosts-e2e-')))
  codexHome = path.join(box, 'codex')
  fs.mkdirSync(path.join(codexHome, 'rules'), { recursive: true })
})

afterAll(() => {
  fs.rmSync(box, { recursive: true, force: true })
})

/** The Codex Bash PreToolUse shape. FORMAT-DERIVED: https://developers.openai.com/codex/hooks.md ("Common input fields", fetched 2026-09-25; tool_name "Bash" is CAPTURE from codex-cli 0.155.0), as tests/fixtures/harness_hook_payloads.ts codexBase carries it, permission_mode "default" included. The cwd is the filesystem root because Codex rules are also read from every .codex folder above the cwd. */
function codexPayload(command: string): Record<string, unknown> {
  return { session_id: `hosts-codex-${command}`, transcript_path: null, cwd: path.parse(box).root, model: 'gpt-5.5', turn_id: 'turn-1', permission_mode: 'default', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command } }
}

/** The Copilot CLI bash preToolUse shape. FORMAT-DERIVED: schemas/copilot_cli.hooks.json PreToolUseHookInput (Copilot CLI 1.0.80 types.d.ts) with toolArgs as a JSON string per https://docs.github.com/en/copilot/reference/hooks-reference, as tests/fixtures/harness_hook_payloads.ts line 100 carries it. That schema has no permission field, so a Copilot CLI hook never says which mode it runs in. */
function copilotPayload(command: string): Record<string, unknown> {
  return { sessionId: `hosts-copilot-${command}`, timestamp: '2026-08-23T00:00:00.000Z', workingDirectory: path.parse(box).root, cwd: path.parse(box).root, toolName: 'bash', toolArgs: JSON.stringify({ command, description: 'Run it' }) }
}

function bundleHook(payload: unknown, env: NodeJS.ProcessEnv): string {
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', 'pre_tool_use'], { cwd: box, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout.trim()
}

/** Runs a bridge shim exactly as the host would: a standalone Node process with the host's event name as argv[2] and the real bundle as its entry. */
function shimHook(script: string, eventArg: string, payload: unknown, env: NodeJS.ProcessEnv): string {
  const scriptPath = path.join(box, `shim-${eventArg}.js`)
  fs.writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg, BUNDLE], { cwd: box, env, input: JSON.stringify(payload), encoding: 'utf8', timeout: 60_000 })
  expect(res.status, res.stderr).toBe(0)
  return res.stdout.trim()
}

describe('Codex through the built bundle, with no claude process at all', () => {
  const rules = (): string => path.join(codexHome, 'rules', 'default.rules')

  it('a build command is rewritten and approved until a Codex rule names it, and only the rule decides', () => {
    fs.rmSync(rules(), { force: true })
    const env = envFor({ TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' })
    const free = JSON.parse(bundleHook(codexPayload('go vet ./...'), env)) as { hookSpecificOutput?: { permissionDecision?: string; updatedInput?: { command?: string } } }
    expect(free.hookSpecificOutput?.permissionDecision).toBe('allow')
    expect(free.hookSpecificOutput?.updatedInput?.command).toContain('token-goat compress')
    fs.writeFileSync(rules(), 'prefix_rule(pattern = ["go", "vet"], decision = "forbidden")\n')
    try {
      expect(bundleHook(codexPayload('go vet ./...'), env)).toBe('{}')
    } finally {
      fs.rmSync(rules(), { force: true })
    }
  })

  it('the bundle entry answers the same bytes with a claude terminal\'s environment inherited as with none', () => {
    fs.rmSync(rules(), { force: true })
    const clean = bundleHook(codexPayload('go vet ./...'), envFor({ TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' }))
    const inherited = bundleHook(codexPayload('go vet ./...'), envFor({ ...INHERITED_CLAUDE_ENV, TOKEN_GOAT_HARNESS_OVERRIDE: 'codex' }))
    expect(JSON.parse(clean).hookSpecificOutput.permissionDecision).toBe('allow')
    expect(inherited).toBe(clean)
  })

  it('the installed Codex shim answers the same bytes with a claude terminal\'s environment inherited as with none', () => {
    fs.rmSync(rules(), { force: true })
    const clean = shimHook(CODEX_HOOK_SCRIPT, 'pre_tool_use', codexPayload('go vet ./...'), envFor())
    const inherited = shimHook(CODEX_HOOK_SCRIPT, 'pre_tool_use', codexPayload('go vet ./...'), envFor(INHERITED_CLAUDE_ENV))
    // The Codex branch approves a build command no Codex rule names; the Claude branch the bundle would fall to without the shim's override answers a rewrite with no decision.
    expect(JSON.parse(clean).hookSpecificOutput.permissionDecision).toBe('allow')
    expect(JSON.parse(clean).hookSpecificOutput.updatedInput.command).toContain('token-goat compress')
    expect(inherited).toBe(clean)
  })
})

describe('Copilot CLI through the built bundle and its installed shim', () => {
  it('a shell command is left alone, with or without a claude terminal\'s environment inherited', () => {
    const clean = shimHook(COPILOT_CLI_HOOK_SCRIPT, 'preToolUse', copilotPayload('go build ./...'), envFor())
    const inherited = shimHook(COPILOT_CLI_HOOK_SCRIPT, 'preToolUse', copilotPayload('go build ./...'), envFor(INHERITED_CLAUDE_ENV))
    expect(inherited).toBe(clean)
    expect(clean).toBe('{}')
    expect(clean).not.toContain('updatedInput')
    expect(clean).not.toContain('"allow"')
  })

  it('the bundle entry resolves the harness from the override, not from an inherited claude environment', () => {
    const clean = bundleHook(copilotPayload('go build ./...'), envFor({ TOKEN_GOAT_HARNESS_OVERRIDE: 'copilot_cli' }))
    const inherited = bundleHook(copilotPayload('go build ./...'), envFor({ ...INHERITED_CLAUDE_ENV, TOKEN_GOAT_HARNESS_OVERRIDE: 'copilot_cli' }))
    expect(inherited).toBe(clean)
  })
})
