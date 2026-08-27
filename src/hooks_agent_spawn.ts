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
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { registerHook, type HookEvent } from './hook_registry.js'
import type { HookOutput } from './types.js'
import { passOutput, contextOutput, extractToolResultText } from './hooks_common.js'
import { buildProjectMap, formatProjectMap } from './baseline.js'
import { getOutstandingAgentSpawns, getSessionBashOutputs, markHintShown, recordOutstandingAgentSpawn, removeOutstandingAgentSpawn, wasHintShown } from './session.js'
import { getBashOutput } from './bash_output_cache.js'
import { estimateTokens } from './compact.js'
import { toKB } from './util.js'
import { storeMcpOutput } from './mcp_cache.js'
import { recordStat } from './stats.js'
import { redactSecrets } from './secret_redact.js'
import { loadConfig } from './config.js'
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/index.js'
import { getHarnessName } from './bridges/registry.js'

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

    // 2. Recent cached output IDs (2-3 most recent) -- built separately from `head`/`tail` so it can be dropped as a whole when over budget, without touching either.
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

    // 3. Surgical-read reminder, plus the report-contract clause. Both are load-bearing (dropped only in the last-resort tail-slice below, after the cache-ids block is already gone) -- the contract is what makes a spawned subagent's report cite evidence instead of pasting it, and its "state every unverified claim explicitly" clause is what has caught a subagent shipping something it never checked, three cycles running.
    const tail: string[] = []
    tail.push('')
    tail.push('Before your first read of any file, check for a token-goat command that returns just what you need and run it instead of a full-file read or wide grep: `token-goat symbol <name>`, `token-goat read "file::symbol"`, `token-goat section "file::<heading>"`. Skipping that check is a violation, not an oversight; the only exemptions are a file under ~200 lines you need whole, a never-indexed file, or an image.')
    tail.push('')
    tail.push('Report contract: cite evidence as `file::symbol` or a token-goat recall id (`token-goat mcp-output <id> --full`) rather than pasting bodies; paste a fenced block only when the exact bytes are load-bearing; state every unverified claim explicitly (e.g. "not verified: ...") rather than omitting it.')

    const withCacheIds = head.join('\n') + cacheIdsBlock + '\n' + tail.join('\n')
    if (estimateTokens(withCacheIds) <= BRIEFING_TARGET_TOKENS) {
      return withCacheIds
    }

    // Over budget: drop the cache-ids block first -- it's the nice-to-have re-use hint, not the load-bearing map/reminder content -- and re-check before falling back to a lossy trim.
    const withoutCacheIds = head.join('\n') + '\n' + tail.join('\n')
    const tokens = estimateTokens(withoutCacheIds)
    if (tokens <= BRIEFING_TARGET_TOKENS) {
      return withoutCacheIds
    }

    // Still over budget with the map alone (e.g. a very large project tree): trim from the end as a last resort. This can still cut into the reminder, but only once dropping the cache-ids block was already insufficient, not as the first thing tried.
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

function isAgentTool(toolName: string | undefined): boolean {
  return toolName === 'Agent' || toolName === 'task' || toolName === 'Task'
}

