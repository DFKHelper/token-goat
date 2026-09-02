/**
 * Corpus-wide session audit: streams every Claude Code transcript (JSONL)
 * under a corpus root (default `~/.claude/projects`) and reports where the
 * tokens actually went. Backs `token-goat session-audit`.
 *
 * Two strictly separated ledgers, never mixed in one column:
 *
 * 1. MEASURED billed tokens, read from assistant lines' `message.usage`
 *    (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
 *    `output_tokens`). Claude Code writes one JSONL line per streamed content
 *    block, and every line of one API response repeats the same `message.id`
 *    and the same usage object (confirmed empirically: 24,610 assistant lines,
 *    13,263 unique ids, 0 id collisions with differing usage). Summing per
 *    line would inflate billed totals ~1.9x, so usage is counted once per
 *    unique `message.id` per file.
 *
 * 2. ESTIMATED content attribution (which text occupies the context), using
 *    the repo's canonical `estimateTokensFromLength` (chars/3) heuristic.
 *    These are estimates of content size, not billed units: billed input
 *    counts the whole re-sent context per call, so the two ledgers are not
 *    comparable and are labelled separately everywhere.
 *
 * Privacy: this module reads transcripts for structure and size only. Its
 * output contains aggregate counts, token totals, tool names, line-type
 * names, agent-type names, and bare command heads (the binary name only) --
 * never message bodies, full command lines, file paths from inside sessions,
 * or project names.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as readline from 'node:readline'

import { estimateTokensFromLength } from './overflow_guard.js'

// ---- result shapes -----------------------------------------------------------

/** Measured billed-token rollup from deduplicated `message.usage` objects. */
export interface MeasuredUsage {
  /** Unique API responses (unique `message.id` values). */
  apiCalls: number
  /** `input_tokens`: uncached input actually billed at full rate. */
  inputTokens: number
  /** `cache_creation_input_tokens`: input written to the prompt cache. */
  cacheCreationTokens: number
  /** `cache_read_input_tokens`: input served from the prompt cache. */
  cacheReadTokens: number
  outputTokens: number
}

/** Estimated content-size rollup for one attribution category. */
export interface EstimatedCategory {
  /** JSONL lines (or content blocks, for block-level categories) counted. */
  count: number
  /** Raw content bytes counted (the ground truth the estimate derives from). */
  bytes: number
  /** chars/3 estimate over those bytes. An estimate, never a billed number. */
  estTokens: number
}

export interface ToolRollup {
  name: string
  /** tool_use invocations seen (unique tool_use ids). */
  calls: number
  /** Result content returned by the tool (estimated attribution). */
  resultBytes: number
  resultEstTokens: number
}

/** Per-attachment-kind census with a billed-cost model over the model-visible content. */
export interface AttachmentKindRollup {
  /** The harness's `attachment.type` discriminator (a fixed vocabulary, never content). */
  kind: string
  injections: number
  /** Raw JSONL line bytes, including the local-only envelope (uuid, timestamps, metadata). */
  lineBytes: number
  /** Bytes of the fields the harness actually injects into model context for this kind. */
  visibleBytes: number
  /** chars/3 estimate over visibleBytes. An estimate, never a billed number. */
  estTokens: number
  /** Sum over injections of estTokens x API calls the content stays in context (capped at the next compact boundary in the same transcript, or end of file). */
  rereadTokens: number
  /** Modeled billed cost in base-input-token equivalents: estTokens x 1.25 (cache write) + rereadTokens x 0.1 (cache read). A model, never a billed number. */
  billedEquivTokens: number
  /** Consecutive injections of this kind (within one transcript) whose visible content was byte-identical to the previous one. */
  repeatedIdentical: number
  /** Consecutive injections whose visible content changed from the previous one. */
  repeatedChanged: number
}

/** Model-visible cost of the hook_success stdout channel, split by hook origin. */
export interface HookOutputRollup {
  /** 'token-goat' when the recorded hook command invokes token-goat, else 'other'. */
  origin: 'token-goat' | 'other'
  event: string
  fires: number
  /** Raw hook stdout bytes recorded locally (display-only unless copied into `content`). */
  stdoutBytes: number
  /** Bytes of the `content` field: the portion the harness injects into model context. */
  contextBytes: number
}

/** One tenth of a session's life, by API-call index within its transcript. */
export interface PositionDecile {
  decile: number
  apiCalls: number
  /** Total measured input per call in this decile (uncached + cache-write + cache-read). */
  inputTokens: number
  cacheReadTokens: number
  outputTokens: number
}

export interface SessionAuditSummary {
  corpusDir: string
  filesScanned: number
  /** Files that existed but could not be opened or streamed. */
  filesFailed: number
  lines: number
  /** Lines that were not valid JSON (counted, sized under `otherLocal`). */
  parseFailedLines: number
  totalBytes: number
  runtimeMs: number
  measured: MeasuredUsage
  /** Sidechain (subagent) share of the measured ledger, already included in `measured`. */
  measuredSidechain: MeasuredUsage
  /** Content attribution by source. Estimated; see module doc. */
  estimated: {
    userTurns: EstimatedCategory
    toolResults: EstimatedCategory
    assistantText: EstimatedCategory
    assistantThinking: EstimatedCategory
    toolUseInputs: EstimatedCategory
    attachments: EstimatedCategory
    harnessMeta: EstimatedCategory
    system: EstimatedCategory
    /** Bookkeeping lines never sent to the model (snapshots, mode, queue ops, unparseable). */
    otherLocal: EstimatedCategory
  }
  /** Ranked by result bytes, descending; complete (never truncated). */
  tools: ToolRollup[]
  /** Per-attachment-kind census, ranked by billedEquivTokens descending; complete. */
  attachmentKinds: AttachmentKindRollup[]
  /** hook_success stdout-channel census, ranked by contextBytes descending; complete. */
  hookOutputs: HookOutputRollup[]
  positionDeciles: PositionDecile[]
  /** Aggregate per-line-type census (line counts and bytes by JSONL `type`). */
  sidechainLanes: SidechainLaneRollup
  laneAgentTypes: LaneTypeRollup[]
  readInterception: ReadInterceptionRollup
  bashInterception: BashInterceptionRollup
  /** Per-kind census of what actually happened after a token-goat Read deny: substituted (surgical command), shell_read (a shell reader binary on the same basename), retried (plain re-read), abandoned, compacted (a later re-read is correct by design), or unresolved (transcript ended too soon to tell). */
  denyOutcomes: DenyOutcomeKindRollup[]
  /** Corpus-wide Edit tool_result error rate, independent of any deny. Each kind's editErrorWithin10Count / editWithin10Count ratio (errors per Edit on denied paths) should be compared against this baseline. */
  editErrorBaseline: EditErrorBaseline
  lineTypes: Record<string, { lines: number; bytes: number }>
  /** Mid-trim marker census: `--- N lines omitted ---` fires inside tool results. */
  omissionMarkers: { fires: number; linesOmitted: number }
}

/** One deny's measured real-world outcome, tested in this fixed order so the six buckets partition every deny exactly once: a later re-read after a compaction boundary is correct by design and must never fall through to 'retried'; a shell command (sed/grep/cat/...) that reads the denied file's basename is 'shell_read' -- a real substitute the agent found on its own, not an escape from the census -- and is tested after 'substituted' so a `node <path>/token-goat.mjs` invocation (also a shell command) is never miscounted as a plain shell read; and a transcript that ends too soon to observe 3 calls is 'unresolved' rather than the misleadingly final-sounding 'abandoned'. */
export type DenyOutcome = 'compacted' | 'retried' | 'substituted' | 'shell_read' | 'unresolved' | 'abandoned'

/** One deny event's raw measurement, before per-kind aggregation. Raw tokens only -- no byte-to-token or cache-read multiplier applied; see DENY_TEMPLATES' doc comment for why. */
interface DenyRawRow {
  kind: string
  withheldBytes: number | null
  /** Count of assistant records carrying a `usage` object after this deny, to end of file. */
  R: number
  nextCallInputTotal: number
  nextCallCacheRead: number
  outcome: DenyOutcome
  /** Same test as the 'retried' outcome, but over a 10-call window instead of 3 -- exists to make the 3-call window's truncation error visible. */
  retriedWithin10: boolean
  /** A shell command in the 3-call outcome window contained the denied file's basename next to a reader binary, but not adjacent to a path separator/quote/word boundary -- too loose to credit as 'shell_read', too suggestive to silently drop. Diagnostic only; never affects `outcome`. */
  shellReadAmbiguous: boolean
  /** An Edit tool_use targeting the exact denied path occurred somewhere in the 10-call window after the deny, whether or not it errored. */
  editWithin10: boolean
  /** An Edit tool_use targeting the exact denied path, somewhere in the 10-call window after the deny, whose tool_result carried `is_error: true` -- the closest available signal that the deny caused real information loss rather than a harmless skip. */
  editErrorWithin10: boolean
}

