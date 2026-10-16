import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as SessionStart from '../src/hooks_session_start.js'

const failures = vi.hoisted(() => ({ startThrowsOnce: false }))

vi.mock('../src/hooks_session_start.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SessionStart>()
  return {
    ...actual,
    // STUBBED: no real failure path reaches sessionStartOutput's caller (every storage and lookup failure inside it is swallowed), so the one throw H3 needs is injected here, once, and everything else passes through.
    sessionStartOutput: (...args: Parameters<typeof actual.sessionStartOutput>): ReturnType<typeof actual.sessionStartOutput> => {
      if (failures.startThrowsOnce) {
        failures.startThrowsOnce = false
        throw new Error('simulated session start failure')
      }
      return actual.sessionStartOutput(...args)
    },
  }
})

import { getGlobalDb } from '../src/stats.js'
import { clearPerRequestCaches } from '../src/reset.js'
import { sessionStateKey } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'
import { COPILOT_SESSION_START_HELPERS } from '../src/bridges/copilot_session_start.js'
import { claimOwedSessionStart, recordSessionStartSettled } from '../src/session_start_owed.js'
import { sessionSidecarPath } from '../src/session_store.js'
import { relayInProcess } from '../src/relay.js'

// Provenance (owed means begun, unsettled, unclaimed): every row is HAND-DERIVED. The H2a, H2b and H3 rows add a second session start for one session key: the shim-side reset is the real function the generated shim embeds, evaluated from COPILOT_SESSION_START_HELPERS, and nothing else is stubbed except the single session start throw named in the mock above. Provenance of the earlier rows: HAND-DERIVED. The marker epochs are picked by hand against the rule in DESIGN.md section 2.1 (owed iff no marker or finishedAtMs > deadlineEpoch - 1000). The expected text is a phrase read off the user-facing reminder wording, not a call to the matcher: NOTE_REMINDER in src/session_reminder.ts is appended to both the indexed and the generic reminder, so it is in the output whichever the temp cwd resolves to. Rows drive relayInProcess, the production dispatch path, never an injected handler.

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
  it('delivers nothing when no start began (no begun marker): a host without the hook, a resumed session', async () => {
    setHarness('copilot_cli')
    const before = deferredCount()
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(0)
    expect(deferredCount()).toBe(before)
  })

  it('delivers the reminder once when a start began and did not settle, and nothing on the second call', async () => {
    setHarness('copilot_cli')
    shimReset(sid)
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
    shimReset(sid)
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
    shimReset(sid)
    const before = deferredCount()
    await toolCall(sid)
    await toolCall(sid)
    expect(deferredCount()).toBe(before + 1)
  })
})

/** The reset the generated Copilot shim runs before it spawns the helper, evaluated from the embedded source. */
function shimReset(sessionId: string): void {
  const run = new Function('require', COPILOT_SESSION_START_HELPERS + '\nreturn resetSessionStartOwedFiles')(createRequire(import.meta.url)) as (payload: unknown) => void
  run({ session_id: sessionId })
}

/** A brand-new hook process: nothing held in memory. */
function freshProcess(): void {
  clearPerRequestCaches()
}

function claimFileExists(sessionId: string): boolean {
  const target = sessionSidecarPath(sessionStateKey(markerEvent(sessionId)), '.session-start-owed')
  return target !== null && existsSync(target)
}

describe('a second missed session start under one key (H2a, H2b)', () => {
  it('H2a: a stale settled marker from start #1 does not hide start #2, which the shim reset made owed', async () => {
    setHarness('copilot_cli')
    recordSessionStartSettled(markerEvent(sid), { finishedAtMs: DEADLINE - 5_000, deadlineEpoch: DEADLINE })
    // Start #2 was killed before the helper ran: only the shim-side reset happened.
    shimReset(sid)
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(1)
  })

  it('H2b: a delivered start #1 (claim taken) does not swallow start #2', async () => {
    setHarness('copilot_cli')
    shimReset(sid)
    expect(occurrences(await toolCall(sid))).toBe(1)
    expect(claimFileExists(sid)).toBe(true)
    shimReset(sid)
    expect(claimFileExists(sid)).toBe(false)
    freshProcess()
    setHarness('copilot_cli')
    const again = await toolCall(sid)
    expect(occurrences(again), again).toBe(1)
  })
})

describe('a failure after the claim (H3)', () => {
  it('gives the claim back so a later hook process delivers', async () => {
    setHarness('copilot_cli')
    shimReset(sid)
    failures.startThrowsOnce = true
    const before = deferredCount()
    const first = await toolCall(sid)
    expect(occurrences(first), first).toBe(0)
    expect(deferredCount()).toBe(before)
    expect(claimFileExists(sid)).toBe(false)
    freshProcess()
    setHarness('copilot_cli')
    const retry = await toolCall(sid)
    expect(occurrences(retry), retry).toBe(1)
  })
})
