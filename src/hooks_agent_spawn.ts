/**
 * Subagent briefing pack hook.
 *
 * pre_tool_use: When an Agent tool (subagent spawn) fires, append a compact
 * project-context briefing to the subagent's prompt field. The briefing includes
 * a one-line project map, a few cached output IDs to hint at re-use opportunities,
 * and an imperative gate directing the subagent to check for a token-goat command before its first read.
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
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

/**
 * Target token budget for the entire briefing (project map + cached ids + reminder).
 * Measured against this repo's own compact map (46 tokens) plus a realistic mid-size project's
 * compact map (~140 tokens, e.g. "Files: 640" + 10 top symbols) combined with the current
 * imperative reminder (136 tokens, grown from a one-liner in c574b1f6) and a 1-3 entry cache-ids
 * block (26-50 tokens): worst-case realistic total lands around 300-370 tokens. 300 left ~zero
 * headroom, so the cache-ids block was silently dropped on essentially every real spawn (cycle
 * 121 regression). 450 leaves a real margin above that; revisit this number again if the reminder
 * text grows further.
 */
const BRIEFING_TARGET_TOKENS = 450

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
    const head: string[] = []
    head.push('')
    head.push('## Session briefing (for context)')

    // 1. Project map summary
    try {
      const map = buildProjectMap(process.cwd(), { compact: true })
      const mapText = formatProjectMap(map, map.compact)
      head.push(mapText)
    } catch {
      // Project map unavailable — skip it and continue with cached ids/reminder
    }

    // 2. Recent cached output IDs (2-3 most recent) -- built separately from `head`/`tail` so it
    // can be dropped as a whole when over budget, without touching either.
    let cacheIdsBlock = ''
    try {
      const outputs = getSessionBashOutputs()
      if (outputs.length > 0) {
        const recent = outputs.slice(-3).reverse()
        const idsList = recent
          .map(([_hash, id]) => {
            const entry = getBashOutput(id)
            const label = entry ? ` (~${toKB(entry.output.length)}KB)` : ''
            return '`token-goat bash-output ' + id + '`' + label
          })
          .join(', ')
        cacheIdsBlock = '\n\nCached outputs this session: ' + idsList
      }
    } catch {
      // Bash output unavailable — skip and continue with reminder
    }

    // 3. Surgical-read reminder
    const tail: string[] = []
    tail.push('')
    tail.push('Before your first read of any file, check for a token-goat command that returns just what you need and run it instead of a full-file read or wide grep: `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::<heading>"`. Skipping that check is a violation, not an oversight; the only exemptions are a file under ~200 lines you need whole, a never-indexed file, or an image.')

    const withCacheIds = head.join('\n') + cacheIdsBlock + '\n' + tail.join('\n')
    if (estimateTokens(withCacheIds) <= BRIEFING_TARGET_TOKENS) {
      return withCacheIds
    }

    // Over budget: drop the cache-ids block first -- it's the nice-to-have re-use hint, not the
    // load-bearing map/reminder content -- and re-check before falling back to a lossy trim.
    const withoutCacheIds = head.join('\n') + '\n' + tail.join('\n')
    const tokens = estimateTokens(withoutCacheIds)
    if (tokens <= BRIEFING_TARGET_TOKENS) {
      return withoutCacheIds
    }

    // Still over budget with the map alone (e.g. a very large project tree): trim from the end as
    // a last resort. This can still cut into the reminder, but only once dropping the cache-ids
    // block was already insufficient, not as the first thing tried.
    return withoutCacheIds.slice(0, Math.floor((withoutCacheIds.length * BRIEFING_TARGET_TOKENS) / tokens))
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

// Well above the ~2,220 char/call average measured from real claude-skills session transcripts, so only genuine outlier reports get cached -- typical subagent reports are completely untouched.
const AGENT_RESULT_CACHE_MIN_BYTES = 8000

// A fenced block must exceed this many lines before any of it is elided, and this many lines are kept at each end. A subagent's report is already-distilled PROSE with no safe way to shrink it losslessly, so prose is never touched by this handler -- caveats, limitations, and "I did not verify X" admissions live there, and those are precisely the sentences that catch a subagent shipping something it did not check (three consecutive self-improvement cycles caught a real defect exactly that way). What IS safely reducible is what agents paste INTO fenced blocks: gate transcripts, `git diff --stat` tables, dogfood output. Those are mechanically reproducible from the repo, and the full text stays one `mcp-output <id>` away, so eliding their middle costs the parent nothing it cannot recover on demand.
const FENCE_COLLAPSE_MIN_LINES = 20
const FENCE_COLLAPSE_KEEP_LINES = 6

// Collapse the middle of over-long fenced code blocks, leaving every non-fenced line byte-identical. Fence tracking is a simple open/close toggle on ``` at the start of a trimmed line, matching how the reports are actually written; an unterminated fence at end-of-text is deliberately left alone rather than collapsed, since without a closing marker there is no way to tell a code block from prose that merely began with a fence.
export function collapseFencedBlocks(text: string, recallHint: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let fenceStart = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const isFenceMarker = line.trimStart().startsWith('```')
    if (fenceStart === -1) {
      if (isFenceMarker) fenceStart = i
      else out.push(line)
      continue
    }
    if (!isFenceMarker) continue
    // Closing marker reached: `fenceStart`..`i` is one complete block, body exclusive of both markers.
    const bodyLines = i - fenceStart - 1
    if (bodyLines > FENCE_COLLAPSE_MIN_LINES) {
      out.push(...lines.slice(fenceStart, fenceStart + 1 + FENCE_COLLAPSE_KEEP_LINES))
      out.push(`[token-goat: ${bodyLines - FENCE_COLLAPSE_KEEP_LINES * 2} lines elided -- full report via ${recallHint}]`)
      out.push(...lines.slice(i - FENCE_COLLAPSE_KEEP_LINES, i + 1))
    } else {
      out.push(...lines.slice(fenceStart, i + 1))
    }
    fenceStart = -1
  }
  // An unterminated trailing fence is emitted verbatim rather than collapsed: with no closing marker there is no way to tell a real code block from prose that merely began with a backtick line, and this handler never guesses at the parent's expense.
  if (fenceStart !== -1) out.push(...lines.slice(fenceStart))
  return out.join('\n')
}

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
    // `--full` is load-bearing, not decoration: a bare `mcp-output <id>` render elides its own middle past the default head 30 / tail 80, so pointing at it would promise a full report the CLI cannot produce -- the elided fence middles would be exactly what a bare recall drops again.
    const recallHint = `token-goat mcp-output ${id} --full`
    const notice = `[token-goat] This subagent report (${toKB(resultText.length)}KB) is cached for later recall: ${recallHint}`

    // Compact the envelope only when the fenced-block collapse actually pays for the notice it adds, using the same shared net-benefit gate as every other rewrite path (hooks_bashoutput, hooks_taskoutput, bash_runner). A report that is long purely because it is long PROSE collapses to nothing here and correctly falls through to the annotate-only path below, which is the pre-existing behavior.
    const collapsed = collapseFencedBlocks(resultText, recallHint)
    const originalBytes = Buffer.byteLength(resultText, 'utf-8')
    if (
      collapsed !== resultText &&
      isRewriteWorthwhile({
        originalBytes,
        rewrittenBytes: Buffer.byteLength(collapsed, 'utf-8'),
        noticeBytes: Buffer.byteLength(notice, 'utf-8'),
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
    ) {
      return { hookType: 'rewriteOutput', updatedOutput: `${collapsed}\n\n${notice}` }
    }

    return contextOutput(notice)
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preAgentHandler, { toolName: 'Agent' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'Agent' })
