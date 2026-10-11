// The Stop advisory and the verification verdict it reads. Provenance: the Stop payloads are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (Stop: session_id, transcript_path, cwd, permission_mode, hook_event_name, stop_hook_active, last_assistant_message) and https://developers.openai.com/codex/hooks (Stop: the common fields plus turn_id, stop_hook_active, last_assistant_message), the same docs tests/fixtures/harness_hook_payloads.ts cites. The failure text "Exit code 1" is FORMAT-DERIVED from the PostToolUseFailure error field of the Claude Code hooks doc (a Bash failure opens with `Exit code N`). Every expected verdict is HAND-DERIVED from the order of the edits and runs the test performs.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { stopAdvisoryText, stopHandler } from '../src/hooks_stop.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import { evaluateVerification, isVerificationCommand, noteFailedVerificationRun, noteVerificationRun } from '../src/verification_state.js'
import { makeHookEvent } from './helpers/hook-event.js'

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

function newSession(): string {
  return `s-stop-${process.pid}-${Math.random().toString(36).slice(2)}`
}

/** One load, work, save, as relay.ts runs a hook, so the verdict is read back from disk. */
function inSession(key: string, work: () => void): void {
  loadSessionState(key)
  try {
    work()
  } finally {
    saveSessionState(key)
  }
}

const stopEvent = (sessionId: string, raw: Record<string, unknown> = {}, agentId?: string) =>
  makeHookEvent({ eventName: 'stop', toolName: undefined, sessionId, agentId, raw: { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.', ...raw } })

describe('isVerificationCommand', () => {
  // HAND-DERIVED: commands a developer types to test, lint, typecheck or build, and ones that prove nothing about an edit.
  it.each([
    ['npm test', true],
    ['npx vitest run tests/a.test.ts', true],
    ['npm run typecheck', true],
    ['npx tsc --noEmit', true],
    ['cargo test', true],
    ['go vet ./...', true],
    ['cd app && FOO=1 pytest -x', true],
    ['npx eslint src', true],
    ['npm install', false],
    ['git status', false],
    ['ls -la', false],
    ['cat package.json', false],
  ])('%s -> %s', (command, expected) => {
    expect(isVerificationCommand(command)).toBe(expected)
  })
})

describe('evaluateVerification', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('an edit with no verification run is unverified', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/a.ts'))
    const state = evaluateVerification(sid)
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
    expect(state.latestRun).toBeUndefined()
  })

  it('a passing run after the edit covers it', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, T0 + 1000)
    })
    const state = evaluateVerification(sid)
    expect(state.editedSinceLastPass).toEqual([])
    expect(state.failingUnresolved).toBe(false)
  })

  it('an edit after the last passing run is unverified again', () => {
    const sid = newSession()
    inSession(sid, () => recordVerificationRun('npm test', 0, T0 - 1000))
    vi.setSystemTime(T0 + 5000)
    inSession(sid, () => recordFileEdit('C:/proj/src/b.ts'))
    expect(evaluateVerification(sid).editedSinceLastPass).toEqual(['b.ts'])
  })

  it('a failing last run is unresolved even when no edit follows it', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 1, T0 + 1000)
    })
    const state = evaluateVerification(sid)
    expect(state.failingUnresolved).toBe(true)
    expect(state.latestRun?.exitCode).toBe(1)
    expect(state.editedSinceLastPass).toEqual(['a.ts'])
  })

  it('a docs edit is not a source edit', () => {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/README.md'))
    expect(evaluateVerification(sid).editedFiles).toEqual([])
  })

  it('a subagent is judged on its own key, not the parent session', () => {
    const sid = newSession()
    const agentKey = `${sid}:agent:sub1`
    inSession(sid, () => recordFileEdit('C:/proj/src/parent.ts'))
    inSession(agentKey, () => recordVerificationRun('npm test', 0, T0 + 1000))
    expect(evaluateVerification(sid).editedSinceLastPass).toEqual(['parent.ts'])
    expect(evaluateVerification(agentKey).editedFiles).toEqual([])
  })
})

describe('noteVerificationRun and noteFailedVerificationRun', () => {
  beforeEach(() => {
    clearModuleCaches()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function runsAfter(work: () => void): readonly { command: string; exitCode: number | null }[] {
    const sid = newSession()
    inSession(sid, work)
    return evaluateVerification(sid).runs
  }

  it('records a finished verification command and ignores everything else', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const runs = runsAfter(() => {
      noteVerificationRun('npm test', null, false)
      noteVerificationRun('git status', 0, false)
      noteVerificationRun('npm run build', 0, true)
    })
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([['npm test', 0]])
  })

  it('leaves the status unknown on a harness whose ordinary post event may carry a failure', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'codex')
    const runs = runsAfter(() => noteVerificationRun('npm test', null, false))
    expect(runs[0]?.exitCode).toBeNull()
  })

  it('reads the exit status out of a Bash failure and skips an interrupt', () => {
    const runs = runsAfter(() => {
      noteFailedVerificationRun('npm test', 'Exit code 2\nFAIL tests/a.test.ts', false)
      noteFailedVerificationRun('npm run lint', 'Exit code 1', true)
    })
    expect(runs.map((r) => [r.command, r.exitCode])).toEqual([['npm test', 2]])
  })

  it('stores the command redacted', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'
    const runs = runsAfter(() => noteVerificationRun(`GH_TOKEN=${secret} npm test`, 0, false))
    expect(runs[0]?.command).not.toContain(secret)
  })
})