/** Per-kind rollup of DenyRawRow for the corpus report. Rates are fractions of `count`. */
export interface DenyOutcomeKindRollup {
  kind: string
  count: number
  compactedRate: number
  retriedRate: number
  substitutedRate: number
  /** Fraction of this kind's denies whose 3-call outcome window contained a shell command reading the denied file by basename (sed/grep/cat/head/tail/awk/rg/less/nl/python/node). Subdivides what would otherwise be counted as 'abandoned'. */
  shellReadRate: number
  unresolvedRate: number
  abandonedRate: number
  retriedWithin10Rate: number
  medianWithheldBytes: number | null
  /** Fraction of this kind's denies whose message printed no byte figure at all (withheldBytes === null). Reported instead of guessing a size. */
  withheldBytesUnknownFraction: number
  medianR: number
  medianNextCallInputTotal: number
  medianNextCallCacheRead: number
  /** Count of denies (of `count`) whose window had a basename-adjacent-but-not-boundary-safe shell match: neither credited as shell_read nor silently dropped. */
  shellReadAmbiguousCount: number
  /** Count of denies (of `count`) where an Edit on the exact denied path occurred within 10 calls, whether or not it errored. The denominator for editErrorWithin10Count, so the ratio editErrorWithin10Count / editWithin10Count is errors-per-Edit on denied paths, directly comparable to editErrorBaseline.rate. */
  editWithin10Count: number
  /** Count of denies (of `count`) where an Edit on the exact denied path errored within 10 calls. Divide by editWithin10Count to get errors-per-Edit on denied paths; compare that ratio against editErrorBaseline.rate. */
  editErrorWithin10Count: number
}

/** Corpus-wide Edit error rate (all Edit tool_results, regardless of deny involvement), so a per-kind editErrorWithin10Count has a denominator to compare against. */
export interface EditErrorBaseline {
  totalEdits: number
  totalErrors: number
  rate: number
}

/** Per-corpus rollup of subagent lane files (transcripts under a `subagents/` directory). firstCallPrefixTokens is input + cache_creation + cache_read on the lane's FIRST API response: the spawn prefix (system prompt, tool and MCP manifests, inherited instruction files, and the task brief) before the subagent has done any work. prefixBilledEquivTokens models that prefix's billed carriage with the same residency model as the attachment census: written once at 1.25x, then re-read at 0.1x on each subsequent call in the lane. NOT billed units. */
export interface SidechainLaneRollup {
  /** Lane transcript files found (every *.jsonl under a subagents/ directory). */
  laneFiles: number
  /** Lane files that carried at least one assistant usage object; all statistics below cover only these. */
  lanesWithUsage: number
  meanFirstCallPrefixTokens: number
  medianFirstCallPrefixTokens: number
  p90FirstCallPrefixTokens: number
  meanCallsPerLane: number
  /** Mean bytes of the lane's first non-meta user turn: the task brief the parent wrote, as distinct from the inherited environment prefix. */
  meanBriefBytes: number
  prefixBilledEquivTokens: number
}

/** Read-interception census over every Read tool_result in the corpus. divertedByMarker counts results short enough to be a divert (under READ_DIVERT_MAX_BYTES) that match token-goat's own deny/serve message templates, so it UNDER-counts if those templates drift. fullServesOver10k counts non-diverted Read results above 10 KiB: the pool surgical reads exist to shrink. The first/repeat split keys each full serve on whether an earlier Read tool_use in the SAME transcript file targeted the same normalized path; the session read-cache can span a session's subagent lane files, so a per-file split UNDER-counts repeats, never over-counts. */
export interface ReadInterceptionRollup {
  readResults: number
  divertedByMarker: number
  divertedBytes: number
  fullServesOver10k: number
  fullServeBytesOver10k: number
  /** Full serves whose path had no earlier Read tool_use in the transcript: the pool the re-read divert excludes by design. */
  fullServesFirstRead: number
  /** Full serves of a path already targeted by an earlier Read tool_use in the transcript: candidates the re-read divert could have caught. */
  fullServesRepeat: number
  repeatBytes: number
  /** Repeats whose own call carried an offset or limit parameter: deliberate paging, not a divert miss. */
  repeatWithRange: number
  /** Repeats served whole with no range parameter: the divert-miss candidates. */
  repeatFullNoRange: number
  /** Repeats inside transcripts that show at least one token-goat hook_success attachment, so the hook was demonstrably installed there. */
  repeatInHookedSessions: number
  /** The intersection that names a live product defect: whole-file repeats (no offset/limit) in transcripts where a token-goat hook demonstrably fired, yet the divert did not. */
  repeatFullNoRangeInHookedSessions: number
  /** Of those, repeats with a compact boundary between the prior read and this one: compaction evicted the content, so re-reading is correct by design and NOT a divert miss. */
  repeatFullNoRangeHookedAfterCompaction: number
  /** Full serves whose Read tool_use carried no usable file_path, counted as neither first nor repeat. */
  fullServesPathUnknown: number
}

/** One command-head bucket of the untouched Bash pool. The head is the binary name only (basename, .exe stripped, lowercased), never a command line. */
export interface BashHeadRollup {
  head: string
  results: number
  bytes: number
}

/** Bash-filter fire-rate census over every Bash tool_result in the corpus. markedByFilter counts results carrying a token-goat in-band marker. A matched-but-under-the-100-byte-net-savings-floor discard leaves NO trace in the transcript, so it is indistinguishable here from "no filter matched" and lands in the untouched buckets. */
export interface BashInterceptionRollup {
  bashResults: number
  markedByFilter: number
  markedBytes: number
  /** Unmarked results under BASH_SMALL_RESULT_MAX_BYTES: too small for any filter to clear the 100-byte net-savings floor by a wide margin. */
  smallUntouched: number
  smallUntouchedBytes: number
  untouched: number
  untouchedBytes: number
  untouchedEstTokens: number
  /** Residency cost of the untouched pool: est-tokens re-read on every later call in the lane until the next compact boundary, same model as the attachment census. */
  untouchedRereadTokens: number
  /** round(1.25 x untouchedEstTokens + 0.1 x untouchedRereadTokens); NOT billed units. */
  untouchedBilledEquivTokens: number
  untouchedHeads: BashHeadRollup[]
}

/** Per-agentType lane rollup, from the lane's sibling agent-<id>.meta.json (agentType field). Prefix stats cover lanes with usage only, same convention as SidechainLaneRollup. */
export interface LaneTypeRollup {
  agentType: string
  lanes: number
  lanesWithUsage: number
  meanFirstCallPrefixTokens: number
  medianFirstCallPrefixTokens: number
}

export interface SessionAuditOptions {
  /** Corpus root holding per-project transcript dirs. Default `~/.claude/projects`. */
  dir?: string
}

// ---- internals ---------------------------------------------------------------

