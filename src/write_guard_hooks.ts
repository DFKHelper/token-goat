/** The checks behind the Write/Edit pre-hook's partial-view guard and sibling-copy advice, with the session and config reads they need. Loaded on demand by hooks_write.ts so the hook entry's eager set does not carry them. */

import { fingerprintContent } from './fingerprint.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { passOutput, contextOutput, denyOutput, getToolName, getToolInput, getFilePath, resolveEventPath } from './hooks_common.js'
import { preToolPathDeclined } from './vscode_path_gate.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { lcsLength, splitLines } from './line_diff.js'
import { normalizePath } from './paths.js'
import { readShapeOf } from './read_shape.js'
import { dropFileLineRangesIfChanged, getFileLineRanges, getSessionFileEntry, getCompactedAt, markHintShown, wasHintShown } from './session.js'
import { siblingCandidates, siblingCopyExcluded, siblingCopyMessage } from './sibling_copy.js'
import { isWithinQuietHours } from './util.js'
import { MAX_LINES_FOR_DIFF, readKnownText } from './write_target.js'
import { BLIND_DROP_MIN_LINES, blindDropMessage, countRunLines, findNewElisionLine, patchAddedLines, placeholderMessage, unseenRemovedRuns } from './write_guards.js'
import type { HookOutput } from './types.js'

/** The verdict for a flagged call, shared by both checks: `hints.write_blind_drop` picks deny, note or silence, quiet hours silence only the note (a refusal stays in force, as every other deny here does), and a call already flagged once under `key` passes, so repeating the identical call is the way through. Books the stat only when the verdict is actually delivered. */
function guardVerdict(key: string, message: string, detail: string): HookOutput {
  const hints = loadConfig().hints
  const policy = hints.write_blind_drop
  if (policy === 'off' || wasHintShown(key)) return passOutput()
  if (policy === 'warn' && isWithinQuietHours(hints.quiet_hours)) return passOutput()
  markHintShown(key)
  recordStat('write_blind_drop', 0, 0, undefined, detail)
  return policy === 'deny' ? denyOutput(message) : contextOutput(message)
}

function guardKey(kind: string, file: string, text: string): string {
  return 'write_blind_drop:' + kind + ':' + fingerprintContent(file + '\0' + text)
}

/** Flag a placeholder line in `newText` that `knownText` (the file as it is now) does not already hold. */
export function placeholderGuard(event: HookEvent, filePath: string, newText: string, knownText: string | (() => string)): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const line = findNewElisionLine(newText, knownText)
  if (line === null) return passOutput()
  return guardVerdict(guardKey('placeholder', filePath, line), placeholderMessage(line), 'kind=placeholder tool=' + (getToolName(event) ?? 'unknown'))
}

/** Flag a whole-file Write that removes at least {@link BLIND_DROP_MIN_LINES} lines the session never read. Only the last Read's shape and the served ranges the session keeps can say what was seen, so it speaks only when both agree the file was read in part: a file never Read here, one read whole since the last compaction, and a `fold` or `truncated` Read (whose shown lines cannot be placed) all pass, as does a partial Read whose ranges an Edit has since dropped. */
export function blindDropGuard(event: HookEvent, filePath: string, newContent: string, oldLines: string[], newLines: string[]): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  if (oldLines.length > MAX_LINES_FOR_DIFF || newLines.length > MAX_LINES_FOR_DIFF) return passOutput()
  const normalized = normalizePath(filePath)
  const shape = readShapeOf(sessionStateKey(event), normalized)
  if (shape === null || shape === 'fold' || shape === 'truncated') return passOutput()
  const fullReadAt = getSessionFileEntry(normalized)?.lastFullReadAt
  if (fullReadAt !== undefined && fullReadAt >= getCompactedAt()) return passOutput()
  dropFileLineRangesIfChanged(normalized)
  const served = getFileLineRanges(normalized)
  if (shape === 'partial' && served.length === 0) return passOutput()
  const runs = unseenRemovedRuns(oldLines, newLines, served)
  if (countRunLines(runs) < BLIND_DROP_MIN_LINES) return passOutput()
  return guardVerdict(guardKey('blind', filePath, newContent), blindDropMessage(filePath, runs), 'kind=blind_drop last_read=' + shape + ' lines=' + countRunLines(runs))
}

/** Advice for a Write that creates a new file named like a copy of an existing sibling (`solver_v2.py` beside `solver.py`) and repeats at least `hints.write_rewrite_unchanged_pct` of its lines: edit the original instead. Advice only, once per original per session; the sibling must have at least `hints.write_rewrite_min_lines` lines and both files stay under the diff caps. */
export function siblingCopyGuard(filePath: string, newContent: string): HookOutput {
  const cfg = loadConfig().hints
  if (!cfg.write_sibling_copy || siblingCopyExcluded(filePath, cfg.write_sibling_copy_allow)) return passOutput()
  const candidates = siblingCandidates(filePath)
  if (candidates.length === 0) return passOutput()
  const newLines = splitLines(newContent)
  if (newLines.length > MAX_LINES_FOR_DIFF) return passOutput()
  for (const original of candidates) {
    const oldLines = splitLines(readKnownText(original))
    if (oldLines.length < cfg.write_rewrite_min_lines || oldLines.length > MAX_LINES_FOR_DIFF) continue
    const unchangedPct = (lcsLength(oldLines, newLines) / oldLines.length) * 100
    if (unchangedPct < cfg.write_rewrite_unchanged_pct) continue
    const key = 'write_sibling_copy:' + fingerprintContent(original)
    if (wasHintShown(key)) return passOutput()
    markHintShown(key)
    const shownPct = Math.round(unchangedPct)
    recordStat('write_sibling_copy', 0, 0, undefined, 'unchanged_pct=' + shownPct)
    return contextOutput(siblingCopyMessage(original, unchangedPct))
  }
  return passOutput()
}

/** The placeholder check for an Edit, a MultiEdit (each edit's `new_string`) or a Codex `apply_patch` (the `+` lines of each file it adds or updates; its input carries the patch under `command`). A line counts only when neither the file now nor the text being replaced holds it. */
export function preEditPlaceholderGuard(event: HookEvent): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const input = getToolInput(event)
  const patch = input['command']
  if (typeof patch === 'string' && input['new_string'] === undefined && input['edits'] === undefined) {
    for (const file of patchAddedLines(patch)) {
      const target = resolveEventPath(event, file.path)
      if (preToolPathDeclined(event, target)) continue
      const verdict = placeholderGuard(event, target, file.added.join('\n'), () => readKnownText(target))
      if (verdict.hookType !== 'pass') return verdict
    }
    return passOutput()
  }
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  if (preToolPathDeclined(event, filePath)) return passOutput()
  const rawEdits = Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : [input]
  let known: string | undefined
  const fileText = (): string => (known ??= readKnownText(filePath))
  for (const raw of rawEdits) {
    if (raw === null || typeof raw !== 'object') continue
    const edit = raw as Record<string, unknown>
    const newString = edit['new_string']
    if (typeof newString !== 'string') continue
    const oldString = typeof edit['old_string'] === 'string' ? edit['old_string'] : ''
    const verdict = placeholderGuard(event, filePath, newString, () => fileText() + '\n' + oldString)
    if (verdict.hookType !== 'pass') return verdict
  }
  return passOutput()
}
