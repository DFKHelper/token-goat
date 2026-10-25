/** What session start remembers per project, in the reconcile_cursor table under the root, a NUL and a word (`swept`, `slowlist`), so index_prune.ts removes the rows with the project: a recent complete sweep, and a listing known to be slow. */

import { globalDbPath } from './constants.js'
import { getDb } from './db.js'
import { envInt } from './env.js'

/** How long a complete sweep stands in for a new one at session start. */
export const SESSION_SWEEP_REUSE_MS = 5 * 60 * 1000

/** How long a project whose listing missed the deadline goes straight to the worker. */
export const SLOW_LISTING_MEMORY_MS = 60 * 60 * 1000

// Named here rather than in constants.ts, which feeds the parser fingerprint.
const MEMORY_OVERRIDE_ENV = 'TOKEN_GOAT_RECONCILE_MEMORY_MS'

const SWEPT = 'swept'
const SLOW_LISTING = 'slowlist'

function keyOf(projectRoot: string, word: string): string {
  return `${projectRoot}\u0000${word}`
}

/** Best-effort: a failed write only means the next session decides without this fact. */
function writeMark(dbPath: string, projectRoot: string, word: string, nowMs: number): void {
  try {
    getDb(dbPath)
      .prepare(
        'INSERT INTO reconcile_cursor (root, last_scanned_path, updated_at) VALUES (?, ?, ?) ON CONFLICT(root) DO UPDATE SET last_scanned_path = excluded.last_scanned_path, updated_at = excluded.updated_at',
      )
      .run(keyOf(projectRoot, word), '', nowMs)
  } catch {
    // Best-effort, see the doc comment above.
  }
}

/** The window a mark counts for: `windowMs`, or the value of TOKEN_GOAT_RECONCILE_MEMORY_MS when set (0 makes every session start sweep and list for itself). */
function windowFor(windowMs: number): number {
  return envInt(MEMORY_OVERRIDE_ENV, windowMs, 0, 24 * 60 * 60 * 1000)
}

/** Whether the mark is younger than the window; missing, unreadable or future-dated reads false so the work is done. */
function markIsFresh(dbPath: string, projectRoot: string, word: string, windowMs: number, nowMs: number): boolean {
  try {
    const row = getDb(dbPath).prepare('SELECT updated_at FROM reconcile_cursor WHERE root = ?').get(keyOf(projectRoot, word)) as { updated_at: number } | undefined
    if (row === undefined) return false
    const age = nowMs - row.updated_at
    return age >= 0 && age < windowFor(windowMs)
  } catch {
    return false
  }
}

/** Record that a sweep of `projectRoot` finished a full lap at `nowMs`. */
export function writeSweepStamp(dbPath: string, projectRoot: string, nowMs: number = Date.now()): void {
  writeMark(dbPath, projectRoot, SWEPT, nowMs)
}

/** Whether a complete sweep of `projectRoot` finished within {@link SESSION_SWEEP_REUSE_MS} before `nowMs`. */
export function sweptRecently(projectRoot: string, dbPath: string = globalDbPath(), nowMs: number = Date.now()): boolean {
  return markIsFresh(dbPath, projectRoot, SWEPT, SESSION_SWEEP_REUSE_MS, nowMs)
}

/** Record that `git ls-files` in `projectRoot` missed the session-start deadline at `nowMs`. */
export function markListingSlow(projectRoot: string, dbPath: string = globalDbPath(), nowMs: number = Date.now()): void {
  writeMark(dbPath, projectRoot, SLOW_LISTING, nowMs)
}

/** Whether a listing of `projectRoot` missed the deadline within {@link SLOW_LISTING_MEMORY_MS} before `nowMs`. */
export function listingKnownSlow(projectRoot: string, dbPath: string = globalDbPath(), nowMs: number = Date.now()): boolean {
  return markIsFresh(dbPath, projectRoot, SLOW_LISTING, SLOW_LISTING_MEMORY_MS, nowMs)
}

/** Forget a slow listing once one finishes inside the deadline. */
export function clearListingSlow(projectRoot: string, dbPath: string = globalDbPath()): void {
  try {
    getDb(dbPath).prepare('DELETE FROM reconcile_cursor WHERE root = ?').run(keyOf(projectRoot, SLOW_LISTING))
  } catch {
    // Best-effort: the mark ages out on its own.
  }
}