function emptyMeasured(): MeasuredUsage {
  return { apiCalls: 0, inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
}

function emptyCategory(): EstimatedCategory {
  return { count: 0, bytes: 0, estTokens: 0 }
}

function addCategory(cat: EstimatedCategory, bytes: number): void {
  cat.count += 1
  cat.bytes += bytes
  cat.estTokens += estimateTokensFromLength(bytes)
}

/** JSONL line types that are local bookkeeping and never enter the model's context. */
const LOCAL_ONLY_TYPES = new Set([
  'file-history-snapshot',
  'queue-operation',
  'mode',
  'permission-mode',
  'last-prompt',
  'bridge-session',
  'ai-title',
])

/** Which fields of each `attachment.type` the harness injects into model context. Kinds absent here carry no model-visible payload (their bytes are local envelope only); confirmed empirically per kind against a real corpus, e.g. hook_success `stdout` is display-only and only `content` reaches the model. */
const ATTACHMENT_VISIBLE_FIELDS: Record<string, string[]> = {
  hook_success: ['content'],
  hook_additional_context: ['content'],
  task_reminder: ['content'],
  skill_listing: ['content'],
  agent_listing_delta: ['addedLines'],
  file: ['content'],
  queued_command: ['prompt'],
  plan_file_reference: ['planContent'],
  edited_text_file: ['snippet'],
  read_truncation_notice: ['banner'],
  total_tokens_reminder: ['text'],
  nested_memory: ['content'],
  mcp_instructions_delta: ['addedBlocks'],
  invoked_skills: ['skills'],
  date_change: ['newDate'],
  goal_status: ['condition'],
  task_status: ['deltaSummary', 'description'],
  command_permissions: ['allowedTools'],
}

/** Prompt-cache write premium over the base input rate (Anthropic pricing: 1.25x). */
const CACHE_WRITE_MULTIPLIER = 1.25

/** Prompt-cache read discount against the base input rate (Anthropic pricing: 0.1x). */
const CACHE_READ_MULTIPLIER = 0.1

/** Total UTF-8 bytes of every string nested anywhere inside a JSON value. */
/** Matches token-goat's own pre-read deny/serve message templates (hooks_read.ts). A Read tool_result matching this AND smaller than READ_DIVERT_MAX_BYTES is a diverted read: token-goat replaced the file body with a pointer. Kept deliberately narrow; template drift makes this under-count, never over-count. */
const READ_DIVERT_MARKER_RE = /(?:was already read this session|Already read |You've already read|Use `token-goat (?:section|read|bash-output|config-get|skeleton)|token-goat bash-output --file)/
/** A divert message is a short pointer; a matching result at or above this size is a real file body that merely mentions a token-goat command, not a divert. */
const READ_DIVERT_MAX_BYTES = 2500
/** Non-diverted Read results at or above this size are counted as the full-serve pool surgical reads exist to shrink. */
const READ_FULL_SERVE_MIN_BYTES = 10240

/**
 * Per-kind classifiers for every Read-deny message template hooks_read.ts's `denyOutput(` call
 * sites can produce, derived by reading (never editing) hooks_read.ts and hints/file_type_handler.ts.
 * Tested in array order, first match wins -- entries are ordered specific-literal-first so a
 * message that could satisfy two templates (e.g. the .improve-state and generic session-artifact
 * re-read denials both end in the same `sessionArtifactRecall` sentence) resolves to its own
 * narrower kind rather than the generic one further down.
 *
 * This table exists because READ_DIVERT_MARKER_RE above is deliberately narrow (by its own doc
 * comment) and was never meant to distinguish kinds -- it only flags "this looks like one of
 * ours". A live corpus query saw divertedByMarker at 422 against a deny population believed to
 * be roughly 1512: most denies never had a kind at all before this table existed.
 */
const DENY_TEMPLATES: Array<{ kind: string; re: RegExp }> = [
  { kind: 'node_modules_deny', re: /node_modules is typically noise/ },
  { kind: 'lock_file_deny', re: /Lock files are rarely useful to read in full/ },
  { kind: 'tsbuildinfo_deny', re: /TypeScript incremental build cache file/ },
  { kind: 'generated_build_deny', re: /Generated\/build artifact — read the source file instead\./ },
  { kind: 'compact_sidecar_served', re: /Serving the extractive compact sidecar in place of the full file/ },
  { kind: 'notebook_sidecar_served', re: /Serving the output-stripped notebook in place of the full file/ },
  { kind: 'markdown_heading_tree_deny', re: /Large markdown file \(\d+ headings\)/ },
  // The first alternative is a wording hooks_read.ts no longer emits (it claimed a compact-manifest
  // section that never existed, reworded in 3d044feb). It stays because this table classifies a
  // historical corpus, not just today's output: transcripts written before the rewording still
  // carry the old text, and dropping the alternative silently shrank this kind from 51 events to
  // 30 -- 41% of its history -- with a green suite. A superseded alternative is only removable
  // once no transcript contains it, which source code cannot tell you. See the superseded-wording
  // test in tests/deny_outcomes.test.ts.
  { kind: 'memory_md_reread_deny', re: /MEMORY\.md was read this session\. Its content is in the compact manifest|already read this session\. Memory files rarely change mid-session/ },
  { kind: 'improve_state_reread_deny', re: /Orchestrator state already read this session/ },
  { kind: 'env_reread_deny', re: /Environment files rarely change mid-session/ },
  { kind: 'session_artifact_truncated_deny', re: /File was truncated on last read\. Use `token-goat bash-output/ },
  { kind: 'session_artifact_unchanged_deny', re: /is unchanged since last read\. Use `token-goat bash-output/ },
  { kind: 'session_artifact_diff_deny', re: /Content changed since last read of [\s\S]*?bash-output --file/ },
  { kind: 'session_artifact_large_deny', re: /(?:Session transcript|Tool-result file) is large \(/ },
  { kind: 'session_artifact_generic_reread_deny', re: /already read this session\. Use `token-goat bash-output --file/ },
  { kind: 'truncated_read_deny', re: /File was truncated on last read \(>33K tokens\)/ },
  { kind: 'doc_unchanged_deny', re: /is unchanged since last read\. Use `token-goat (?:section|read)/ },
  { kind: 'doc_diff_deny', re: /Content changed since last read of [\s\S]*?Use `token-goat (?:section|read)/ },
  { kind: 'read_served_deny', re: /was already served in this session, byte for byte/ },
  { kind: 'markdown_already_read_deny', re: /Markdown file already read this session\. Use `token-goat section/ },
  { kind: 'read_count_deny', re: /Read this file \d+ times already/ },
  { kind: 'generic_reread_deny', re: /was already read this session \(\d+ read/ },
  { kind: 'large_file_deny', re: /is very large \(\d+(?:\.\d+)?KB\)\./ },
  { kind: 'file_type_handler_deny', re: /too large to preview \(exceeds the in-hook scan cap\)|cannot be read as text\.|Read cannot return spreadsheet content|Read cannot return slide content|Read cannot return document content|Use Read with offset and limit parameters to read specific line ranges/ },
]

/** Kinds whose message template prints a byte figure (formatBytes/toKB style) that parseWithheldBytes can extract. Every other kind's withheldBytes is unconditionally null -- not every template prints a size, and guessing one from unrelated digits in the message (e.g. a reread count, or bytes inside a fenced diff) would be worse than admitting it is unknown. */
const DENY_KINDS_WITH_SIZE = new Set(['large_file_deny', 'session_artifact_large_deny', 'file_type_handler_deny'])

/** Matches a `formatBytes`/`toKB`-style size figure ("123KB", "12.3 MB", "40 B") inside a deny message. */
const DENY_SIZE_RE = /(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)\b/

/** Extracts the withheld-bytes figure a deny message prints, or null when this kind's template never prints one (see DENY_KINDS_WITH_SIZE). */
function parseWithheldBytes(kind: string, text: string): number | null {
  if (!DENY_KINDS_WITH_SIZE.has(kind)) return null
  const m = DENY_SIZE_RE.exec(text)
  if (m === null) return null
  const n = Number.parseFloat(m[1]!)
  const unit = m[2]!.toUpperCase()
  const mult = unit === 'B' ? 1 : unit === 'KB' ? 1024 : unit === 'MB' ? 1024 * 1024 : unit === 'GB' ? 1024 ** 3 : 1024 ** 4
  return Math.round(n * mult)
}

/** A Bash command invoking one of token-goat's own surgical-read commands, per TASK 2's definition. Matches at the start of the command OR after a shell separator (`;`, `&`, `|`, `(`, or whitespace) so `cd x && token-goat section ...`, an env-prefixed invocation, and `node dist/token-goat.mjs read ...` are all recognized -- not just a bare leading `token-goat`/`tg`. */
const SURGICAL_COMMAND_RE = /(?:^|[\s;&|(])(?:token-goat|tg|node\s+\S*token-goat\.mjs)\s+(read|section|symbol|skeleton|outline|bash-output|config-get|skill-section|skill-body)\b/

/** Reader binaries counted as a manual "shell read" substitute for a denied token-goat Read: the agent routed around the deny with a plain shell command instead of a surgical one. `node`/`python` are included because they read files directly (`node -e`, a one-off script) as often as they invoke tooling -- a `node .../token-goat.mjs` invocation is caught by SURGICAL_COMMAND_RE first, so it never reaches this check (see the outcome classification order). */
const SHELL_READER_TOKEN_RE = /\b(?:sed|grep|cat|head|tail|awk|rg|less|nl|python3?|node)\b/

/** Escapes a string for literal use inside a RegExp source. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Whether a Bash command reads the denied file by basename via a shell reader binary.
 * 'none': no reader binary present, or the basename never appears in the command at all.
 * 'ambiguous': a reader binary is present and the basename appears as a raw substring, but not
 *   adjacent to a path separator, quote, or word boundary -- e.g. `index.ts` inside `myindex.tsx`.
 *   A bare substring test on a short basename would over-credit this; report it separately
 *   instead of silently guessing either way.
 * 'match': the basename appears adjacent to a boundary that makes it a real argument.
 */
function shellReadMatch(command: string, basename: string): 'none' | 'ambiguous' | 'match' {
  if (basename === '' || !SHELL_READER_TOKEN_RE.test(command)) return 'none'
  if (!command.includes(basename)) return 'none'
  const escaped = escapeRegExp(basename)
  const strict = new RegExp(`(?:^|["'\`/\\\\\\s])${escaped}(?:$|["'\`/\\\\\\s,;:)])`)
  return strict.test(command) ? 'match' : 'ambiguous'
}

/** In-band markers token-goat's bash filters and recall/delta hints leave inside a Bash tool_result. A filter that matched but fell under the 100-byte net-savings floor prints the original unchanged with no marker, so this UNDER-counts fires and cannot see that case. */
const BASH_FILTER_MARKER_RE = /\[token-goat[:\]]/
/** Unmarked Bash results under this size are bucketed as too small to be a meaningful compression target (the filter floor alone is 100 bytes of net savings). */
const BASH_SMALL_RESULT_MAX_BYTES = 1024

/** First binary name of a Bash command: strips leading parens, env assignments and a cd prefix, then basenames the first token, drops a trailing .exe and lowercases. Aggregation key only; the full command line is never stored or emitted. */
function commandHead(raw: string): string {
  let s = raw.trim()
  for (let guard = 0; guard < 20; guard++) {
    const stripped = s.replace(/^[(\s]+/, '')
    const env = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(stripped)
    if (env !== null) {
      s = stripped.slice(env[0].length)
      continue
    }
    const cd = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&]+)[^\S\n]*(?:&&|;|\n)\s*/.exec(stripped)
    if (cd !== null) {
      s = stripped.slice(cd[0].length)
      continue
    }
    if (stripped === s) break
    s = stripped
  }
  const m = /^"([^"]+)"|^'([^']+)'|^(\S+)/.exec(s)
  const tok = m === null ? '' : (m[1] ?? m[2] ?? m[3] ?? '')
  const base = tok.split(/[\\/]/).pop() ?? ''
  const head = base.replace(/\.exe$/i, '').toLowerCase()
  return head === '' ? '(none)' : head
}

/** Normalizes a Read file_path for repeat detection only: forward slashes, lowercase (Windows paths are case-insensitive and the corpus mixes spellings). Never emitted. */
function normalizeReadPath(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

function deepStringBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8')
  if (Array.isArray(value)) return value.reduce((acc: number, v) => acc + deepStringBytes(v), 0)
  if (value !== null && typeof value === 'object') {
    return Object.values(value).reduce((acc: number, v) => acc + deepStringBytes(v), 0)
  }
  return 0
}

/** The generic mid-trim marker every tool filter's line cap emits (tool_filters/helpers.ts), plus the git.ts spellings. */
const OMISSION_MARKER_RE = /(?:--- (\d+) lines omitted ---|\[token-goat: \+?(\d+) more [a-z ]*lines omitted\]|--- patch: (\d+) lines omitted by token-goat ---|\.\.\. (\d+) lines omitted by token-goat \.\.\.)/g

/** Flatten a tool_result `content` field (string or array of text blocks) to its text length and text. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let text = ''
    for (const block of content) {
      if (block !== null && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        text += (block as { text: string }).text
      }
    }
    return text
  }
  return ''
}

interface PerCallUsage {
  inputTotal: number
  cacheRead: number
  output: number
}

/** List every `*.jsonl` transcript under `corpusDir` (one level of project dirs, plus loose files). */
export function listCorpusTranscripts(corpusDir: string): string[] {
  const found: string[] = []
  // Recurse the whole tree: modern Claude Code stores subagent and workflow transcripts under <project>/<session>/subagents/**, and a two-level walk misses them (measured on one real corpus: 6,022 of 11,555 transcripts, carrying 65% of all API calls and 57% of cache-read billing).
  const walk = (dir: string, entries: fs.Dirent[]): void => {
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.name.endsWith('.jsonl')) {
        found.push(full)
      } else if (entry.isDirectory()) {
        let inner: fs.Dirent[]
        try {
          inner = fs.readdirSync(full, { withFileTypes: true })
        } catch {
          continue
        }
        walk(full, inner)
      }
    }
  }
  walk(corpusDir, fs.readdirSync(corpusDir, { withFileTypes: true }))
  return found.sort()
}

