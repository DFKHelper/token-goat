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

import { createHash } from 'node:crypto'
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
import { loadConfig } from './config.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'

/**
 * Target token budget for the entire briefing (project map + cached ids + reminder + report
 * contract). Measured against this repo's own compact map (46 tokens) plus a realistic mid-size
 * project's compact map (~140 tokens, e.g. "Files: 640" + 10 top symbols) combined with the
 * imperative surgical-read reminder (136 tokens, grown from a one-liner in c574b1f6), the report
 * contract added below (~95 tokens), and a 1-3 entry cache-ids block (26-50 tokens): worst-case
 * realistic total lands around 400-470 tokens. 450 left too little headroom once the contract was
 * added, so 550 leaves a real margin above that; revisit this number again if either tail block
 * grows further.
 */
const BRIEFING_TARGET_TOKENS = 550

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

    // 3. Surgical-read reminder, plus the report-contract clause. Both are load-bearing (dropped
    // only in the last-resort tail-slice below, after the cache-ids block is already gone) --
    // the contract is what makes a spawned subagent's report cite evidence instead of pasting it,
    // and its "state every unverified claim explicitly" clause is what has caught a subagent
    // shipping something it never checked, three cycles running.
    const tail: string[] = []
    tail.push('')
    tail.push('Before your first read of any file, check for a token-goat command that returns just what you need and run it instead of a full-file read or wide grep: `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::<heading>"`. Skipping that check is a violation, not an oversight; the only exemptions are a file under ~200 lines you need whole, a never-indexed file, or an image.')
    tail.push('')
    tail.push('Report contract: cite evidence as `file::symbol` or a token-goat recall id (`token-goat mcp-output <id> --full`) rather than pasting bodies; paste a fenced block only when the exact bytes are load-bearing; state every unverified claim explicitly (e.g. "not verified: ...") rather than omitting it.')

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

// Thresholds live in config (agent_report.*, see config.ts) rather than as literals here so an operator can retune or disable envelope compaction without a rebuild, matching how every other compaction subsystem in this codebase is tuned. A subagent's report is already-distilled PROSE with no safe way to shrink it losslessly, so prose is never touched by this handler -- caveats, limitations, and "I did not verify X" admissions live there, and those are precisely the sentences that catch a subagent shipping something it did not check (three consecutive self-improvement cycles caught a real defect exactly that way). What IS safely reducible is what agents paste INTO fenced blocks: gate transcripts, `git diff --stat` tables, dogfood output. Those are mechanically reproducible from the repo, and the full text stays one `mcp-output <id> --full` away, so eliding their middle costs the parent nothing it cannot recover on demand.

// A fence line per CommonMark: up to 3 leading spaces, then a run of 3+ backticks or 3+ tildes, then an optional info string. Capturing the run (not just "starts with ```") is what makes nesting safe -- see collapseFencedBlocks.
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

interface FencedBlockLines {
  /** Line index of the opening fence marker. */
  fenceStart: number
  /** Line index of the closing fence marker (inclusive). */
  closerIndex: number
}

// Shared CommonMark-following fence scanner used by both collapseFencedBlocks and dedupeFencedBlocks, so both stay in agreement about where a complete fenced block begins and ends: an unterminated trailing fence (no closer) is deliberately NOT reported as a block by either caller -- see collapseFencedBlocks's own comment for why.
function findFencedBlockLines(lines: readonly string[]): FencedBlockLines[] {
  const blocks: FencedBlockLines[] = []
  let fenceStart = -1
  let openMarker = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const match = FENCE_LINE_RE.exec(line)
    if (fenceStart === -1) {
      if (match !== null) {
        fenceStart = i
        openMarker = match[1]!
      }
      continue
    }
    const isCloser =
      match !== null &&
      match[1]![0] === openMarker[0] &&
      match[1]!.length >= openMarker.length &&
      match[2]!.trim() === ''
    if (!isCloser) continue
    blocks.push({ fenceStart, closerIndex: i })
    fenceStart = -1
  }
  return blocks
}

