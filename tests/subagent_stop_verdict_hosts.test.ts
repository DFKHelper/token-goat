// Where the SubagentStop change-claim verdict goes, per host, and where it never goes. Provenance: the Claude Code payload keys (session_id, cwd, hook_event_name, stop_hook_active, agent_id, agent_type, agent_transcript_path, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop), which says to use a PostToolUse hook on the Agent tool to reach the parent; the Codex keys (agent_id, agent_transcript_path, agent_type, cwd, hook_event_name, last_assistant_message, model, permission_mode, session_id, stop_hook_active, transcript_path) are FORMAT-DERIVED from the subagent-stop.command.input schema embedded in codex.exe 0.159.3, whose subagent-stop.command.output allows only continue, decision, reason, stopReason, suppressOutput and systemMessage; the Copilot CLI payload follows tests/fixtures/copilot_cli_1_0_88/C4a-013-subagentStop.json (CAPTURE, Copilot CLI 1.0.88) with `response` already mapped to last_assistant_message by its shim; the VS Code payload is FORMAT-DERIVED from executeSubagentStopHook in the Copilot Chat extension.js of VS Code 1.140.0 (agent_id, agent_type, stop_hook_active plus the common fields, no report), the same source tests/agent_receipt.test.ts cites. Neither the Claude Code nor the Codex payload was live-captured (the capture attempt hit a usage limit), so those two rows prove agreement with the vendor schema, not with a shipped build. Every expected verdict line is HAND-DERIVED from the report text each test builds. The tree is a real temporary git repository.

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GitAsyncModule from '../src/git_async.js'
import type { runHook as RunHookFn, serializeOutput as SerializeOutputFn } from '../src/hook_registry.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'
import type { RunGitAsyncOptions } from '../src/util.js'

import { recordFileEdit } from '../src/session.js'
import { loadSessionState, saveSessionState } from '../src/session_store.js'

// A cold git on a loaded machine can outlast the product's bound, which a hook is right to read as "no evidence" and a test is wrong to depend on: the bound is dropped here, real git still runs.
vi.mock('../src/git_async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitAsyncModule>()
  return {
    ...actual,
    runGitAsync: (args: string[], opts: RunGitAsyncOptions = {}) => {
      const { timeoutMs, ...unbounded } = opts
      void timeoutMs
      return actual.runGitAsync(args, unbounded)
    },
  }
})

let runHook: typeof RunHookFn
let serializeOutput: typeof SerializeOutputFn
let buildEvent: typeof BuildEventFn
let repo = ''
let warnings: string[] = []

async function freshRegistry(): Promise<void> {
  // clearModuleCaches would also empty the hook registry, so the modules are reloaded and dispatch goes through the production registrations.
  vi.resetModules()
  ;({ runHook, serializeOutput } = await import('../src/hook_registry.js'))
  ;({ buildEvent } = await import('../src/relay.js'))
}

beforeEach(async () => {
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
    warnings.push(parts.map(String).join(' '))
  })
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stop-verdict-'))
  expect(spawnSync('git', ['init', '-q'], { cwd: repo }).status).toBe(0)
  await freshRegistry()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

let sessionCounter = 0
const newSession = (): string => `s-verdict-${process.pid}-${sessionCounter++}-${Math.random().toString(36).slice(2)}`
const cwdOf = (): string => repo.replaceAll(path.sep, '/')
const CLAIM = 'I fixed the parser bug in widget.ts.'
const VERDICT = 'the report claims a change, but this subagent recorded no edit and the working tree is clean'
const HALLUCINATION = (sid: string): string => `subagent-stop: possible hallucination — session=${sid} but git status is clean`

/** Every channel a SubagentStop reply could use to reach the stopped subagent instead of the parent: a block, a continuation, extra context. None of them is ever the way this verdict travels. */
function expectNoSubagentChannel(wire: string): void {
  const parsed = JSON.parse(wire) as Record<string, unknown>
  expect(parsed['decision']).toBeUndefined()
  expect(parsed['reason']).toBeUndefined()
  expect(parsed['continue']).toBeUndefined()
  expect(wire).not.toContain('additionalContext')
  expect(wire).not.toContain('"block"')
}

const claudeStop = (sid: string, message: string) => ({
  session_id: sid,
  cwd: cwdOf(),
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'sub1',
  agent_type: 'general-purpose',
  agent_transcript_path: '/tmp/agent-sub1.jsonl',
  last_assistant_message: message,
})

const codexStop = (sid: string, message: string) => ({
  session_id: sid,
  turn_id: 'turn-1',
  cwd: cwdOf(),
  hook_event_name: 'SubagentStop',
  model: 'gpt-5',
  permission_mode: 'default',
  transcript_path: null,
  agent_transcript_path: null,
  stop_hook_active: false,
  agent_id: 'thread-a',
  agent_type: 'default',
  last_assistant_message: message,
})

const vscodeStop = (sid: string) => ({
  timestamp: '2026-10-17T00:00:00.000Z',
  hook_event_name: 'SubagentStop',
  session_id: sid,
  transcript_path: '/tmp/vscode-transcript.jsonl',
  cwd: cwdOf(),
  agent_id: 'sub-vs',
  agent_type: 'Explore',
  stop_hook_active: false,
})