export function defaultCorpusDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** Stream one transcript into the accumulating summary. Throws only on stream-open failure. */
/** One subagent lane transcript's observation, consumed by the corpus-level SidechainLaneRollup. firstPrefixTokens stays null when the lane carried no assistant usage at all. */
interface LaneObservation {
  firstPrefixTokens: number | null
  calls: number
  briefBytes: number
  agentType: string
}

async function auditOneFile(filePath: string, s: SessionAuditSummary, toolMap: Map<string, ToolRollup>, attachmentMap: Map<string, AttachmentKindRollup>, hookMap: Map<string, HookOutputRollup>, laneObservations: LaneObservation[], bashHeadMap: Map<string, BashHeadRollup>, denyRows: DenyRawRow[]): Promise<void> {
  const isLane = filePath.split(/[\\/]/).includes('subagents')
  let laneFirstPrefix: number | null = null
  let laneBriefBytes = -1
  const toolNameById = new Map<string, string>()
  // Bash census bookkeeping: tool_use id -> command head, plus the residency pending list for untouched results (same compact-boundary model as attachments).
  const bashHeadById = new Map<string, string>()
  let pendingBashReread: Array<{ tokens: number; atCall: number; lane: number }> = []
  // Read first/repeat bookkeeping: tool_use id -> whether an earlier Read tool_use in THIS transcript already targeted the path, and whether this call carried offset/limit. Folded into the summary at end of file so repeatInHookedSessions can see hook fires that appear later in the stream.
  const readCallById = new Map<string, { wasSeenBefore: boolean; hasRange: boolean; afterCompaction: boolean }>()
  // tool_use id -> normalized file_path, so a deny-outcome row opened at tool_result time (which only carries the tool_use_id) can recover the path it denied.
  const readPathById = new Map<string, string>()
  // Edit tool_use id -> normalized file_path, so the Edit-error canary can tell whether an Edit targeted the exact denied path.
  const editPathById = new Map<string, string>()
  // Edit tool_use id -> true once its tool_result carries is_error: true. Populated at tool_result time; read back once at end-of-file finalization, by which point every Edit in this file has resolved.
  const editErrorById = new Map<string, boolean>()
  // Normalized path -> compact-boundary count at its last Read tool_use, so a repeat can tell whether a compaction intervened (the boundary count is file-wide, not per lane; reads are overwhelmingly main-chain).
  const readPathEpoch = new Map<string, number>()
  let compactEpoch = 0
  // Deny-outcome census: one entry per Read deny still watching its post-deny call window. Finalized
  // (outcome/retriedWithin10 computed, R/nextCall filled from perCall) once the stream ends, so R and
  // "the next API call" can see the whole file rather than only what came before this point in it.
  interface OpenDenyState {
    kind: string
    withheldBytes: number | null
    path: string
    basename: string
    callIndexAtDeny: number
    compactEpochAtOpen: number
    /** compactEpoch snapshotted at the 3rd tool call after this deny, or at end-of-file if fewer than 3 tool calls ever arrived. Compared against compactEpochAtOpen to decide the 'compacted' outcome. */
    compactEpochAtWindow: number | null
    toolCalls: Array<{
      isReadSamePath: boolean
      isSurgicalSamePath: boolean
      isShellReadSamePath: boolean
      /** A shell reader binary and the basename were both present, but not boundary-adjacent -- see shellReadMatch's 'ambiguous' case. */
      isShellReadAmbiguous: boolean
      /** The tool_use id of this call, IF it was an Edit on the exact denied path -- looked up in editErrorById at finalization, once every Edit in the file has resolved. undefined for every other call. */
      editCallId: string | undefined
    }>
  }
  const openDenies: OpenDenyState[] = []
  let sawTokenGoatHook = false
  let fileRepeats = 0
  let fileRepeatsFullNoRange = 0
  let fileRepeatsFullNoRangeAfterCompaction = 0
  const usageSeenIds = new Set<string>()
  const perCall: PerCallUsage[] = []
  // Residency model for attachment reread cost: each injection stays in context from its API-call index until the next compact boundary on its lane (main vs sidechain), or end of transcript. laneCalls[0] counts main-chain API calls, laneCalls[1] sidechain calls.
  const laneCalls = [0, 0]
  let pendingReread: Array<{ kind: string; tokens: number; atCall: number; lane: number }> = []
  const lastVisibleByKind = new Map<string, string>()
  const flushLane = (lane: number): void => {
    const kept: typeof pendingReread = []
    for (const p of pendingReread) {
      if (p.lane !== lane) {
        kept.push(p)
        continue
      }
      attachmentRollup(attachmentMap, p.kind).rereadTokens += p.tokens * Math.max(0, laneCalls[lane]! - p.atCall)
    }
    pendingReread = kept
    const keptBash: typeof pendingBashReread = []
    for (const p of pendingBashReread) {
      if (p.lane !== lane) {
        keptBash.push(p)
        continue
      }
      s.bashInterception.untouchedRereadTokens += p.tokens * Math.max(0, laneCalls[lane]! - p.atCall)
    }
    pendingBashReread = keptBash
  }
  const stream = fs.createReadStream(filePath)
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  const streamFailure = new Promise<never>((_, reject) => stream.on('error', reject))
  const consume = (async () => {
    for await (const line of rl) {
      if (line.length === 0) continue
      s.lines += 1
      const lineBytes = Buffer.byteLength(line, 'utf8')
      s.totalBytes += lineBytes
      let obj: Record<string, unknown>
      try {
        obj = JSON.parse(line) as Record<string, unknown>
      } catch {
        s.parseFailedLines += 1
        addCategory(s.estimated.otherLocal, lineBytes)
        continue
      }
      const type = typeof obj['type'] === 'string' ? obj['type'] : '(untyped)'
      const census = (s.lineTypes[type] ??= { lines: 0, bytes: 0 })
      census.lines += 1
      census.bytes += lineBytes
      if (LOCAL_ONLY_TYPES.has(type)) {
        addCategory(s.estimated.otherLocal, lineBytes)
        continue
      }
      const message = obj['message'] as { id?: unknown; usage?: Record<string, unknown>; content?: unknown } | undefined
      if (type === 'assistant' && message !== undefined) {
        const usage = message.usage
        if (usage !== undefined && typeof message.id === 'string' && !usageSeenIds.has(message.id)) {
          usageSeenIds.add(message.id)
          const num = (k: string): number => (typeof usage[k] === 'number' ? (usage[k] as number) : 0)
          const input = num('input_tokens')
          const cacheWrite = num('cache_creation_input_tokens')
          const cacheRead = num('cache_read_input_tokens')
          const output = num('output_tokens')
          s.measured.apiCalls += 1
          s.measured.inputTokens += input
          s.measured.cacheCreationTokens += cacheWrite
          s.measured.cacheReadTokens += cacheRead
          s.measured.outputTokens += output
          if (obj['isSidechain'] === true) {
            s.measuredSidechain.apiCalls += 1
            s.measuredSidechain.inputTokens += input
            s.measuredSidechain.cacheCreationTokens += cacheWrite
            s.measuredSidechain.cacheReadTokens += cacheRead
            s.measuredSidechain.outputTokens += output
          }
          if (isLane && laneFirstPrefix === null) laneFirstPrefix = input + cacheWrite + cacheRead
          perCall.push({ inputTotal: input + cacheWrite + cacheRead, cacheRead, output })
          const callLane = obj['isSidechain'] === true ? 1 : 0
          laneCalls[callLane] = laneCalls[callLane]! + 1
        }
        const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        for (const block of blocks) {
          if (block === null || typeof block !== 'object') continue
          if (block['type'] === 'text' && typeof block['text'] === 'string') {
            addCategory(s.estimated.assistantText, Buffer.byteLength(block['text'], 'utf8'))
          } else if (block['type'] === 'thinking' && typeof block['thinking'] === 'string') {
            addCategory(s.estimated.assistantThinking, Buffer.byteLength(block['thinking'], 'utf8'))
          } else if (block['type'] === 'tool_use' && typeof block['id'] === 'string') {
            const name = typeof block['name'] === 'string' ? block['name'] : '(unnamed)'
            if (!toolNameById.has(block['id'])) {
              toolNameById.set(block['id'], name)
              toolRollup(toolMap, name).calls += 1
              const input = (block['input'] !== null && typeof block['input'] === 'object' ? block['input'] : {}) as Record<string, unknown>
              let readNorm: string | undefined
              let editNorm: string | undefined
              if (name === 'Bash' && typeof input['command'] === 'string') {
                bashHeadById.set(block['id'], commandHead(input['command']))
              } else if (name === 'Read' && typeof input['file_path'] === 'string') {
                readNorm = normalizeReadPath(input['file_path'])
                const priorEpoch = readPathEpoch.get(readNorm)
                readCallById.set(block['id'], { wasSeenBefore: priorEpoch !== undefined, hasRange: input['offset'] !== undefined || input['limit'] !== undefined, afterCompaction: priorEpoch !== undefined && compactEpoch > priorEpoch })
                readPathById.set(block['id'], readNorm)
                readPathEpoch.set(readNorm, compactEpoch)
              } else if (name === 'Edit' && typeof input['file_path'] === 'string') {
                editNorm = normalizeReadPath(input['file_path'])
                editPathById.set(block['id'], editNorm)
                s.editErrorBaseline.totalEdits += 1
              }
              // Deny-outcome census: this tool_use is "one tool call" (TASK 2's definition) for every
              // open deny still watching its 3-/10-call window. A Bash command matching
              // SURGICAL_COMMAND_RE against the denied path's basename is 'substituted'; a Bash command
              // reading the denied path via a shell reader binary (sed/grep/cat/...) is 'shell_read';
              // a Read of the exact same normalized path is 'retried'; an Edit of the exact same
              // normalized path records its tool_use id so the finalization pass can look up whether
              // it errored, once every Edit in this file has resolved. All checks run regardless of
              // which open deny they belong to -- a call can resolve several open denies from earlier
              // in the file.
              if (openDenies.length > 0) {
                const bashCommand = name === 'Bash' && typeof input['command'] === 'string' ? input['command'] : undefined
                for (const o of openDenies) {
                  if (o.toolCalls.length >= 10) continue
                  const isReadSamePath = readNorm !== undefined && o.path !== '' && readNorm === o.path
                  const isSurgicalSamePath = bashCommand !== undefined && o.basename !== '' && SURGICAL_COMMAND_RE.test(bashCommand) && bashCommand.includes(o.basename)
                  const shellRead = bashCommand !== undefined && o.basename !== '' ? shellReadMatch(bashCommand, o.basename) : 'none'
                  const isEditSamePath = editNorm !== undefined && o.path !== '' && editNorm === o.path
                  o.toolCalls.push({
                    isReadSamePath,
                    isSurgicalSamePath,
                    isShellReadSamePath: shellRead === 'match',
                    isShellReadAmbiguous: shellRead === 'ambiguous',
                    editCallId: isEditSamePath ? block['id'] : undefined,
                  })
                  if (o.toolCalls.length === 3) o.compactEpochAtWindow = compactEpoch
                }
              }
            }
            let inputBytes: number
            try {
              inputBytes = Buffer.byteLength(JSON.stringify(block['input'] ?? null), 'utf8')
            } catch {
              inputBytes = 0
            }
            addCategory(s.estimated.toolUseInputs, inputBytes)
          }
        }
        continue
      }
      if (type === 'user' && message !== undefined) {
        const blocks = Array.isArray(message.content) ? (message.content as Record<string, unknown>[]) : []
        let sawToolResult = false
        for (const block of blocks) {
          if (block === null || typeof block !== 'object' || block['type'] !== 'tool_result') continue
          sawToolResult = true
          const text = toolResultText(block['content'])
          const bytes = Buffer.byteLength(text, 'utf8')
          const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : ''
          const name = toolNameById.get(id) ?? '(unknown)'
          addCategory(s.estimated.toolResults, bytes)
          const roll = toolRollup(toolMap, name)
          if (!toolNameById.has(id)) roll.calls += 1
          roll.resultBytes += bytes
          roll.resultEstTokens += estimateTokensFromLength(bytes)
          if (name === 'Edit' && block['is_error'] === true) {
            s.editErrorBaseline.totalErrors += 1
            editErrorById.set(id, true)
          }
          if (name === 'Read') {
            s.readInterception.readResults += 1
            // Deny-outcome census: orthogonal to the divert/full-serve split above -- a deny
            // template match opens a new pending row that watches the calls following it in
            // this same file, regardless of whether READ_DIVERT_MARKER_RE also matched.
            const denyTemplate = DENY_TEMPLATES.find((t) => t.re.test(text))
            if (denyTemplate !== undefined) {
              const path = readPathById.get(id) ?? ''
              const lastSlash = path.lastIndexOf('/')
              openDenies.push({
                kind: denyTemplate.kind,
                withheldBytes: parseWithheldBytes(denyTemplate.kind, text),
                path,
                basename: lastSlash === -1 ? path : path.slice(lastSlash + 1),
                callIndexAtDeny: perCall.length,
                compactEpochAtOpen: compactEpoch,
                compactEpochAtWindow: null,
                toolCalls: [],
              })
            }
            if (bytes < READ_DIVERT_MAX_BYTES && READ_DIVERT_MARKER_RE.test(text)) {
              s.readInterception.divertedByMarker += 1
              s.readInterception.divertedBytes += bytes
            } else if (bytes >= READ_FULL_SERVE_MIN_BYTES) {
              s.readInterception.fullServesOver10k += 1
              s.readInterception.fullServeBytesOver10k += bytes
              const call = readCallById.get(id)
              if (call === undefined) {
                s.readInterception.fullServesPathUnknown += 1
              } else if (call.wasSeenBefore) {
                s.readInterception.fullServesRepeat += 1
                s.readInterception.repeatBytes += bytes
                fileRepeats += 1
                if (call.hasRange) {
                  s.readInterception.repeatWithRange += 1
                } else {
                  s.readInterception.repeatFullNoRange += 1
                  fileRepeatsFullNoRange += 1
                  if (call.afterCompaction) fileRepeatsFullNoRangeAfterCompaction += 1
                }
              } else {
                s.readInterception.fullServesFirstRead += 1
              }
            }
          } else if (name === 'Bash') {
            const b = s.bashInterception
            b.bashResults += 1
            if (BASH_FILTER_MARKER_RE.test(text)) {
              b.markedByFilter += 1
              b.markedBytes += bytes
            } else if (bytes < BASH_SMALL_RESULT_MAX_BYTES) {
              b.smallUntouched += 1
              b.smallUntouchedBytes += bytes
            } else {
              b.untouched += 1
              b.untouchedBytes += bytes
              const tokens = estimateTokensFromLength(bytes)
              b.untouchedEstTokens += tokens
              const lane = obj['isSidechain'] === true ? 1 : 0
              pendingBashReread.push({ tokens, atCall: laneCalls[lane]!, lane })
              const head = bashHeadById.get(id) ?? '(unknown)'
              let headRoll = bashHeadMap.get(head)
              if (headRoll === undefined) {
                headRoll = { head, results: 0, bytes: 0 }
                bashHeadMap.set(head, headRoll)
              }
              headRoll.results += 1
              headRoll.bytes += bytes
            }
          }
          OMISSION_MARKER_RE.lastIndex = 0
          for (const m of text.matchAll(OMISSION_MARKER_RE)) {
            s.omissionMarkers.fires += 1
            s.omissionMarkers.linesOmitted += Number(m[1] ?? m[2] ?? m[3] ?? m[4] ?? 0)
          }
        }
        if (!sawToolResult) {
          const target = obj['isMeta'] === true ? s.estimated.harnessMeta : s.estimated.userTurns
          let contentBytes = 0
          if (typeof message.content === 'string') {
            contentBytes = Buffer.byteLength(message.content, 'utf8')
          } else {
            for (const block of blocks) {
              if (block !== null && typeof block === 'object' && typeof block['text'] === 'string') {
                contentBytes += Buffer.byteLength(block['text'], 'utf8')
              }
            }
          }
          addCategory(target, contentBytes)
          if (isLane && laneBriefBytes < 0 && obj['isMeta'] !== true) laneBriefBytes = contentBytes
        }
        continue
      }
      if (type === 'attachment') {
        addCategory(s.estimated.attachments, lineBytes)
        const att = (obj['attachment'] !== null && typeof obj['attachment'] === 'object' ? obj['attachment'] : {}) as Record<string, unknown>
        const kind = typeof att['type'] === 'string' ? att['type'] : '(untyped)'
        const lane = obj['isSidechain'] === true ? 1 : 0
        const roll = attachmentRollup(attachmentMap, kind)
        roll.injections += 1
        roll.lineBytes += lineBytes
        const fields = ATTACHMENT_VISIBLE_FIELDS[kind]
        if (fields !== undefined) {
          const visibleBytes = fields.reduce((acc, f) => acc + deepStringBytes(att[f]), 0)
          roll.visibleBytes += visibleBytes
          const tokens = visibleBytes > 0 ? estimateTokensFromLength(visibleBytes) : 0
          roll.estTokens += tokens
          if (tokens > 0) pendingReread.push({ kind, tokens, atCall: laneCalls[lane]!, lane })
          let serialized: string
          try {
            serialized = JSON.stringify(fields.map((f) => att[f]))
          } catch {
            serialized = ''
          }
          const previous = lastVisibleByKind.get(kind)
          if (previous !== undefined) {
            if (previous === serialized) roll.repeatedIdentical += 1
            else roll.repeatedChanged += 1
          }
          lastVisibleByKind.set(kind, serialized)
        }
        if (kind === 'hook_success') {
          const command = typeof att['command'] === 'string' ? att['command'] : ''
          const origin: HookOutputRollup['origin'] = command.includes('token-goat') || command.includes('token_goat') ? 'token-goat' : 'other'
          if (origin === 'token-goat') sawTokenGoatHook = true
          const event = typeof att['hookEvent'] === 'string' ? att['hookEvent'] : '(none)'
          const hook = hookRollup(hookMap, origin, event)
          hook.fires += 1
          hook.stdoutBytes += typeof att['stdout'] === 'string' ? Buffer.byteLength(att['stdout'], 'utf8') : 0
          hook.contextBytes += typeof att['content'] === 'string' ? Buffer.byteLength(att['content'], 'utf8') : 0
        }
        continue
      }
      if (type === 'system' || type === 'summary') {
        // A compact boundary evicts the prior conversation from context: settle the reread cost of every attachment pending on this line's lane at the call count reached so far.
        if (obj['subtype'] === 'compact_boundary') {
          flushLane(obj['isSidechain'] === true ? 1 : 0)
          compactEpoch += 1
        }
        addCategory(s.estimated.system, lineBytes)
        continue
      }
      addCategory(s.estimated.otherLocal, lineBytes)
    }
  })()
  void consume.catch(() => {})
  void streamFailure.catch(() => {})
  try {
    await Promise.race([consume, streamFailure])
  } finally {
    rl.close()
    stream.destroy()
  }
  flushLane(0)
  flushLane(1)
  // Finalize every deny opened in this file: R and nextCall need the file's final perCall count
  // (which is why this waits for end of stream instead of resolving eagerly), editErrorById needs
  // every Edit tool_result in the file to have resolved, and the outcome is computed in the fixed
  // order this module documents (DenyOutcome) so the six buckets partition every deny.
  for (const o of openDenies) {
    if (o.compactEpochAtWindow === null) o.compactEpochAtWindow = compactEpoch
    const windowCalls = o.toolCalls.slice(0, 3)
    let outcome: DenyOutcome
    if (o.compactEpochAtWindow > o.compactEpochAtOpen) {
      outcome = 'compacted'
    } else if (windowCalls.some((c) => c.isReadSamePath)) {
      outcome = 'retried'
    } else if (windowCalls.some((c) => c.isSurgicalSamePath)) {
      outcome = 'substituted'
    } else if (windowCalls.some((c) => c.isShellReadSamePath)) {
      outcome = 'shell_read'
    } else if (o.toolCalls.length < 3) {
      outcome = 'unresolved'
    } else {
      outcome = 'abandoned'
    }
    const retriedWithin10 = o.toolCalls.some((c) => c.isReadSamePath)
    const shellReadAmbiguous = windowCalls.some((c) => c.isShellReadAmbiguous)
    const editWithin10 = o.toolCalls.some((c) => c.editCallId !== undefined)
    const editErrorWithin10 = o.toolCalls.some((c) => c.editCallId !== undefined && editErrorById.get(c.editCallId) === true)
    const R = perCall.length - o.callIndexAtDeny
    const nextCall = perCall[o.callIndexAtDeny]
    denyRows.push({
      kind: o.kind,
      withheldBytes: o.withheldBytes,
      R,
      nextCallInputTotal: nextCall?.inputTotal ?? 0,
      nextCallCacheRead: nextCall?.cacheRead ?? 0,
      outcome,
      retriedWithin10,
      shellReadAmbiguous,
      editWithin10,
      editErrorWithin10,
    })
  }
  if (sawTokenGoatHook) {
    s.readInterception.repeatInHookedSessions += fileRepeats
    s.readInterception.repeatFullNoRangeInHookedSessions += fileRepeatsFullNoRange
    s.readInterception.repeatFullNoRangeHookedAfterCompaction += fileRepeatsFullNoRangeAfterCompaction
  }
  if (isLane) {
    // The lane's sibling agent-<id>.meta.json carries agentType (plus parentAgentId, toolUseId, spawnDepth): the typed-vs-unrestricted key the lane file itself lacks.
    let agentType = '(none)'
    try {
      const meta = JSON.parse(fs.readFileSync(filePath.replace(/\.jsonl$/i, '.meta.json'), 'utf8')) as Record<string, unknown>
      if (typeof meta['agentType'] === 'string' && meta['agentType'] !== '') agentType = meta['agentType']
    } catch {
      // No meta file (older harness) or unparseable: keep '(none)'.
    }
    laneObservations.push({ firstPrefixTokens: laneFirstPrefix, calls: usageSeenIds.size, briefBytes: Math.max(0, laneBriefBytes), agentType })
  }
  const callCount = perCall.length
  for (let i = 0; i < callCount; i++) {
    const call = perCall[i]!
    const d = s.positionDeciles[Math.min(9, Math.floor((i * 10) / callCount))]!
    d.apiCalls += 1
    d.inputTokens += call.inputTotal
    d.cacheReadTokens += call.cacheRead
    d.outputTokens += call.output
  }
}

