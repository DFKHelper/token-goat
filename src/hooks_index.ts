/** Dirty-queue management for incremental re-indexing. Ports the `queue/dirty.txt` side of `worker.py::enqueue_dirty` and the pre-compact flush concept. Edited files are appended to the queue by {@link appendDirtyPath} (called from `hooks_edit.ts`); the background indexer (Layer 7) will later drain it. On `pre_compact` this module records the pending paths and clears the queue so the next session starts clean. This module is the read/write/clear surface the hooks and the CLI use; the queue path and the append itself live in dirty_queue.ts (`dirtyQueuePathFor`, `appendDirtyQueuePaths`), so the producers here and the worker's own requeues write the queue through one definition. */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { dataDir } from './constants.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput } from './hooks_common.js'
import { resolveIndexPath } from './paths.js'
import { isUnderSystemTemp } from './project.js'
import { ensureDirSync, atomicWriteBytes } from './util.js'
import type { HookOutput } from './types.js'
import { appendDirtyQueuePaths, dirtyQueuePathFor, getDirtyPathsFor } from './dirty_queue.js'
import { ensureWorkerAlive } from './worker_lifecycle.js'

/** Absolute path to the dirty queue file (`{dataDir}/queue/dirty.txt`). */
export function dirtyQueuePath(): string {
  return dirtyQueuePathFor(dataDir())
}

/** Append every path in `normalizedPaths` to the dirty queue under {@link dataDir}, one newline-terminated path per line, in one filesystem append, through dirty_queue.ts::appendDirtyQueuePaths, which holds the torn-line guard and the recheck against a claim renaming the queue mid-write. Throws when the queue cannot be written, which the edit hook records as a failed append. */
export function appendDirtyPaths(normalizedPaths: string[]): void {
  appendDirtyQueuePaths(dataDir(), normalizedPaths)
}

/** Append `normalizedPath` to the dirty queue, one path per line. The single-path form of {@link appendDirtyPaths}, for its one caller, `hooks_edit.ts`, which needs the throw to record a failed append; every other producer goes through {@link enqueueDirtyPathSafe}, which swallows it. */
export function appendDirtyPath(normalizedPath: string): void {
  appendDirtyPaths([normalizedPath])
  // Deliberately NOT calling worker.ts's clearRetryCount here anymore: doing so unconditionally opened a full DB connection (WAL pragma, schema exec, FTS triggers, sqlite-vec extension load attempt) via getDb() on every single edit hook invocation -- and could even create global.db from scratch if it did not exist yet -- just to run a retry-counter reset that is a no-op for virtually every file. The daemon's own dequeue logic already covers this: every path whose fingerprintFile read succeeds during a drain has its retry_count cleared right there (see processDirtyBatch's clearRetryCount call in worker.ts), so a freshly-edited file gets its retry budget restored automatically the next time it is read successfully -- no separate reset needed on the hot hook path. The only case this trades away is a file whose retry budget was already exhausted from an earlier transient-lock episode AND that fails to fingerprint again on the very first drain immediately following this edit: it will not be requeued that one cycle, but the next edit re-enqueues it and the cycle repeats -- it is never permanently lost, only occasionally slower to recover a mid-collision retry.
}

/** Enqueue `filePath` for background reindexing, never letting a queue-append failure block the write/read it follows. Pass `alreadyResolved: true` when the caller has already run the path through {@link resolveIndexPath} (avoids re-resolving); omitted or `false` resolves it here. A path under the OS temp dir is dropped here, once, for every caller: nothing there should become a permanent index row (see isUnderSystemTemp), and when only the edit hook refused it, shell redirects, `tee` and `sed -i` into scratch files filled one real index with 3,186 of them. */
export function enqueueDirtyPathSafe(filePath: string, opts?: { alreadyResolved?: boolean }): void {
  enqueueDirtyPathsSafe([filePath], opts)
}

