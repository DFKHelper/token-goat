/**
 * post_tool_use edit hooks (Write / Edit / NotebookEdit).
 *
 * Ports `hooks_edit.py::post_edit`: after a successful Write/Edit/NotebookEdit,
 * record the file in the session cache and append it to the dirty queue so the
 * background indexer (Layer 7) reindexes only what changed. Never blocks an
 * edit — returns `context` for markdown files (with a section hint) or `pass`
 * for others.
 *
 * The dirty-queue path and write logic live in `hooks_index.ts`
 * ({@link appendDirtyPath}) so this writer and the queue drainer share one
 * definition.
 */

import * as path from 'node:path'
import { statSync } from 'node:fs'

import { getFilePath } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput, contextOutput } from './hooks_common.js'
import { applyHintTracking, classifyEditHint, meetsSavingsFloor } from './hint_stats.js'
import { appendDirtyPath } from './hooks_index.js'
import { recordKnownRootThrottled } from './index_prune.js'
import { normalizePath } from './paths.js'
import { extractErrorMessage } from './util.js'
import { recordFileEdit } from './session.js'
import { isUnderSystemTemp } from './project.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { compactPathFor, markCompactStale } from './doc_compact.js'
import { ensureWorkerAlive } from './worker.js'
import type { HookOutput } from './types.js'

/**
 * post_tool_use handler for Write/Edit/NotebookEdit.
 *
 * Records the edit in the session cache and enqueues the normalized path for
 * reindexing. A missing path (malformed payload — `file_path` for Write/Edit,
 * `notebook_path` for NotebookEdit) is tolerated — the call passes through
 * without touching the queue. Returns a context hint for markdown/rst files
 * suggesting the token-goat section command for re-reading.
 */
function postEditHandlerInner(event: HookEvent): HookOutput {
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()

  const normalized = normalizePath(filePath)
  recordFileEdit(normalized)
  // Nothing under the OS system temp dir should ever become a permanent index citizen -- see isUnderSystemTemp's docstring for the concrete pollution this prevents; skip both the dirty-queue enqueue and the known-root recording.
  const underSystemTemp = isUnderSystemTemp(normalized)
  if (!underSystemTemp) {
    try {
      appendDirtyPath(normalized)
    } catch (e) {
      // Fail-soft: a transient fs error (disk full, permission, Windows file lock) must not crash the whole handler -- recordFileEdit above already succeeded, and the rest of this handler's work (the markdown hint below) should still run.
      recordStat('dirty_queue_append_failed', 0, 0, undefined, extractErrorMessage(e))
    }

    // Work was just queued above for the background worker to drain -- nudge it back to life if the daemon died and nothing has restarted it since (see ensureWorkerAlive's docstring). Rate-limited internally, so this is cheap on every call after the first in a given window.
    try {
      ensureWorkerAlive()
    } catch (e) {
      recordStat('worker_healthcheck_failed', 0, 0, undefined, extractErrorMessage(e))
    }

    // Record this file's project root as known-alive so the worker's periodic sweep (sweepKnownRoots) has a safe, bounded set of roots to auto-prune dead file rows from -- see recordKnownRootThrottled's docstring. Also rate-limited internally.
    try {
      recordKnownRootThrottled(normalized)
    } catch (e) {
      recordStat('known_root_record_failed', 0, 0, undefined, extractErrorMessage(e))
    }
  }

  // A fresh compact sidecar (built via `token-goat compact-doc`) is only valid while the source is unchanged -- mark it stale so pre_read falls back to a full read instead of serving outdated content. markCompactStale is a fail-soft no-op when no sidecar exists for this path.
  if (loadConfig().hints.stable_doc_compacts) {
    markCompactStale(compactPathFor(normalized))
  }

  const editedBasename = path.basename(normalized)
  if (/\.(md|mdx|markdown|rst)$/i.test(editedBasename)) {
    // The hint's value is re-reading via `section` instead of the whole file, so its quantified savings are the edited file's own size -- skip the fs.statSync entirely on failure (fail-soft) rather than let a stat error suppress a hint that would otherwise have fired.
    let editedSize = Infinity
    try {
      editedSize = statSync(normalized).size
    } catch {
      // best-effort; treat as eligible for the hint below on stat failure
    }
    if (meetsSavingsFloor(editedSize)) {
      const escapedPath = normalized.replace(/`/g, '\\`').replace(/"/g, '\\"')
      return contextOutput(
        editedBasename +
          ' was edited. Use `token-goat section "' +
          escapedPath +
          '::HeadingName"` to re-read a specific section rather than the full file.',
      )
    }
  }

  return passOutput()
}

/** Public wrapper: intercepts every `context` (hint) output from {@link postEditHandlerInner} for efficacy tracking/suppression — see hint_stats.ts's module doc comment. */
export function postEditHandler(event: HookEvent): HookOutput {
  return applyHintTracking(event, postEditHandlerInner(event), classifyEditHint)
}

registerHook('post_tool_use', postEditHandler, { toolName: 'Write' })
registerHook('post_tool_use', postEditHandler, { toolName: 'Edit' })
registerHook('post_tool_use', postEditHandler, { toolName: 'MultiEdit' })
registerHook('post_tool_use', postEditHandler, { toolName: 'NotebookEdit' })
