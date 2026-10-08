/** post_tool_use edit hooks (Write / Edit / MultiEdit / NotebookEdit). Ports `hooks_edit.py::post_edit`: after a successful edit, record every file it touched in the session cache and append each to the dirty queue so the background indexer (Layer 7) reindexes only what changed. Never blocks an edit -- returns `context` for a single edited markdown file (with a section hint) or `pass` otherwise. The dirty-queue path and write logic live in `hooks_index.ts` ({@link appendDirtyPath}) so this writer and the queue drainer share one definition. */

import * as path from 'node:path'
import { statSync } from 'node:fs'

import { getCwd, getFilePaths } from './hooks_common.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook, sessionStateKey } from './hook_registry.js'
import { passOutput, contextOutput } from './hooks_common.js'
import { applyHintTracking, classifyEditHint, logSuppressedDetection, meetsSavingsFloor } from './hint_stats.js'
import { fileSubject, leadWithCommand, sentenceStart } from './hint_suggestion_guard.js'
import { hintTarget, sectionOrRangeCommand } from './hint_target.js'
import { appendDirtyPath } from './hooks_index.js'
import { recordKnownRootThrottled } from './known_roots.js'
import { displaySafePath, hostPathOfIndexKey, normalizePath, resolveIndexPath } from './paths.js'
import { extractErrorMessage } from './util.js'
import { getCompactedAt, markHintShown, recordFileEdit, wasHintShown } from './session.js'
import { readShapeOf, recordReadShape } from './read_shape.js'
import { isUnderSystemTemp } from './project.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { compactPathFor, markCompactStale } from './doc_compact.js'
import { ensureWorkerAlive } from './worker_lifecycle.js'
import type { HookOutput } from './types.js'

/** post_tool_use handler for Write/Edit/MultiEdit/NotebookEdit. Records each edited file in the session cache and enqueues its absolute path for reindexing. A missing path (malformed payload: no `file_paths`, and no `file_path` for Write/Edit or `notebook_path` for NotebookEdit) is tolerated, and the call passes through without touching the queue. Returns a context hint for markdown/rst files suggesting the token-goat section command for re-reading. */
function postEditHandlerInner(event: HookEvent): HookOutput {
  const filePaths = getFilePaths(event)
  if (filePaths.length === 0) return passOutput()
  // One call can edit several files (VS Code's multi_replace_string_in_file and apply_patch arrive with `file_paths`), and every one of them has to reach the dirty queue, or the files after the first stay stale in the index until something else touches them. The section hint below names one file, so it fires only for a single-file edit.
  const normalizedPaths = filePaths.map((p) => recordEditedFile(event, p))
  if (normalizedPaths.length !== 1) return passOutput()
  const normalized = normalizedPaths[0]!
  return markdownSectionHint(event, normalized)
}

/** Record one edited file in the session cache, queue it for reindexing, and mark its compact sidecar stale. Returns the normalized path. */
function recordEditedFile(event: HookEvent, filePath: string): string {
  const normalized = normalizePath(filePath)
  recordFileEdit(normalized)
  bookEditAfterPartialRead(event, normalized)
  // The index keys on the absolute path and the worker drains from its own directory, so a relative path (pi's edit and write tools take one) is resolved against the directory the harness ran the tool in before it is queued: left relative, the drain found no such file, read it as a deletion of a path no row carries, and the edit was never indexed.
  const indexPath = resolveIndexPath(filePath, getCwd(event) ?? process.cwd())
  // Nothing under the OS system temp dir should ever become a permanent index citizen -- see isUnderSystemTemp's docstring for the concrete pollution this prevents; skip both the dirty-queue enqueue and the known-root recording.
  const underSystemTemp = isUnderSystemTemp(indexPath)
  if (!underSystemTemp) {
    try {
      appendDirtyPath(indexPath)
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
      recordKnownRootThrottled(indexPath)
    } catch (e) {
      recordStat('known_root_record_failed', 0, 0, undefined, extractErrorMessage(e))
    }
  }

  // A fresh compact sidecar (built via `token-goat compact-doc`) is only valid while the source is unchanged -- mark it stale so pre_read falls back to a full read instead of serving outdated content. markCompactStale is a fail-soft no-op when no sidecar exists for this path.
  if (loadConfig().hints.stable_doc_compacts) {
    markCompactStale(compactPathFor(normalized))
  }
  return normalized
}

