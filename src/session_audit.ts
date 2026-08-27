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
  positionDeciles: PositionDecile[]
  /** Aggregate per-line-type census (line counts and bytes by JSONL `type`). */
  lineTypes: Record<string, { lines: number; bytes: number }>
  /** Mid-trim marker census: `--- N lines omitted ---` fires inside tool results. */
  omissionMarkers: { fires: number; linesOmitted: number }
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
  const entries = fs.readdirSync(corpusDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.endsWith('.jsonl')) {
      found.push(path.join(corpusDir, entry.name))
    } else if (entry.isDirectory()) {
      let inner: fs.Dirent[]
      try {
        inner = fs.readdirSync(path.join(corpusDir, entry.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const f of inner) {
        if (f.isFile() && f.name.endsWith('.jsonl')) found.push(path.join(corpusDir, entry.name, f.name))
      }
    }
  }
  return found.sort()
}

export function defaultCorpusDir(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

/** Stream one transcript into the accumulating summary. Throws only on stream-open failure. */
async function auditOneFile(filePath: string, s: SessionAuditSummary, toolMap: Map<string, ToolRollup>): Promise<void> {
  const toolNameById = new Map<string, string>()
  const usageSeenIds = new Set<string>()
  const perCall: PerCallUsage[] = []
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
          perCall.push({ inputTotal: input + cacheWrite + cacheRead, cacheRead, output })
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
        }
        continue
      }
      if (type === 'attachment') {
        addCategory(s.estimated.attachments, lineBytes)
        continue
      }
      if (type === 'system' || type === 'summary') {
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
    positionDeciles: Array.from({ length: 10 }, (_, i) => ({ decile: i + 1, apiCalls: 0, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 })),
    lineTypes: {},
    omissionMarkers: { fires: 0, linesOmitted: 0 },
  }
  const toolMap = new Map<string, ToolRollup>()
  for (const file of files) {
    try {
      await auditOneFile(file, summary, toolMap)
      summary.filesScanned += 1
    } catch {
      summary.filesFailed += 1
    }
  }
  summary.tools = [...toolMap.values()].sort((a, b) => b.resultBytes - a.resultBytes || a.name.localeCompare(b.name))
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
  lines.push('## Measured billed tokens by session position (deciles of each session\'s API calls)')
  for (const d of s.positionDeciles) {
    lines.push(`decile ${d.decile.toString().padStart(2)}  calls ${fmt(d.apiCalls).padStart(9)}  input ${fmt(d.inputTokens).padStart(15)}  cache-read ${fmt(d.cacheReadTokens).padStart(15)}  output ${fmt(d.outputTokens).padStart(11)}`)
  }
  lines.push('')
  lines.push('## Mid-trim omission markers inside tool results')
  lines.push(`fires: ${fmt(s.omissionMarkers.fires)}, lines discarded: ${fmt(s.omissionMarkers.linesOmitted)}`)
  return lines.join('\n')
}