function preAgentHandler(event: HookEvent): HookOutput {
  // Only fire on Agent or Copilot task tool
  if (!isAgentTool(event.toolName)) return passOutput()

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
// The info-string tail is `[^\n]*`, not `.*`, for the same reason markdown_lines.ts's eachUnfencedLine uses it: a JS regex `.` excludes `\r`, so a CRLF-terminated fence line (a report that pasted Windows command output into a block) matched nothing and every fenced block went uncollapsed.
const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/

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

// Intra-report cross-fence dedup: when the SAME complete fenced-block body (byte-for-byte) appears more than once in one report, every occurrence after the first is replaced with a marker pointing at the cached full report -- never at "block N", since mcp-output has no way to address an individual block. Deliberately intra-report only: comparing across sessions/reports would be "the gate was not re-run", the exact admission this design exists to preserve, not a savings opportunity. Body hashes are computed from `original` (pre-collapse) so two blocks that only look alike after collapseFencedBlocks elided their middles are never mistaken for duplicates; block BOUNDARIES for the actual replacement are read from `collapsed` (post-collapse) so a marker never points at a block whose visible content collapseFencedBlocks already elided out from under it -- running dedup after collapse, on collapse's own output, is what keeps that in sync.
export function dedupeFencedBlocks(collapsed: string, original: string, recallHint: string): string {
  const originalLines = original.split('\n')
  const originalBlocks = findFencedBlockLines(originalLines)
  if (originalBlocks.length < 2) return collapsed

  const collapsedLines = collapsed.split('\n')
  const collapsedBlocks = findFencedBlockLines(collapsedLines)
  // Structural mismatch (should not happen: collapseFencedBlocks never adds or removes fence boundaries) -- fail safe by declining to touch anything rather than guessing at an index.
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

// Collapse runs of MORE THAN two blank lines to exactly two, but ONLY inside fenced blocks -- never touching prose, which stays byte-identical per the core design rule. No count marker (a blank line carries no evidence or caveat worth pointing a recall hint at) and no recomputation of anything: this deliberately runs LAST, after collapseFencedBlocks and dedupeFencedBlocks have already finished, on their combined output -- never before slicing -- so it can never perturb the bodyLines count collapseFencedBlocks used to decide what to elide, nor the `keep_lines <= floor((min_lines-1)/2)` clamp that keeps that math from going negative (see config.ts). Explicitly NOT dedupeConsecutive (src/tool_filters/helpers.ts): that helper's default `${line} (×${count})` formatter would inject a token-goat annotation into a region this design promises stays byte-identical.
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

/** Session-hint dedupe key for the unrestricted-spawn advisory below: fires at most once per session. */
const SPAWN_RESTRICT_HINT_KEY = 'agent-spawn-restrict-hint'

/** How many restricted agent names the advisory lists by name before collapsing the rest into a count. */
const SPAWN_RESTRICT_MAX_NAMES = 3

/** Depth cap for the roster walk. The common layouts are flat files in ~/.claude/agents and symlinked collection directories one level down, so 4 leaves margin without letting a pathological tree run away. */
const ROSTER_WALK_MAX_DEPTH = 4

/** Hard cap on definition files parsed per scan, so a mispointed or gigantic roster directory cannot stall a post-tool hook. */
const ROSTER_WALK_MAX_FILES = 400

/**
 * Parse a Claude Code agent-definition markdown file's YAML frontmatter, answering the one question
 * the unrestricted-spawn advisory needs: does this definition carry a `tools:` allowlist? Corpus
 * measurement (loop 48, 5,988 lanes) showed the allowlist is the causal lever on spawn-prefix cost:
 * an agent WITHOUT one inherits every tool and MCP schema into its lane's system prompt, and typing
 * alone changes nothing. Returns null when the file has no parseable frontmatter at all.
 *
 * `restricted` means: a `tools:` key exists and its value is neither empty nor the inherit-everything
 * `*`. Both the inline comma-list form and the indented block-list form count; a `tools:` line with
 * no value and no block items is treated as absent (unrestricted), the conservative direction for a
 * gate whose false positive would recommend an agent that saves nothing.
 */
export function parseAgentDefinition(text: string, fallbackName: string): { name: string; restricted: boolean } | null {
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!fmMatch) return null
  const fm = fmMatch[1] as string
  // `(.*)$` under /m stops before \n but captures a trailing \r, so every capture below is trimmed before use (see the CRLF line-end-predicate defect class).
  const nameMatch = /^name:(.*)$/m.exec(fm)
  const rawName = nameMatch ? (nameMatch[1] as string).trim().replace(/^["']|["']$/g, '') : ''
  const name = rawName !== '' ? rawName : fallbackName
  const toolsMatch = /^tools:(.*)$/m.exec(fm)
  if (!toolsMatch) return { name, restricted: false }
  const inline = (toolsMatch[1] as string).trim()
  if (inline === '*' || inline === '"*"' || inline === "'*'") return { name, restricted: false }
  if (inline !== '') return { name, restricted: true }
  // Bare `tools:` line: the allowlist, if any, is an indented block list on the following lines. Stop at the first non-indented line, which is the next top-level frontmatter key.
  const after = fm.slice(toolsMatch.index + toolsMatch[0].length)
  for (const line of after.split(/\r?\n/)) {
    if (/^\s+-\s*\S/.test(line)) return { name, restricted: true }
    if (/^\S/.test(line)) break
  }
  return { name, restricted: false }
}

/**
 * Scan the machine-level agent roster (~/.claude/agents, recursively, following symlinked collection
 * directories with a realpath cycle guard) and return the sorted names of every definition that
 * carries a `tools:` allowlist. This is the advisory's existence gate: with no restricted definition
 * on the machine there is nothing actionable to recommend, and an unclearable warning trains the
 * user to ignore every warning the tool emits. Deliberately home-level only, not <cwd>/.claude/agents:
 * the gate asks whether a restricted definition exists ON THE MACHINE, and a cwd-relative root would
 * make the answer flap with the directory the harness happened to launch the hook from.
 */
export function findRestrictedAgentNames(roots?: readonly string[]): string[] {
  const scanRoots = roots ?? [path.join(os.homedir(), '.claude', 'agents')]
  const names = new Set<string>()
  const visited = new Set<string>()
  let filesSeen = 0
  const walk = (dir: string, depth: number): void => {
    if (depth > ROSTER_WALK_MAX_DEPTH || filesSeen >= ROSTER_WALK_MAX_FILES) return
    let real: string
    try {
      real = fs.realpathSync(dir)
    } catch {
      return
    }
    const key = process.platform === 'win32' ? real.toLocaleLowerCase() : real
    if (visited.has(key)) return
    visited.add(key)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (filesSeen >= ROSTER_WALK_MAX_FILES) return
      const full = path.join(dir, entry.name)
      // statSync rather than the Dirent flags because a symlinked collection directory reports isDirectory() false on its Dirent; the visited-set above keeps a link cycle from recursing forever.
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!stat.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      filesSeen++
      let text: string
      try {
        text = fs.readFileSync(full, 'utf-8')
      } catch {
        continue
      }
      const parsed = parseAgentDefinition(text, path.basename(entry.name, path.extname(entry.name)))
      if (parsed !== null && parsed.restricted) names.add(parsed.name)
    }
  }
  for (const root of scanRoots) walk(root, 0)
  return Array.from(names).sort()
}

/**
 * Build the once-per-session unrestricted-spawn advisory, or '' when it does not apply.
 *
 * Trigger: the finished spawn ran as general-purpose, either because `subagent_type` was absent
 * (620 of 3,167 corpus spawn blocks) or because it named general-purpose explicitly; both are
 * definitionally unrestricted with no definition file to resolve, which is the only restriction
 * status observable at the hook without reading a roster file for the spawned type. Gate: at least
 * one tools-restricted agent definition exists in ~/.claude/agents, so the advice is actionable and
 * the hint clearable. Dedupe: once per session via the persisted hints-shown set.
 *
 * Accounting: recorded as a zero-credit `session_hint`. The advisory fires AFTER the spawn it
 * observed and cannot save that spawn: the counterfactual it might improve (the user's next spawn,
 * or their roster) is not a branch this code blocks, so crediting anything would repeat the
 * advisory-credited-the-full-file defect class. The text says so explicitly for the same reason.
 */
export function buildUnrestrictedSpawnAdvisory(toolInput: Record<string, unknown>): string {
  try {
    // Gated off entirely on Copilot CLI, for two independent reasons established in src/bridges/copilot_cli.ts: (1) this advisory rides post_tool_use additionalContext, which Copilot's 1.0.80 bundle drops on the JS path (no onAdditionalContext supplier, no additional_contexts key in that event's native return payload), so it would be emitted into a void while still burning the once-per-session hint budget and recording a session_hint stat for text nobody received; (2) the advisory's content is Claude Code's Task schema (subagent_type, ~/.claude/agents rosters) -- Copilot's own task tool carries no subagent_type argument, so the absent-field trigger would misclassify every Copilot task spawn as an untyped general-purpose spawn even if the channel delivered. Other bridges are not gated here: their task-tool wire shapes are unverified (loop-ledger BE-06) and their bridges forward additionalContext, so suppressing them would rest on inference.
    if (getHarnessName() === 'copilot_cli') return ''
    const rawType = toolInput['subagent_type']
    const spawnType = typeof rawType === 'string' ? rawType.trim() : ''
    if (spawnType !== '' && spawnType !== 'general-purpose') return ''
    if (wasHintShown(SPAWN_RESTRICT_HINT_KEY)) return ''
    const names = findRestrictedAgentNames()
    if (names.length === 0) return ''
    markHintShown(SPAWN_RESTRICT_HINT_KEY)
    recordStat('session_hint', 0, 0, undefined, 'agent-spawn-restrict')
    const shown = names.slice(0, SPAWN_RESTRICT_MAX_NAMES).join(', ')
    const more = names.length > SPAWN_RESTRICT_MAX_NAMES ? ` and ${names.length - SPAWN_RESTRICT_MAX_NAMES} more` : ''
    return `[token-goat] This spawn ran as general-purpose (the default when subagent_type is omitted), which is unrestricted: its lane starts by paying for every tool and MCP schema on the machine. Tools-restricted agent definitions exist here: ${shown}${more}. A future spawn that fits one of them can pass that name as subagent_type to start with a much smaller prefix. Advisory only: this spawn has already run, and this notice saved nothing.`
  } catch {
    return ''
  }
}

function postAgentHandler(event: HookEvent): HookOutput {
  try {
    if (!isAgentTool(event.toolName) || !event.sessionId) return passOutput()

    // Clear this spawn's outstanding-prompt entry so a later, unrelated Agent spawn with similar wording is not incorrectly flagged as a duplicate of a call that has already finished.
    const finishedPrompt = event.toolInput['prompt']
    if (typeof finishedPrompt === 'string' && finishedPrompt !== '') {
      removeOutstandingAgentSpawn(finishedPrompt)
    }

    // Redact BEFORE anything downstream reads the report, so the compacted envelope this handler hands the model and the blob storeMcpOutput() writes to disk are the same sanitized text. They were not: storeMcpOutput redacts its own copy (see mcp_cache.ts), while the rewriteOutput branch below built `updatedOutput` from the raw result -- so a credential a subagent pasted into its report was redacted on disk and raw in the model's context, in text token-goat itself authored. Redacting at the single point the report enters this handler is what keeps every consumer below on one sanitized source instead of each having to remember.
    const redactedReport = redactSecrets(extractToolResultText(event.raw))
    const resultText = redactedReport.text
    const agentReportCfg = loadConfig().agent_report
    // Built before the min_bytes early returns because the advisory is about the SPAWN, not the report: a lane that came back with a two-line answer paid the same unrestricted prefix. On the early-return paths it rides alone as the whole context output; past them it is folded into `notice` below, BEFORE the net-benefit gate prices that notice, so the gate-then-emit-extra accounting trap cannot reappear here.
    const spawnAdvisory = buildUnrestrictedSpawnAdvisory(event.toolInput)
    if (!resultText || resultText.length < agentReportCfg.min_bytes) {
      return spawnAdvisory === '' ? passOutput() : contextOutput(spawnAdvisory)
    }
    const id = storeMcpOutput(event.sessionId, event.toolName ?? 'Agent', event.toolInput, resultText)
    if (id === null) return spawnAdvisory === '' ? passOutput() : contextOutput(spawnAdvisory)
    // Recorded here rather than at the redaction above, and here rather than inside either branch below, because this is the first point past which the redacted report is guaranteed to reach someone: it is now in the cache, and both remaining returns (the compacted rewrite and the annotate-only notice) hand back or point at that same sanitized text. Recording at the redaction itself would credit the early `min_bytes` return, where the raw report reaches the model untouched. `storeMcpOutput`'s own redaction pass finds nothing left to strip now that the text arrives clean, so its disk_cache stat reports zero -- this replaces that count rather than double-counting it.
    if (redactedReport.count > 0) recordStat('secret_redacted', 0, redactedReport.count, undefined, 'agent')
    recordStat('session_hint', 0, 0)
    // `--full` is load-bearing, not decoration: a bare `mcp-output <id>` render elides its own middle past the default head 30 / tail 80, so pointing at it would promise a full report the CLI cannot produce -- the elided fence middles would be exactly what a bare recall drops again.
    const recallHint = `token-goat mcp-output ${id} --full`
    const notice = `[token-goat] This subagent report (${toKB(resultText.length)}KB) is cached for later recall: ${recallHint}${spawnAdvisory === '' ? '' : `\n${spawnAdvisory}`}`

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
registerHook('pre_tool_use', preAgentHandler, { toolName: 'task' })
registerHook('pre_tool_use', preAgentHandler, { toolName: 'Task' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'Agent' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'task' })
registerHook('post_tool_use', postAgentHandler, { toolName: 'Task' })
