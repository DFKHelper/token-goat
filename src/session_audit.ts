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
 * output contains aggregate counts, token totals, tool names and line-type
 * names -- never message bodies, file paths from inside sessions, or project
 * names.
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
  readInterception: ReadInterceptionRollup
  lineTypes: Record<string, { lines: number; bytes: number }>
  /** Mid-trim marker census: `--- N lines omitted ---` fires inside tool results. */
  omissionMarkers: { fires: number; linesOmitted: number }
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

/** Read-interception census over every Read tool_result in the corpus. divertedByMarker counts results short enough to be a divert (under READ_DIVERT_MAX_BYTES) that match token-goat's own deny/serve message templates, so it UNDER-counts if those templates drift. fullServesOver10k counts non-diverted Read results above 10 KiB: the pool surgical reads exist to shrink. */
export interface ReadInterceptionRollup {
  readResults: number
  divertedByMarker: number
  divertedBytes: number
  fullServesOver10k: number
  fullServeBytesOver10k: number
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
}

async function auditOneFile(filePath: string, s: SessionAuditSummary, toolMap: Map<string, ToolRollup>, attachmentMap: Map<string, AttachmentKindRollup>, hookMap: Map<string, HookOutputRollup>, laneObservations: LaneObservation[]): Promise<void> {
  const isLane = filePath.split(/[\\/]/).includes('subagents')
  let laneFirstPrefix: number | null = null
  let laneBriefBytes = -1
  const toolNameById = new Map<string, string>()
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
          if (name === 'Read') {
            s.readInterception.readResults += 1
            if (bytes < READ_DIVERT_MAX_BYTES && READ_DIVERT_MARKER_RE.test(text)) {
              s.readInterception.divertedByMarker += 1
              s.readInterception.divertedBytes += bytes
            } else if (bytes >= READ_FULL_SERVE_MIN_BYTES) {
              s.readInterception.fullServesOver10k += 1
              s.readInterception.fullServeBytesOver10k += bytes
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
        if (obj['subtype'] === 'compact_boundary') flushLane(obj['isSidechain'] === true ? 1 : 0)
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
  if (isLane) laneObservations.push({ firstPrefixTokens: laneFirstPrefix, calls: usageSeenIds.size, briefBytes: Math.max(0, laneBriefBytes) })
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
    readInterception: { readResults: 0, divertedByMarker: 0, divertedBytes: 0, fullServesOver10k: 0, fullServeBytesOver10k: 0 },
    lineTypes: {},
    omissionMarkers: { fires: 0, linesOmitted: 0 },
  }
  const toolMap = new Map<string, ToolRollup>()
  const attachmentMap = new Map<string, AttachmentKindRollup>()
  const hookMap = new Map<string, HookOutputRollup>()
  const laneObservations: LaneObservation[] = []
  for (const file of files) {
    try {
      await auditOneFile(file, summary, toolMap, attachmentMap, hookMap, laneObservations)
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
  summary.tools = [...toolMap.values()].sort((a, b) => b.resultBytes - a.resultBytes || a.name.localeCompare(b.name))
  for (const roll of attachmentMap.values()) {
    roll.billedEquivTokens = Math.round(CACHE_WRITE_MULTIPLIER * roll.estTokens + CACHE_READ_MULTIPLIER * roll.rereadTokens)
  }
  summary.attachmentKinds = [...attachmentMap.values()].sort((a, b) => b.billedEquivTokens - a.billedEquivTokens || b.injections - a.injections || a.kind.localeCompare(b.kind))
  summary.hookOutputs = [...hookMap.values()].sort((a, b) => b.contextBytes - a.contextBytes || b.fires - a.fires || a.origin.localeCompare(b.origin) || a.event.localeCompare(b.event))
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
  lines.push('')
  lines.push('## Read interception (token-goat divert markers inside Read tool results)')
  const ri = s.readInterception
  lines.push(`Read results: ${fmt(ri.readResults)}; diverted by marker: ${fmt(ri.divertedByMarker)} (${fmt(ri.divertedBytes)} bytes); full serves >=10 KiB: ${fmt(ri.fullServesOver10k)} (${fmt(ri.fullServeBytesOver10k)} bytes)`)
  lines.push('')
  lines.push('## Mid-trim omission markers inside tool results')
  lines.push(`fires: ${fmt(s.omissionMarkers.fires)}, lines discarded: ${fmt(s.omissionMarkers.linesOmitted)}`)
  return lines.join('\n')
}