/** Lazily create the per-tool rollup row. Calls are counted at tool_use time; result bytes attach later at tool_result time (a result whose tool_use was never seen counts one call under '(unknown)'). */
function toolRollup(toolMap: Map<string, ToolRollup>, name: string): ToolRollup {
  let roll = toolMap.get(name)
  if (roll === undefined) {
    roll = { name, calls: 0, resultBytes: 0, resultEstTokens: 0 }
    toolMap.set(name, roll)
  }
  return roll
}

function attachmentRollup(attachmentMap: Map<string, AttachmentKindRollup>, kind: string): AttachmentKindRollup {
  let roll = attachmentMap.get(kind)
  if (roll === undefined) {
    roll = { kind, injections: 0, lineBytes: 0, visibleBytes: 0, estTokens: 0, rereadTokens: 0, billedEquivTokens: 0, repeatedIdentical: 0, repeatedChanged: 0 }
    attachmentMap.set(kind, roll)
  }
  return roll
}

function hookRollup(hookMap: Map<string, HookOutputRollup>, origin: HookOutputRollup['origin'], event: string): HookOutputRollup {
  const key = `${origin}|${event}`
  let roll = hookMap.get(key)
  if (roll === undefined) {
    roll = { origin, event, fires: 0, stdoutBytes: 0, contextBytes: 0 }
    hookMap.set(key, roll)
  }
  return roll
}

