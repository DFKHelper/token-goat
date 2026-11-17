/** HAND-DERIVED: claim files are planted by hand as `{claimedAtMs}` at a fixed epoch, and every instant is a literal passed in as `now`; no real clock is read. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'
import { utimesSync } from 'node:fs'
import { afterEach, vi } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { relayInProcess } from '../src/relay.js'
import { clearPerRequestCaches } from '../src/reset.js'
import { OWED_CLAIM_STALE_MS, claimOwedSessionStart, releaseOwedSessionStart, resetSessionStartOwed } from '../src/session_start_owed.js'
import { sessionSidecarPath } from '../src/session_store.js'

const CLAIMED_AT = 1_700_000_000_000
let counter = 0

function freshEvent(): HookEvent {
  counter += 1
  return { eventName: 'pre_tool_use', toolName: 'Read', toolInput: {}, sessionId: `claim-expiry-${process.pid}-${counter}-${Math.random().toString(36).slice(2)}`, agentId: undefined, raw: {} }
}

function claimPath(event: HookEvent): string {
  const path = sessionSidecarPath(event.sessionId as string, '.session-start-owed')
  expect(path).not.toBeNull()
  return path as string
}

function plantClaim(event: HookEvent, body: string): string {
  const path = claimPath(event)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

describe('an owed-start claim whose holder never delivered', () => {
  it('is taken over once older than the bound, and delivered to exactly one caller', () => {
    const event = freshEvent()
    plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT }))
    const now = CLAIMED_AT + OWED_CLAIM_STALE_MS + 1
    expect([claimOwedSessionStart(event, now), claimOwedSessionStart(event, now)]).toEqual([true, false])
    expect(JSON.parse(readFileSync(claimPath(event), 'utf8'))).toEqual({ claimedAtMs: now })
  })

  it('is left alone while younger than the bound', () => {
    const event = freshEvent()
    const path = plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT }))
    expect(claimOwedSessionStart(event, CLAIMED_AT + OWED_CLAIM_STALE_MS - 1)).toBe(false)
    expect(claimOwedSessionStart(event, CLAIMED_AT + OWED_CLAIM_STALE_MS)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ claimedAtMs: CLAIMED_AT })
  })

  it('is left alone when the stamp is in the future or the file is not a claim', () => {
    for (const body of [JSON.stringify({ claimedAtMs: CLAIMED_AT + 10 * OWED_CLAIM_STALE_MS }), '', 'garbage', '{}', JSON.stringify({ claimedAtMs: 'x' })]) {
      const event = freshEvent()
      const path = plantClaim(event, body)
      expect(claimOwedSessionStart(event, CLAIMED_AT + 10 * OWED_CLAIM_STALE_MS - 1)).toBe(false)
      expect(readFileSync(path, 'utf8')).toBe(body)
    }
  })

  it('keeps one winner among many concurrent takers of a stale claim', async () => {
    const event = freshEvent()
    plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT }))
    const now = CLAIMED_AT + 2 * OWED_CLAIM_STALE_MS
    const results = await Promise.all(Array.from({ length: 8 }, async () => claimOwedSessionStart(event, now)))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('can be released and claimed again after a takeover', () => {
    const event = freshEvent()
    plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT }))
    expect(claimOwedSessionStart(event, CLAIMED_AT + 2 * OWED_CLAIM_STALE_MS)).toBe(true)
    releaseOwedSessionStart(event)
    expect(existsSync(claimPath(event))).toBe(false)
    expect(claimOwedSessionStart(event, CLAIMED_AT)).toBe(true)
  })
})

// HAND-DERIVED (rows below): the delivered-claim, takeover-marker and empty-claim states are planted by hand from the module's own contract (a claim file, its `.takeover` sibling, an mtime set with utimesSync); every instant is a literal and the relay row freezes Date with fake timers, so no real clock decides a result.
const REMINDER_PHRASE = 'must outlive a compaction'

function occurrences(text: string): number {
  return text.split(REMINDER_PHRASE).length - 1
}

describe('a delivered owed start is never delivered again (SMR-1)', () => {
  const savedHarness = process.env['TOKEN_GOAT_HARNESS_OVERRIDE']

  afterEach(() => {
    vi.useRealTimers()
    if (savedHarness === undefined) delete process.env['TOKEN_GOAT_HARNESS_OVERRIDE']
    else process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = savedHarness
    clearPerRequestCaches()
  })

  it('through the real relay, delivers once and nothing at 0x, 1x, 2x or 10x the claim bound afterwards', async () => {
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'copilot_cli'
    clearPerRequestCaches()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(CLAIMED_AT)
    const event = freshEvent()
    const sid = event.sessionId
    resetSessionStartOwed(event)
    const toolCall = async (): Promise<string> => relayInProcess('post_tool_use', { session_id: sid, tool_name: 'TgDeliveredProbe', tool_input: {}, tool_response: { output: 'raw' } })
    const first = await toolCall()
    expect(occurrences(first), first).toBe(1)
    for (const factor of [0, 1, 2, 10]) {
      vi.setSystemTime(CLAIMED_AT + factor * OWED_CLAIM_STALE_MS + 1)
      const later = await toolCall()
      expect(occurrences(later), `call at ${factor}x the bound redelivered the owed start`).toBe(0)
    }
  })

  it('treats a claim stamped delivered as never stale, however old', () => {
    const event = freshEvent()
    plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT, deliveredAtMs: CLAIMED_AT + 5 }))
    for (const factor of [1, 2, 10]) expect(claimOwedSessionStart(event, CLAIMED_AT + factor * OWED_CLAIM_STALE_MS + 1), `${factor}x`).toBe(false)
  })
})

describe('a takeover in progress is never raced (SMR-2)', () => {
  it('lets no other caller win while one taker holds the takeover, and leaves the claim in place', () => {
    const event = freshEvent()
    const stale = JSON.stringify({ claimedAtMs: CLAIMED_AT })
    const path = plantClaim(event, stale)
    writeFileSync(`${path}.takeover`, '', 'utf8')
    const now = CLAIMED_AT + 2 * OWED_CLAIM_STALE_MS
    expect([claimOwedSessionStart(event, now), claimOwedSessionStart(event, now)], 'a taker mid-takeover must be the only one who can win').toEqual([false, false])
    expect(readFileSync(path, 'utf8')).toBe(stale)
  })

  it('delivers exactly once across sequential takers and keeps the claim path present', () => {
    const event = freshEvent()
    const path = plantClaim(event, JSON.stringify({ claimedAtMs: CLAIMED_AT }))
    const now = CLAIMED_AT + 2 * OWED_CLAIM_STALE_MS
    const results: boolean[] = []
    for (let i = 0; i < 3; i++) {
      results.push(claimOwedSessionStart(event, now))
      expect(existsSync(path), `claim path absent after caller ${i}`).toBe(true)
    }
    expect(results).toEqual([true, false, false])
    expect(existsSync(`${path}.takeover`), 'the takeover marker is orphaned').toBe(false)
  })
})

describe('an empty claim file is judged by its mtime (SMR-3)', () => {
  const MTIME_S = 1_700_000_000

  it('is recovered and delivered once when older than the bound', () => {
    const event = freshEvent()
    const path = plantClaim(event, '')
    utimesSync(path, MTIME_S, MTIME_S)
    const now = MTIME_S * 1000 + OWED_CLAIM_STALE_MS + 1
    expect([claimOwedSessionStart(event, now), claimOwedSessionStart(event, now)]).toEqual([true, false])
  })

  it('is left alone while fresh', () => {
    const event = freshEvent()
    const path = plantClaim(event, '')
    utimesSync(path, MTIME_S, MTIME_S)
    expect(claimOwedSessionStart(event, MTIME_S * 1000 + 1)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('')
  })
})
