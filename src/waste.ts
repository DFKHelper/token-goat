/**
 * Session spend-ledger: parses a Claude Code session transcript (JSONL) and
 * attributes token cost per tool call, per tool name, and per file, then
 * flags a few concrete waste signals. Backs `token-goat waste`.
 *
 * Transcript format (Claude Code, not otherwise documented in this repo --
 * confirmed empirically against real transcripts under
 * `~/.claude/projects/<slug>/*.jsonl`): one JSON object per line. Assistant
 * lines have `message.content` containing `{ type: 'tool_use', id, name,
 * input }` blocks; the corresponding result arrives in a later `user`-role
 * line as a `{ type: 'tool_result', tool_use_id, content }` block, where
 * `content` is either a plain string or an array of `{ type: 'text', text }`
 * blocks. Line order in the file is chronological.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { estimateTokens } from './overflow_guard.js'
import { commandHash, getBashOutput, normalizeCommandForCacheKey } from './bash_output_cache.js'

// ---- transcript discovery ----------------------------------------------------

/**
 * Directory Claude Code stores this project's session transcripts under.
 *
 * Matches the project-dir slug convention already relied on by
 * `findMemoryMd` in cli_context_stats.ts: every non-alphanumeric character of
 * the resolved project root becomes `-`, no trimming.
 */
export function projectTranscriptsDir(projectRoot: string): string {
  const rootStr = path.resolve(projectRoot)
  const slug = rootStr.replace(/[^A-Za-z0-9]/g, '-')
  return path.join(os.homedir(), '.claude', 'projects', slug)
}

/** Return the most-recently-modified `*.jsonl` transcript for `projectRoot`, or null if none exist. */
export function findLatestTranscript(projectRoot: string): string | null {
  const dir = projectTranscriptsDir(projectRoot)
  let entries: string[]
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
  } catch {
    return null
  }
  let best: { file: string; mtimeMs: number } | null = null
  for (const name of entries) {
    const full = path.join(dir, name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (best === null || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs }
  }
  return best?.file ?? null
}

// ---- parsing ------------------------------------------------------------------

export interface ParsedToolCall {
  /** Position in the transcript, in encounter order (0-based). */
  seq: number
  id: string
  name: string
  input: unknown
  /** Best-effort file path for Read/Edit/Write/NotebookEdit calls. */
  filePath: string | null
  /** Best-effort shell command for Bash calls. */
  command: string | null
  /** Short human-readable description of the input (file path, command, pattern, ...). */
  summary: string
  /** Working directory recorded on the transcript line this call appeared on, if present. */
  cwd: string | null
}

export interface ParsedTranscript {
  calls: ParsedToolCall[]
  resultTextById: Map<string, string>
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

const FILE_PATH_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'])

function extractFilePath(name: string, input: unknown): string | null {
  if (!FILE_PATH_TOOLS.has(name)) return null
  if (input === null || typeof input !== 'object') return null
  const fp = (input as Record<string, unknown>)['file_path']
  return typeof fp === 'string' ? fp : null
}

function extractCommand(name: string, input: unknown): string | null {
  if (name !== 'Bash') return null
  if (input === null || typeof input !== 'object') return null
  const cmd = (input as Record<string, unknown>)['command']
  return typeof cmd === 'string' ? cmd : null
}

function summarizeInput(name: string, input: unknown, filePath: string | null, command: string | null): string {
  if (filePath !== null) return filePath
  if (command !== null) return command.length > 100 ? `${command.slice(0, 100)}…` : command
  if (input === null || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const key of ['pattern', 'query', 'path', 'description', 'prompt']) {
    const v = o[key]
    if (typeof v === 'string') return v.length > 100 ? `${v.slice(0, 100)}…` : v
  }
  const s = safeStringify(input)
  return s.length > 100 ? `${s.slice(0, 100)}…` : s
}

function extractResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b !== null && typeof b === 'object' && (b as Record<string, unknown>)['type'] === 'text') {
          const t = (b as Record<string, unknown>)['text']
          return typeof t === 'string' ? t : ''
        }
        return ''
      })
      .join('\n')
  }
  return ''
}

