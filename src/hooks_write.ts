/** pre_tool_use hook for the Write tool: full-rewrite detector (feature-queue #302). The gap: `hooks_edit.ts::postEditHandler` already intercepts Write AFTER it happens (enqueue reindex, emit a markdown-section hint), but nothing intercepts it BEFORE. When an agent uses Write to rewrite an EXISTING file where only a small portion actually changed, it has to send the entire new file content through the tool call -- every unchanged line burns tokens that a targeted `Edit` (or `token-goat replace` / `write-file --from`, see CLAUDE.md's "Writing Files with Special Characters" section) would have avoided. This hook compares the incoming Write's new content against the current on-disk content -- only possible when the file already exists; a Write creating a brand-new file has nothing to compare against, so the rewrite comparison is never attempted for it (only the placeholder check of write_guards.ts runs, as it does for Edit, MultiEdit and Codex apply_patch) -- and, when the unchanged-line fraction is high on a non-trivially large file, emits an advisory hint recommending Edit instead. Never blocks: Write is sometimes genuinely the right tool (a real full-file rewrite), so this is `context`-only, exactly like hooks_glob.ts's dedup hint. Diff-detection approach: checked for a reusable line-diff utility first (per task instructions) -- `bash_output_cache.ts::summarizeOutputDelta` is bag-of-lines only (counts issue-marker lines present/absent, or a bare old-vs-new line-count delta), not order-aware, so it can't distinguish "10% of lines changed, scattered" from "one contiguous 90% rewrite"; `read_commands.ts`'s `parseDiffHunks`/`splitDiffHunks` shell out to `git diff` against a committed ref and a path already on disk, which doesn't fit here (the new content is a pending tool_input, not yet written, and spawning `git diff --no-index` on every Write would add subprocess latency to a hook that must stay fast and must also work outside a git repo). Neither is an adequate fit, so this hook computes its own line-level LCS length -- the honest, order-respecting signal the task asked for -- bounded by {@link MAX_LINES_FOR_DIFF} so the O(n*m) DP never turns a Write into a multi-second hook call. */
import { readFileSync, statSync } from 'node:fs'

import { fingerprintContent } from './fingerprint.js'
import type { HookEvent } from './hook_registry.js'
import { registerHook, sessionStateKey } from './hook_registry.js'
import { passOutput, contextOutput, denyOutput, getToolName, getToolInput, getFilePath, resolveEventPath } from './hooks_common.js'
import { preToolPathDeclined } from './vscode_path_gate.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { lcsLength, splitLines } from './line_diff.js'
import { normalizePath } from './paths.js'
import { readShapeOf } from './read_shape.js'
import { dropFileLineRangesIfChanged, getFileLineRanges, getSessionFileEntry, getCompactedAt, markHintShown, wasHintShown } from './session.js'
import { isWithinQuietHours } from './util.js'
import { BLIND_DROP_MIN_LINES, blindDropMessage, countRunLines, findNewElisionLine, patchAddedLines, placeholderMessage, unseenRemovedRuns } from './write_guards.js'
import type { HookOutput } from './types.js'

/** Performance safety valve for the O(n*m) LCS computation below. Independent of the user-configurable `hints.write_rewrite_min_lines` floor (which gates whether the detector fires at all): this caps how large a file the detector will even attempt to diff, so a huge file's Write never turns into a multi-second (or memory-heavy) synchronous hook call. Above this size the detector fails open (passes through, no comparison) rather than block on a diff that's too expensive to be worth it. */
const MAX_LINES_FOR_DIFF = 4000

/** Byte-size gate applied to the OLD file's `stat.size` before it is ever read into memory. `MAX_LINES_FOR_DIFF` above only rejects an oversized file AFTER `readFileSync` has already loaded the whole thing and `splitLines` has already run -- so a huge single-line file (a minified bundle, a data dump) or a huge multi-GB log sailed straight through that gate and synchronously read its entire content into a JS string on every single Write, exactly the unbounded-`readFileSync` pattern already fixed for the catch-all file-type dispatch in hooks_read.ts (see SLICE_ESTIMATE_SCAN_CAP_BYTES there). Checked against `stat.size`, which is already available post-`statSync`, before any read is attempted. */
const MAX_OLD_FILE_BYTES_FOR_DIFF = 4 * 1024 * 1024

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

