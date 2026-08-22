/**
 * Dirty-queue management for incremental re-indexing.
 *
 * Ports the `queue/dirty.txt` side of `worker.py::enqueue_dirty` and the
 * pre-compact flush concept. Edited files are appended to the queue by
 * {@link appendDirtyPath} (called from `hooks_edit.ts`); the background indexer
 * (Layer 7) will later drain it. On `pre_compact` this module records the
 * pending paths and clears the queue so the next session starts clean.
 *
 * This module owns the queue file path and its read/write/clear surface so the
 * writer (`hooks_edit.ts`) and the drainer share one definition rather than
 * duplicating the path join.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir } from './constants.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput } from './hooks_common.js'
import { resolveIndexPath } from './paths.js'
import { ensureDirSync, atomicWriteBytes } from './util.js'
import type { HookOutput } from './types.js'
import { encodeDirtyQueueLine, parseDirtyQueueLines } from './worker.js'

/** Absolute path to the dirty queue file (`{dataDir}/queue/dirty.txt`). */
export function dirtyQueuePath(): string {
  return path.join(dataDir(), 'queue', 'dirty.txt')
}

/**
 * Append `normalizedPath` to the dirty queue, one path per line.
 *
 * Creates the `queue/` directory and the file on first use. Uses append mode
 * so concurrent edits accumulate; a trailing newline terminates each entry so
 * {@link getDirtyPaths} can split cleanly.
 */
export function appendDirtyPath(normalizedPath: string): void {
  const queuePath = dirtyQueuePath()
  const dir = path.dirname(queuePath)
  try {
    ensureDirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }
  // Guard against a torn last line left by a previous crashed write: if the queue file already
  // exists and does not end in a newline, start this append with one so the partial line never
  // merges with the new path into a single garbage entry.
  let leadingNewline = ''
  try {
    const existing = fs.readFileSync(queuePath, 'utf8')
    if (existing.length > 0 && !existing.endsWith('\n')) leadingNewline = '\n'
  } catch {
    // File doesn't exist yet (first append) -- nothing to guard against.
  }
  fs.appendFileSync(queuePath, `${leadingNewline}${encodeDirtyQueueLine(normalizedPath)}\n`)
  // Deliberately NOT calling worker.ts's clearRetryCount here anymore: doing so unconditionally
  // opened a full DB connection (WAL pragma, schema exec, FTS triggers, sqlite-vec extension
  // load attempt) via getDb() on every single edit hook invocation -- and could even create
  // global.db from scratch if it did not exist yet -- just to run a retry-counter reset that is
  // a no-op for virtually every file. The daemon's own dequeue logic already covers this: every
  // path whose fingerprintFile read succeeds during a drain has its retry_count cleared right
  // there (see processDirtyBatch's clearRetryCount call in worker.ts), so a freshly-edited file
  // gets its retry budget restored automatically the next time it is read successfully -- no
  // separate reset needed on the hot hook path. The only case this trades away is a file whose
  // retry budget was already exhausted from an earlier transient-lock episode AND that fails to
  // fingerprint again on the very first drain immediately following this edit: it will not be
  // requeued that one cycle, but the next edit re-enqueues it and the cycle repeats -- it is
  // never permanently lost, only occasionally slower to recover a mid-collision retry.
}

/**
 * Enqueue `filePath` for background reindexing, never letting a queue-append failure block the
 * write/read it follows. Pass `alreadyResolved: true` when the caller has already run the path
 * through {@link resolveIndexPath} (avoids re-resolving); omitted or `false` resolves it here.
 */
export function enqueueDirtyPathSafe(filePath: string, opts?: { alreadyResolved?: boolean }): void {
  try {
    appendDirtyPath(opts?.alreadyResolved === true ? filePath : resolveIndexPath(filePath))
  } catch {
    // Fail-soft: the file write/reparse already landed either way, just not reindexed until the
    // next `token-goat index` or edit touches this file again.
  }
}

/**
 * Return every queued dirty path, in insertion order, deduplicated.
 *
 * Returns an empty array when the queue file does not exist. Blank lines (from
 * a trailing newline or a partial write) are skipped. Duplicates are collapsed
 * so a file edited several times is reindexed once.
 */
export function getDirtyPaths(): string[] {
  const queuePath = dirtyQueuePath()
  let raw: string
  try {
    raw = fs.readFileSync(queuePath, 'utf8')
  } catch {
    return []
  }
  return parseDirtyQueueLines(raw)
}

/**
 * Remove the dirty queue file.
 *
 * Idempotent: a missing file is a no-op rather than an error, so callers can
 * clear unconditionally after draining.
 */
export function clearDirtyQueue(): void {
  try {
    fs.rmSync(dirtyQueuePath(), { force: true })
  } catch {
    // best-effort: a locked/already-removed file should not break compaction
  }
}

/**
 * pre_compact handler: snapshot the dirty queue.
 *
 * Actual reindexing is Layer 7; for now this records the pending paths (via
 * {@link atomicWriteBytes} to a sidecar the indexer can pick up). The live
 * queue is deliberately left intact (see the TOCTOU note in the handler body
 * below) so nothing appended around compaction time is ever dropped. Never
 * blocks: always returns `pass`.
 */
export function preCompactIndexHandler(_event: HookEvent): HookOutput {
  const paths = getDirtyPaths()
  if (paths.length > 0) {
    // Informational snapshot only — the live queue is never cleared here. Nothing reads
    // this sidecar back; the worker keeps draining queue/dirty.txt on its own cadence, so
    // clearing it at compact time would drop any entry appended around the same moment
    // (a TOCTOU race with appendDirtyPath) with no code left to reindex it.
    const sidecar = path.join(dataDir(), 'queue', 'pending.txt')
    try {
      ensureDirSync(path.dirname(sidecar))
      atomicWriteBytes(sidecar, Buffer.from(`${paths.join('\n')}\n`, 'utf8'))
    } catch {
      // best-effort snapshot; failures here must never affect the live queue
    }
  }
  return passOutput()
}

// advisory: this handler is a side-effect-only snapshot writer that always intends to
// pass through; marking it advisory guarantees runHook never lets a future non-pass
// return from it suppress another pre_compact handler's output (see hook_registry.ts).
registerHook('pre_compact', preCompactIndexHandler, { advisory: true })