/** Batch form of {@link enqueueDirtyPathSafe}: the same `resolveIndexPath` + `isUnderSystemTemp` filter over the whole array, then one queue append and one `ensureWorkerAlive()` for the set rather than one of each per path. `reconcileProject` fans a whole sweep's changed/added/removed set through here. Calling the single-path form in a loop made the append cost grow with the queue it was filling. Returns how many paths reached the queue, which is fewer than were passed whenever the temp-dir filter dropped some and zero when the append failed: a caller reporting a count reports what the worker will drain, not what it offered. */
export function enqueueDirtyPathsSafe(filePaths: string[], opts?: { alreadyResolved?: boolean }): number {
  const resolved: string[] = []
  try {
    for (const filePath of filePaths) {
      const r = opts?.alreadyResolved === true ? filePath : resolveIndexPath(filePath)
      // A path under the OS temp dir is dropped without disqualifying the rest of the batch, and an all-temp batch takes the same early return the single-path form always has: nothing was queued, so there is nothing to wake a worker for.
      if (isUnderSystemTemp(r)) continue
      resolved.push(r)
    }
    if (resolved.length === 0) return 0
    appendDirtyPaths(resolved)
  } catch {
    // Fail-soft: the file write/reparse already landed either way, just not reindexed until the next `token-goat index` or edit touches this file again.
    return 0
  }
  // Every caller of this function just queued work for the background worker to drain -- `hooks_edit.ts` was the only site that ever nudged a dead worker back to life after doing so, so a session driven entirely through the Bash hook's enqueues (`hooks_bash_post.ts` for a HEAD-moving git command, `hooks_bash_commands.ts` for a shell write into a file), the stale-read self-heal (`read_commands.ts::healStaleIndex`), a `--force-refresh` read (`read_outline.ts`, `read_spec.ts`), the fold path's stale-span repair (`fold_delivery.ts`), a CLI write (`cli_file_ops.ts`) or a reconcile sweep (`reconcile.ts`) could fill the dirty queue with nothing running to drain it. Calling it here, at the one choke point every enqueue path already funnels through, covers all of them at once instead of repeating the same nudge at each call site. `ensureWorkerAlive` already gates on `TOKEN_GOAT_NO_WORKER_SPAWN` and rate-limits itself internally, so this is cheap (and test-safe) on every call after the first in a given window.
  try {
    ensureWorkerAlive()
  } catch {
    // Best-effort, same as hooks_edit.ts's own call: a healthcheck failure must never turn a successful enqueue into a thrown error.
  }
  return resolved.length
}

/** Return every queued dirty path, in insertion order, deduplicated. Returns an empty array when the queue file does not exist. Blank lines (from a trailing newline or a partial write) are skipped. Duplicates are collapsed so a file edited several times is reindexed once. */
export function getDirtyPaths(): string[] {
  return getDirtyPathsFor(dataDir())
}

/** Remove the dirty queue file. Idempotent: a missing file is a no-op rather than an error, so callers can clear unconditionally after draining. */
export function clearDirtyQueue(): void {
  try {
    fs.rmSync(dirtyQueuePath(), { force: true })
  } catch {
    // best-effort: a locked/already-removed file should not break compaction
  }
}

/** pre_compact handler: snapshot the dirty queue. Actual reindexing is Layer 7; for now this records the pending paths (via {@link atomicWriteBytes} to a sidecar the indexer can pick up). The live queue is deliberately left intact (see the TOCTOU note in the handler body below) so nothing appended around compaction time is ever dropped. Never blocks: always returns `pass`. */
export function preCompactIndexHandler(_event: HookEvent): HookOutput {
  const paths = getDirtyPaths()
  if (paths.length > 0) {
    // Informational snapshot only — the live queue is never cleared here. Nothing reads this sidecar back; the worker keeps draining queue/dirty.txt on its own cadence, so clearing it at compact time would drop any entry appended around the same moment (a TOCTOU race with appendDirtyPath) with no code left to reindex it.
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

// advisory: this handler is a side-effect-only snapshot writer that always intends to pass through; marking it advisory guarantees runHook never lets a future non-pass return from it suppress another pre_compact handler's output (see hook_registry.ts).
registerHook('pre_compact', preCompactIndexHandler, { advisory: true })
