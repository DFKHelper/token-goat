/** Settle marker for a session-start hook that may have missed its budget. The Copilot shim answers `{}` when the helper outruns its deadline, so the reminder, notes, drift sweep, capsule and update notice vanish with nothing to say so. The helper writes this marker as its last act and clears it as its first, so the first tool call of the session can tell a session start that finished in time from one that was cut off, and deliver what was owed. A marker written within {@link OWED_RESERVE_MS} of the deadline counts as owed too: the shim may have lost the race to publish it. Everything here is best-effort storage; a marker that cannot be read is no marker, which reads as owed. */

import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionStateKey } from './hook_registry.js'
import { stripUnsafeSuggestions } from './hint_suggestion_guard.js'
import { queuePendingContext } from './pending_context.js'
import type { HookEvent } from './hook_registry.js'
import { sessionSidecarPath } from './session_store.js'
import { ensureDirSync } from './util.js'

/** Sidecar suffix of the settle marker. Not `.json`: sessionSidecarPath refuses any other suffix ending in it, so session listings never mistake a sidecar for a session. */
const SETTLED_SUFFIX = '.session-start'

/** Sidecar suffix of the exclusive claim on delivering the owed session start. */
const OWED_CLAIM_SUFFIX = '.session-start-owed'

/** A session start that finished this close to its deadline, or later, is treated as cut off: the shim's own deadline timer and the helper's last write race within this window. */
export const OWED_RESERVE_MS = 1_000

/** What the helper leaves behind when it finishes. `deadlineEpoch` is the shim's deadline as epoch milliseconds, or null when the helper was not started by a deadline-carrying shim. */
export interface SessionStartMarker {
  finishedAtMs: number
  deadlineEpoch: number | null
}

/** Narrow parsed JSON to a marker, or null for any other shape. */
function parseMarker(raw: unknown): SessionStartMarker | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { finishedAtMs, deadlineEpoch } = raw as Record<string, unknown>
  if (typeof finishedAtMs !== 'number' || !Number.isFinite(finishedAtMs)) return null
  if (deadlineEpoch === null) return { finishedAtMs, deadlineEpoch: null }
  if (typeof deadlineEpoch !== 'number' || !Number.isFinite(deadlineEpoch)) return null
  return { finishedAtMs, deadlineEpoch }
}

/** Record that this session start ran to its end. Never throws. */
export function recordSessionStartSettled(event: HookEvent, marker: SessionStartMarker): void {
  const target = sessionSidecarPath(sessionStateKey(event), SETTLED_SUFFIX)
  if (target === null) return
  try {
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify(marker), 'utf8')
  } catch {
    // Best-effort: an unwritten marker reads as owed, which errs toward delivering.
  }
}

/** Remove one sidecar of this session. Never throws. */
function removeSidecar(event: HookEvent, suffix: string): void {
  const target = sessionSidecarPath(sessionStateKey(event), suffix)
  if (target === null) return
  try {
    rmSync(target, { force: true })
  } catch {
    // Best-effort: a sidecar that cannot be removed is overwritten or re-claimed by the next writer.
  }
}

/** Record that a session start began and has not settled: the settle file holds only a begun stamp, which reads as owed until {@link recordSessionStartSettled} replaces it. A previous run's finish is never mistaken for this one's, and a start killed before it settles is still owed. Never throws. */
export function recordSessionStartBegun(event: HookEvent): void {
  const target = sessionSidecarPath(sessionStateKey(event), SETTLED_SUFFIX)
  if (target === null) return
  try {
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify({ begunAtMs: Date.now() }), 'utf8')
  } catch {
    // Best-effort: an unwritten stamp reads as no start began, which delivers nothing.
  }
}

/** Begin a session start of this key: drop the delivery claim an earlier start left and stamp the settle file as begun. The Copilot shim does this in plain JS before it spawns the helper (a helper killed before its own stamp would otherwise leave a stale marker reading settled, or nothing reading as not owed), and tests/session_start_owed_reset.test.ts pins both to the same files. Never throws. */
export function resetSessionStartOwed(event: HookEvent): void {
  recordSessionStartBegun(event)
  removeSidecar(event, OWED_CLAIM_SUFFIX)
}

/** Give back a claim whose delivery failed, so a later hook process retries. Never throws. */
export function releaseOwedSessionStart(event: HookEvent): void {
  removeSidecar(event, OWED_CLAIM_SUFFIX)
}

