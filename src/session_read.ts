/**
 * Surgical reads over Claude Code's own session JSONL transcripts (files
 * like `~/.claude/projects/<project-slug>/<session-id>.jsonl`). Backs
 * `token-goat session-outline` and `token-goat session-slice`.
 *
 * Transcript discovery/format matches `waste.ts` and `resume.ts`, which
 * already parse this same file for cost attribution and resume packets:
 * one JSON object per line, chronological. Not every line is a
 * conversational turn -- real transcripts interleave `custom-title`,
 * `mode`, `attachment`, `file-history-snapshot`, `system`, and other
 * bookkeeping event types alongside `user`/`assistant` message lines
 * (confirmed empirically against real transcripts). Only lines with
 * `type` `user` or `assistant` and a `message.content` field count as a
 * "turn" here; turn numbers are 1-based positions in that filtered
 * sequence, not raw line numbers, so `--range` stays stable and compact
 * even though the underlying file may have many more non-turn lines.
 *
 * `message.content` is either a plain string (a simple text message) or an
 * array of blocks (`text`, `thinking`, `tool_use`, `tool_result`, ...) --
 * unlike `waste.ts`'s `parseTranscript`, which only looks at array-content
 * lines (it only needs tool_use/tool_result), this module also has to
 * summarize plain-string turns for the outline.
 *
 * Read line-by-line via `readline` rather than `fs.readFileSync` +
 * `.split('\n')` (waste.ts's approach): these transcripts are explicitly
 * the multi-MB case this feature exists to make cheaper to inspect, so
 * avoiding one whole-file string allocation is worth the small deviation
 * from waste.ts's simpler (but for this use case, more expensive) pattern.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'

import { estimateTokens } from './compact.js'
import { projectTranscriptsDir, findLatestTranscript, safeStringify, extractResultText } from './waste.js'
import { resolveProjectRoot } from './project.js'

// ---- resolution -----------------------------------------------------------

/**
 * Resolve a `session-id-or-path` argument (or, when omitted, "the current
 * session") to an on-disk transcript path.
 *
 * Precedence:
 *  1. `arg` is an existing file path -> used directly.
 *  2. `arg` looks like a session id -> `<projectTranscriptsDir>/<arg>.jsonl`
 *     (also tried with `arg` already carrying a `.jsonl` suffix).
 *  3. `arg` omitted -> the most-recently-modified `*.jsonl` transcript in
 *     the resolved project's transcripts dir (same "current session"
 *     resolution `waste.ts`'s `runWasteCommand` already uses when
 *     `--transcript` is not passed).
 *
 * Returns null when nothing resolves; never throws.
 */
export function resolveSessionTranscript(arg?: string, opts: { project?: string } = {}): string | null {
  if (arg !== undefined && arg !== '') {
    if (fs.existsSync(arg) && fs.statSync(arg).isFile()) return arg
    const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})
    const dir = projectTranscriptsDir(projectRoot)
    const byId = arg.endsWith('.jsonl') ? arg : `${arg}.jsonl`
    const candidate = path.join(dir, byId)
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
    return null
  }

  const projectRoot = resolveProjectRoot(opts.project !== undefined ? { project: opts.project } : {})
  return findLatestTranscript(projectRoot)
}

// ---- parsing ----------------------------------------------------------------

/** One block from a `message.content` array, narrowed to the fields this module renders. */
export interface SessionBlock {
  type: string
  /** `text`/`thinking` blocks. */
  text?: string
  /** `tool_use` blocks. */
  name?: string
  input?: unknown
  /** `tool_result`/`tool_use` blocks. */
  toolUseId?: string
  /** `tool_result` content, already flattened to plain text. */
  resultText?: string
}

export interface SessionOutlineTurn {
  /** 1-based position among filtered user/assistant turns (stable `--range` locator). */
  turn: number
  /** 1-based raw line number in the transcript file. */
  lineNumber: number
  role: string
  /** Short human-readable preview of the turn's text content (truncated). */
  preview: string
  /** Tool names invoked in this turn (tool_use blocks), in order. */
  toolCalls: string[]
  /** Rough token estimate of the raw JSONL line. */
  tokens: number
  /** Byte size of the raw JSONL line. */
  bytes: number
}

