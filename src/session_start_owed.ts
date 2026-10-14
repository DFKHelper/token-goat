/** Settle marker for a session-start hook that may have missed its budget. The Copilot shim answers `{}` when the helper outruns its deadline, so the reminder, notes, drift sweep, capsule and update notice vanish with nothing to say so. The helper writes this marker as its last act and clears it as its first, so the first tool call of the session can tell a session start that finished in time from one that was cut off, and deliver what was owed. A marker written within {@link OWED_RESERVE_MS} of the deadline counts as owed too: the shim may have lost the race to publish it. Everything here is best-effort storage; a marker that cannot be read is no marker, which reads as owed. */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { sessionStateKey } from './hook_registry.js'
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

/** Take the one-time right to deliver the owed session start. An exclusive create, so of any number of concurrent callers exactly one gets true. False also when the claim cannot be stored: a lost delivery is better than a duplicated one. */
export function claimOwedSessionStart(event: HookEvent): boolean {
  const target = sessionSidecarPath(sessionStateKey(event), OWED_CLAIM_SUFFIX)
  if (target === null) return false
  try {
    ensureDirSync(dirname(target))
    writeFileSync(target, JSON.stringify({ claimedAtMs: Date.now() }), { encoding: 'utf8', flag: 'wx' })
    return true
  } catch {
    return false
  }
}