/** Median of a numeric array; 0 for an empty array (matches this file's existing mean()/median-style helpers). Sorts a copy so callers can pass an array they still own. */
function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Groups raw per-deny rows by kind and computes the rates/medians the report needs, sorted by count descending. */
function aggregateDenyOutcomes(rows: DenyRawRow[]): DenyOutcomeKindRollup[] {
  const byKind = new Map<string, DenyRawRow[]>()
  for (const r of rows) {
    const bucket = byKind.get(r.kind)
    if (bucket === undefined) byKind.set(r.kind, [r])
    else bucket.push(r)
  }
  const result: DenyOutcomeKindRollup[] = []
  for (const [kind, kindRows] of byKind) {
    const count = kindRows.length
    const rateOf = (outcome: DenyOutcome): number => kindRows.filter((r) => r.outcome === outcome).length / count
    const knownBytes = kindRows.map((r) => r.withheldBytes).filter((b): b is number => b !== null)
    result.push({
      kind,
      count,
      compactedRate: rateOf('compacted'),
      retriedRate: rateOf('retried'),
      substitutedRate: rateOf('substituted'),
      shellReadRate: rateOf('shell_read'),
      unresolvedRate: rateOf('unresolved'),
      abandonedRate: rateOf('abandoned'),
      retriedWithin10Rate: kindRows.filter((r) => r.retriedWithin10).length / count,
      medianWithheldBytes: knownBytes.length === 0 ? null : median(knownBytes),
      withheldBytesUnknownFraction: (count - knownBytes.length) / count,
      medianR: median(kindRows.map((r) => r.R)),
      medianNextCallInputTotal: median(kindRows.map((r) => r.nextCallInputTotal)),
      medianNextCallCacheRead: median(kindRows.map((r) => r.nextCallCacheRead)),
      shellReadAmbiguousCount: kindRows.filter((r) => r.shellReadAmbiguous).length,
      editWithin10Count: kindRows.filter((r) => r.editWithin10).length,
      editErrorWithin10Count: kindRows.filter((r) => r.editErrorWithin10).length,
    })
  }
  return result.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
}