// Collapse the middle of over-long fenced code blocks, leaving every non-fenced line byte-identical. Fence matching follows CommonMark rather than a naive ```-toggle, because agent reports routinely quote markdown AT us: a report that pastes a snippet containing its own ``` fence, or wraps an example in a 4-backtick fence, would close a toggle at the wrong line and mis-slice the surrounding prose. A block therefore ends only at a fence of the SAME character, at least as long as the opener, carrying no info string; anything else inside is content. An unterminated fence at end-of-text is emitted verbatim rather than collapsed, since without a closing marker there is no way to tell a code block from prose that merely began with a fence.
export function collapseFencedBlocks(text: string, recallHint: string, minLines: number, keepLines: number): string {
  const lines = text.split('\n')
  const blocks = findFencedBlockLines(lines)
  const out: string[] = []
  let cursor = 0
  for (const { fenceStart, closerIndex } of blocks) {
    out.push(...lines.slice(cursor, fenceStart))
    const bodyLines = closerIndex - fenceStart - 1
    if (bodyLines > minLines) {
      out.push(...lines.slice(fenceStart, fenceStart + 1 + keepLines))
      out.push(`[token-goat: ${bodyLines - keepLines * 2} lines elided -- full report via ${recallHint}]`)
      out.push(...lines.slice(closerIndex - keepLines, closerIndex + 1))
    } else {
      out.push(...lines.slice(fenceStart, closerIndex + 1))
    }
    cursor = closerIndex + 1
  }
  // Whatever follows the last complete block -- including an unterminated trailing fence -- is emitted verbatim: with no closing marker there is no way to tell a real code block from prose that merely began with a backtick line, and this handler never guesses at the parent's expense.
  out.push(...lines.slice(cursor))
  return out.join('\n')
}

// Intra-report cross-fence dedup: when the SAME complete fenced-block body (byte-for-byte) appears
// more than once in one report, every occurrence after the first is replaced with a marker pointing
// at the cached full report -- never at "block N", since mcp-output has no way to address an
// individual block. Deliberately intra-report only: comparing across sessions/reports would be "the
// gate was not re-run", the exact admission this design exists to preserve, not a savings
// opportunity. Body hashes are computed from `original` (pre-collapse) so two blocks that only look
// alike after collapseFencedBlocks elided their middles are never mistaken for duplicates; block
// BOUNDARIES for the actual replacement are read from `collapsed` (post-collapse) so a marker never
// points at a block whose visible content collapseFencedBlocks already elided out from under it --
// running dedup after collapse, on collapse's own output, is what keeps that in sync.
export function dedupeFencedBlocks(collapsed: string, original: string, recallHint: string): string {
  const originalLines = original.split('\n')
  const originalBlocks = findFencedBlockLines(originalLines)
  if (originalBlocks.length < 2) return collapsed

  const collapsedLines = collapsed.split('\n')
  const collapsedBlocks = findFencedBlockLines(collapsedLines)
  // Structural mismatch (should not happen: collapseFencedBlocks never adds or removes fence
  // boundaries) -- fail safe by declining to touch anything rather than guessing at an index.
  if (collapsedBlocks.length !== originalBlocks.length) return collapsed

  const bodyHashes = originalBlocks.map(({ fenceStart, closerIndex }) =>
    createHash('sha256').update(originalLines.slice(fenceStart + 1, closerIndex).join('\n')).digest('hex'),
  )

  const firstOccurrenceOf = new Map<string, number>()
  const out: string[] = []
  let cursor = 0
  let dedupedAny = false
  for (let i = 0; i < collapsedBlocks.length; i++) {
    const { fenceStart, closerIndex } = collapsedBlocks[i]!
    const hash = bodyHashes[i]!
    if (!firstOccurrenceOf.has(hash)) {
      firstOccurrenceOf.set(hash, i)
      out.push(...collapsedLines.slice(cursor, closerIndex + 1))
    } else {
      out.push(...collapsedLines.slice(cursor, fenceStart))
      out.push(`[token-goat: identical bytes to an earlier block in this report -- full report via ${recallHint}]`)
      dedupedAny = true
    }
    cursor = closerIndex + 1
  }
  out.push(...collapsedLines.slice(cursor))
  return dedupedAny ? out.join('\n') : collapsed
}

/** Number of consecutive blank lines kept when a longer run is collapsed -- fixed, not configurable: this is deliberately the "safe half" of blank-line handling with no tunable surface. */
const BLANK_RUN_KEEP = 2