/** What the settle file of this (sub)agent holds: a settled marker, 'begun' for a file that is present but is not one (a begun stamp, or garbage a killed run left), or null when there is no file. */
export function readSessionStartRecord(event: HookEvent): SessionStartMarker | 'begun' | null {
  const target = sessionSidecarPath(sessionStateKey(event), SETTLED_SUFFIX)
  if (target === null) return null
  let raw: string
  try {
    raw = readFileSync(target, 'utf8')
  } catch {
    return null
  }
  try {
    return parseMarker(JSON.parse(raw)) ?? 'begun'
  } catch {
    return 'begun'
  }
}

/** The settled marker for this (sub)agent, or null when absent, begun-only, unparseable or the wrong shape. */
export function readSessionStartSettled(event: HookEvent): SessionStartMarker | null {
  const record = readSessionStartRecord(event)
  return record === 'begun' ? null : record
}

/** Whether the session start still owes its output. Nothing is owed unless a start began (no file); a begun start that never settled is owed; a settled one is owed only when it finished inside the reserve before the deadline or after it. A marker with no deadline is settled, because nothing was racing. */
export function sessionStartOwed(record: SessionStartMarker | 'begun' | null, _now: number): boolean {
  if (record === null) return false
  if (record === 'begun') return true
  if (record.deadlineEpoch === null) return false
  return record.finishedAtMs > record.deadlineEpoch - OWED_RESERVE_MS
}

/** A claim older than this is taken to belong to a process that died before it delivered. Generous on purpose: a duplicated start costs more than a late one, and a live holder finishes in seconds. */
export const OWED_CLAIM_STALE_MS = 15 * 60_000

/** Exclusive create of the claim file stamped `now`; false when it exists or cannot be written. */
function writeClaimExclusive(target: string, now: number): boolean {
  try {
    writeFileSync(target, JSON.stringify({ claimedAtMs: now }), { encoding: 'utf8', flag: 'wx' })
    return true
  } catch {
    return false
  }
}

/** Sidecar suffix, appended to the claim path, of the mutex that lets one taker at a time judge and replace a stale claim. */
const TAKEOVER_SUFFIX = '.takeover'

/** What a claim file holds: its text and when it was last written. */
interface ClaimFile {
  text: string
  mtimeMs: number
}

function readClaimFile(target: string): ClaimFile | null {
  try {
    return { text: readFileSync(target, 'utf8'), mtimeMs: statSync(target).mtimeMs }
  } catch {
    return null
  }
}

/** Whether a claim belongs to a holder that died before delivering: stamped more than {@link OWED_CLAIM_STALE_MS} before `now`, or empty (a crash between the exclusive create and the write) and last written that long before `now`. A claim stamped delivered is never stale, because the delivery it guards happened. Anything else that is not a claim stamp, or a stamp in the future, is not stale: it is left alone. */
function claimIsStale(claim: ClaimFile, now: number): boolean {
  if (claim.text.trim() === '') return now - claim.mtimeMs > OWED_CLAIM_STALE_MS
  try {
    const stamp = JSON.parse(claim.text) as { claimedAtMs?: unknown; deliveredAtMs?: unknown } | null
    if (typeof stamp?.deliveredAtMs === 'number') return false
    const claimedAtMs = stamp?.claimedAtMs
    return typeof claimedAtMs === 'number' && Number.isFinite(claimedAtMs) && now - claimedAtMs > OWED_CLAIM_STALE_MS
  } catch {
    return false
  }
}

/** Create the takeover mutex exclusively. A mutex whose holder died is cleared once it is older than the bound, and the caller that clears it loses this round. limit: a holder killed mid-takeover blocks every takeover until its mutex ages out revisit-when: stuck owed starts are reported. */
function acquireTakeover(mutex: string, now: number): boolean {
  try {
    writeFileSync(mutex, '', { encoding: 'utf8', flag: 'wx' })
    return true
  } catch {
    try {
      if (now - statSync(mutex).mtimeMs > OWED_CLAIM_STALE_MS) rmSync(mutex, { force: true })
    } catch {
      // Best-effort: a mutex that cannot be inspected or cleared stays, which errs toward no takeover.
    }
    return false
  }
}

