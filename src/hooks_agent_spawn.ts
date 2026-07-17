/**
 * Subagent briefing pack hook.
 *
 * pre_tool_use: When an Agent tool (subagent spawn) fires, append a compact
 * project-context briefing to the subagent's prompt field. The briefing includes
 * a one-line project map, a few cached output IDs to hint at re-use opportunities,
 * and a reminder to prefer surgical reads over full-file dumps.
 *
 * Fails open: if building the briefing fails for any reason, the input is passed
 * through unchanged, never blocking a subagent spawn.
 */

import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput } from './hooks_common.js'
import { buildProjectMap, formatProjectMap } from './baseline.js'
import { getSessionBashOutputs } from './session.js'
import { getBashOutput } from './bash_output_cache.js'
import { estimateTokens } from './compact.js'

/**
 * Target token budget for the entire briefing (project map + cached ids + reminder).
 * Roughly 300 tokens, leaving room for the actual prompt and other context.
 */
const BRIEFING_TARGET_TOKENS = 300

/**
 * Build a compact subagent briefing block.
 *
 * Returns a brief formatted string with:
 * 1. One-line project-map summary (top-level structure only)
 * 2. 2-3 recent cached output IDs as re-use hints
 * 3. One-line surgical-read reminder
 *
 * Returns empty string if the briefing cannot be built (project unavailable, etc.).
 * Estimated length is kept under BRIEFING_TARGET_TOKENS for efficient context usage.
 */
function buildSubagentBriefing(): string {
  try {
    const lines: string[] = []
    lines.push('')
    lines.push('## Session briefing (for context)')

    // 1. Project map summary
    try {
      const map = buildProjectMap(process.cwd(), { compact: true })
      const mapText = formatProjectMap(map, true)
      lines.push(mapText)
    } catch {
      // Project map unavailable — skip it and continue with cached ids/reminder
    }

    // 2. Recent cached output IDs (2-3 most recent)
    try {
      const outputs = getSessionBashOutputs()
      if (outputs.length > 0) {
        lines.push('')
        const recent = outputs.slice(-3).reverse()
        const idsList = recent
          .map(([_hash, id]) => {
            const entry = getBashOutput(id)
            const label = entry ? ` (~${Math.round(entry.output.length / 1024)}KB)` : ''
            return '`token-goat bash-output ' + id + '`' + label
          })
          .join(', ')
        lines.push('Cached outputs this session: ' + idsList)
      }
    } catch {
      // Bash output unavailable — skip and continue with reminder
    }

    // 3. Surgical-read reminder
    lines.push('')
    lines.push('Prefer surgical reads over full-file dumps: `token-goat symbol <name>` / `token-goat read "file::symbol"` / `token-goat section "file::<heading>"` are cheaper alternatives that are already cached by the hook system.')

    const briefing = lines.join('\n')

    // Truncate if the briefing exceeds the token budget
    const tokens = estimateTokens(briefing)
    if (tokens > BRIEFING_TARGET_TOKENS) {
      // Trim from the end to fit the budget (keep map + reminder, sacrifice cache ids if needed)
      const trimmed = briefing.slice(0, Math.floor((briefing.length * BRIEFING_TARGET_TOKENS) / tokens))
      return trimmed
    }

    return briefing
  } catch {
    // Any error during briefing construction: fail open
    return ''
  }
}

function preAgentHandler(event: HookEvent): HookOutput {
  // Only fire on Agent tool
  if (event.toolName !== 'Agent') return passOutput()

  const toolInput = event.toolInput
  const prompt = toolInput['prompt']

  // Skip if prompt is missing or empty
  if (typeof prompt !== 'string' || prompt.trim() === '') return passOutput()

  try {
    const briefing = buildSubagentBriefing()

    // If briefing is empty (failed to build), pass through unchanged
    if (!briefing) return passOutput()

    // Append briefing to the prompt
    const updatedPrompt = prompt + briefing
    const updatedInput = { ...toolInput, prompt: updatedPrompt }

    return {
      hookType: 'rewriteInput',
      updatedInput,
    }
  } catch {
    // Any unexpected error: fail open, never block the spawn
    return passOutput()
  }
}

registerHook('pre_tool_use', preAgentHandler, { toolName: 'Agent' })