/** Parse a transcript JSONL file into ordered tool calls plus a map of tool_use id -> result text. */
export function parseTranscript(transcriptPath: string): ParsedTranscript {
  const raw = fs.readFileSync(transcriptPath, 'utf-8')
  const calls: ParsedToolCall[] = []
  const resultTextById = new Map<string, string>()
  let seq = 0

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let obj: unknown
    try {
      obj = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (obj === null || typeof obj !== 'object') continue
    const o = obj as Record<string, unknown>
    const message = o['message']
    if (message === null || typeof message !== 'object') continue
    const content = (message as Record<string, unknown>)['content']
    if (!Array.isArray(content)) continue
    const cwd = typeof o['cwd'] === 'string' ? (o['cwd'] as string) : null

    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      const b = block as Record<string, unknown>

      if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        const name = b['name']
        const input = b['input']
        const filePath = extractFilePath(name, input)
        const command = extractCommand(name, input)
        calls.push({
          seq: seq++,
          id: b['id'],
          name,
          input,
          filePath,
          command,
          summary: summarizeInput(name, input, filePath, command),
          cwd,
        })
      } else if (b['type'] === 'tool_result' && typeof b['tool_use_id'] === 'string') {
        const id = b['tool_use_id']
        if (!resultTextById.has(id)) {
          resultTextById.set(id, extractResultText(b['content']))
        }
      }
    }
  }

  return { calls, resultTextById }
}

// ---- cost attribution -----------------------------------------------------

export interface ToolCallCost extends ParsedToolCall {
  tokens: number
}

/** Attach an estimated result-token cost (via {@link estimateTokens}) to every parsed call. */
export function costPerCall(parsed: ParsedTranscript): ToolCallCost[] {
  return parsed.calls.map((c) => ({
    ...c,
    tokens: estimateTokens(parsed.resultTextById.get(c.id) ?? ''),
  }))
}

export interface TokensByKey {
  key: string
  tokens: number
}

function aggregateSortedDesc(pairs: Iterable<[string, number]>): TokensByKey[] {
  return [...pairs].map(([key, tokens]) => ({ key, tokens })).sort((a, b) => b.tokens - a.tokens)
}

/** Total tokens per tool name (Read, Bash, Grep, ...). */
export function tokensByTool(costs: ToolCallCost[]): TokensByKey[] {
  const m = new Map<string, number>()
  for (const c of costs) m.set(c.name, (m.get(c.name) ?? 0) + c.tokens)
  return aggregateSortedDesc(m)
}

/** Total tokens per file path, for Read/Edit/Write/NotebookEdit calls only. */
export function tokensByFile(costs: ToolCallCost[]): TokensByKey[] {
  const m = new Map<string, number>()
  for (const c of costs) {
    if (c.filePath === null) continue
    m.set(c.filePath, (m.get(c.filePath) ?? 0) + c.tokens)
  }
  return aggregateSortedDesc(m)
}

/** The `n` most expensive individual tool calls, by result tokens. */
export function topExpensiveCalls(costs: ToolCallCost[], n: number): ToolCallCost[] {
  return [...costs].sort((a, b) => b.tokens - a.tokens).slice(0, n)
}

// ---- waste signals ----------------------------------------------------------

export interface NeverTouchedFile {
  filePath: string
  tokens: number
}

/**
 * Files read via Read whose path is never referenced again afterward: no
 * later Read/Edit/Write/NotebookEdit of the same path, and no later tool_use
 * whose input mentions the path anywhere (e.g. a Grep scoped to it, or a Bash
 * command operating on it). Aggregated per file across all of that file's
 * Read calls, anchored at the *first* Read of the file -- a second Read of
 * the same path is itself a "referenced again" event, so it must count as
 * touching the file rather than reset the window.
 */
