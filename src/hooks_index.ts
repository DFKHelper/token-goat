/** Dirty-queue management for incremental re-indexing. Ports the `queue/dirty.txt` side of `worker.py::enqueue_dirty` and the pre-compact flush concept. Edited files are appended to the queue by {@link appendDirtyPath} (called from `hooks_edit.ts`); the background indexer (Layer 7) will later drain it. On `pre_compact` this module records the pending paths and clears the queue so the next session starts clean. This module owns the queue file path and its read/write/clear surface so the writer (`hooks_edit.ts`) and the drainer share one definition rather than duplicating the path join. */

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
import { encodeDirtyQueueLine, ensureWorkerAlive, parseDirtyQueueLines } from './worker.js'

/** Absolute path to the dirty queue file (`{dataDir}/queue/dirty.txt`). */
export function dirtyQueuePath(): string {
  return path.join(dataDir(), 'queue', 'dirty.txt')
}

/** Guard against a torn last line left by a previous crashed write: if the queue file already exists and does not end in a newline, the next append has to start with one so the partial line never merges with the appended path into a single garbage entry. Answers that question from the file's size and its final byte alone. Reading the whole file to look at one byte made every append cost the length of the queue, so enqueueing N paths read 1 + 2 + ... + N lines -- quadratic on a queue that routinely reaches four figures at session start. */
function dirtyQueueLeadingNewline(queuePath: string): string {
  let fd: number | undefined
  try {
    const size = fs.statSync(queuePath).size
    if (size === 0) return ''
    fd = fs.openSync(queuePath, 'r')
    const tail = Buffer.allocUnsafe(1)
    fs.readSync(fd, tail, 0, 1, size - 1)
    return tail[0] === 0x0a ? '' : '\n'
  } catch {
    // File doesn't exist yet (first append) -- nothing to guard against.
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Nothing to do about a failed close of a read-only handle.
      }
    }
  }
}

/** Append every path in `normalizedPaths` to the dirty queue, one path per line, in one filesystem append. Creates the `queue/` directory and the file on first use. Uses append mode so concurrent edits accumulate; a trailing newline terminates each entry so {@link getDirtyPaths} can split cleanly. The torn-line guard is consulted once for the whole batch, which is correct because the batch is written as a single append: only the first line of it can ever meet a partial line. The worker claims the queue by renaming it, and a handle opened before that rename still writes into the renamed file, which the worker deletes once it has read it a last time. A write landing after that read went out with the delete. So each append checks, after writing, that the file it wrote is still the one named `dirty.txt`, and writes again if a claim took it: from that point on the path is in a file the worker has yet to claim. A duplicate costs the drain one unchanged-sha skip. */
export function appendDirtyPaths(normalizedPaths: string[]): void {
  if (normalizedPaths.length === 0) return
  const queuePath = dirtyQueuePath()
  const dir = path.dirname(queuePath)
  try {
    ensureDirSync(dir)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.existsSync(dir)) throw e
  }
  const body = normalizedPaths.map((p) => `${encodeDirtyQueueLine(p)}\n`).join('')
  for (let attempt = 0; attempt < 3; attempt++) {
    if (appendToLiveQueue(queuePath, `${dirtyQueueLeadingNewline(queuePath)}${body}`)) return
  }
}

/** Append `data` to `queuePath` and report whether the file written is still the one at that path afterwards. Compared by inode alone: some Windows Node versions report a device number of 0 from a path stat and the volume serial from a descriptor stat of the same file. */
function appendToLiveQueue(queuePath: string, data: string): boolean {
  const fd = fs.openSync(queuePath, 'a')
  try {
    fs.writeFileSync(fd, data)
    return fs.statSync(queuePath, { bigint: true, throwIfNoEntry: false })?.ino === fs.fstatSync(fd, { bigint: true }).ino
  } finally {
    fs.closeSync(fd)
  }
}

