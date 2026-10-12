/** pre_tool_use hook for the Write tool: full-rewrite detector (feature-queue #302). The gap: `hooks_edit.ts::postEditHandler` already intercepts Write AFTER it happens (enqueue reindex, emit a markdown-section hint), but nothing intercepts it BEFORE. When an agent uses Write to rewrite an EXISTING file where only a small portion actually changed, it has to send the entire new file content through the tool call -- every unchanged line burns tokens that a targeted `Edit` (or `token-goat replace` / `write-file --from`, see CLAUDE.md's "Writing Files with Special Characters" section) would have avoided. This hook compares the incoming Write's new content against the current on-disk content -- only possible when the file already exists; a Write creating a brand-new file has nothing at its own path to compare against, so the rewrite comparison is never attempted for it (it gets the placeholder check of write_guards.ts, as Edit, MultiEdit and Codex apply_patch do, and the sibling-copy advice of sibling_copy.ts) -- and, when the unchanged-line fraction is high on a non-trivially large file, emits an advisory hint recommending Edit instead. Never blocks: Write is sometimes genuinely the right tool (a real full-file rewrite), so this is `context`-only, exactly like hooks_glob.ts's dedup hint. Diff-detection approach: checked for a reusable line-diff utility first (per task instructions) -- `bash_output_cache.ts::summarizeOutputDelta` is bag-of-lines only (counts issue-marker lines present/absent, or a bare old-vs-new line-count delta), not order-aware, so it can't distinguish "10% of lines changed, scattered" from "one contiguous 90% rewrite"; `read_commands.ts`'s `parseDiffHunks`/`splitDiffHunks` shell out to `git diff` against a committed ref and a path already on disk, which doesn't fit here (the new content is a pending tool_input, not yet written, and spawning `git diff --no-index` on every Write would add subprocess latency to a hook that must stay fast and must also work outside a git repo). Neither is an adequate fit, so this hook computes its own line-level LCS length -- the honest, order-respecting signal the task asked for -- bounded by {@link MAX_LINES_FOR_DIFF} so the O(n*m) DP never turns a Write into a multi-second hook call. */

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput, contextOutput, getToolName, getToolInput, getFilePath } from './hooks_common.js'
import { preToolPathDeclined } from './vscode_path_gate.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import { lcsLength, splitLines } from './line_diff.js'
import { MAX_LINES_FOR_DIFF, inspectFile } from './write_target.js'
import type { HookOutput } from './types.js'
import type * as WriteGuardHooks from './write_guard_hooks.js'

/** The placeholder, blind-drop and sibling-copy checks load on demand: only a Write or Edit needs them, and they would otherwise sit in the eager set of every hook process. */
function loadGuards(): Promise<typeof WriteGuardHooks> {
  return import('./write_guard_hooks.js')
}

/** pre_tool_use handler for Write. Fails open on every path that isn't a clean "existing file, mostly-unchanged rewrite" match: missing/non-string content, a path that doesn't exist yet (brand-new file -- zero comparison attempted), a directory at that path, an old file over `MAX_OLD_FILE_BYTES_FOR_DIFF` or one that cannot be read (never diffed; the placeholder check still runs on the new text, with nothing known of the old), a file below `hints.write_rewrite_min_lines`, a diff too large to compute cheaply, or an unchanged-line fraction below `hints.write_rewrite_unchanged_pct` all just `passOutput()`. */
export async function preWriteRewriteHandler(event: HookEvent): Promise<HookOutput> {
  try {
    const toolName = getToolName(event)
    if (toolName === 'Edit' || toolName === 'MultiEdit') return (await loadGuards()).preEditPlaceholderGuard(event)
    if (toolName !== 'Write') return passOutput()
    const filePath = getFilePath(event)
    if (filePath === undefined) return passOutput()
    // Before the stat below: this runs ahead of the user's approval, see preToolPathDeclined.
    if (preToolPathDeclined(event, filePath)) return passOutput()
    const newContent = getToolInput(event)['content']
    if (typeof newContent !== 'string') return passOutput()

    const guards = await loadGuards()
    const onDisk = inspectFile(filePath)
    if (onDisk.state === 'absent') {
      // Doesn't exist yet (or the path is otherwise unreachable) -- a brand-new-file Write has nothing to compare against for the rewrite hint, but a placeholder in it is still a placeholder.
      const created = guards.placeholderGuard(event, filePath, newContent, '')
      return created.hookType !== 'pass' ? created : guards.siblingCopyGuard(event, filePath, newContent)
    }
    if (onDisk.state === 'unusable') return passOutput()
    // A regular file too big to read (or unreadable) still gets the placeholder check, against an empty known text: whatever markers it already carries are unknown, so the guard errs toward speaking, once.
    if (onDisk.state === 'unread') return guards.placeholderGuard(event, filePath, newContent, '')
    const oldContent = onDisk.text
    if (oldContent === newContent) return passOutput()

    const placeholder = guards.placeholderGuard(event, filePath, newContent, oldContent)
    if (placeholder.hookType !== 'pass') return placeholder

    const oldLines = splitLines(oldContent)
    if (oldLines.length === 0) return passOutput()

    const cfg = loadConfig().hints
    const newLines = splitLines(newContent)
    const blind = guards.blindDropGuard(event, filePath, newContent, oldLines, newLines)
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