export function neverTouchedAgain(costs: ToolCallCost[]): NeverTouchedFile[] {
  const readsByFile = new Map<string, ToolCallCost[]>()
  for (const c of costs) {
    if (c.name !== 'Read' || c.filePath === null) continue
    const arr = readsByFile.get(c.filePath) ?? []
    arr.push(c)
    readsByFile.set(c.filePath, arr)
  }

  const out: NeverTouchedFile[] = []
  for (const [filePath, reads] of readsByFile) {
    const firstSeq = Math.min(...reads.map((r) => r.seq))
    const touchedLater = costs.some((c) => {
      if (c.seq <= firstSeq) return false
      if (c.filePath === filePath) return true
      return safeStringify(c.input).includes(filePath)
    })
    if (!touchedLater) {
      out.push({ filePath, tokens: reads.reduce((n, r) => n + r.tokens, 0) })
    }
  }
  return out.sort((a, b) => b.tokens - a.tokens)
}

export interface RepeatedBashCommand {
  /** Normalized command (see `normalizeCommandForCacheKey`). */
  normalized: string
  count: number
  totalTokens: number
  avgTokens: number
}

/**
 * Bash commands run 2+ times in the session (grouped by
 * `normalizeCommandForCacheKey`) where none of the repeat runs hit
 * token-goat's own bash-output cache (`bash_output_cache.ts`).
 *
 * Cache membership is checked best-effort via `commandHash` + `getBashOutput`
 * for each occurrence's recorded command/cwd; a lookup that throws (e.g. a
 * transient fingerprint probe failure) is treated as a miss rather than
 * aborting the whole report. Note this check reflects the *current* on-disk
 * cache state, not the cache state at the time each historical command ran --
 * a git-mutable command (`git status`/`git diff`) in particular is
 * fingerprinted against live repo state, so a session-old invocation will
 * usually miss even if it was cached when it originally ran. Treat this list
 * as "still uncached as of right now", not a perfect historical replay.
 */
export async function repeatedUncompressedBashCommands(costs: ToolCallCost[]): Promise<RepeatedBashCommand[]> {
  const groups = new Map<string, ToolCallCost[]>()
  for (const c of costs) {
    if (c.name !== 'Bash' || c.command === null) continue
    const norm = normalizeCommandForCacheKey(c.command)
    const arr = groups.get(norm) ?? []
    arr.push(c)
    groups.set(norm, arr)
  }

  const out: RepeatedBashCommand[] = []
  for (const [norm, calls] of groups) {
    if (calls.length < 2) continue

    let cached = false
    for (const c of calls) {
      try {
        const hash = await commandHash(c.command as string, c.cwd)
        if (getBashOutput(hash) !== null) {
          cached = true
          break
        }
      } catch {
        // Treat a failed fingerprint lookup as a cache miss; not fatal to the report.
      }
    }
    if (cached) continue

    const totalTokens = calls.reduce((n, c) => n + c.tokens, 0)
    out.push({
      normalized: norm,
      count: calls.length,
      totalTokens,
      avgTokens: Math.round(totalTokens / calls.length),
    })
  }
  return out.sort((a, b) => b.totalTokens - a.totalTokens)
}

// ---- report -------------------------------------------------------------------

export interface WasteReport {
  transcriptPath: string
  totalTokens: number
  tokensByTool: TokensByKey[]
  tokensByFile: TokensByKey[]
  topCalls: Array<{ seq: number; name: string; summary: string; tokens: number }>
  neverTouchedAgain: NeverTouchedFile[]
  repeatedUncompressedBash: RepeatedBashCommand[]
}

export async function buildWasteReport(transcriptPath: string, opts: { topN?: number } = {}): Promise<WasteReport> {
  const parsed = parseTranscript(transcriptPath)
  const costs = costPerCall(parsed)
  const topN = opts.topN ?? 10

  return {
    transcriptPath,
    totalTokens: costs.reduce((n, c) => n + c.tokens, 0),
    tokensByTool: tokensByTool(costs),
    tokensByFile: tokensByFile(costs),
    topCalls: topExpensiveCalls(costs, topN).map((c) => ({ seq: c.seq, name: c.name, summary: c.summary, tokens: c.tokens })),
    neverTouchedAgain: neverTouchedAgain(costs),
    repeatedUncompressedBash: await repeatedUncompressedBashCommands(costs),
  }
}