// ---- entry point -------------------------------------------------------------

/**
 * Stream every transcript under the corpus root and aggregate the audit.
 * Throws (message suitable for CliError wrapping) when the corpus root does
 * not exist or contains no transcripts, so an empty corpus can never render
 * as a populated-but-zero report.
 */
export async function auditSessionCorpus(opts: SessionAuditOptions = {}): Promise<SessionAuditSummary> {
  const corpusDir = path.resolve(opts.dir ?? defaultCorpusDir())
  if (!fs.existsSync(corpusDir)) {
    throw new Error(`session corpus directory not found: ${corpusDir}`)
  }
  const files = listCorpusTranscripts(corpusDir)
  if (files.length === 0) {
    throw new Error(`no .jsonl session transcripts found under ${corpusDir}`)
  }
  const started = Date.now()
  const summary: SessionAuditSummary = {
    corpusDir,
    filesScanned: 0,
    filesFailed: 0,
    lines: 0,
    parseFailedLines: 0,
    totalBytes: 0,
    runtimeMs: 0,
    measured: emptyMeasured(),
    measuredSidechain: emptyMeasured(),
    estimated: {
      userTurns: emptyCategory(),
      toolResults: emptyCategory(),
      assistantText: emptyCategory(),
      assistantThinking: emptyCategory(),
      toolUseInputs: emptyCategory(),
      attachments: emptyCategory(),
      harnessMeta: emptyCategory(),
      system: emptyCategory(),
      otherLocal: emptyCategory(),
    },
    tools: [],
    attachmentKinds: [],
    hookOutputs: [],
    positionDeciles: Array.from({ length: 10 }, (_, i) => ({ decile: i + 1, apiCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })),
    sidechainLanes: { laneFiles: 0, lanesWithUsage: 0, meanFirstCallPrefixTokens: 0, medianFirstCallPrefixTokens: 0, p90FirstCallPrefixTokens: 0, meanCallsPerLane: 0, meanBriefBytes: 0, prefixBilledEquivTokens: 0 },
    laneAgentTypes: [],
    readInterception: { readResults: 0, divertedByMarker: 0, divertedBytes: 0, fullServesOver10k: 0, fullServeBytesOver10k: 0, fullServesFirstRead: 0, fullServesRepeat: 0, repeatBytes: 0, repeatWithRange: 0, repeatFullNoRange: 0, repeatInHookedSessions: 0, repeatFullNoRangeInHookedSessions: 0, repeatFullNoRangeHookedAfterCompaction: 0, fullServesPathUnknown: 0 },
    bashInterception: { bashResults: 0, markedByFilter: 0, markedBytes: 0, smallUntouched: 0, smallUntouchedBytes: 0, untouched: 0, untouchedBytes: 0, untouchedEstTokens: 0, untouchedRereadTokens: 0, untouchedBilledEquivTokens: 0, untouchedHeads: [] },
    denyOutcomes: [],
    editErrorBaseline: { totalEdits: 0, totalErrors: 0, rate: 0 },
    lineTypes: {},
    omissionMarkers: { fires: 0, linesOmitted: 0 },
  }
  const toolMap = new Map<string, ToolRollup>()
  const attachmentMap = new Map<string, AttachmentKindRollup>()
  const hookMap = new Map<string, HookOutputRollup>()
  const laneObservations: LaneObservation[] = []
  const bashHeadMap = new Map<string, BashHeadRollup>()
  const denyRows: DenyRawRow[] = []
  for (const file of files) {
    try {
      await auditOneFile(file, summary, toolMap, attachmentMap, hookMap, laneObservations, bashHeadMap, denyRows)
      summary.filesScanned += 1
    } catch {
      summary.filesFailed += 1
    }
  }
  const withUsage = laneObservations.filter((l) => l.firstPrefixTokens !== null)
  const prefixes = withUsage.map((l) => l.firstPrefixTokens as number).sort((a, b) => a - b)
  const mean = (arr: number[]): number => (arr.length === 0 ? 0 : Math.round(arr.reduce((a, b) => a + b, 0) / arr.length))
  summary.sidechainLanes = {
    laneFiles: laneObservations.length,
    lanesWithUsage: withUsage.length,
    meanFirstCallPrefixTokens: mean(prefixes),
    medianFirstCallPrefixTokens: prefixes.length === 0 ? 0 : prefixes[Math.floor(prefixes.length / 2)]!,
    p90FirstCallPrefixTokens: prefixes.length === 0 ? 0 : prefixes[Math.min(prefixes.length - 1, Math.floor(prefixes.length * 0.9))]!,
    meanCallsPerLane: mean(withUsage.map((l) => l.calls)),
    meanBriefBytes: mean(withUsage.map((l) => l.briefBytes)),
    prefixBilledEquivTokens: Math.round(withUsage.reduce((acc, l) => acc + (l.firstPrefixTokens as number) * (CACHE_WRITE_MULTIPLIER + CACHE_READ_MULTIPLIER * Math.max(0, l.calls - 1)), 0)),
  }
  const byType = new Map<string, LaneObservation[]>()
  for (const l of laneObservations) {
    const bucket = byType.get(l.agentType)
    if (bucket === undefined) byType.set(l.agentType, [l])
    else bucket.push(l)
  }
  summary.laneAgentTypes = [...byType.entries()].map(([agentType, obs]) => {
    const typed = obs.filter((l) => l.firstPrefixTokens !== null).map((l) => l.firstPrefixTokens as number).sort((a, b) => a - b)
    return { agentType, lanes: obs.length, lanesWithUsage: typed.length, meanFirstCallPrefixTokens: mean(typed), medianFirstCallPrefixTokens: typed.length === 0 ? 0 : typed[Math.floor(typed.length / 2)]! }
  }).sort((a, b) => b.lanes - a.lanes || a.agentType.localeCompare(b.agentType))
  summary.bashInterception.untouchedBilledEquivTokens = Math.round(CACHE_WRITE_MULTIPLIER * summary.bashInterception.untouchedEstTokens + CACHE_READ_MULTIPLIER * summary.bashInterception.untouchedRereadTokens)
  summary.bashInterception.untouchedHeads = [...bashHeadMap.values()].sort((a, b) => b.bytes - a.bytes || b.results - a.results || a.head.localeCompare(b.head))
  summary.tools = [...toolMap.values()].sort((a, b) => b.resultBytes - a.resultBytes || a.name.localeCompare(b.name))
  for (const roll of attachmentMap.values()) {
    roll.billedEquivTokens = Math.round(CACHE_WRITE_MULTIPLIER * roll.estTokens + CACHE_READ_MULTIPLIER * roll.rereadTokens)
  }
  summary.attachmentKinds = [...attachmentMap.values()].sort((a, b) => b.billedEquivTokens - a.billedEquivTokens || b.injections - a.injections || a.kind.localeCompare(b.kind))
  summary.hookOutputs = [...hookMap.values()].sort((a, b) => b.contextBytes - a.contextBytes || b.fires - a.fires || a.origin.localeCompare(b.origin) || a.event.localeCompare(b.event))
  summary.denyOutcomes = aggregateDenyOutcomes(denyRows)
  summary.editErrorBaseline.rate = summary.editErrorBaseline.totalEdits === 0 ? 0 : summary.editErrorBaseline.totalErrors / summary.editErrorBaseline.totalEdits
  summary.runtimeMs = Date.now() - started
  return summary
}

