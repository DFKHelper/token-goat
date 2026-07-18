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
import { passOutput, contextOutput, extractToolResultText } from './hooks_common.js'
import { buildProjectMap, formatProjectMap } from './baseline.js'
import { getOutstandingAgentSpawns, getSessionBashOutputs, recordOutstandingAgentSpawn, removeOutstandingAgentSpawn } from './session.js'
import { getBashOutput } from './bash_output_cache.js'
import { estimateTokens } from './compact.js'
import { toKB } from './util.js'
import { storeMcpOutput } from './mcp_cache.js'
import { recordStat } from './stats.js'

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
            const label = entry ? ` (~${toKB(entry.output.length)}KB)` : ''
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

/**
 * Word-set Jaccard similarity threshold above which two Agent-spawn prompts are treated as
 * near-duplicates. Chosen high (0.75, within the recommended 0.7-0.8 range) to bias hard against
 * false positives: two genuinely different subagent tasks that merely share some vocabulary
 * (both mention "fix", "the file", "tests", ...) must never trip this. A missed true duplicate
 * only costs a nice-to-have warning; a false "duplicate!" on two real, different tasks is
 * actively annoying and erodes trust in the hint.
 */
const DUPLICATE_PROMPT_JACCARD_THRESHOLD = 0.75

/** Normalize `text` into its lowercase, punctuation-stripped word set for Jaccard comparison. */
function promptWordSet(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
  return new Set(words)
}

/** Word-set Jaccard similarity: |intersection| / |union|, 0 when either side has no words. */
function jaccardSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const word of a) {
    if (b.has(word)) intersection++
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Find an already-outstanding Agent-spawn prompt this session that is a near-duplicate of
 * `prompt` (Jaccard similarity >= {@link DUPLICATE_PROMPT_JACCARD_THRESHOLD}), or null if none.
 */
function findDuplicateOutstandingPrompt(prompt: string): string | null {
  const words = promptWordSet(prompt)
  for (const entry of getOutstandingAgentSpawns()) {
    if (jaccardSimilarity(words, promptWordSet(entry.prompt)) >= DUPLICATE_PROMPT_JACCARD_THRESHOLD) {
      return entry.prompt
    }
  }
  return null
}

/** Truncate `text` to `max` chars for embedding in the advisory warning, appending an ellipsis when cut. */
function truncateForWarning(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text
}

function preAgentHandler(event: HookEvent): HookOutput {
  // Only fire on Agent tool
  if (event.toolName !== 'Agent') return passOutput()

  const toolInput = event.toolInput
  const prompt = toolInput['prompt']

  // Skip if prompt is missing or empty
  if (typeof prompt !== 'string' || prompt.trim() === '') return passOutput()

  try {
    // Check for a near-duplicate BEFORE registering this prompt, so a spawn never flags itself.
    const duplicateOf = findDuplicateOutstandingPrompt(prompt)
    recordOutstandingAgentSpawn(prompt)

    const briefing = buildSubagentBriefing()
    const advisory = duplicateOf
      ? `\n\n[token-goat] A similar subagent spawn already appears to be outstanding this session (prompt starts: "${truncateForWarning(duplicateOf, 80)}"). This is advisory only -- proceeding is fine if intentional.`
      : ''

    // If there is nothing to add (briefing failed to build and no duplicate warning), pass through unchanged
    if (!briefing && !advisory) return passOutput()

    // Append briefing and/or duplicate-spawn advisory to the prompt
    const updatedPrompt = prompt + briefing + advisory
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

// Well above the ~2,220 char/call average measured from real claude-skills session transcripts, so only genuine outlier reports get cached -- typical subagent reports are completely untouched. Deliberately conservative: unlike MCP JSON (lossless structural re-encoding) or Tab Context (verified byte-identical dedup), a subagent's own report is already-distilled prose with no safe way to shrink it losslessly, so this handler never hides or truncates what the parent sees -- it only appends a recall pointer to the full text for a later turn, via contextOutput (never rewriteOutput).
const AGENT_RESULT_CACHE_MIN_BYTES = 8000

function postAgentHandler(event: HookEvent): HookOutput {
  try {
    if (event.toolName !== 'Agent' || !event.sessionId) return passOutput()

    // Clear this spawn's outstanding-prompt entry so a later, unrelated Agent spawn with similar
    // wording is not incorrectly flagged as a duplicate of a call that has already finished.
    const finishedPrompt = event.toolInput['prompt']
    if (typeof finishedPrompt === 'string' && finishedPrompt !== '') {
      removeOutstandingAgentSpawn(finishedPrompt)
    }

    const resultText = extractToolResultText(event.raw)
    if (!resultText || resultText.length < AGENT_RESULT_CACHE_MIN_BYTES) return passOutput()
    const id = storeMcpOutput(event.sessionId, 'Agent', event.toolInput, resultText)
    if (id === null) return passOutput()
    recordStat('session_hint', 0, 0)
    return contextOutput(
      `[token-goat] This subagent report (${toKB(resultText.length)}KB) is cached for later recall: token-goat mcp-output ${id}`,
    )
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preAgentHandler, { toolName: 'Agent' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'Agent' })