describe('stopHandler', () => {
  beforeEach(() => {
    clearModuleCaches()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function unverifiedSession(): string {
    const sid = newSession()
    inSession(sid, () => recordFileEdit('C:/proj/src/widget.ts'))
    return sid
  }

  it('names the edited file when work is unverified', () => {
    const out = stopHandler(stopEvent(unverifiedSession()))
    expect(out.hookType).toBe('context')
    expect(out.hookType === 'context' ? out.context : '').toContain('widget.ts')
  })

  it('says the last check failed, with its command and status', () => {
    const sid = newSession()
    inSession(sid, () => recordVerificationRun('npm test', 1))
    const out = stopHandler(stopEvent(sid))
    expect(out.hookType === 'context' ? out.context : '').toContain('exit 1')
  })

  it('stays silent when everything edited was verified', () => {
    const sid = newSession()
    inSession(sid, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, Date.now() + 1000)
    })
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
  })

  it('never answers a stop a hook already continued', () => {
    expect(stopHandler(stopEvent(unverifiedSession(), { stop_hook_active: true })).hookType).toBe('pass')
  })

  it('speaks once per distinct state', () => {
    const sid = unverifiedSession()
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
    expect(stopHandler(stopEvent(sid)).hookType).toBe('pass')
    inSession(sid, () => recordFileEdit('C:/proj/src/other.ts'))
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
  })

  it('is off when the config key is off', () => {
    vi.stubEnv('TOKEN_GOAT_STOP_VERIFICATION_ADVISORY', '0')
    clearModuleCaches()
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  it('is quiet during quiet hours', () => {
    vi.stubEnv('TOKEN_GOAT_QUIET_HOURS', '00:00-23:59')
    clearModuleCaches()
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  it('does nothing on Copilot CLI, whose agentStop drops a non-blocking message', () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    expect(stopHandler(stopEvent(unverifiedSession())).hookType).toBe('pass')
  })

  it('judges a subagent on its own commands', () => {
    const sid = unverifiedSession()
    const agentKey = `${sid}:agent:sub1`
    inSession(agentKey, () => recordVerificationRun('npm test', 0))
    expect(stopHandler(stopEvent(sid, {}, 'sub1')).hookType).toBe('pass')
    expect(stopHandler(stopEvent(sid)).hookType).toBe('context')
  })

  it('quotes a file name that carries a backtick instead of opening a code span', () => {
    const text = stopAdvisoryText({ runs: [], failingUnresolved: false, editedFiles: ['a`b.ts'], editedSinceLastPass: ['a`b.ts'] })
    expect(text).not.toContain('`')
  })
})

describe('the built hook entry, per host', () => {
  const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
  let root: string
  let project: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-e2e-'))
    project = path.join(root, 'proj')
    for (const d of ['proj', 'tg', 'local', 'xdg', 'home', 'claude', 'codex']) fs.mkdirSync(path.join(root, d), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function hook(event: string, harness: string, payload: Record<string, unknown>): { status: number; stdout: string } {
    const res = spawnSync(process.execPath, [BUNDLE, 'hook', event], {
      cwd: project,
      encoding: 'utf-8',
      timeout: 30000,
      input: JSON.stringify({ cwd: project.replaceAll(path.sep, '/'), ...payload }),
      env: {
        ...process.env,
        TOKEN_GOAT_HOME: path.join(root, 'tg'),
        LOCALAPPDATA: path.join(root, 'local'),
        XDG_DATA_HOME: path.join(root, 'xdg'),
        HOME: path.join(root, 'home'),
        USERPROFILE: path.join(root, 'home'),
        CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        CODEX_HOME: path.join(root, 'codex'),
        TOKEN_GOAT_HARNESS_OVERRIDE: harness,
        TOKEN_GOAT_HOOK_SERVER: '0',
        TOKEN_GOAT_NATIVE_HOOKS: '0',
        TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      },
    })
    return { status: res.status ?? 1, stdout: res.stdout ?? '' }
  }

  it('codex: a test run that reported no status, then an edit, then a stop names the file and the run', () => {
    // FORMAT-DERIVED: a Codex PostToolUse carries tool_response as a plain string (https://developers.openai.com/codex/hooks), with no exit status field.
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'widget.ts'), 'export const w = 1\n')
    const base = { session_id: 'e2e-stop-codex', permission_mode: 'default', turn_id: 'turn-1', transcript_path: null }
    hook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' }, tool_response: 'ok' })
    hook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-export const w = 1\n+export const w = 2\n*** End Patch` }, tool_response: 'Success' })
    const out = hook('stop', 'codex', { ...base, hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Done.' })
    expect(out.status).toBe(0)
    const message = (JSON.parse(out.stdout) as { systemMessage?: string }).systemMessage ?? ''
    expect(message).toContain('widget.ts')
    expect(message).toContain('npm test')
  })

  it('claudecode: an edit, a failed test run, then a stop yields a systemMessage naming both', () => {
    const harness = 'claudecode'
    const stopName = 'Stop'
    const sid = `e2e-stop-${harness}`
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'widget.ts'), 'export const w = 1\n')
    const base = { session_id: sid, permission_mode: 'default' }
    hook('post_tool_use', harness, { ...base, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'export const w = 1\n' }, tool_response: { filePath: file, success: true } })
    hook('post_tool_use_failure', harness, { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', error: 'Exit code 1\nFAIL', is_interrupt: false })
    const out = hook('stop', harness, { ...base, hook_event_name: stopName, stop_hook_active: false, last_assistant_message: 'Done.' })
    expect(out.status).toBe(0)
    const message = (JSON.parse(out.stdout) as { systemMessage?: string }).systemMessage ?? ''
    expect(message).toContain('widget.ts')
    expect(message).toContain('exit 1')
  })
})