// Collapse runs of MORE THAN two blank lines to exactly two, but ONLY inside fenced blocks -- never
// touching prose, which stays byte-identical per the core design rule. No count marker (a blank
// line carries no evidence or caveat worth pointing a recall hint at) and no recomputation of
// anything: this deliberately runs LAST, after collapseFencedBlocks and dedupeFencedBlocks have
// already finished, on their combined output -- never before slicing -- so it can never perturb the
// bodyLines count collapseFencedBlocks used to decide what to elide, nor the
// `keep_lines <= floor((min_lines-1)/2)` clamp that keeps that math from going negative (see
// config.ts). Explicitly NOT dedupeConsecutive (src/tool_filters/helpers.ts): that helper's default
// `${line}  (×${count})` formatter would inject a token-goat annotation into a region this design
// promises stays byte-identical.
export function collapseBlankRunsInFences(text: string): string {
  const lines = text.split('\n')
  const blocks = findFencedBlockLines(lines)
  if (blocks.length === 0) return text
  const out: string[] = []
  let cursor = 0
  let changedAny = false
  for (const { fenceStart, closerIndex } of blocks) {
    out.push(...lines.slice(cursor, fenceStart + 1))
    let blankRun = 0
    for (let i = fenceStart + 1; i < closerIndex; i++) {
      const line = lines[i]!
      if (line === '') {
        blankRun++
        if (blankRun <= BLANK_RUN_KEEP) out.push(line)
        else changedAny = true
      } else {
        blankRun = 0
        out.push(line)
      }
    }
    out.push(lines[closerIndex]!)
    cursor = closerIndex + 1
  }
  out.push(...lines.slice(cursor))
  return changedAny ? out.join('\n') : text
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
    const agentReportCfg = loadConfig().agent_report
    if (!resultText || resultText.length < agentReportCfg.min_bytes) return passOutput()
    const id = storeMcpOutput(event.sessionId, 'Agent', event.toolInput, resultText)
    if (id === null) return passOutput()
    recordStat('session_hint', 0, 0)
    // `--full` is load-bearing, not decoration: a bare `mcp-output <id>` render elides its own middle past the default head 30 / tail 80, so pointing at it would promise a full report the CLI cannot produce -- the elided fence middles would be exactly what a bare recall drops again.
    const recallHint = `token-goat mcp-output ${id} --full`
    const notice = `[token-goat] This subagent report (${toKB(resultText.length)}KB) is cached for later recall: ${recallHint}`

    // Compact the envelope only when the combined rewrite (fence collapse, then intra-report cross-fence dedup, then blank-run collapse) actually pays for the notice it adds, using the same shared net-benefit gate as every other rewrite path (hooks_bashoutput, hooks_taskoutput, bash_runner). A report that is long purely because it is long PROSE rewrites to nothing here and correctly falls through to the annotate-only path below, which is the pre-existing behavior.
    const collapsed = collapseFencedBlocks(resultText, recallHint, agentReportCfg.fence_collapse_min_lines, agentReportCfg.fence_collapse_keep_lines)
    // Dedup runs AFTER collapse, on collapse's own output -- see dedupeFencedBlocks's comment for why.
    const deduped = dedupeFencedBlocks(collapsed, resultText, recallHint)
    // Blank-run collapse runs LAST, on the combined output of both -- see collapseBlankRunsInFences's comment for why. All three rewrites are judged by ONE combined net-benefit check below, not separate gates: sub-threshold rewrites could each decline alone when their sum would pass, and firing the notice cost more than once would double-charge it.
    const final = collapseBlankRunsInFences(deduped)
    const originalBytes = Buffer.byteLength(resultText, 'utf-8')
    if (final !== resultText) {
      const worthwhile = isRewriteWorthwhile({
        originalBytes,
        rewrittenBytes: Buffer.byteLength(final, 'utf-8'),
        noticeBytes: Buffer.byteLength(notice, 'utf-8'),
        minNetSavingsBytes: resolveMinNetSavingsBytes(),
      })
      if (worthwhile) {
        const updatedOutput = `${final}\n\n${notice}`
        // Record the REAL saving, measured against the envelope the parent actually receives (notice included), not against the rewritten body alone -- the notice is part of what is spent to buy the compaction. The sibling session_hint event above stays at 0/0 because appending a pointer genuinely saves nothing; leaving this branch to be represented by that same zero-valued event is precisely the recordStat desync this codebase has fixed repeatedly, and it would report its single largest new saver as worth nothing.
        const savedBytes = originalBytes - Buffer.byteLength(updatedOutput, 'utf-8')
        if (savedBytes > 0) recordStat('agent_report_compact', savedBytes, Math.round(savedBytes / 4))
        return { hookType: 'rewriteOutput', updatedOutput }
      }
      // The gate declined: collapse and/or dedup rewrote something but the net savings did not clear the notice cost. Record this at (0, 0) -- like the sibling session_hint event above -- so hit-rate and near-misses are visible instead of the gate's declines being invisible, without inflating any savings total with a non-saving.
      recordStat('agent_report_compact_declined', 0, 0)
    }

    return contextOutput(notice)
  } catch {
    return passOutput()
  }
}

registerHook('pre_tool_use', preAgentHandler, { toolName: 'Agent' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'Agent' })
