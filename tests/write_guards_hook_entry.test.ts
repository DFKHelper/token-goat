/** Per-host proof that the write guards (placeholder, blind drop) reach each host through its real hook entry: the built bundle for VS Code Chat, and the real Copilot CLI and Codex shims in front of it. Visual Studio and JetBrains reach token-goat through MCP and guidance only, so no hook runs there and nothing is asserted for them. */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CODEX_HOOK_SCRIPT } from '../src/bridges/codex.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'

import { BUNDLE } from './helpers/bundle.js'

const SPAWN_TIMEOUT_MS = 60_000
const MARK = '// ... existing code ...'
const tempDirs: string[] = []

interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

interface HookOut {
  decision?: string
  reason?: string
  permissionDecision?: string
  permissionDecisionReason?: string
  hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string }
}

function mkIsolated(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function hostEnv(harness: string, base: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TOKEN_GOAT_HOME: path.join(base, 'tg'), LOCALAPPDATA: base, XDG_DATA_HOME: base, HOME: base, USERPROFILE: base, TOKEN_GOAT_HARNESS_OVERRIDE: harness }
  for (const key of Object.keys(env)) if (key.startsWith('CLAUDE_CODE') || key === 'CLAUDECODE') delete env[key]
  return env
}

function runBundle(event: string, payload: unknown, env: NodeJS.ProcessEnv, cwd: string): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, 'hook', event], { cwd, env, encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, input: JSON.stringify(payload) })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

function runShim(script: string, cwd: string, eventArg: string, payload: unknown, env: NodeJS.ProcessEnv): RunResult {
  const scriptPath = path.join(cwd, 'shim.js')
  fs.writeFileSync(scriptPath, script, 'utf8')
  const res = spawnSync(process.execPath, [scriptPath, eventArg, BUNDLE], { cwd, input: JSON.stringify(payload), encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS, env })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort; a lingering detached worker can briefly hold a temp dir on Windows
    }
  }
})

const lines = (n: number): string => Array.from({ length: n }, (_, i) => `const value${i} = ${i} + helper${i}()`).join('\n') + '\n'