export interface SessionTurnDetail {
  turn: number
  lineNumber: number
  role: string
  blocks: SessionBlock[]
}

const PREVIEW_MAX = 140

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed
}

/** Normalize one raw `message.content` block into a {@link SessionBlock}. */
function toSessionBlock(raw: unknown): SessionBlock | null {
  if (raw === null || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const type = typeof b['type'] === 'string' ? b['type'] : 'unknown'
  const block: SessionBlock = { type }
  if (typeof b['text'] === 'string') block.text = b['text']
  if (typeof b['thinking'] === 'string' && block.text === undefined) block.text = b['thinking']
  if (typeof b['name'] === 'string') block.name = b['name']
  if ('input' in b) block.input = b['input']
  if (typeof b['tool_use_id'] === 'string') block.toolUseId = b['tool_use_id']
  if (type === 'tool_result') block.resultText = extractResultText(b['content'])
  return block
}

/** Extract `{ role, blocks }` from one parsed transcript-line object, or null if it is not a user/assistant turn. */
function toTurnBlocks(obj: unknown): { role: string; blocks: SessionBlock[] } | null {
  if (obj === null || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const lineType = o['type']
  if (lineType !== 'user' && lineType !== 'assistant') return null
  const message = o['message']
  if (message === null || typeof message !== 'object') return null
  const m = message as Record<string, unknown>
  const content = m['content']
  const role = typeof m['role'] === 'string' ? m['role'] : lineType

  if (typeof content === 'string') {
    return { role, blocks: [{ type: 'text', text: content }] }
  }
  if (!Array.isArray(content)) return null
  const blocks: SessionBlock[] = []
  for (const raw of content) {
    const block = toSessionBlock(raw)
    if (block !== null) blocks.push(block)
  }
  return { role, blocks }
}

function previewForBlocks(blocks: SessionBlock[]): string {
  for (const b of blocks) {
    if (b.type === 'tool_result' && b.resultText) return truncate(b.resultText, PREVIEW_MAX)
    if ((b.type === 'text' || b.type === 'thinking') && b.text) return truncate(b.text, PREVIEW_MAX)
  }
  const toolUse = blocks.find((b) => b.type === 'tool_use')
  if (toolUse) return `${toolUse.name ?? 'tool'}(${truncate(safeStringify(toolUse.input), PREVIEW_MAX - 20)})`
  return '(empty)'
}

function toolCallsForBlocks(blocks: SessionBlock[]): string[] {
  return blocks.filter((b) => b.type === 'tool_use' && b.name !== undefined).map((b) => b.name as string)
}

/** One valid (parseable, user/assistant) turn yielded by {@link streamTurns}. */
interface StreamedTurn {
  turn: number
  lineNumber: number
  trimmed: string
  role: string
  blocks: SessionBlock[]
}

/**
 * Stream a transcript line-by-line, yielding one entry per valid turn -- blank lines,
 * malformed JSON, and non-user/assistant lines are silently skipped, mirroring
 * `toTurnBlocks`' null-return contract. Never loads the whole file into memory at once.
 * Shared iteration core for `buildSessionOutline` and `sliceSessionTurns`, which otherwise
 * differ only in what each does with a valid turn (and `sliceSessionTurns` additionally stops
 * early once past its turn range). `rl.close()` and `input.destroy()` both run in `finally` so
 * an early `break` in a `for await` consumer (which invokes this generator's `return()`) still
 * releases the stream -- `readline.close()` alone does not destroy the underlying input stream,
 * so without the explicit destroy the fs read handle/fd would linger until GC.
 */
async function* streamTurns(transcriptPath: string): AsyncGenerator<StreamedTurn> {
  const input = fs.createReadStream(transcriptPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  try {
    let lineNumber = 0
    let turn = 0
    for await (const line of rl) {
      lineNumber++
      const trimmed = line.trim()
      if (trimmed === '') continue
      let obj: unknown
      try {
        obj = JSON.parse(trimmed)
      } catch {
        continue
      }
      const parsed = toTurnBlocks(obj)
      if (parsed === null) continue
      turn++
      yield { turn, lineNumber, trimmed, role: parsed.role, blocks: parsed.blocks }
    }
  } finally {
    rl.close()
    input.destroy()
  }
}

/**
 * Stream a transcript line-by-line, building the compact per-turn outline.
 * Never loads the whole file into memory at once.
 */
export async function buildSessionOutline(transcriptPath: string): Promise<SessionOutlineTurn[]> {
  const out: SessionOutlineTurn[] = []
  for await (const t of streamTurns(transcriptPath)) {
    out.push({
      turn: t.turn,
      lineNumber: t.lineNumber,
      role: t.role,
      preview: previewForBlocks(t.blocks),
      toolCalls: toolCallsForBlocks(t.blocks),
      tokens: estimateTokens(t.trimmed),
      bytes: Buffer.byteLength(t.trimmed, 'utf8'),
    })
  }
  return out
}

/**
 * Stream a transcript line-by-line, collecting the full block content for
 * every turn whose 1-based turn number falls in `[startTurn, endTurn]`
 * (inclusive, same locators `buildSessionOutline` assigns). Stops reading
 * once past `endTurn` rather than draining the whole file.
 */
export async function sliceSessionTurns(
  transcriptPath: string,
  startTurn: number,
  endTurn: number,
): Promise<SessionTurnDetail[]> {
  const out: SessionTurnDetail[] = []
  for await (const t of streamTurns(transcriptPath)) {
    if (t.turn < startTurn) continue
    if (t.turn > endTurn) break
    out.push({ turn: t.turn, lineNumber: t.lineNumber, role: t.role, blocks: t.blocks })
  }
  return out
}

/** Parses a 1-indexed inclusive turn-range spec like "3-7" or "5". Mirrors `pdf_extract.ts`'s `parsePageRange`. */
export function parseTurnRange(spec: string): { start: number; end: number } {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim())
  if (!m) throw new Error(`invalid --range spec: ${spec} (expected "N" or "N-M")`)
  const start = parseInt(m[1] as string, 10)
  const end = m[2] ? parseInt(m[2], 10) : start
  if (start < 1 || end < start) throw new Error(`invalid --range spec: ${spec}`)
  return { start, end }
}

// ---- formatting ---------------------------------------------------------------

export function formatSessionOutline(turns: SessionOutlineTurn[]): string {
  if (turns.length === 0) return '(no turns found)'
  const lines: string[] = []
  for (const t of turns) {
    const tools = t.toolCalls.length > 0 ? `  [tools: ${t.toolCalls.join(', ')}]` : ''
    lines.push(`${t.turn}. [${t.role}] ${t.preview}${tools}  (~${t.tokens} tok, ${t.bytes}B, line ${t.lineNumber})`)
  }
  return lines.join('\n')
}

function formatBlock(block: SessionBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'thinking':
      return `[thinking]\n${block.text ?? ''}`
    case 'tool_use':
      return `[tool_use: ${block.name ?? '?'}]\n${safeStringify(block.input)}`
    case 'tool_result':
      return `[tool_result${block.toolUseId ? ` for ${block.toolUseId}` : ''}]\n${block.resultText ?? ''}`
    default:
      return `[${block.type}]`
  }
}

export function formatSessionSlice(turns: SessionTurnDetail[]): string {
  if (turns.length === 0) return '(no turns in range)'
  const parts: string[] = []
  for (const t of turns) {
    parts.push(`--- Turn ${t.turn} [${t.role}] (line ${t.lineNumber}) ---`)
    for (const block of t.blocks) {
      const text = formatBlock(block)
      if (text.length > 0) parts.push(text)
    }
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}
