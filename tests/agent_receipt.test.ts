// The evidence receipt a subagent report carries. Provenance: the SubagentStop payload keys (session_id, cwd, agent_id, agent_type, stop_hook_active, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop) and https://developers.openai.com/codex/hooks, the same docs tests/fixtures/harness_hook_payloads.ts cites for its subagent_stop rows; the Copilot subagentStop keys follow tests/fixtures/copilot_cli_1_0_88/C4a-013-subagentStop.json (CAPTURE, Copilot CLI 1.0.88). The Agent tool result is a plain string here, as in tests/hooks_agent_spawn.test.ts; the envelope Claude Code wraps around it is not verified, which is why the trailer case below is HAND-DERIVED rather than claimed as captured. Every expected receipt is HAND-DERIVED from the edits, runs and report text each test builds.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runHook as RunHookFn } from '../src/hook_registry.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'

import { parkAgentReceipt, receiptLines, takeAgentReceipt } from '../src/agent_receipt.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'
import type { VerificationState } from '../src/verification_state.js'

// clearModuleCaches also empties the hook registry, so the registry tests reload the modules instead and dispatch through the production registrations.
let runHook: typeof RunHookFn
let buildEvent: typeof BuildEventFn
async function freshRegistry(): Promise<void> {
  vi.resetModules()
  runHook = (await import('../src/hook_registry.js')).runHook
  buildEvent = (await import('../src/relay.js')).buildEvent
}

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0)

function newSession(): string {
  return `s-receipt-${process.pid}-${Math.random().toString(36).slice(2)}`
}

function inSession(key: string, work: () => void): void {
  loadSessionState(key)
  try {
    work()
  } finally {
    saveSessionState(key)
  }
}

function state(overrides: Partial<VerificationState> = {}): VerificationState {
  return { runs: [], failingUnresolved: false, editedFiles: [], editedAnyFile: false, editedSinceLastPass: [], ...overrides }
}

const failedRun = { command: 'npm test', exitCode: 1, at: T0 }

describe('receiptLines', () => {
  it('a clean subagent gets no receipt', () => {
    expect(receiptLines(state(), false)).toEqual([])
    expect(receiptLines(state({ editedFiles: ['a.ts'], runs: [{ command: 'npm test', exitCode: 0, at: T0 }] }), false)).toEqual([])
  })

  it('a failed last check is named with its exit code', () => {
    const lines = receiptLines(state({ failingUnresolved: true, latestRun: failedRun, runs: [failedRun] }), false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('npm test')
    expect(lines[0]).toContain('exit 1')
  })

  it('an edit after the last passing check names the file', () => {
    const lines = receiptLines(state({ editedFiles: ['a.ts'], editedSinceLastPass: ['a.ts'] }), false)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('a.ts')
  })

  it('a claimed change with no edit says so', () => {
    const lines = receiptLines(state(), true)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('recorded no edit')
  })

  it('never exceeds three lines and caps the file names', () => {
    const names = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
    const lines = receiptLines(state({ failingUnresolved: true, latestRun: failedRun, runs: [failedRun], editedFiles: names, editedSinceLastPass: names }), true)
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('+2 more')
    expect(lines[1]).not.toContain('d.ts')
  })

  it('quotes a file name carrying a backtick instead of opening a code span', () => {
    expect(receiptLines(state({ editedFiles: ['a`b.ts'], editedSinceLastPass: ['a`b.ts'] }), false).join('\n')).not.toContain('`')
  })
})

describe('parked receipts', () => {
  beforeEach(() => clearModuleCaches())

  it('hands a receipt to the report that hashes the same, once', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'The work is done.', 'receipt text')
    expect(takeAgentReceipt(sid, 'The work is done.')).toBe('receipt text')
    expect(takeAgentReceipt(sid, 'The work is done.')).toBeNull()
  })

  it('does not hand it to a different report', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'The work is done.', 'receipt text')
    expect(takeAgentReceipt(sid, 'The work is not done.')).toBeNull()
  })

  it('matches a report the harness continued with a trailer', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'The work is done.', 'receipt text')
    expect(takeAgentReceipt(sid, 'The work is done.\nagentId: abc123')).toBe('receipt text')
  })

  it('keeps the newest sixteen', () => {
    const sid = newSession()
    for (let i = 0; i < 17; i += 1) parkAgentReceipt(sid, `report ${i}`, `receipt ${i}`)
    expect(takeAgentReceipt(sid, 'report 0')).toBeNull()
    expect(takeAgentReceipt(sid, 'report 16')).toBe('receipt 16')
  })
})