/** The current text of `filePath`, or '' when it is missing, not a regular file, over the diff byte cap, or unreadable. */
function readKnownText(filePath: string): string {
  try {
    const stat = statSync(filePath)
    if (!stat.isFile() || stat.size > MAX_OLD_FILE_BYTES_FOR_DIFF) return ''
    return readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Flag a placeholder line in `newText` that `knownText` (the file as it is now) does not already hold. */
function placeholderGuard(event: HookEvent, filePath: string, newText: string, knownText: string): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const line = findNewElisionLine(newText, knownText)
  if (line === null) return passOutput()
  return guardVerdict(guardKey('placeholder', filePath, line), placeholderMessage(line), 'kind=placeholder tool=' + (getToolName(event) ?? 'unknown'))
}

/** Flag a whole-file Write that removes at least {@link BLIND_DROP_MIN_LINES} lines the session never read. Only the last Read's shape and the served ranges the session keeps can say what was seen, so it speaks only when both agree the file was read in part: a file never Read here, one read whole since the last compaction, and a `fold` or `truncated` Read (whose shown lines cannot be placed) all pass, as does a partial Read whose ranges an Edit has since dropped. */
function blindDropGuard(event: HookEvent, filePath: string, newContent: string, oldLines: string[], newLines: string[]): HookOutput {
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

/** The placeholder check for an Edit, a MultiEdit (each edit's `new_string`) or a Codex `apply_patch` (the `+` lines of each file it adds or updates; its input carries the patch under `command`). A line counts only when neither the file now nor the text being replaced holds it. */
function preEditPlaceholderGuard(event: HookEvent): HookOutput {
  if (loadConfig().hints.write_blind_drop === 'off') return passOutput()
  const input = getToolInput(event)
  const patch = input['command']
  if (typeof patch === 'string' && input['new_string'] === undefined && input['edits'] === undefined) {
    for (const file of patchAddedLines(patch)) {
      const target = resolveEventPath(event, file.path)
      const verdict = placeholderGuard(event, target, file.added.join('\n'), readKnownText(target))
      if (verdict.hookType !== 'pass') return verdict
    }
    return passOutput()
  }
  const filePath = getFilePath(event)
  if (filePath === undefined) return passOutput()
  if (preToolPathDeclined(event, filePath)) return passOutput()
  const rawEdits = Array.isArray(input['edits']) ? (input['edits'] as unknown[]) : [input]
  const known = readKnownText(filePath)
  for (const raw of rawEdits) {
    if (raw === null || typeof raw !== 'object') continue
    const edit = raw as Record<string, unknown>
    const newString = edit['new_string']
    if (typeof newString !== 'string') continue
    const oldString = typeof edit['old_string'] === 'string' ? edit['old_string'] : ''
    const verdict = placeholderGuard(event, filePath, newString, known + '\n' + oldString)
    if (verdict.hookType !== 'pass') return verdict
  }
  return passOutput()
}

/** pre_tool_use handler for Write. Fails open on every path that isn't a clean "existing file, mostly-unchanged rewrite" match: missing/non-string content, a path that doesn't exist yet (brand-new file -- zero comparison attempted), a directory at that path, an old file over `MAX_OLD_FILE_BYTES_FOR_DIFF` (never even read), a read error, a file below `hints.write_rewrite_min_lines`, a diff too large to compute cheaply, or an unchanged-line fraction below `hints.write_rewrite_unchanged_pct` all just `passOutput()`. */
export function preWriteRewriteHandler(event: HookEvent): HookOutput {
  try {
    const toolName = getToolName(event)
    if (toolName === 'Edit' || toolName === 'MultiEdit') return preEditPlaceholderGuard(event)
    if (toolName !== 'Write') return passOutput()
    const filePath = getFilePath(event)
    if (filePath === undefined) return passOutput()
    // Before the stat below: this runs ahead of the user's approval, see preToolPathDeclined.
    if (preToolPathDeclined(event, filePath)) return passOutput()
    const newContent = getToolInput(event)['content']
    if (typeof newContent !== 'string') return passOutput()

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      // Doesn't exist yet (or the path is otherwise unreachable) -- a brand-new-file Write has nothing to compare against for the rewrite hint, but a placeholder in it is still a placeholder.
      return placeholderGuard(event, filePath, newContent, '')
    }
    if (!stat.isFile()) return passOutput()
    if (stat.size > MAX_OLD_FILE_BYTES_FOR_DIFF) return passOutput()

    let oldContent: string
    try {
      oldContent = readFileSync(filePath, 'utf-8')
    } catch {
      return passOutput()
    }
    if (oldContent === newContent) return passOutput()

    const placeholder = placeholderGuard(event, filePath, newContent, oldContent)
    if (placeholder.hookType !== 'pass') return placeholder

    const oldLines = splitLines(oldContent)
    if (oldLines.length === 0) return passOutput()

    const cfg = loadConfig().hints
    const newLines = splitLines(newContent)
    const blind = blindDropGuard(event, filePath, newContent, oldLines, newLines)
    if (blind.hookType !== 'pass') return blind

    if (oldLines.length < cfg.write_rewrite_min_lines) return passOutput()
    if (oldLines.length > MAX_LINES_FOR_DIFF || newLines.length > MAX_LINES_FOR_DIFF) return passOutput()

    const unchanged = lcsLength(oldLines, newLines)
    const unchangedPct = (unchanged / oldLines.length) * 100
    if (unchangedPct < cfg.write_rewrite_unchanged_pct) return passOutput()

    recordStat('write_rewrite_hint', 0, 0)
    return contextOutput(
      'This Write rewrites an existing ' + oldLines.length + '-line file, but about ' +
        Math.round(unchangedPct) + '% of its lines are unchanged. `Edit` (or `token-goat replace`) ' +
        'would send far less content over the wire than a full rewrite -- consider that instead ' +
        'unless a genuine full-file rewrite is intended.',
    )
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preWriteRewriteHandler, { toolName: 'Write' })
registerHook('pre_tool_use', preWriteRewriteHandler, { toolName: 'Edit' })
registerHook('pre_tool_use', preWriteRewriteHandler, { toolName: 'MultiEdit' })