/** Replace a stale claim with a fresh one for the caller. One taker at a time holds the takeover mutex; it re-judges the claim it finds, so a claim another taker just replaced is left alone, then overwrites the claim in place. The claim path is never absent, so no third caller can win it with an exclusive create in a gap. */
function takeOverStaleClaim(target: string, now: number): boolean {
  const mutex = `${target}${TAKEOVER_SUFFIX}`
  try {
    const seen = readClaimFile(target)
    if (seen === null || !claimIsStale(seen, now)) return false
    if (!acquireTakeover(mutex, now)) return false
    try {
      const held = readClaimFile(target)
      if (held === null || !claimIsStale(held, now)) return false
      writeFileSync(target, JSON.stringify({ claimedAtMs: now }), 'utf8')
      return true
    } finally {
      try {
        rmSync(mutex, { force: true })
      } catch {
        // A mutex that cannot be removed ages out; it must not turn a won takeover into a refusal.
      }
    }
  } catch {
    return false
  }
}

/** Stamp the claim this caller holds as delivered, so it is never taken for a dead holder's and the start is not delivered again. Only a claim still stamped `now` is touched: one a new start removed and another caller re-created is not ours. Never throws. */
export function markOwedSessionStartDelivered(event: HookEvent, now: number): void {
  const target = sessionSidecarPath(sessionStateKey(event), OWED_CLAIM_SUFFIX)
  if (target === null) return
  try {
    const held = readClaimFile(target)
    if (held === null || (JSON.parse(held.text) as { claimedAtMs?: unknown } | null)?.claimedAtMs !== now) return
    writeFileSync(target, JSON.stringify({ claimedAtMs: now, deliveredAtMs: now }), 'utf8')
  } catch {
    // Best-effort: an unstamped claim ages out as a dead holder's, which delivers again only after the bound.
  }
}

/** Take the one-time right to deliver the owed session start. An exclusive create, so of any number of concurrent callers exactly one gets true. A claim older than {@link OWED_CLAIM_STALE_MS} before `now` that was never stamped delivered (see {@link markOwedSessionStartDelivered}) was left by a process that died before delivering, and is taken over once. False also when the claim cannot be stored: a lost delivery is better than a duplicated one. */
export function claimOwedSessionStart(event: HookEvent, now: number = Date.now()): boolean {
  const target = sessionSidecarPath(sessionStateKey(event), OWED_CLAIM_SUFFIX)
  if (target === null) return false
  try {
    ensureDirSync(dirname(target))
  } catch {
    return false
  }
  return writeClaimExclusive(target, now) || takeOverStaleClaim(target, now)
}

/** The owed text each claim winner holds between producing it and the relay proving it was emitted, keyed by the event object so no other call, in this process or another, can reach it. */
const carriedOwed = new WeakMap<HookEvent, string>()

/** The text the pending-context handler offered for this call, which is what the relay can find in the emitted output: the carried text cut to the queue cap, plus anything queued ahead of it. Without it an owed start over the cap is looked for whole, never found, and queued again, so it is shown twice. */
const offeredOwed = new WeakMap<HookEvent, string>()

/** Hold the owed text for this call alone. It is deliberately not queued: a queued text is visible to a concurrent call that lost the claim, which peeked it before the winner's relay cleared it, and the reminder was then emitted by both. A winner that is killed before its output goes out loses the text by design, because a lost delivery is better than a duplicated one. */
export function carryOwedSessionStart(event: HookEvent, text: string): void {
  carriedOwed.set(event, text.trim())
}

/** Record the text the pending-context handler returned for this call, so {@link requeueUndeliveredOwedSessionStart} looks for what was offered and not for the uncut carried text. */
export function offerOwedSessionStart(event: HookEvent, offered: string): void {
  offeredOwed.set(event, offered)
}

/** The text {@link carryOwedSessionStart} holds for this call, or undefined. */
export function carriedOwedSessionStart(event: HookEvent): string | undefined {
  return carriedOwed.get(event)
}

/** Once the relay knows what it is about to emit: queue the carried text for the next tool call unless the emitted output already carries it. An advisory result can lose to another handler's, and the claim is spent, so without this the owed text would be gone for good. The emitted string is compared the way {@link commitPendingContext} compares it, after the suggestion guard the relay applies, against the text the handler offered. The relay also calls it with null when a step after the handler threw, since nothing was emitted and the claim is spent. Never throws. */
export function requeueUndeliveredOwedSessionStart(event: HookEvent, delivered: string | null): void {
  const carried = carriedOwed.get(event)
  if (carried === undefined) return
  carriedOwed.delete(event)
  const offered = offeredOwed.get(event) ?? carried
  offeredOwed.delete(event)
  if (carried === '') return
  try {
    if (delivered !== null && (delivered.includes(offered) || delivered.includes(stripUnsafeSuggestions(offered)))) return
    queuePendingContext(sessionStateKey(event), carried)
  } catch {
    // Best-effort, as for queuePendingContext: a text that cannot be queued is a lost delivery, never a failed hook.
  }
}
