/**
 * post_tool_use / pre_tool_use handlers for the Glob tool.
 *
 * Investigated two compression angles for feature-queue #301 before building anything:
 *
 * (a) Session-scoped dedup/hint, mirroring hooks_grep.ts's grep_dedup_hint: like Grep, Glob has
 *     zero existing output-side treatment anywhere in the codebase (confirmed via `rg "toolName:
 *     'Glob'" src/*.ts` before this file existed -- zero hits), so a repeated identical Glob
 *     pattern+path just silently re-runs and re-returns the same path list, exactly the gap Grep
 *     already closes. This is a direct, low-risk mirror of a pattern already proven in
 *     hooks_grep.ts.
 *
 * (b) Structural compression of the raw path list itself (group by common directory prefix
 *     instead of a flat list), gated on overflow_guard.ts's `trimToBudget`/`capJsonRows` being
 *     genuinely inadequate for Glob's shape. Investigation finding: overflow_guard.ts is NOT
 *     wired to any raw tool_response reaching the model at all -- its only two callers
 *     (read_commands.ts and dep_docs.ts) cap token-goat's own CLI-command output, never a
 *     harness tool's raw result. Grep's raw tool_response goes over the wire uncapped today (the
 *     same gap Glob has), and hooks_grep.ts deliberately does not add capping for it either --
 *     it only dedups. So the honest comparison isn't "flat truncation is inadequate for Glob's
 *     shape" (there is no flat truncation in play to begin with for either tool's raw output);
 *     it's "would a *new* compression mechanism, applied only to Glob and not to Grep or any
 *     other uncapped raw tool output, be scoped correctly here." It would not: adding path-list
 *     grouping here means one tool gets bespoke result-shape compression while every structurally
 *     similar tool (Grep's `files_with_matches` mode returns an equally flat, equally
 *     directory-clustered file list) does not, which is exactly the kind of one-off, uncoordinated
 *     abstraction CLAUDE.md's "no premature abstraction" rule warns against. If raw-tool-response
 *     capping is wanted, it belongs as a generic post_tool_use mechanism applied uniformly (a
 *     separate, larger design decision, out of scope for #301), not smuggled in as a Glob-only
 *     special case. Decision: (a) only.
 */
import { registerHook } from './hook_registry.js'
import type { HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { contextOutput, passOutput, getToolInput, getToolName, makeDedupHintHandlers } from './hooks_common.js'
import { displaySafeText } from './paths.js'
import { recordGlobQuery, getGlobMatchCount } from './session.js'
import { recordStat } from './stats.js'

/** Returns true if pattern is a broad catch-all glob on a root or unscoped directory (e.g. wildcards on empty, dot, or top-level roots). */
export function isBroadCatchAllGlob(pattern: string, pathArg?: string): boolean {
  const p = pattern.trim()
  const isBroad = p === '*' || p === '**/*' || p === '**' || p === '*.*' || p === '**/*.*' || p === '**/*.**'
  if (!isBroad) return false
  const target = (pathArg ?? '').trim().replace(/[\\/]+$/, '')
  return target === '' || target === '.' || target === './' || target === '.\\' || (!target.includes('/') && !target.includes('\\'))
}

/** Session-scoped identity for a Glob call: two calls with the same signature searched the same
 *  thing the same way. Returns null when there is no pattern to key on. Glob's tool_input has
 *  only `pattern` and optional `path` (no output_mode/glob/type/case-sensitivity knobs like Grep
 *  has -- confirmed against the tool's own schema), so those two fields are the whole signature. */
function globSignature(toolInput: Record<string, unknown>): string | null {
  const pattern = toolInput['pattern']
  if (typeof pattern !== 'string' || pattern === '') return null
  const path = typeof toolInput['path'] === 'string' ? toolInput['path'] : ''
  return JSON.stringify([pattern, path])
}

const { post: postGlobHandler, pre: preGlobDedupHandler } = makeDedupHintHandlers({
  toolName: 'Glob',
  buildSignature: globSignature,
  recordQuery: recordGlobQuery,
  getMatchCount: getGlobMatchCount,
  minMatchesConfigKey: 'glob_dedup_min_matches',
  statName: 'glob_dedup_hint',
})

/**
 * pre_tool_use handler for the Glob tool.
 *
 * Checks for broad catch-all wildcard patterns and advises `token-goat map --compact`,
 * or delegates to dedup recall hints.
 */
function preGlobHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Glob') return passOutput()
    const toolInput = getToolInput(event)
    const pattern = typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : ''
    const pathArg =
      typeof toolInput['path'] === 'string'
        ? toolInput['path']
        : typeof toolInput['paths'] === 'string'
          ? toolInput['paths']
          : Array.isArray(toolInput['paths']) && toolInput['paths'].length === 1 && typeof toolInput['paths'][0] === 'string'
            ? toolInput['paths'][0]
            : undefined

    if (pattern && isBroadCatchAllGlob(pattern, pathArg)) {
      recordStat('session_hint', 0, 0)
      return contextOutput(
        'Broad recursive glob pattern "' +
          displaySafeText(pattern) +
          '" traverses entire directory trees and may dump thousands of paths into context. Use `token-goat map --compact` to inspect project directory structure efficiently, or narrow the glob path.',
      )
    }

    return preGlobDedupHandler(event)
  } catch {
    return passOutput()
  }
}

export { postGlobHandler, preGlobDedupHandler, preGlobHandler }

// Registered after hooks_read.ts's preReadHandler (see relay.ts import order) so a correctness-relevant deny there (node_modules, oversized file) always takes priority over this purely advisory recall hint.
registerHook('pre_tool_use', preGlobHandler, { toolName: 'Glob' })
registerHook('post_tool_use', postGlobHandler, { toolName: 'Glob' })
