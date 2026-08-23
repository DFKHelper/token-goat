/**
 * Waste analysis for Copilot CLI sessions.
 *
 * Copilot records every session as an append-only event log at
 * `<copilot-home>/session-state/<id>/events.jsonl`, which makes it a better measurement target
 * than a Claude Code transcript rather than a worse one, for two reasons.
 *
 * First, `user.message.transformedContent` is the *assembled* prompt: it carries the
 * `<current_datetime>` and `<system_reminder>` envelope that the sibling `content` field does not.
 * So the harness-injected context can be read directly instead of reconstructed by working out
 * what the renderer would have done with each record.
 *
 * Second, `session.shutdown` carries Copilot's own token accounting -- `systemTokens`,
 * `toolDefinitionsTokens`, `conversationTokens` -- so the dominant cost can be reported in the
 * unit that actually bills instead of a byte count standing in for one. On a real session here
 * those read 6569 + 7268 + 111, i.e. over 13k tokens of fixed per-request overhead against 111
 * tokens of conversation. That ratio is the finding; no estimator of ours would have been
 * trusted to produce it.
 *
 * The counterweight is that most of the file is not model-visible at all. `hook.start` and
 * `hook.end` are the largest event types on disk in a token-goat-instrumented session and reach
 * the model exactly never -- the same shape as Claude Code's `hook_success` attachments, which
 * are ~10% of a transcript and ~0% of the bill. Reporting on-disk size as if it were context is
 * the specific error this module exists to avoid, so hook records are measured separately and
 * labelled as not billed.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { copilotCliUserRoot } from './bridges/copilot_cli_install.js'

/** Event types verified to carry no model-visible content: they exist only in the on-disk log. */
const HOOK_RECORD_TYPES = new Set(['hook.start', 'hook.end'])

/** One class of injected block, aggregated across the session's turns. */
export interface CopilotBlockClass {
  /** Block label: the wrapper tag, or the first inner tag of a `<system_reminder>`. */
  kind: string
  count: number
  bytes: number
  /** Bytes belonging to a payload byte-identical to one already sent earlier this session. */
  repeatBytes: number
  repeatCount: number
}

/** Copilot's own token split for the session, as it reported it. */
export interface CopilotTokenSplit {
  systemTokens: number
  toolDefinitionsTokens: number
  conversationTokens: number
  currentTokens: number
}

export interface CopilotCompaction {
  trigger: string
  summaryBytes: number
  preTokens: number
  postTokens: number
}

export interface CopilotWasteReport {
  sessionPath: string
  sessionId: string
  turns: number
  /** Null when the session never emitted a shutdown event (still running, or killed). */
  tokens: CopilotTokenSplit | null
  blocks: CopilotBlockClass[]
  compactions: CopilotCompaction[]
  /** Bytes of hook.start/hook.end records: on disk, never in context. */
  hookRecordBytes: number
  totalEventBytes: number
}

/**
 * Split an assembled prompt into its injected blocks.
 *
 * Only top-level `<tag>...</tag>` wrappers are treated as blocks; the user's own prose between
 * them is deliberately not counted, since it is the one part of the prompt that is not overhead.
 * A `<system_reminder>` is labelled by its first inner tag (`sql_tables`, `todo_status`, ...)
 * because the wrapper name alone would collapse every distinct reminder into one bucket and hide
 * which of them is actually repeating.
 */
export function splitInjectedBlocks(transformed: string): { kind: string; body: string }[] {
  const out: { kind: string; body: string }[] = []
  const blockRe = /<([a-z_][a-z0-9_]*)>([\s\S]*?)<\/\1>/gi
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(transformed)) !== null) {
    const tag = (m[1] ?? '').toLowerCase()
    const body = m[2] ?? ''
    let kind = tag
    if (tag === 'system_reminder') {
      const inner = /^\s*<([a-z_][a-z0-9_]*)>/i.exec(body)
      kind = inner !== null ? `reminder:${(inner[1] ?? '').toLowerCase()}` : 'reminder:text'
    }
    out.push({ kind, body: m[0] })
  }
  return out
}