/** The `token-goat section` re-read hint for an edited markdown/rst file, or pass for any other file. */
function markdownSectionHint(event: HookEvent, normalized: string): HookOutput {
  const editedBasename = path.basename(normalized)
  if (/\.(md|mdx|markdown|rst)$/i.test(editedBasename)) {
    // The hint's value is re-reading via `section` instead of the whole file, so its quantified savings are the edited file's own size -- skip the fs.statSync entirely on failure (fail-soft) rather than let a stat error suppress a hint that would otherwise have fired.
    let editedSize = Infinity
    try {
      editedSize = statSync(hostPathOfIndexKey(normalized)).size
    } catch {
      // best-effort; treat as eligible for the hint below on stat failure
    }
    // Once per file per compaction epoch: the hint names the same command every time the same file is edited, so a second copy tells the model nothing the first did not while the first is still in context (one session carried the CHANGELOG.md hint 17 times). A compaction takes the earlier copy out of context, so the epoch is part of the key.
    const repeatKey = `edit-section-hint:${normalized}:${getCompactedAt()}`
    if (wasHintShown(repeatKey)) return passOutput()
    if (!meetsSavingsFloor(editedSize)) {
      // The file was edited, it is markdown, and a `section` hint was composable from it, so price is the only thing that stopped this one -- the same decision declineUnpriced records for bash redirects, in the category that emits more hints than any other and had never recorded a refusal.
      logSuppressedDetection('edit_reread_suggest', event.sessionId, normalized)
    } else {
      // displaySafePath first: the backtick/quote escaping below is about not breaking the markdown span, and does nothing about a newline in the file name, which would end the hint line and let the rest of the name read as a note of token-goat's own.
      const escapedPath = displaySafePath(normalized).replace(/`/g, '\\`').replace(/"/g, '\\"')
      // The index row for this file was just queued stale, so hintTarget reads the heading off the written file's first bytes. The path goes in as the correlator, so hint-stats credits a `section` on any heading of it, as it did when this printed a placeholder.
      const heading = hintTarget(normalized, 'section')
      markHintShown(repeatKey)
      const command = sectionOrRangeCommand(displaySafePath(normalized), heading)
      return contextOutput(
        leadWithCommand(command, 'to re-read a specific section rather than the full file', sentenceStart(fileSubject(command, displaySafePath(normalized), normalized)) + ' was edited.'),
        [escapedPath],
      )
    }
  }

  return passOutput()
}

/** Book an edit of a file whose last Read handed the model only part of it (read_shape.ts), with the shape of that Read and the editing tool. An Edit keeps the record, since the model still has not seen what the Read withheld; a Write clears it, since the model has just supplied every line of the file itself. Best-effort: a lost measurement never affects the edit. */
function bookEditAfterPartialRead(event: HookEvent, normalized: string): void {
  try {
    const stateKey = sessionStateKey(event)
    const shape = readShapeOf(stateKey, normalized)
    if (shape === null) return
    recordStat('edit_after_fold', 0, 0, undefined, `last_read=${shape} tool=${event.toolName ?? 'unknown'}`)
    if (event.toolName === 'Write') recordReadShape(stateKey, normalized, null)
  } catch {
    // See the doc comment above.
  }
}

/** Public wrapper: intercepts every `context` (hint) output from {@link postEditHandlerInner} for efficacy tracking/suppression — see hint_stats.ts's module doc comment. */
export function postEditHandler(event: HookEvent): HookOutput {
  return applyHintTracking(event, postEditHandlerInner(event), classifyEditHint)
}

registerHook('post_tool_use', postEditHandler, { toolName: 'Write' })
registerHook('post_tool_use', postEditHandler, { toolName: 'Edit' })
registerHook('post_tool_use', postEditHandler, { toolName: 'MultiEdit' })
registerHook('post_tool_use', postEditHandler, { toolName: 'NotebookEdit' })
