/** The checks behind the Write/Edit pre-hook's partial-view guard and sibling-copy advice, with the session and config reads they need. Loaded on demand by hooks_write.ts so the hook entry's eager set does not carry them. */

import { fingerprintContent } from './fingerprint.js'
import type { HookEvent } from './hook_registry.js'
import { sessionStateKey } from './hook_registry.js'
import { passOutput, contextOutput, denyOutput, getToolName, getToolInput, getFilePath, getCwd, resolveEventPath } from './hooks_common.js'
import { preToolPathDeclined } from './vscode_path_gate.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { lcsLength, splitLines } from './line_diff.js'
import { normalizePath } from './paths.js'
import { resolveProjectRoot } from './project.js'
import { readShapeOf } from './read_shape.js'
import { dropFileLineRangesIfChanged, getFileLineRanges, wasFileFullyReadThisSession, markHintShown, wasHintShown } from './session.js'
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

/** Flag a placeholder line in `newText` that `knownText` (the file as it is now) does not already hold. Flagged once per file and text: a verbatim repeat of the same call passes, a different text carrying the same marker is flagged again. */
export function placeholderGuard(event: HookEvent, filePath: string, newText: string, knownText: string | (() => string)): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const line = findNewElisionLine(newText, knownText)
  if (line === null) return passOutput()
  return guardVerdict(guardKey('placeholder', filePath, newText), placeholderMessage(line), 'kind=placeholder tool=' + (getToolName(event) ?? 'unknown'))
}

/** Flag a whole-file Write that removes at least {@link BLIND_DROP_MIN_LINES} lines the session never read. Only the last Read's shape and the served ranges the session keeps can say what was seen, so it speaks only when both agree the file was read in part: a file never Read here, one read whole since the last compaction, and a `fold` or `truncated` Read (whose shown lines cannot be placed) all pass, as does a partial Read whose ranges an Edit has since dropped. */
export function blindDropGuard(event: HookEvent, filePath: string, newContent: string, oldLines: string[], newLines: string[]): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  if (oldLines.length > MAX_LINES_FOR_DIFF || newLines.length > MAX_LINES_FOR_DIFF) return passOutput()
  const normalized = normalizePath(filePath)
  const shape = readShapeOf(sessionStateKey(event), normalized)
  if (shape === null || shape === 'fold' || shape === 'truncated') return passOutput()
  if (wasFileFullyReadThisSession(normalized)) return passOutput()
  dropFileLineRangesIfChanged(normalized)
  const served = getFileLineRanges(normalized)
  if (shape === 'partial' && served.length === 0) return passOutput()
  const runs = unseenRemovedRuns(oldLines, newLines, served)
  if (countRunLines(runs) < BLIND_DROP_MIN_LINES) return passOutput()
  return guardVerdict(guardKey('blind', filePath, newContent), blindDropMessage(filePath, runs), 'kind=blind_drop last_read=' + shape + ' lines=' + countRunLines(runs))
}

/** Advice for a Write that creates a new file named like a copy of an existing sibling (`solver_v2.py` beside `solver.py`) and repeats at least `hints.write_rewrite_unchanged_pct` of its lines: edit the original instead. Advice only, once per original per session; the sibling must have at least `hints.write_rewrite_min_lines` lines and both files stay under the diff caps. */
export function siblingCopyGuard(event: HookEvent, filePath: string, newContent: string): HookOutput {
  const cfg = loadConfig().hints
  if (!cfg.write_sibling_copy) return passOutput()
  const candidates = siblingCandidates(filePath)
  if (candidates.length === 0) return passOutput()
  const cwd = getCwd(event)
  if (siblingCopyExcluded(filePath, cfg.write_sibling_copy_allow, cwd === undefined ? null : resolveProjectRoot({ project: cwd }))) return passOutput()
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

/** The placeholder check for an Edit, a MultiEdit (each edit's `new_string`), a Codex `apply_patch` or a VS Code `apply_patch` (the `+` lines of each file it adds or updates; the patch sits under `command` for Codex and `input` for VS Code) and a VS Code `multi_replace_string_in_file` (each of its `replacements`, which name their own file). A line counts only when neither the file now nor the text being replaced holds it. VS Code's `insert_edit_into_file` is left out on purpose: its `code` is written with `// ...existing code...` markers by the tool's own contract. */
export function preEditPlaceholderGuard(event: HookEvent): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const input = getToolInput(event)
  const patch = typeof input['command'] === 'string' ? input['command'] : input['input']
  if (typeof patch === 'string' && input['new_string'] === undefined && input['edits'] === undefined && input['replacements'] === undefined) {
    for (const file of patchAddedLines(patch)) {
      const target = resolveEventPath(event, file.path)
      if (preToolPathDeclined(event, target)) continue
      const verdict = placeholderGuard(event, target, file.added.join('\n'), () => readKnownText(target))
      if (verdict.hookType !== 'pass') return verdict
    }
    return passOutput()
  }
  const known = new Map<string, string>()
  const fileText = (path: string): string => {
    let text = known.get(path)
    if (text === undefined) known.set(path, (text = readKnownText(path)))
    return text
  }
  const edits: Array<{ path: string | undefined; raw: unknown }> = []
  if (Array.isArray(input['replacements'])) {
    for (const raw of input['replacements'] as unknown[]) {
      const named = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['filePath'] : undefined
      edits.push({ path: typeof named === 'string' && named !== '' ? resolveEventPath(event, named) : undefined, raw })
    }
  } else {
    const filePath = getFilePath(event)
    for (const raw of Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : [input]) edits.push({ path: filePath, raw })
  }
  for (const { path, raw } of edits) {
    if (path === undefined || raw === null || typeof raw !== 'object' || preToolPathDeclined(event, path)) continue
    const edit = raw as Record<string, unknown>
    const newString = edit['new_string'] ?? edit['newString']
    if (typeof newString !== 'string') continue
    const oldString = edit['old_string'] ?? edit['oldString']
    const replaced = typeof oldString === 'string' ? oldString : ''
    const verdict = placeholderGuard(event, path, newString, () => fileText(path) + '\n' + replaced)
    if (verdict.hookType !== 'pass') return verdict
  }
  return passOutput()
}
