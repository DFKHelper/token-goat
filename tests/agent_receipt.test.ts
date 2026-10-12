// The evidence receipt a subagent report carries. Provenance: the SubagentStop payload keys (session_id, cwd, agent_id, agent_type, stop_hook_active, last_assistant_message) are FORMAT-DERIVED from https://code.claude.com/docs/en/hooks (SubagentStop) and https://developers.openai.com/codex/hooks, the same docs tests/fixtures/harness_hook_payloads.ts cites for its subagent_stop rows; the Copilot subagentStop keys follow tests/fixtures/copilot_cli_1_0_88/C4a-013-subagentStop.json (CAPTURE, Copilot CLI 1.0.88). The Agent tool result is a plain string here, as in tests/hooks_agent_spawn.test.ts; the envelope Claude Code wraps around it is not verified, which is why the trailer case below is HAND-DERIVED rather than claimed as captured. Every expected receipt is HAND-DERIVED from the edits, runs and report text each test builds.

import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { runHook as RunHookFn } from '../src/hook_registry.js'
import type { buildEvent as BuildEventFn } from '../src/relay.js'

import { claimsChangeTheTreeLacks, parkAgentReceipt, receiptLines, takeAgentReceipt } from '../src/agent_receipt.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { clearModuleCaches } from '../src/reset.js'
import { redactSecrets } from '../src/secret_redact.js'
import { recordFileEdit, recordVerificationRun } from '../src/session.js'
import { loadSessionState, saveSessionState, sessionSidecarPath } from '../src/session_store.js'
import { withFileLock } from '../src/util.js'
import { noteFailedVerificationRun, type VerificationState } from '../src/verification_state.js'

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

  // HAND-DERIVED: two subagents return the same words with different verdicts; the ids are what tell them apart.
  it('two identical reports go to their own subagents when the delivery names the id', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'receipt for A', 'agent-a')
    parkAgentReceipt(sid, 'Done.', 'receipt for B', 'agent-b')
    expect(takeAgentReceipt(sid, 'Done.', 'agent-b')).toBe('receipt for B')
    expect(takeAgentReceipt(sid, 'Done.', 'agent-a')).toBe('receipt for A')
  })

  // CAPTURE: the trailer shape is from a real Claude Code 2.1.284 Agent tool result in a local session transcript (~/.claude/projects/<project>/<session>.jsonl): `agentId: a9ac7a96ac3596453 (internal ID - do not mention to user. Use SendMessage with to: 'a9ac7a96ac3596453', ...`. The same id names that subagent's own transcript, subagents/agent-a9ac7a96ac3596453.jsonl. That the SubagentStop agent_id carries this id is the documented meaning of agent_id, pinned by the registry test below, not captured here.
  it('two identical reports go to their own subagents by the agentId trailer of a Claude Code result', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'receipt for A', 'a1b2c3d4e5f60718')
    parkAgentReceipt(sid, 'Done.', 'receipt for B', '99887766554433aa')
    const trailer = (id: string): string => `Done.\n\nagentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}' to continue this agent.)`
    expect(takeAgentReceipt(sid, trailer('99887766554433aa'))).toBe('receipt for B')
    expect(takeAgentReceipt(sid, trailer('a1b2c3d4e5f60718'))).toBe('receipt for A')
  })

  it('identical reports with different verdicts and no id to tell them apart deliver nothing', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'receipt for A', 'agent-a')
    parkAgentReceipt(sid, 'Done.', 'receipt for B', 'agent-b')
    expect(takeAgentReceipt(sid, 'Done.')).toBeNull()
  })

  it('a delivery that names an id never takes a receipt parked for another agent', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'receipt for A', 'agent-a')
    expect(takeAgentReceipt(sid, 'Done.', 'agent-c')).toBeNull()
    expect(takeAgentReceipt(sid, 'Done.', 'agent-a')).toBe('receipt for A')
  })

  it('drops a receipt nobody claimed within half an hour', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(T0)
      const sid = newSession()
      parkAgentReceipt(sid, 'The work is done.', 'receipt text', 'agent-a')
      vi.setSystemTime(T0 + 31 * 60 * 1000)
      expect(takeAgentReceipt(sid, 'The work is done.', 'agent-a')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes under the cross-process lock: a park that cannot get it parks nothing', () => {
    const sid = newSession()
    const lockPath = sessionSidecarPath(sid, '.agent-receipts.lock')
    if (lockPath === null) throw new Error('no lock path')
    // Another hook process holds the lock for longer than a park waits, so a park that ignored the lock would write into the file the holder is rewriting.
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    const held = withFileLock(lockPath, () => {
      parkAgentReceipt(sid, 'Done.', 'receipt text', 'agent-a')
      return 'held'
    })
    expect(held, 'the test must hold the lock for the park to contend with').toBe('held')
    expect(takeAgentReceipt(sid, 'Done.', 'agent-a')).toBeNull()
  }, 15000)

  it('keeps the newest sixteen', () => {
    const sid = newSession()
    for (let i = 0; i < 17; i += 1) parkAgentReceipt(sid, `report ${i}`, `receipt ${i}`)
    expect(takeAgentReceipt(sid, 'report 0')).toBeNull()
    expect(takeAgentReceipt(sid, 'report 16')).toBe('receipt 16')
  })

  // HAND-DERIVED: a flagged receipt is the evidence, so a burst of clean agents after it must push out each other, not it.
  it('over the cap drops clean entries before an older flagged one', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'flagged report', 'receipt for the flagged agent', 'agent-flagged')
    for (let i = 0; i < 20; i += 1) parkAgentReceipt(sid, `clean report ${i}`, '', `agent-clean-${i}`)
    expect(takeAgentReceipt(sid, 'flagged report', 'agent-flagged')).toBe('receipt for the flagged agent')
  })

  it('over the cap with only flagged entries drops the oldest', () => {
    const sid = newSession()
    for (let i = 0; i < 18; i += 1) parkAgentReceipt(sid, `report ${i}`, `receipt ${i}`, `agent-${i}`)
    expect(takeAgentReceipt(sid, 'report 0', 'agent-0')).toBeNull()
    expect(takeAgentReceipt(sid, 'report 1', 'agent-1')).toBeNull()
    expect(takeAgentReceipt(sid, 'report 2', 'agent-2')).toBe('receipt 2')
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

  // FORMAT-DERIVED as in the codex case of the built-entry block below (wait.rs:299-302, protocol.rs:1932-1948, registry.rs:943-952).
  const waitResult = (sid: string, status: Record<string, unknown>, asText = true) =>
    runHook(buildEvent('post_tool_use', { tool_name: 'multi_agent_v1wait_agent', tool_input: { targets: Object.keys(status) }, session_id: sid, tool_response: asText ? JSON.stringify({ status, timed_out: false }) : { status, timed_out: false } }))

  it('codex: a finished subagent gets its receipt on the wait_agent result, keyed on its thread id', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:thread-a`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    inSession(`${sid}:agent:thread-b`, () => recordVerificationRun('npm test', 2, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: 'thread-a' })))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: 'thread-b' })))
    const out = await waitResult(sid, { 'thread-b': { completed: 'Done.' }, 'thread-a': 'running' })
    expect(out.hookType).toBe('context')
    const text = JSON.stringify(out)
    expect(text).toContain('exit 2')
    expect(text).not.toContain('exit 1')
    const later = await waitResult(sid, { 'thread-a': { completed: 'Done.' } }, false)
    expect(JSON.stringify(later)).toContain('exit 1')
  })

  it('codex: a wait_agent result with nothing finished, or a clean agent, adds nothing', async () => {
    const sid = newSession()
    expect((await waitResult(sid, { 'thread-a': 'running' })).hookType).toBe('pass')
    expect((await waitResult(sid, { 'thread-a': { completed: 'Done.' } })).hookType).toBe('pass')
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

  // HAND-DERIVED: sentences a read-only agent (Explore, a reviewer) writes about code it only read, and ones that report its own work. Every form here gets no accusation on a clean tree.
  it.each([
    ['The handler adds a header to each request.'],
    ['The parser removes comments before it tokenizes, and the cache replaces stale entries.'],
    ['Callers update the index when a file changes.'],
    ['I did not fix anything; the bug is in the caller.'],
    ["I couldn't update the config because it is read only."],
    ['I wrote up what I found below.'],
    ['Findings:\n- The loader creates a temp file.\n- The writer deletes it.'],
    ['We updated nothing'],
    ['Fixed: nothing'],
    ['Deleted files: none'],
    ['We removed nothing'],
    ['Summary: updated nothing, read only.'],
    ['Renamed symbols are listed below.'],
    ['Replaced by foo in the cache layer.'],
    ['Findings:\n- Removed code at line 5 is dead\n- Updated docs are stale'],
    ['The diff for reference:\n```diff\n- removed foo\n+ added bar\n```'],
    ['The diff for reference:\n- removed foo\n+ added bar\n@@ -1 +1 @@'],
    ['Quoted from the log:\n```\nI fixed the parser\n```'],
    ['Quoted commit:\n- I removed the dead branch\n+ we added a guard'],
    ['Changed: none'],
    ['Changes made: none'],
    ['Changes made:\n- None'],
    ['Changes: nothing, this was a read-only review.'],
    ["I'll add the guard next."],
  ])('read-only report %j with a clean tree is not flagged', (message) => {
    expect(claimsChangeTheTreeLacks(message, repo)).toBe(false)
  })

  it.each([
    ['I renamed foo to bar.'],
    ["I've also added a guard."],
    ['We fixed the parser bug in x.ts'],
    ['Changes made: added a guard to y.ts'],
    ['Changes made:\n- Updated the README.\n- Added a test.'],
    ['Done.\nI updated the README.'],
    ['We replaced the cache layer.'],
    ['Fixed the parser bug.'],
    ['Done:\n- I fixed the parser\n- I added tests'],
  ])('own-work claim %j with a clean tree is flagged', (message) => {
    expect(claimsChangeTheTreeLacks(message, repo)).toBe(true)
  })

  it('a read-only report from an Explore agent gets no receipt through the registry', async () => {
    const sid = newSession()
    const message = 'The handler adds a header to each request.'
    await runHook(buildEvent('subagent_stop', stopPayload(sid, message, { agent_type: 'Explore' })))
    expect((await agentResult(sid, message)).hookType).toBe('pass')
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

  // HAND-DERIVED: AKIA plus sixteen capitals is the AWS access key shape secret_redact.ts matches, here inside a file name the subagent chose.
  it('redacts a secret in a file name before the receipt is stored', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordFileEdit('C:/proj/src/a_AKIAABCDEFGHIJKLMNOP.ts'))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    const stored = fs.readFileSync(sessionSidecarPath(sid, '.agent-receipts')!, 'utf8')
    expect(stored).toContain('edited after its last passing check')
    expect(stored).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  // The receipt line is built from file names and commands (nameSubject and echoedValue quote them, they do not redact), so the parked text itself is what has to carry no secret.
  it('redacts the receipt text it is handed before it is stored', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'token-goat: this subagent edited after its last passing check: file "a_AKIAABCDEFGHIJKLMNOP.ts".', 'agent-a')
    const stored = fs.readFileSync(sessionSidecarPath(sid, '.agent-receipts')!, 'utf8')
    expect(stored).toContain('edited after its last passing check')
    expect(stored).not.toContain('AKIAABCDEFGHIJKLMNOP')
  })

  it('names the failed command in the receipt without the secret its env assignment carried', async () => {
    const sid = newSession()
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'claudecode')
    inSession(`${sid}:agent:sub1`, () => {
      noteFailedVerificationRun('API_TOKEN=abcd1234efgh5678ijkl npm test', 'Exit code 1', false)
    })
    await runHook(buildEvent('subagent_stop', stopPayload(sid, report)))
    const text = JSON.stringify(await agentResult(sid, report))
    expect(text).toContain('npm test')
    expect(text).not.toContain('abcd1234efgh5678ijkl')
  })

  it('a delivery with nothing parked writes no file and takes no lock', async () => {
    const sid = newSession()
    expect((await agentResult(sid, report)).hookType).toBe('pass')
    expect((await waitResult(sid, { 'thread-a': { completed: 'Done.' } })).hookType).toBe('pass')
    expect(fs.existsSync(sessionSidecarPath(sid, '.agent-receipts')!)).toBe(false)
    expect(fs.existsSync(sessionSidecarPath(sid, '.agent-receipts.lock')!)).toBe(false)
  })

  it('a delivery that matches nothing leaves the sidecar byte for byte as it was', () => {
    const sid = newSession()
    parkAgentReceipt(sid, 'Done.', 'receipt for A', 'agent-a')
    const sidecar = sessionSidecarPath(sid, '.agent-receipts')!
    const before = fs.readFileSync(sidecar, 'utf8')
    const old = new Date(T0 - 60_000)
    fs.utimesSync(sidecar, old, old)
    expect(takeAgentReceipt(sid, 'Something else entirely.')).toBeNull()
    expect(fs.readFileSync(sidecar, 'utf8')).toBe(before)
    expect(fs.statSync(sidecar).mtimeMs).toBe(old.getTime())
  })

  // HAND-DERIVED: agent B is clean and agent A is flagged, and both return the same words. B parks nothing, so before clean agents were recorded the ambiguity was invisible and B's result took A's receipt.
  it('a clean agent that returned the same words as a flagged one does not take its receipt', async () => {
    const sid = newSession()
    inSession(`${sid}:agent:agent-a`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    inSession(`${sid}:agent:agent-b`, () => recordVerificationRun('npm test', 0, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: 'agent-a' })))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: 'agent-b' })))
    expect((await agentResult(sid, 'Done.')).hookType).toBe('pass')
    expect(JSON.stringify(await agentResult(sid, 'Done.\n\nagentId: agent-a (internal ID - do not mention to user.)'))).toContain('exit 1')
    expect((await agentResult(sid, 'Done.\n\nagentId: agent-b (internal ID - do not mention to user.)')).hookType).toBe('pass')
  })

  // This pins the join logic only, with an agent_id the test chose: the equality of the trailer id and the hook's agent_id is not captured. What is: the trailer ids of the 2.1.284 transcript name the subagents/agent-<id>.jsonl files (CAPTURE), and the SubagentStop payload carries agent_transcript_path of that agent-<id>.jsonl shape (FORMAT-DERIVED, tests/fixtures/harness_hook_payloads.ts). A host that stops agreeing delivers nothing rather than another agent's receipt.
  it('the id in the Agent result trailer is the agent_id of its SubagentStop', async () => {
    const sid = newSession()
    const id = 'a9ac7a96ac3596453'
    inSession(`${sid}:agent:${id}`, () => recordVerificationRun('npm test', 3, T0 + 1000))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: id })))
    await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Done.', { agent_id: 'af00000000000000b' })))
    const out = await agentResult(sid, `Done.\n\nagentId: ${id} (internal ID - do not mention to user. Use SendMessage with to: '${id}' to continue this agent.)`)
    expect(JSON.stringify(out)).toContain('exit 3')
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

  it('on Copilot CLI the post-tool pass leaves the rewritten report, receipt lines included, as it is', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    // HAND-DERIVED: prose the compaction leaves alone keeps the rewritten report above agent_report.min_bytes (8000, src/config_defaults.ts), the size from which the post-tool pass would otherwise compact it again.
    const bulky = `${'A paragraph of findings that no rewrite shortens. '.repeat(200)}\n\n${longReport}`
    const rewritten = await runHook(buildEvent('subagent_stop', stopPayload(sid, bulky)))
    if (rewritten.hookType !== 'rewriteOutput') throw new Error('the subagentStop rewrite was expected to fire')
    expect(rewritten.updatedOutput).toContain('last check failed')
    expect(rewritten.updatedOutput.length).toBeGreaterThan(8000)
    const again = await runHook(buildEvent('post_tool_use', { tool_name: 'task', tool_input: { prompt: 'Look into it.' }, session_id: sid, tool_response: rewritten.updatedOutput }))
    expect(again.hookType).toBe('pass')
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

  it('on Copilot CLI the rewrite keeps the redacted report byte for byte and a redacted secret stays redacted', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    const sid = newSession()
    inSession(`${sid}:agent:sub1`, () => recordVerificationRun('npm test', 1, T0 + 1000))
    // FORMAT-DERIVED: the AWS access key id shape (AKIA plus 16 upper-case alphanumerics) that tests/hooks_agent_spawn.test.ts also uses as its secret.
    const secret = 'AKIAABCDEFGHIJKLMNOP'
    const leaky = `Checked the loader. The key ${secret} is in the fixture.`
    const redacted = redactSecrets(leaky).text
    expect(redacted).not.toContain(secret)
    const out = await runHook(buildEvent('subagent_stop', stopPayload(sid, leaky)))
    if (out.hookType !== 'rewriteOutput') throw new Error('the subagentStop rewrite was expected to fire')
    expect(out.updatedOutput.startsWith(redacted + '\n\n')).toBe(true)
    expect(out.updatedOutput).not.toContain(secret)
  })

  it('on Copilot CLI the state flags need the subagent to have its own record, since its tool events carry no agentId', async () => {
    vi.stubEnv('TOKEN_GOAT_HARNESS_OVERRIDE', 'copilot_cli')
    await freshRegistry()
    // CAPTURE: tests/fixtures/copilot_cli_1_0_88 C4a-004, C4a-014 and C1a-005 (preToolUse and postToolUse) hold no agentId, while the subagentStop fixtures C4a-013 and C4c-011 do; so a Copilot subagent's checks land under the parent session key.
    const sid = newSession()
    inSession(sid, () => recordVerificationRun('npm test', 1, T0 + 1000))
    expect((await runHook(buildEvent('subagent_stop', stopPayload(sid, 'Looked at the loader; it reads the file once.')))).hookType).toBe('pass')
    // The git-status branch needs no per-agent record, so a claim of work on a clean tree is still caught.
    const claim = await runHook(buildEvent('subagent_stop', stopPayload(sid, 'I fixed the parser bug.')))
    expect(JSON.stringify(claim)).toContain('recorded no edit')
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

  it('claudecode: subagents stopping at the same moment each keep their receipt', async () => {
    const base = { session_id: 'e2e-receipt-race', permission_mode: 'default' }
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']
    const env = { ...process.env, TOKEN_GOAT_HOME: path.join(root, 'tg'), LOCALAPPDATA: path.join(root, 'local'), XDG_DATA_HOME: path.join(root, 'xdg'), HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'), COPILOT_HOME: path.join(root, 'copilot'), TOKEN_GOAT_HARNESS_OVERRIDE: 'claudecode', TOKEN_GOAT_HOOK_SERVER: '0', TOKEN_GOAT_NATIVE_HOOKS: '0', TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
    const runOne = (event: string, payload: Record<string, unknown>): Promise<void> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [BUNDLE, 'hook', event], { cwd: project, env, stdio: ['pipe', 'ignore', 'ignore'] })
        child.on('close', () => resolve())
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify({ cwd: project.replaceAll(path.sep, '/'), ...payload }))
      })
    // Each failed check is recorded first, one after another, so only the stops race.
    for (const id of ids) {
      await runOne('post_tool_use_failure', { ...base, agent_id: 'sub-' + id, agent_type: 'general-purpose', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_' + id, error: 'Exit code 1\nFAIL' })
    }
    await Promise.all(ids.map((id) => runOne('subagent_stop', { ...base, agent_id: 'sub-' + id, agent_type: 'general-purpose', hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: 'Report from ' + id + '.' })))
    for (const id of ids) {
      const out = hook('post_tool_use', 'claudecode', { ...base, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { prompt: 'Work.' }, tool_response: 'Report from ' + id + '.' })
      expect(out, 'receipt for ' + id).toContain('last check failed')
    }
  }, 120000)

  // HAND-DERIVED: three fenced blocks of 90 lines, past agent_report.min_bytes (8000, src/config_defaults.ts) and collapsible, so the report takes the compaction path.
  const LONG_REPORT = `Wrote the widget; the tests fail.\n\n${('```\n' + 'a filler line of captured build output, long enough to collapse\n'.repeat(90) + '```\n').repeat(3)}`

  it('vscode: a long report is delivered unchanged with the receipt in additionalContext, since VS Code drops a result rewrite', () => {
    const base = { session_id: 'e2e-receipt-vs', permission_mode: 'default' }
    // The contextOutput delivery path is defensive only: VS Code 1.140.0 never parks a receipt (see the next test), so this parks one from the Claude Code flow in the same session to exercise it.
    hook('post_tool_use_failure', 'claudecode', { ...base, agent_id: 'sub1', agent_type: 'general-purpose', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1', error: 'Exit code 1\nFAIL', is_interrupt: false })
    hook('subagent_stop', 'claudecode', { ...base, agent_id: 'sub1', agent_type: 'general-purpose', hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: LONG_REPORT })
    expect(fs.readdirSync(path.join(root, 'tg'), { recursive: true }).map(String).filter((n) => n.includes('.agent-receipts')).length).toBeGreaterThan(0)
    // FORMAT-DERIVED: PostToolUse input is tool_name, tool_input, tool_response, tool_use_id (the agent-hook payload builder in <user>/AppData/Local/Programs/Microsoft VS Code/07f806f999/resources/app/extensions/copilot/dist/extension.js, VS Code 1.140.0 with Copilot Chat 0.68.0, sha256 a918eb6ed04a7fb10ab673f2243b4dbd9ac8368c8ba82a60194d74ca45c1191f); runSubagent is the subagent tool (src/hooks_cli.ts VS Code tool map).
    const out = hook('post_tool_use', 'vscode', { ...base, hook_event_name: 'PostToolUse', tool_name: 'runSubagent', tool_input: { prompt: 'Build the widget.' }, tool_response: LONG_REPORT, tool_use_id: 'tu-1' })
    const parsed = JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string; updatedToolOutput?: string } }
    expect(parsed.hookSpecificOutput?.additionalContext ?? '').toContain('last check failed')
    expect(parsed.hookSpecificOutput?.updatedToolOutput).toBeUndefined()
  })

  it('vscode: a long report with no receipt to deliver passes silently, as it did before receipts existed', () => {
    const out = hook('post_tool_use', 'vscode', { session_id: 'e2e-receipt-vs-quiet', permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'runSubagent', tool_input: { prompt: 'Build the widget.' }, tool_response: LONG_REPORT, tool_use_id: 'tu-2' })
    expect(JSON.parse(out)).toEqual({})
  })

  it('vscode: a SubagentStop carries no report, so nothing is parked and the later result has no receipt', () => {
    const base = { session_id: 'e2e-receipt-vs-none', permission_mode: 'default' }
    hook('post_tool_use_failure', 'vscode', { ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'run_in_terminal', tool_input: { command: 'npm test' }, tool_use_id: 'tu-0', error: 'Exit code 1' })
    // FORMAT-DERIVED: extension.js (<user>/AppData/Local/Programs/Microsoft VS Code/07f806f999/resources/app/extensions/copilot/dist/extension.js, VS Code 1.140.0 with Copilot Chat 0.68.0, sha256 a918eb6ed04a7fb10ab673f2243b4dbd9ac8368c8ba82a60194d74ca45c1191f) builds the SubagentStop input as agent_id, agent_type and stop_hook_active only; a search of that file for last_assistant_message finds none.
    const stop = hook('subagent_stop', 'vscode', { ...base, hook_event_name: 'SubagentStop', agent_id: 'sub-vs', agent_type: 'Explore', stop_hook_active: false })
    expect(JSON.parse(stop)).toEqual({})
    expect(fs.readdirSync(path.join(root, 'tg'), { recursive: true }).map(String).filter((n) => n.includes('.agent-receipts'))).toEqual([])
    const out = hook('post_tool_use', 'vscode', { ...base, hook_event_name: 'PostToolUse', tool_name: 'runSubagent', tool_input: { prompt: 'Look.' }, tool_response: 'Wrote the widget; the tests fail.', tool_use_id: 'tu-1' })
    expect(out).not.toContain('last check failed')
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
    // FORMAT-DERIVED: the report reaches the parent through the multi-agent v1 wait_agent tool, hook tool name = namespace + name (openai/codex a9b0815 codex-rs/core/src/tools/registry.rs:943-952, tools/mod.rs:47-59, handlers/multi_agents_spec.rs:14); its result is WaitAgentResult { status: { <thread id>: AgentStatus }, timed_out } (handlers/multi_agents/wait.rs:299-302) with AgentStatus::Completed(Option<String>) serialized snake_case (protocol/src/protocol.rs:1932-1948), and the SubagentStop agent_id is that thread id (core/src/hook_runtime.rs:1056). Not a capture: no real Codex multi-agent run was made for this fixture.
    const waited = JSON.stringify({ status: { 'agent-1': { completed: 'Patched the widget.' } }, timed_out: false })
    const out = hook('post_tool_use', 'codex', { ...base, hook_event_name: 'PostToolUse', tool_name: 'multi_agent_v1wait_agent', tool_use_id: 'call_3', tool_input: { targets: ['agent-1'], timeout_ms: 30000 }, tool_response: waited })
    expect(out).toContain('edited after its last passing check')
    expect(out).toContain('widget.ts')
  })
})
