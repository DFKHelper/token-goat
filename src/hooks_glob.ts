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
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, contextOutput, getToolName, getToolInput, extractToolResponseField, OUTPUT_FIRST_TOOL_RESPONSE_KEYS } from './hooks_common.js'
import { recordGlobQuery, getGlobMatchCount } from './session.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'

function extractToolResponse(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, OUTPUT_FIRST_TOOL_RESPONSE_KEYS)
}

/** Non-empty lines in `text` (one line per matched path), used as a match-count proxy for Glob's
 *  flat newline-separated path-list output. Mirrors hooks_grep.ts's countNonEmptyLines. */
function countNonEmptyLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length
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

export function postGlobHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Glob') return passOutput()
    const signature = globSignature(getToolInput(event))
    if (signature === null) return passOutput()
    recordGlobQuery(signature, countNonEmptyLines(extractToolResponse(event.raw)))
    return passOutput()
  } catch {
    return passOutput()
  }
}

export function preGlobDedupHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Glob') return passOutput()
    const toolInput = getToolInput(event)
    const signature = globSignature(toolInput)
    if (signature === null) return passOutput()
    const priorCount = getGlobMatchCount(signature)
    if (priorCount === null) return passOutput()
    if (priorCount < loadConfig().hints.glob_dedup_min_matches) return passOutput()

    recordStat('glob_dedup_hint', 0, 0)
    const pattern = typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : ''
    return contextOutput(
      'Note: an identical Glob for "' + pattern + '" already ran this session and returned ' +
        priorCount + (priorCount === 1 ? ' match' : ' matches') +
        '. If that result already answers this, you can skip re-running it.',
    )
  } catch {
    return passOutput()
  }
}

// Registered after hooks_read.ts's preReadHandler (see relay.ts import order) so a correctness-relevant deny there (node_modules, oversized file) always takes priority over this purely advisory recall hint.
registerHook('pre_tool_use', preGlobDedupHandler, { toolName: 'Glob' })
registerHook('post_tool_use', postGlobHandler, { toolName: 'Glob' })