const copilotStop = (sid: string, message: string) => ({
  session_id: sid,
  cwd: cwdOf(),
  hook_event_name: 'SubagentStop',
  stop_hook_active: false,
  agent_id: 'sub1',
  agent_type: 'general-purpose',
  last_assistant_message: message,
})

const agentResult = (sid: string, text: string) => runHook(buildEvent('post_tool_use', { tool_name: 'Agent', tool_input: { prompt: 'Look into it.' }, session_id: sid, tool_response: text }))
const waitResult = (sid: string, report: string) =>
  runHook(buildEvent('post_tool_use', { tool_name: 'multi_agent_v1wait_agent', tool_input: { targets: ['thread-a'] }, session_id: sid, tool_response: JSON.stringify({ status: { 'thread-a': { completed: report } }, timed_out: false }) }))

async function stop(harness: 'claude' | 'codex' | 'vscode', payload: Record<string, unknown>): Promise<string> {
  // A SubagentStop names no tool, so the hook entry hands the payload to buildEvent as it arrived; normalizePayload answers an empty payload for it.
  const event = buildEvent('subagent_stop', payload)
  return serializeOutput(await runHook(event), 'subagent_stop', harness === 'claude' ? 'claudecode' : harness, event)
}

describe('a change claim on a clean tree: where the verdict goes, per host', () => {
  it('claudecode: the parent gets it on the Agent result, the human on stderr, and the reply to the subagent is empty', async () => {
    const sid = newSession()
    const wire = await stop('claude', claudeStop(sid, CLAIM))
    expect(JSON.parse(wire)).toEqual({})
    expectNoSubagentChannel(wire)
    expect(warnings).toEqual([HALLUCINATION(sid)])
    expect(JSON.stringify(await agentResult(sid, CLAIM))).toContain(VERDICT)
  })

  it('codex: the parent gets it on the wait_agent result, the human on stderr, and the reply to the subagent is empty', async () => {
    const sid = newSession()
    const wire = await stop('codex', codexStop(sid, CLAIM))
    expect(JSON.parse(wire)).toEqual({})
    expectNoSubagentChannel(wire)
    // Codex's subagent-stop output schema has no hookSpecificOutput at all.
    expect(wire).not.toContain('hookSpecificOutput')
    expect(warnings).toEqual([HALLUCINATION(sid)])
    expect(JSON.stringify(await waitResult(sid, CLAIM))).toContain(VERDICT)
  })

  it('vscode: the payload carries no report, so there is no verdict and the reply is empty', async () => {
    const sid = newSession()
    const wire = await stop('vscode', vscodeStop(sid))
    expect(JSON.parse(wire)).toEqual({})
    expectNoSubagentChannel(wire)
    expect(warnings).toEqual([])
    expect((await agentResult(sid, CLAIM)).hookType).toBe('pass')
  })

  it('copilot_cli: the verdict is appended to the report the parent reads, and nothing blocks', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const sid = newSession()
    const out = await runHook(buildEvent('subagent_stop', copilotStop(sid, CLAIM)))
    if (out.hookType !== 'rewriteOutput') throw new Error(`expected the report rewrite, got ${out.hookType}`)
    expect(out.updatedOutput.startsWith(`${CLAIM}\n\n`)).toBe(true)
    expect(out.updatedOutput).toContain(VERDICT)
    expect(warnings).toEqual([HALLUCINATION(sid)])
  })

  it('copilot_cli: with the receipt switched off the report is left alone, and the stop is still not blocked', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    vi.stubEnv('TOKEN_GOAT_AGENT_RECEIPT', '0')
    await freshRegistry()
    const sid = newSession()
    expect((await runHook(buildEvent('subagent_stop', copilotStop(sid, CLAIM)))).hookType).toBe('pass')
    expect(warnings).toEqual([HALLUCINATION(sid)])
  })

  it.each([
    ['claude', claudeStop],
    ['codex', codexStop],
  ] as const)('%s: a report that claims nothing gets no verdict anywhere', async (harness, payload) => {
    const sid = newSession()
    expect(JSON.parse(await stop(harness, payload(sid, 'The parser reads the file once.')))).toEqual({})
    expect(warnings).toEqual([])
    expect((await agentResult(sid, 'The parser reads the file once.')).hookType).toBe('pass')
  })
})

describe('a recorded edit stands as evidence in the receipt, which the stderr warning does not need', () => {
  // HAND-DERIVED: a subagent that tried a change and took it back says so in the words a claim matcher reads as a claim, and a recorded edit is the one fact that tells the honest report from the false one.
  const REVERTED = 'I implemented the change but reverted it.'

  it('an honest report of a reverted experiment is not accused to the parent, though the human still sees the clean tree', async () => {
    const sid = newSession()
    loadSessionState(`${sid}:agent:sub1`)
    try {
      recordFileEdit(`${cwdOf()}/src/widget.ts`)
    } finally {
      saveSessionState(`${sid}:agent:sub1`)
    }
    expect(JSON.parse(await stop('claude', claudeStop(sid, REVERTED)))).toEqual({})
    expect(warnings).toEqual([HALLUCINATION(sid)])
    // The receipt still lists the recorded edit, but it does not accuse the report of a change the tree lacks.
    expect(JSON.stringify(await agentResult(sid, REVERTED))).not.toContain(VERDICT)
  })
})