describe('write guards through the VS Code Chat hook entry (real bundle)', () => {
  // PROVENANCE: FORMAT-DERIVED. Envelope from ChatHookService.executePreToolUseHook in VS Code 1.136.0 extension.js (see tests/hook_event_harness_matrix.test.ts); tool names and input keys per VSCODE_TOOL_NAME_MAP / VSCODE_INPUT_KEY_MAP in src/hooks_cli.ts; deny shape hookSpecificOutput.permissionDecision, a top-level decision:"block" is ignored by VS Code.
  let base: string
  let proj: string
  let env: NodeJS.ProcessEnv

  const envelope = (event: string, id: string, tool: string, input: unknown, extra: object = {}): object => ({ timestamp: '2026-09-11T00:00:00.000Z', hook_event_name: event, session_id: id, cwd: proj, tool_name: tool, tool_input: input, tool_use_id: `tu-${tool}`, ...extra })
  const pre = (id: string, tool: string, input: unknown): HookOut => {
    const r = runBundle('pre_tool_use', envelope('PreToolUse', id, tool, input), env, proj)
    expect(r.status, r.stderr).toBe(0)
    return JSON.parse(r.stdout) as HookOut
  }
  const denied = (out: HookOut): boolean => out.hookSpecificOutput?.permissionDecision === 'deny'

  beforeAll(() => {
    base = mkIsolated('tg-wg-vscode-')
    proj = path.join(base, 'proj')
    fs.mkdirSync(proj, { recursive: true })
    env = hostEnv('vscode', base)
    fs.writeFileSync(path.join(proj, 'small.ts'), 'a\nb\n')
    fs.writeFileSync(path.join(proj, 'big.ts'), lines(200))
  })

  it('create_file with a placeholder line is denied through hookSpecificOutput, with no top-level decision', () => {
    const out = pre('wg-v1', 'create_file', { filePath: path.join(proj, 'new.ts'), content: `const a = 1\n${MARK}\n` })
    expect(denied(out)).toBe(true)
    expect(out.hookSpecificOutput?.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain('placeholder')
    expect('decision' in out).toBe(false)
  })

  it('replace_string_in_file and apply_patch with a placeholder line are denied', () => {
    expect(denied(pre('wg-v2', 'replace_string_in_file', { filePath: path.join(proj, 'small.ts'), oldString: 'b', newString: MARK }))).toBe(true)
    const patch = `*** Begin Patch\n*** Update File: ${path.join(proj, 'small.ts')}\n@@\n-b\n+${MARK}\n*** End Patch\n`
    expect(denied(pre('wg-v3', 'apply_patch', { explanation: 'x', input: patch }))).toBe(true)
  })

  it('an ordinary replace_string_in_file and spread syntax in a create_file are not denied', () => {
    expect(denied(pre('wg-v4', 'replace_string_in_file', { filePath: path.join(proj, 'small.ts'), oldString: 'b', newString: 'c' }))).toBe(false)
    expect(denied(pre('wg-v5', 'create_file', { filePath: path.join(proj, 'spread.ts'), content: 'const a = {\n  ...existing,\n  ...remaining\n}\n' }))).toBe(false)
  })

  it('a create_file over a file that drops lines never read is denied after a partial read_file, and not after a token-goat read of those lines', () => {
    const big = lines(200).split('\n')
    const dropped = big.slice(0, 120).concat(big.slice(140)).join('\n') + '// edited\n'
    const file = path.join(proj, 'big.ts')
    const partial = { filePath: file, startLine: 1, endLine: 100 }
    const readPartial = (id: string): void => {
      pre(id, 'read_file', partial)
      const r = runBundle('post_tool_use', envelope('PostToolUse', id, 'read_file', partial, { tool_response: big.slice(0, 100).join('\n') }), env, proj)
      expect(r.status, r.stderr).toBe(0)
    }
    readPartial('wg-v6')
    const blind = pre('wg-v6', 'create_file', { filePath: file, content: dropped })
    expect(denied(blind)).toBe(true)
    expect(blind.hookSpecificOutput?.permissionDecisionReason).toContain('never read in full')

    readPartial('wg-v7')
    const command = `token-goat read "${file}@121-140"`
    const served = runBundle('post_tool_use', envelope('PostToolUse', 'wg-v7', 'run_in_terminal', { command, explanation: 'x', goal: 'x', isBackground: false }, { tool_response: 'served' }), env, proj)
    expect(served.status, served.stderr).toBe(0)
    expect(denied(pre('wg-v7', 'create_file', { filePath: file, content: dropped + 'again\n' }))).toBe(false)
  })
})

describe('write guards through the Copilot CLI shim (real COPILOT_CLI_HOOK_SCRIPT in front of the real bundle)', () => {
  // PROVENANCE: FORMAT-DERIVED. Native payload {sessionId, cwd, toolName, toolArgs} read off COPILOT_CLI_HOOK_SCRIPT's own main()/TOOL_TO_TG/FILE_PATH_ARG_KEY (src/bridges/copilot_cli.ts), the same source tests/hook_event_harness_matrix.test.ts cites; the deny shape {permissionDecision:"deny"} is the shim's reshaping of the bundle's block.
  let base: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    base = mkIsolated('tg-wg-copilot-')
    env = hostEnv('copilot_cli', base)
    fs.writeFileSync(path.join(base, 'small.ts'), 'a\nb\n')
  })

  const call = (toolName: string, toolArgs: object): HookOut => {
    const r = runShim(COPILOT_CLI_HOOK_SCRIPT, base, 'preToolUse', { sessionId: `wg-c-${toolName}`, cwd: base, toolName, toolArgs }, env)
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim() === '' ? {} : (JSON.parse(r.stdout) as HookOut)
  }

  it('create and edit with a placeholder line are denied as {permissionDecision:"deny"}', () => {
    const created = call('create', { path: path.join(base, 'new.ts'), file_text: `const a = 1\n${MARK}\n` })
    expect(created.permissionDecision).toBe('deny')
    expect(created.permissionDecisionReason).toContain('placeholder')
    const edited = call('edit', { path: path.join(base, 'small.ts'), old_str: 'b', new_str: MARK })
    expect(edited.permissionDecision).toBe('deny')
  })

  it('an ordinary edit is not denied', () => {
    expect(call('edit', { path: path.join(base, 'small.ts'), old_str: 'b', new_str: 'c' }).permissionDecision).toBeUndefined()
  })
})

describe('write guards through the Codex shim (real CODEX_HOOK_SCRIPT in front of the real bundle)', () => {
  // PROVENANCE: FORMAT-DERIVED. apply_patch payload {tool_name, tool_input:{command}} per CODEX_TOOL_NAME_MAP and the codex apply_patch handling in src/hooks_cli.ts; the patch envelope is the apply_patch grammar ("*** Begin Patch" / "*** Update File:" / "*** End Patch") the guard's own parser reads.
  let base: string
  let env: NodeJS.ProcessEnv

  beforeAll(() => {
    base = mkIsolated('tg-wg-codex-')
    env = hostEnv('codex', base)
    fs.writeFileSync(path.join(base, 'small.ts'), 'a\nb\n')
  })

  const patchCall = (id: string, added: string): HookOut => {
    const command = `*** Begin Patch\n*** Update File: ${path.join(base, 'small.ts')}\n@@\n-b\n+${added}\n*** End Patch\n`
    const r = runShim(CODEX_HOOK_SCRIPT, base, 'pre_tool_use', { session_id: id, cwd: base, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command } }, env)
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim() === '' ? {} : (JSON.parse(r.stdout) as HookOut)
  }

  it('an apply_patch adding a placeholder line is blocked', () => {
    const out = patchCall('wg-x1', MARK)
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('placeholder')
  })

  it('an ordinary apply_patch is not blocked', () => {
    expect(patchCall('wg-x2', 'c').decision).toBeUndefined()
  })
})