/** Append `normalizedPath` to the dirty queue, one path per line. The single-path form of {@link appendDirtyPaths}, kept for the one-at-a-time callers (`hooks_edit.ts` and the CLI write paths). */
export function appendDirtyPath(normalizedPath: string): void {
  appendDirtyPaths([normalizedPath])
  // Deliberately NOT calling worker.ts's clearRetryCount here anymore: doing so unconditionally opened a full DB connection (WAL pragma, schema exec, FTS triggers, sqlite-vec extension load attempt) via getDb() on every single edit hook invocation -- and could even create global.db from scratch if it did not exist yet -- just to run a retry-counter reset that is a no-op for virtually every file. The daemon's own dequeue logic already covers this: every path whose fingerprintFile read succeeds during a drain has its retry_count cleared right there (see processDirtyBatch's clearRetryCount call in worker.ts), so a freshly-edited file gets its retry budget restored automatically the next time it is read successfully -- no separate reset needed on the hot hook path. The only case this trades away is a file whose retry budget was already exhausted from an earlier transient-lock episode AND that fails to fingerprint again on the very first drain immediately following this edit: it will not be requeued that one cycle, but the next edit re-enqueues it and the cycle repeats -- it is never permanently lost, only occasionally slower to recover a mid-collision retry.
}

/** Enqueue `filePath` for background reindexing, never letting a queue-append failure block the write/read it follows. Pass `alreadyResolved: true` when the caller has already run the path through {@link resolveIndexPath} (avoids re-resolving); omitted or `false` resolves it here. A path under the OS temp dir is dropped here, once, for every caller: nothing there should become a permanent index row (see isUnderSystemTemp), and when only the edit hook refused it, shell redirects, `tee` and `sed -i` into scratch files filled one real index with 3,186 of them. */
export function enqueueDirtyPathSafe(filePath: string, opts?: { alreadyResolved?: boolean }): void {
  enqueueDirtyPathsSafe([filePath], opts)
}

/** Batch form of {@link enqueueDirtyPathSafe}: the same `resolveIndexPath` + `isUnderSystemTemp` filter over the whole array, then one queue append and one `ensureWorkerAlive()` for the set rather than one of each per path. `reconcileProject` fans a whole sweep's changed/added/removed set through here. Calling the single-path form in a loop made the append cost grow with the queue it was filling. */
export function enqueueDirtyPathsSafe(filePaths: string[], opts?: { alreadyResolved?: boolean }): void {
  try {
    const resolved: string[] = []
    for (const filePath of filePaths) {
      const r = opts?.alreadyResolved === true ? filePath : resolveIndexPath(filePath)
      // A path under the OS temp dir is dropped without disqualifying the rest of the batch, and an all-temp batch takes the same early return the single-path form always has: nothing was queued, so there is nothing to wake a worker for.
      if (isUnderSystemTemp(r)) continue
      resolved.push(r)
    }
    if (resolved.length === 0) return
    appendDirtyPaths(resolved)
  } catch {
    // Fail-soft: the file write/reparse already landed either way, just not reindexed until the next `token-goat index` or edit touches this file again.
    return
  }
  // Every caller of this function just queued work for the background worker to drain -- `hooks_edit.ts` was the only site that ever nudged a dead worker back to life after doing so, so a session driven entirely through the Bash hook's rewrite enqueues (`hooks_bash.ts`), the stale-read self-heal (`read_commands.ts::healStaleIndex`), or a plain CLI append (`cli.ts`, `fold_delivery.ts`, `reconcile.ts`) could fill the dirty queue with nothing running to drain it. Calling it here, at the one choke point every enqueue path already funnels through, covers all of them at once instead of repeating the same nudge at each call site. `ensureWorkerAlive` already gates on `TOKEN_GOAT_NO_WORKER_SPAWN` and rate-limits itself internally, so this is cheap (and test-safe) on every call after the first in a given window.
  try {
    ensureWorkerAlive()
  } catch {
    // Best-effort, same as hooks_edit.ts's own call: a healthcheck failure must never turn a successful enqueue into a thrown error.
  }
}

/** Return every queued dirty path, in insertion order, deduplicated. Returns an empty array when the queue file does not exist. Blank lines (from a trailing newline or a partial write) are skipped. Duplicates are collapsed so a file edited several times is reindexed once. */
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
