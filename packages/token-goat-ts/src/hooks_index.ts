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
import { atomicWriteBytes } from './util.js'
import type { HookOutput } from './types.js'

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
  fs.mkdirSync(path.dirname(queuePath), { recursive: true })
  fs.appendFileSync(queuePath, `${normalizedPath}\n`)
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
  const seen = new Set<string>()
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
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
 * pre_compact handler: snapshot the dirty queue and clear it.
 *
 * Actual reindexing is Layer 7; for now this records the pending paths (via
 * {@link atomicWriteBytes} to a sidecar the indexer can pick up) and clears the
 * live queue so the post-compact session starts fresh. Never blocks: always
 * returns `pass`.
 */
export function preCompactIndexHandler(_event: HookEvent): HookOutput {
  const paths = getDirtyPaths()
  if (paths.length > 0) {
    const sidecar = path.join(dataDir(), 'queue', 'pending.txt')
    try {
      fs.mkdirSync(path.dirname(sidecar), { recursive: true })
      atomicWriteBytes(sidecar, Buffer.from(`${paths.join('\n')}\n`, 'utf8'))
    } catch {
      // best-effort snapshot; clearing below is the load-bearing step
    }
    clearDirtyQueue()
  }
  return passOutput()
}

registerHook('pre_compact', preCompactIndexHandler)
