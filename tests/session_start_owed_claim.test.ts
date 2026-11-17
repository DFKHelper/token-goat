/** HAND-DERIVED: claim files are planted by hand as `{claimedAtMs}` at a fixed epoch, and every instant is a literal passed in as `now`; no real clock is read. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { HookEvent } from '../src/hook_registry.js'
import { OWED_CLAIM_STALE_MS, claimOwedSessionStart, releaseOwedSessionStart } from '../src/session_start_owed.js'
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
