/**
 * post_tool_use / pre_tool_use handlers for the Grep tool.
 *
 * Grep has no other output-side treatment anywhere in the codebase: unlike Read/Bash/WebFetch,
 * a repeated identical Grep just silently re-runs. This records each Grep's match count keyed by
 * (pattern, path, output_mode, glob) so an identical repeat later in the session, once the last
 * known match count meets hints.grep_dedup_min_matches, gets a recall-style advisory instead.
 */
import type { HookEvent } from './hook_registry.js'
import { registerHook } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, contextOutput, getToolName, getToolInput, extractToolResponseField } from './hooks_common.js'
import { recordGrepQuery, getGrepMatchCount } from './session.js'
import { recordStat } from './stats.js'
import { loadConfig } from './config.js'

function extractToolResponse(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, ['output', 'content', 'text', 'body'])
}

/** Non-empty lines in `text`, used as a match-count proxy across every Grep output_mode
 *  (one line per matched file in `files_with_matches`, one per matched line in `content`,
 *  one per file in `count`). Deliberately approximate: `count` mode undercounts the true
 *  total match tally, but the result stays monotonic with real result size either way. */
function countNonEmptyLines(text: string): number {
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0).length
}

/** Session-scoped identity for a Grep call: two calls with the same signature searched the
 *  same thing the same way. Returns null when there is no pattern to key on. */
function grepSignature(toolInput: Record<string, unknown>): string | null {
  const pattern = toolInput['pattern']
  if (typeof pattern !== 'string' || pattern === '') return null
  const path = typeof toolInput['path'] === 'string' ? toolInput['path'] : ''
  const outputMode = typeof toolInput['output_mode'] === 'string' ? toolInput['output_mode'] : 'files_with_matches'
  const glob = typeof toolInput['glob'] === 'string' ? toolInput['glob'] : ''
  return JSON.stringify([pattern, path, outputMode, glob])
}

export function postGrepHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Grep') return passOutput()
    const signature = grepSignature(getToolInput(event))
    if (signature === null) return passOutput()
    recordGrepQuery(signature, countNonEmptyLines(extractToolResponse(event.raw)))
    return passOutput()
  } catch {
    return passOutput()
  }
}

export function preGrepDedupHandler(event: HookEvent): HookOutput {
  try {
    if (getToolName(event) !== 'Grep') return passOutput()
    const toolInput = getToolInput(event)
    const signature = grepSignature(toolInput)
    if (signature === null) return passOutput()
    const priorCount = getGrepMatchCount(signature)
    if (priorCount === null) return passOutput()
    if (priorCount < loadConfig().hints.grep_dedup_min_matches) return passOutput()

    recordStat('grep_dedup_hint', 0, 0)
    const pattern = typeof toolInput['pattern'] === 'string' ? toolInput['pattern'] : ''
    return contextOutput(
      'Note: an identical Grep for "' + pattern + '" already ran this session and returned ' +
        priorCount + (priorCount === 1 ? ' match' : ' matches') +
        '. If that result already answers this, you can skip re-running it.',
    )
  } catch {
    return passOutput()
  }
}

// Registered after hooks_read.ts's preReadHandler (see relay.ts import order) so a
// correctness-relevant deny there (node_modules, oversized file) always takes priority over
// this purely advisory recall hint.
registerHook('pre_tool_use', preGrepDedupHandler, { toolName: 'Grep' })
registerHook('post_tool_use', postGrepHandler, { toolName: 'Grep' })
