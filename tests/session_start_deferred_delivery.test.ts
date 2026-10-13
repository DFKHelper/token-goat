import { randomUUID } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getGlobalDb } from '../src/stats.js'
import { clearPerRequestCaches } from '../src/reset.js'
import { sessionStateKey } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import { claimOwedSessionStart, recordSessionStartSettled } from '../src/session_start_owed.js'
import { relayInProcess } from '../src/relay.js'

// Provenance: every row is HAND-DERIVED. The marker epochs are picked by hand against the rule in DESIGN.md section 2.1 (owed iff no marker or finishedAtMs > deadlineEpoch - 1000). The expected text is a phrase read off the user-facing reminder wording, not a call to the matcher: NOTE_REMINDER in src/session_reminder.ts is appended to both the indexed and the generic reminder, so it is in the output whichever the temp cwd resolves to. Rows drive relayInProcess, the production dispatch path, never an injected handler.

const DEADLINE = 1_800_000_000_000
const REMINDER_PHRASE = 'must outlive a compaction'

let sid: string
let savedHarness: string | undefined

function setHarness(name: string): void {
  process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = name
  // Per-request resets only: the full reset also empties the hook registry, which this file drives through the relay.
  clearPerRequestCaches()
}

function markerEvent(sessionId: string): HookEvent {
  return { eventName: 'session_start', toolName: undefined, toolInput: {}, sessionId, agentId: undefined, raw: {} }
}

function deferredCount(): number {
  const row = getGlobalDb().prepare("SELECT count(*) AS n FROM stats WHERE kind = 'session_start_deferred'").get() as { n: number }
  return row.n
}

/** One post_tool_use through the real relay; returns what the harness would receive. */
async function toolCall(sessionId: string, agentId?: string): Promise<string> {
  const payload: Record<string, unknown> = { session_id: sessionId, tool_name: 'TgDeferredProbe', tool_input: {}, tool_response: { output: 'raw' } }
  if (agentId !== undefined) payload['agent_id'] = agentId
  return relayInProcess('post_tool_use', payload)
}

function occurrences(text: string): number {
  return text.split(REMINDER_PHRASE).length - 1
}

beforeEach(() => {
  sid = `deferred-${randomUUID()}`
  savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  getGlobalDb()
})

afterEach(() => {
  if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
  else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
  clearPerRequestCaches()
})

describe('owed session start delivered on the first tool call (R1)', () => {
  it('delivers the reminder once when no marker exists, and nothing on the second call', async () => {
    setHarness('copilot_cli')
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(1)
    const second = await toolCall(sid)
    expect(occurrences(second), second).toBe(0)
  })

  it('delivers once when the marker finished 500 ms before the deadline', async () => {
    setHarness('copilot_cli')
    recordSessionStartSettled(markerEvent(sid), { finishedAtMs: DEADLINE - 500, deadlineEpoch: DEADLINE })
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(1)
    expect(occurrences(await toolCall(sid))).toBe(0)
  })
})

describe('settled session start (R4b)', () => {
  it('gives no deferred text when the marker finished 5 s before its deadline', async () => {
    setHarness('copilot_cli')
    recordSessionStartSettled(markerEvent(sid), { finishedAtMs: DEADLINE - 5_000, deadlineEpoch: DEADLINE })
    const before = deferredCount()
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(0)
    expect(deferredCount()).toBe(before)
  })
})

describe('subagent first call (R6)', () => {
  it('neither delivers nor consumes the parent entry', async () => {
    setHarness('copilot_cli')
    const sub = await toolCall(sid, 'agent-1')
    expect(occurrences(sub), sub).toBe(0)
    // The parent's claim is still free: a subagent call that had taken it would make this false.
    expect(claimOwedSessionStart(markerEvent(sid))).toBe(true)
    expect(sessionStateKey({ ...markerEvent(sid), agentId: 'agent-1' })).not.toBe(sessionStateKey(markerEvent(sid)))
  })

  it('still delivers to the parent after a subagent call came first', async () => {
    setHarness('copilot_cli')
    await toolCall(sid, 'agent-1')
    expect(occurrences(await toolCall(sid))).toBe(1)
  })
})

describe('harnesses with no deadline (R7)', () => {
  for (const harness of ['claudecode', 'codex']) {
    it(`${harness} with no marker produces no deferred text and no stat`, async () => {
      setHarness(harness)
      const before = deferredCount()
      const first = await toolCall(sid)
      expect(occurrences(first), first).toBe(0)
      expect(deferredCount()).toBe(before)
    })
  }
})

describe('deferral stat (R8)', () => {
  it('counts exactly one deferral after a delivered session start, however many calls follow', async () => {
    setHarness('copilot_cli')
    const before = deferredCount()
    await toolCall(sid)
    await toolCall(sid)
    expect(deferredCount()).toBe(before + 1)
  })
})
