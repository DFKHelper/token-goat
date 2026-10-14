import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { sessionSidecarPath } from '../src/session_store.js'
import { sessionStartMayBeDeferred } from '../src/harness_channels.js'
import { sessionStartHandler } from '../src/hooks_session_start.js'
import {
  claimOwedSessionStart,
  readSessionStartRecord,
  recordSessionStartBegun,
  readSessionStartSettled,
  recordSessionStartSettled,
  sessionStartOwed,
} from '../src/session_start_owed.js'
import { sessionStateKey } from '../src/hook_registry.js'
import type { HookEvent } from '../src/hook_registry.js'

// Provenance: every row is HAND-DERIVED. Epochs are picked by hand against the rule in DESIGN.md section 2.1 (owed iff finishedAtMs > deadlineEpoch - 1000, or no marker) and are not read off the implementation. No wire format is involved.

const DEADLINE = 1_800_000_000_000
const DEADLINE_ENV = 'TG_SESSION_START_DEADLINE_EPOCH'

function makeEvent(sessionId: string, agentId?: string): HookEvent {
  return {
    eventName: 'session_start',
    toolName: undefined,
    toolInput: {},
    sessionId,
    agentId,
    raw: {},
  }
}

let sid: string
let cwd: string
let savedDeadline: string | undefined

beforeEach(() => {
  sid = `owed-${randomUUID()}`
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-owed-'))
  savedDeadline = process.env[DEADLINE_ENV]
})

afterEach(() => {
  if (savedDeadline === undefined) delete process.env[DEADLINE_ENV]
  else process.env[DEADLINE_ENV] = savedDeadline
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe('sessionStartOwed (R3)', () => {
  it('is owed when the run finished 500 ms before the deadline', () => {
    expect(sessionStartOwed({ finishedAtMs: DEADLINE - 500, deadlineEpoch: DEADLINE }, DEADLINE)).toBe(true)
  })

  it('is owed when the run finished after the deadline', () => {
    expect(sessionStartOwed({ finishedAtMs: DEADLINE + 10, deadlineEpoch: DEADLINE }, DEADLINE)).toBe(true)
  })

  it('is settled when the run finished 2000 ms before the deadline', () => {
    expect(sessionStartOwed({ finishedAtMs: DEADLINE - 2000, deadlineEpoch: DEADLINE }, DEADLINE)).toBe(false)
  })

  it('is settled exactly on the reserve edge (1000 ms before), since the rule is strict', () => {
    expect(sessionStartOwed({ finishedAtMs: DEADLINE - 1000, deadlineEpoch: DEADLINE }, DEADLINE)).toBe(false)
  })

  it('is not owed when no start began (no settle file at all)', () => {
    expect(sessionStartOwed(null, DEADLINE)).toBe(false)
  })

  it('is owed for a start that began and never settled', () => {
    expect(sessionStartOwed('begun', DEADLINE)).toBe(true)
  })

  it('is owed when the marker file on disk is garbage', () => {
    const target = sessionSidecarPath(sessionStateKey(makeEvent(sid)), '.session-start')
    expect(target).not.toBeNull()
    fs.mkdirSync(path.dirname(target as string), { recursive: true })
    for (const body of ['not json {', '[1,2]', '{"finishedAtMs":"soon","deadlineEpoch":null}', '{"finishedAtMs":1}', '{"finishedAtMs":1,"deadlineEpoch":"x"}', 'null']) {
      fs.writeFileSync(target as string, body, 'utf8')
      expect(readSessionStartSettled(makeEvent(sid)), body).toBeNull()
      const record = readSessionStartRecord(makeEvent(sid))
      expect(record, body).toBe('begun')
      expect(sessionStartOwed(record, DEADLINE), body).toBe(true)
    }
  })
})

describe('marker storage', () => {
  it('round-trips a marker and clears it', () => {
    const event = makeEvent(sid)
    recordSessionStartSettled(event, { finishedAtMs: 5, deadlineEpoch: null })
    expect(readSessionStartSettled(event)).toEqual({ finishedAtMs: 5, deadlineEpoch: null })
    recordSessionStartBegun(event)
    expect(readSessionStartSettled(event)).toBeNull()
    expect(readSessionStartRecord(event)).toBe('begun')
  })
})

describe('claimOwedSessionStart', () => {
  it('gives exactly one winner across sequential calls', () => {
    const event = makeEvent(sid)
    expect([claimOwedSessionStart(event), claimOwedSessionStart(event)]).toEqual([true, false])
  })

  it('gives exactly one winner across many concurrent callers', async () => {
    const event = makeEvent(sid)
    const results = await Promise.all(Array.from({ length: 8 }, async () => claimOwedSessionStart(event)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('keeps a subagent claim apart from its parent claim', () => {
    expect(claimOwedSessionStart(makeEvent(sid))).toBe(true)
    expect(claimOwedSessionStart(makeEvent(sid, 'child'))).toBe(true)
  })
})

describe('sessionStartHandler leaves the settle marker (R4)', () => {
  it('writes finishedAtMs and the env deadline on the real handler path', async () => {
    process.env[DEADLINE_ENV] = String(DEADLINE)
    const event: HookEvent = { ...makeEvent(sid), raw: { cwd } }
    const before = Date.now()
    await sessionStartHandler(event)
    const marker = readSessionStartSettled(event)
    expect(marker).not.toBeNull()
    expect(marker?.finishedAtMs).toBeGreaterThanOrEqual(before)
    expect(marker?.deadlineEpoch).toBe(DEADLINE)
    const target = sessionSidecarPath(sessionStateKey(event), '.session-start')
    expect(fs.existsSync(target as string)).toBe(true)
  })

  it('records a null deadline when the env var is absent or invalid', async () => {
    for (const value of [undefined, '', 'soon', '-5']) {
      if (value === undefined) delete process.env[DEADLINE_ENV]
      else process.env[DEADLINE_ENV] = value
      const event: HookEvent = { ...makeEvent(`${sid}-${String(value)}`), raw: { cwd } }
      await sessionStartHandler(event)
      expect(readSessionStartSettled(event)?.deadlineEpoch, String(value)).toBeNull()
    }
  })

  it('replaces a stale marker rather than keeping it', async () => {
    const event: HookEvent = { ...makeEvent(sid), raw: { cwd } }
    recordSessionStartSettled(event, { finishedAtMs: 1, deadlineEpoch: null })
    await sessionStartHandler(event)
    expect(readSessionStartSettled(event)?.finishedAtMs).toBeGreaterThan(1)
  })

  it('does not show a subagent its parent marker', async () => {
    const parent: HookEvent = { ...makeEvent(sid), raw: { cwd } }
    await sessionStartHandler(parent)
    expect(readSessionStartSettled(parent)).not.toBeNull()
    expect(readSessionStartSettled(makeEvent(sid, 'child'))).toBeNull()
  })
})

describe('sessionStartMayBeDeferred', () => {
  it('is true for copilot_cli and vscode only', () => {
    expect(sessionStartMayBeDeferred('copilot_cli')).toBe(true)
    expect(sessionStartMayBeDeferred('vscode')).toBe(true)
    for (const host of ['claudecode', 'codex', 'opencode', 'unknown', '']) {
      expect(sessionStartMayBeDeferred(host), host).toBe(false)
    }
  })
})