describe('the receipt through the real hook registry', () => {
  let repo: string
  const report = 'Investigated the module and wrote up what I found. '.repeat(3)

  beforeEach(async () => {
    await freshRegistry()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-repo-'))
    spawnSync('git', ['init', '-q'], { cwd: repo })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    fs.rmSync(repo, { recursive: true, force: true })
  })

  const stopPayload = (sid: string, message: string, extra: Record<string, unknown> = {}) => ({
    session_id: sid,
    cwd: repo.replaceAll(path.sep, '/'),
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_id: 'sub1',
    agent_type: 'general-purpose',
    last_assistant_message: message,
    ...extra,
  })
  const agentResult = (sid: string, text: string) => runHook(buildEvent('post_tool_use', { tool_name: 'Agent', tool_input: { prompt: 'Look into it.' }, session_id: sid, tool_response: text }))

  it('a subagent whose last check failed gets a receipt on its report', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 1, T0 + 1000)
    })
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    const out = await agentResult(sid, report)
    expect(out.hookType).toBe('context')
    const text = JSON.stringify(out)
    expect(text).toContain('last check failed')
    expect(text).toContain('npm test')
  })

  it('books one agent_receipt stat for the delivered receipt and none for a clean report', async () => {
    const receiptRows = (): number => (getDb(globalDbPath()).prepare("SELECT count(*) c FROM stats WHERE kind='agent_receipt'").get() as { c: number }).c
    const before = receiptRows()
    const flagged = newSession()
    inSession(`${flagged}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(flagged, report)))
    await agentResult(flagged, report)
    expect(receiptRows()).toBe(before + 1)
    const clean = newSession()
    inSession(`${clean}:agent:sub1`, () => recordVerificationRun('npm test', 0, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(clean, report)))
    await agentResult(clean, report)
    expect(receiptRows()).toBe(before + 1)
  })

  it('a clean subagent gets nothing', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, T0 + 1000)
    })
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    expect((await agentResult(sid, report)).hookType).toBe('pass')
  })

  it('a report that claims a change on a clean tree with no recorded edit gets a receipt', async () => {
    const sid = newSession()
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'I fixed the parser bug.')))
    expect(JSON.stringify(await agentResult(sid, 'I fixed the parser bug.'))).toContain('recorded no edit')
  })

  it('a claimed change that was committed is not flagged', async () => {
    const sid = newSession()
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'I fixed the parser bug and committed it.')))
    expect((await agentResult(sid, 'I fixed the parser bug and committed it.')).hookType).toBe('pass')
  })

  it('a claimed change the subagent did record and verify is not flagged, even on a clean tree', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => {
      recordFileEdit('C:/proj/src/a.ts')
      recordVerificationRun('npm test', 0, T0 + 1000)
    })
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'I fixed the parser bug.')))
    expect((await agentResult(sid, 'I fixed the parser bug.')).hookType).toBe('pass')
  })

  it('a claimed change on a tree with edits is not flagged', async () => {
    const sid = newSession()
    fs.writeFileSync(path.join(repo, 'changed.txt'), 'x')
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'I fixed the parser bug.')))
    expect((await agentResult(sid, 'I fixed the parser bug.')).hookType).toBe('pass')
  })

  it('delivers the receipt with a short report too, since the receipt does not depend on report size', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 2, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Tests fail.')))
    expect(JSON.stringify(await agentResult(sid, 'Tests fail.'))).toContain('exit 2')
  })

  it('is off when the config key is off', async () => {
    vi.stubEnv('TOKEN_GOAT_AGENT_RECEIPT', '0')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    expect((await agentResult(sid, report)).hookType).toBe('pass')
  })

  it('is quiet during quiet hours', async () => {
    vi.stubEnv('TOKEN_GOAT_QUIET_HOURS', '00:00-23:59')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    expect((await agentResult(sid, report)).hookType).toBe('pass')
  })

  // HAND-DERIVED: three fenced blocks of 90 identical lines, the shape tests/hooks_agent_spawn.test.ts uses for a report the compaction rewrites.
  const longReport = `Findings from the run.\n\n${'```\n' + 'a filler line of captured build output, long enough to collapse\n'.repeat(90) + '```\n'}`.repeat(3)

  it('rides along with the compacted report when the report is long enough to be rewritten', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, longReport)))
    const out = await agentResult(sid, longReport)
    expect(out.hookType).toBe('rewriteOutput')
    const text = JSON.stringify(out)
    expect(text).toContain('cached for later recall')
    expect(text).toContain('last check failed')
  })

  it('on Copilot CLI a long report is compacted and still carries the receipt and books the stat', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const receiptRows = (): number => (getDb(globalDbPath()).prepare("SELECT count(*) c FROM stats WHERE kind='agent_receipt'").get() as { c: number }).c
    const before = receiptRows()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, longReport)))
    expect(out.hookType).toBe('rewriteOutput')
    const text = JSON.stringify(out)
    expect(text).toContain('cached for later recall')
    expect(text).toContain('last check failed')
    expect(receiptRows()).toBe(before + 1)
  })

  it('does not park a receipt for a stop a hook already continued', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report, { stop_hook_active: true })))
    expect((await agentResult(sid, report)).hookType).toBe('pass')
  })

  it('on Copilot CLI the subagentStop rewrite carries the receipt and nothing is parked', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    const receiptRows = (): number => (getDb(globalDbPath()).prepare("SELECT count(*) c FROM stats WHERE kind='agent_receipt'").get() as { c: number }).c
    const before = receiptRows()
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    expect(out.hookType).toBe('rewriteOutput')
    expect(JSON.stringify(out)).toContain('last check failed')
    expect(receiptRows()).toBe(before + 1)
    expect(takeAgentReceipt(sid, report)).toBeNull()
  })

  it('on Copilot CLI a clean subagent report is left alone', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 0, T0 + 1000))
    expect((await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))).hookType).toBe('pass')
  })
})

describe('the built hook entry, per host', () => {
  const BUNDLE = path.join(process.cwd(), 'dist', 'token-goat.mjs')
  let root: string
  let project: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-receipt-e2e-'))
    project = path.join(root, 'proj')
    for (const d of ['proj', 'tg', 'local', 'xdg', 'home', 'claude', 'codex', 'copilot']) fs.mkdirSync(path.join(root, d), { recursive: true })
  })
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  function hook(event: string, harness: string, payload: Record<string, unknown>): string {
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
        COPILOT_HOME: path.join(root, 'copilot'),
        TOKEN_GOAT_HARNESS_OVERRIDE: harness,
        TOKEN_GOAT_HOOK_SERVER: '0',
        TOKEN_GOAT_NATIVE_HOOKS: '0',
        TOKEN_GOAT_NO_WORKER_SPAWN: '1',
      },
    })
    return res.stdout ?? ''
  }

  it('claudecode: a subagent edit, a failed check, its stop, then the parent Agent result', () => {
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    const base = { session_id: 'e2e-receipt-cc', permission_mode: 'default' }
    const child = { ...base, agent_id: 'sub1', agent_type: 'general-purpose' }
    hook('post_tool_use', 'claudecode', { ...child, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_response: { filePath: file, success: true } })
    hook('post_tool_use_failure', 'claudecode', { ...child, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', error: 'Exit code 1\nFAIL', is_interrupt: false })
    hook('subagent_stop', 'claudecode', { ...child, hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: 'Wrote the widget; the tests fail.' })
    const out = hook('post_tool_use', 'claudecode', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: 'Build the widget.' }, tool_response: 'Wrote the widget; the tests fail.' })
    const context = (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? ''
    expect(context).toContain('last check failed')
    expect(context).toContain('widget.ts')
  })

  it('codex: the same flow reports the run that was never confirmed passing', () => {
    const file = `${project.replaceAll(path.sep, '/')}/src/widget.ts`
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.writeFileSync(path.join(project, 'src', 'widget.ts'), 'export const w = 1\n')
    const base = { session_id: 'e2e-receipt-cx', permission_mode: 'default', turn_id: 'turn-1', transcript_path: null }
    const child = { ...base, agent_id: 'agent-1', agent_type: 'default' }
    hook('post_tool_use', 'codex', { ...child, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call_1', tool_input: { command: 'npm test' }, tool_response: 'ok' })
    hook('post_tool_use', 'codex', { ...child, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'call_2', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-export const w = 1\n+export const w = 2\n*** End Patch` }, tool_response: 'Success' })
    hook('subagent_stop', 'codex', { ...child, hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: 'Patched the widget.' })
    const out = hook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'call_3', tool_input: { prompt: 'Patch it.' }, tool_response: 'Patched the widget.' })
    expect(out).toContain('edited after its last passing check')
    expect(out).toContain('widget.ts')
  })
})