/** Newest `events.jsonl` under the Copilot session-state directory, or null if there is none. */
export function findLatestCopilotSession(): string | null {
  const root = path.join(copilotCliUserRoot(), 'session-state')
  let entries: string[]
  try {
    entries = fs.readdirSync(root)
  } catch {
    return null
  }
  let best: string | null = null
  let bestMtime = -Infinity
  for (const entry of entries) {
    const candidate = path.join(root, entry, 'events.jsonl')
    try {
      const st = fs.statSync(candidate)
      if (!st.isFile()) continue
      if (st.mtimeMs > bestMtime) {
        bestMtime = st.mtimeMs
        best = candidate
      }
    } catch {
      // Missing events.jsonl for this session (started but never wrote one); skip it.
    }
  }
  return best
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Parse one Copilot session event log into a waste report. */
export function buildCopilotWasteReport(eventsPath: string): CopilotWasteReport {
  const raw = fs.readFileSync(eventsPath, 'utf-8')
  const report: CopilotWasteReport = {
    sessionPath: eventsPath,
    sessionId: path.basename(path.dirname(eventsPath)),
    turns: 0,
    tokens: null,
    blocks: [],
    compactions: [],
    hookRecordBytes: 0,
    totalEventBytes: Buffer.byteLength(raw, 'utf-8'),
  }

  const classes = new Map<string, CopilotBlockClass>()
  const seen = new Map<string, Set<string>>()

  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // A partially-flushed final line is normal on a live session; skip it rather than abort.
      continue
    }
    const type = typeof event['type'] === 'string' ? (event['type'] as string) : ''
    const data = (event['data'] ?? {}) as Record<string, unknown>

    if (HOOK_RECORD_TYPES.has(type)) {
      report.hookRecordBytes += Buffer.byteLength(trimmed, 'utf-8')
      continue
    }

    if (type === 'session.shutdown') {
      // Last one wins: a resumed session writes several, and the final split is the current one.
      report.tokens = {
        systemTokens: readNumber(data, 'systemTokens'),
        toolDefinitionsTokens: readNumber(data, 'toolDefinitionsTokens'),
        conversationTokens: readNumber(data, 'conversationTokens'),
        currentTokens: readNumber(data, 'currentTokens'),
      }
      continue
    }

    if (type === 'session.compaction_complete') {
      const summary = typeof data['summaryContent'] === 'string' ? (data['summaryContent'] as string) : ''
      report.compactions.push({
        trigger: typeof data['trigger'] === 'string' ? (data['trigger'] as string) : 'unknown',
        summaryBytes: Buffer.byteLength(summary, 'utf-8'),
        preTokens: readNumber(data, 'preCompactionTokens'),
        postTokens: readNumber(data, 'postCompactionTokens'),
      })
      continue
    }

    if (type !== 'user.message') continue
    const transformed = typeof data['transformedContent'] === 'string' ? (data['transformedContent'] as string) : ''
    if (transformed === '') continue
    report.turns += 1

    for (const block of splitInjectedBlocks(transformed)) {
      const bytes = Buffer.byteLength(block.body, 'utf-8')
      let cls = classes.get(block.kind)
      if (cls === undefined) {
        cls = { kind: block.kind, count: 0, bytes: 0, repeatBytes: 0, repeatCount: 0 }
        classes.set(block.kind, cls)
      }
      cls.count += 1
      cls.bytes += bytes
      let bucket = seen.get(block.kind)
      if (bucket === undefined) {
        bucket = new Set<string>()
        seen.set(block.kind, bucket)
      }
      if (bucket.has(block.body)) {
        cls.repeatBytes += bytes
        cls.repeatCount += 1
      } else {
        bucket.add(block.body)
      }
    }
  }

  report.blocks = [...classes.values()].sort((a, b) => b.bytes - a.bytes)
  return report
}
