/**
 * pre_tool_use hook for the Write tool: full-rewrite detector (feature-queue #302).
 *
 * The gap: `hooks_edit.ts::postEditHandler` already intercepts Write AFTER it happens (enqueue
 * reindex, emit a markdown-section hint), but nothing intercepts it BEFORE. When an agent uses
 * Write to rewrite an EXISTING file where only a small portion actually changed, it has to send
 * the entire new file content through the tool call -- every unchanged line burns tokens that a
 * targeted `Edit` (or `token-goat replace` / `write-file --from`, see CLAUDE.md's "Writing Files
 * with Special Characters" section) would have avoided.
 *
 * This hook compares the incoming Write's new content against the current on-disk content --
 * only possible when the file already exists; a Write creating a brand-new file has nothing to
 * compare against and always passes through with zero comparison attempted -- and, when the
 * unchanged-line fraction is high on a non-trivially large file, emits an advisory hint
 * recommending Edit instead. Never blocks: Write is sometimes genuinely the right tool (a real
 * full-file rewrite), so this is `context`-only, exactly like hooks_glob.ts's dedup hint.
 *
 * Diff-detection approach: checked for a reusable line-diff utility first (per task instructions)
 * -- `bash_output_cache.ts::summarizeOutputDelta` is bag-of-lines only (counts issue-marker lines
 * present/absent, or a bare old-vs-new line-count delta), not order-aware, so it can't distinguish
 * "10% of lines changed, scattered" from "one contiguous 90% rewrite"; `read_commands.ts`'s
 * `parseDiffHunks`/`splitDiffHunks` shell out to `git diff` against a committed ref and a path
 * already on disk, which doesn't fit here (the new content is a pending tool_input, not yet
 * written, and spawning `git diff --no-index` on every Write would add subprocess latency to a
 * hook that must stay fast and must also work outside a git repo). Neither is an adequate fit, so
 * this hook computes its own line-level LCS length -- the honest, order-respecting signal the task
 * asked for -- bounded by {@link MAX_LINES_FOR_DIFF} so the O(n*m) DP never turns a Write into a
 * multi-second hook call.
 */
import { readFileSync, statSync } from 'node:fs'

import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import { passOutput, contextOutput, getToolName, getToolInput, getFilePath } from './hooks_common.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'
import type { HookOutput } from './types.js'

/**
 * Performance safety valve for the O(n*m) LCS computation below. Independent of the
 * user-configurable `hints.write_rewrite_min_lines` floor (which gates whether the detector
 * fires at all): this caps how large a file the detector will even attempt to diff, so a huge
 * file's Write never turns into a multi-second (or memory-heavy) synchronous hook call. Above
 * this size the detector fails open (passes through, no comparison) rather than block on a diff
 * that's too expensive to be worth it.
 */
const MAX_LINES_FOR_DIFF = 4000

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

/**
 * Length of the longest common subsequence between two line arrays, via the standard O(n*m)
 * time / O(min(n,m)) space DP (two rolling rows, always iterating the shorter side as the inner
 * loop). Order-respecting by construction -- unlike a multiset/bag-of-lines intersection, lines
 * that recur out of order don't inflate the "unchanged" count, so a genuine full-file rewrite
 * that happens to share some common lines (imports, boilerplate) doesn't masquerade as a small
 * edit.
 */
function lcsLength(a: string[], b: string[]): number {
  const [shortArr, longArr] = a.length <= b.length ? [a, b] : [b, a]
  const n = shortArr.length
  let prev = new Array<number>(n + 1).fill(0)
  let curr = new Array<number>(n + 1).fill(0)
  for (let i = 1; i <= longArr.length; i++) {
    for (let j = 1; j <= n; j++) {
      curr[j] = shortArr[j - 1] === longArr[i - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[n] ?? 0
}

/**
 * pre_tool_use handler for Write. Fails open on every path that isn't a clean "existing file,
 * mostly-unchanged rewrite" match: missing/non-string content, a path that doesn't exist yet
 * (brand-new file -- zero comparison attempted), a directory at that path, a read error, a file
 * below `hints.write_rewrite_min_lines`, a diff too large to compute cheaply, or an
 * unchanged-line fraction below `hints.write_rewrite_unchanged_pct` all just `passOutput()`.
 */
export function preWriteRewriteHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Write') return passOutput()
    const filePath = getFilePath(event)
    if (filePath === undefined) return passOutput()
    const newContent = getToolInput(event)['content']
    if (typeof newContent !== 'string') return passOutput()

    let stat
    try {
      stat = statSync(filePath)
    } catch {
      // Doesn't exist yet (or the path is otherwise unreachable) -- a brand-new-file Write has
      // nothing to compare against and must always pass through untouched.
      return passOutput()
    }
    if (!stat.isFile()) return passOutput()

    let oldContent: string
    try {
      oldContent = readFileSync(filePath, 'utf-8')
    } catch {
      return passOutput()
    }
    if (oldContent === newContent) return passOutput()

    const oldLines = splitLines(oldContent)
    if (oldLines.length === 0) return passOutput()

    const cfg = loadConfig().hints
    if (oldLines.length < cfg.write_rewrite_min_lines) return passOutput()

    const newLines = splitLines(newContent)
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