// ---- rendering ---------------------------------------------------------------

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`
}

/** Render the plain-text report. Aggregates only: no message content, paths, or project names. */
export function formatSessionAudit(s: SessionAuditSummary): string {
  const lines: string[] = []
  lines.push('# Session corpus audit')
  lines.push(`Corpus: ${s.corpusDir}`)
  lines.push(`Files: ${fmt(s.filesScanned)} scanned, ${fmt(s.filesFailed)} unreadable`)
  lines.push(`Lines: ${fmt(s.lines)} (${fmt(s.parseFailedLines)} unparseable), bytes: ${fmt(s.totalBytes)}`)
  lines.push(`Runtime: ${(s.runtimeMs / 1000).toFixed(1)}s`)
  lines.push('')
  lines.push('## Measured billed tokens (assistant message.usage, one count per API response)')
  const m = s.measured
  lines.push(`API calls: ${fmt(m.apiCalls)} (sidechain: ${fmt(s.measuredSidechain.apiCalls)})`)
  lines.push(`Output tokens:      ${fmt(m.outputTokens)}`)
  lines.push(`Input, uncached:    ${fmt(m.inputTokens)}`)
  lines.push(`Input, cache-write: ${fmt(m.cacheCreationTokens)}`)
  lines.push(`Input, cache-read:  ${fmt(m.cacheReadTokens)}`)
  const totalInput = m.inputTokens + m.cacheCreationTokens + m.cacheReadTokens
  lines.push(`Cache-read share of input: ${pct(m.cacheReadTokens, totalInput)}`)
  lines.push('')
  lines.push('## Estimated content attribution (chars/3 heuristic; NOT billed units)')
  const e = s.estimated
  const rows: [string, EstimatedCategory][] = [
    ['tool results', e.toolResults],
    ['assistant text', e.assistantText],
    ['assistant thinking', e.assistantThinking],
    ['tool call inputs', e.toolUseInputs],
    ['attachments (harness)', e.attachments],
    ['user turns', e.userTurns],
    ['meta user lines', e.harnessMeta],
    ['system lines', e.system],
    ['local bookkeeping (never sent)', e.otherLocal],
  ]
  const modelVisibleBytes = rows.slice(0, 8).reduce((acc, [, c]) => acc + c.bytes, 0)
  for (const [label, cat] of rows.sort((a, b) => b[1].bytes - a[1].bytes)) {
    lines.push(`${label.padEnd(31)} count ${fmt(cat.count).padStart(11)}  bytes ${fmt(cat.bytes).padStart(15)}  est-tokens ${fmt(cat.estTokens).padStart(13)}  ${label === 'local bookkeeping (never sent)' ? '(excluded from share)' : pct(cat.bytes, modelVisibleBytes)}`)
  }
  lines.push('')
  lines.push('## Tool results by tool (estimated content size; calls = tool_use invocations)')
  for (const t of s.tools.slice(0, 25)) {
    lines.push(`${t.name.padEnd(42)} calls ${fmt(t.calls).padStart(9)}  bytes ${fmt(t.resultBytes).padStart(15)}  est-tokens ${fmt(t.resultEstTokens).padStart(12)}`)
  }
  if (s.tools.length > 25) lines.push(`(${s.tools.length - 25} smaller tools omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Attachment kinds by modeled billed cost (model-visible fields only; NOT billed units)')
  lines.push('Model: est-tokens x 1.25 cache-write + reread-tokens x 0.1 cache-read; an injection stays in context until the next compact boundary on its lane, or end of transcript.')
  for (const a of s.attachmentKinds.slice(0, 15)) {
    lines.push(`${a.kind.padEnd(28)} inj ${fmt(a.injections).padStart(9)}  visible-bytes ${fmt(a.visibleBytes).padStart(13)}  est-tok ${fmt(a.estTokens).padStart(12)}  reread-tok ${fmt(a.rereadTokens).padStart(14)}  billed-equiv ${fmt(a.billedEquivTokens).padStart(12)}  identical-reinject ${fmt(a.repeatedIdentical).padStart(8)}`)
  }
  if (s.attachmentKinds.length > 15) lines.push(`(${s.attachmentKinds.length - 15} smaller kinds omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Hook stdout channel (hook_success attachments; context-bytes is the model-visible share)')
  for (const h of s.hookOutputs) {
    lines.push(`${h.origin.padEnd(11)} ${h.event.padEnd(18)} fires ${fmt(h.fires).padStart(9)}  stdout-bytes ${fmt(h.stdoutBytes).padStart(13)}  context-bytes ${fmt(h.contextBytes).padStart(13)}`)
  }
  lines.push('')
  lines.push('## Measured billed tokens by session position (deciles of each session\'s API calls)')
  for (const d of s.positionDeciles) {
    lines.push(`decile ${d.decile.toString().padStart(2)}  calls ${fmt(d.apiCalls).padStart(9)}  input ${fmt(d.inputTokens).padStart(15)}  cache-read ${fmt(d.cacheReadTokens).padStart(15)}  output ${fmt(d.outputTokens).padStart(11)}`)
  }
  lines.push('')
  lines.push('## Subagent lanes (spawn-prefix carriage; same residency model as the attachment census; NOT billed units)')
  const sl = s.sidechainLanes
  lines.push(`Lane files: ${fmt(sl.laneFiles)} (${fmt(sl.lanesWithUsage)} with usage)`)
  lines.push(`First-call prefix tokens: mean ${fmt(sl.meanFirstCallPrefixTokens)}, median ${fmt(sl.medianFirstCallPrefixTokens)}, p90 ${fmt(sl.p90FirstCallPrefixTokens)}`)
  lines.push(`Calls per lane: mean ${fmt(sl.meanCallsPerLane)}; task-brief bytes: mean ${fmt(sl.meanBriefBytes)}`)
  lines.push(`Prefix billed-equiv tokens: ${fmt(sl.prefixBilledEquivTokens)} (write x 1.25, then x 0.1 per later call in the lane)`)
  for (const t of s.laneAgentTypes.slice(0, 12)) {
    lines.push(`  type ${t.agentType.padEnd(24)} lanes ${fmt(t.lanes).padStart(7)} (${fmt(t.lanesWithUsage)} with usage)  prefix mean ${fmt(t.meanFirstCallPrefixTokens).padStart(9)}, median ${fmt(t.medianFirstCallPrefixTokens).padStart(9)}`)
  }
  if (s.laneAgentTypes.length > 12) lines.push(`  (${s.laneAgentTypes.length - 12} smaller agent types omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Read interception (token-goat divert markers inside Read tool results)')
  const ri = s.readInterception
  lines.push(`Read results: ${fmt(ri.readResults)}; diverted by marker: ${fmt(ri.divertedByMarker)} (${fmt(ri.divertedBytes)} bytes); full serves >=10 KiB: ${fmt(ri.fullServesOver10k)} (${fmt(ri.fullServeBytesOver10k)} bytes)`)
  lines.push(`Full-serve split (same transcript file; a session's lanes are separate files, so repeats UNDER-count): first read ${fmt(ri.fullServesFirstRead)}, repeat ${fmt(ri.fullServesRepeat)} (${fmt(ri.repeatBytes)} bytes), path unknown ${fmt(ri.fullServesPathUnknown)}`)
  lines.push(`Repeats: with offset/limit ${fmt(ri.repeatWithRange)} (deliberate paging), whole-file ${fmt(ri.repeatFullNoRange)} (divert-miss candidates), in sessions with a token-goat hook fire ${fmt(ri.repeatInHookedSessions)} (whole-file among them: ${fmt(ri.repeatFullNoRangeInHookedSessions)}, of which post-compaction and so correct by design: ${fmt(ri.repeatFullNoRangeHookedAfterCompaction)})`)
  lines.push('')
  lines.push('## Deny outcomes (what actually happened after a token-goat Read deny; raw tokens, not billed units)')
  const eb = s.editErrorBaseline
  lines.push(`Edit-error baseline (all Edit tool_results, corpus-wide, independent of any deny): ${fmt(eb.totalErrors)}/${fmt(eb.totalEdits)} (${(eb.rate * 100).toFixed(1)}%) -- compare each row's edit-error<=10 ratio against this rate.`)
  for (const d of s.denyOutcomes) {
    const editErrorRatio = d.editWithin10Count > 0 ? `${fmt(d.editErrorWithin10Count)}/${fmt(d.editWithin10Count)}` : 'n/a'
    lines.push(`${d.kind.padEnd(34)} n ${fmt(d.count).padStart(6)}  compacted ${pct(d.compactedRate * d.count, d.count)}  retried ${pct(d.retriedRate * d.count, d.count)}  substituted ${pct(d.substitutedRate * d.count, d.count)}  shell-read ${pct(d.shellReadRate * d.count, d.count)}  unresolved ${pct(d.unresolvedRate * d.count, d.count)}  abandoned ${pct(d.abandonedRate * d.count, d.count)}  retried<=10 ${pct(d.retriedWithin10Rate * d.count, d.count)}  median-withheld ${d.medianWithheldBytes === null ? 'n/a' : fmt(d.medianWithheldBytes) + 'B'} (unknown ${pct(d.withheldBytesUnknownFraction * d.count, d.count)})  median-R ${fmt(d.medianR)}  shell-read-ambiguous ${fmt(d.shellReadAmbiguousCount)}  edit-error<=10 ${editErrorRatio}`)
  }
  if (s.denyOutcomes.length === 0) lines.push('(no denies matched a known template)')
  lines.push('')
  lines.push('## Bash filter fire-rate (token-goat in-band markers inside Bash tool results)')
  const bi = s.bashInterception
  lines.push(`Bash results: ${fmt(bi.bashResults)}; marked by a filter: ${fmt(bi.markedByFilter)} (${fmt(bi.markedBytes)} bytes); small unmarked <${fmt(BASH_SMALL_RESULT_MAX_BYTES)} B: ${fmt(bi.smallUntouched)} (${fmt(bi.smallUntouchedBytes)} bytes)`)
  lines.push(`Untouched >=${fmt(BASH_SMALL_RESULT_MAX_BYTES)} B: ${fmt(bi.untouched)} (${fmt(bi.untouchedBytes)} bytes, est-tokens ${fmt(bi.untouchedEstTokens)}, billed-equiv ${fmt(bi.untouchedBilledEquivTokens)})`)
  lines.push('A filter that matched but fell under the 100-byte net-savings floor leaves no transcript trace and counts as untouched here.')
  for (const h of bi.untouchedHeads.slice(0, 15)) {
    lines.push(`  ${h.head.padEnd(28)} results ${fmt(h.results).padStart(9)}  bytes ${fmt(h.bytes).padStart(15)}`)
  }
  if (bi.untouchedHeads.length > 15) lines.push(`  (${bi.untouchedHeads.length - 15} smaller command heads omitted from this table; --json has all)`)
  lines.push('')
  lines.push('## Mid-trim omission markers inside tool results')
  lines.push(`fires: ${fmt(s.omissionMarkers.fires)}, lines discarded: ${fmt(s.omissionMarkers.linesOmitted)}`)
  return lines.join('\n')
}
