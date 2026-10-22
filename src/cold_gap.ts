/** Cold-cache re-write accounting behind `session-audit`. A request is a cold re-write when the gap since the previous request on its lane outlived the prompt-cache TTL of its tier and the request then wrote most of its prefix back instead of reading it. Each one is attributed to the tool call the session was waiting on during the gap (the last tool_use of the previous request), by tool name and, for Bash, a coarse class of the command's first word. Aggregates only: no command text, prompt or path is stored. Transcript fields read (CAPTURE: field names read off real Claude Code transcript lines, 2026-10-22): the line's top-level `timestamp` (ISO 8601), and the assistant message's `usage.cache_creation.ephemeral_5m_input_tokens` / `usage.cache_creation.ephemeral_1h_input_tokens`, which split `usage.cache_creation_input_tokens` by TTL tier. */

import { displaySafeText } from './paths.js'
import { countNoun } from './util.js'

/** Cache TTL of the 5-minute tier (Anthropic prompt-caching docs: "5-minute cache duration"; the 1-hour tier is the longer option). */
export const COLD_TTL_MS_5M = 5 * 60 * 1000

/** Cache TTL of the 1-hour tier. */
export const COLD_TTL_MS_1H = 60 * 60 * 1000

/** A request writing fewer cache tokens than this is not a prefix re-write, whatever its read share (the API will not cache a shorter prefix at all). */
export const COLD_MIN_CACHE_WRITE_TOKENS = 1024

/** A request is a re-write only when cache reads cover less than this share of (reads + writes): a warm request that merely appends a few new turns reads nearly everything. */
export const COLD_MAX_READ_SHARE = 0.2

/** Attribution bucket for a gap whose previous request issued no tool call (the session was waiting on the user or on a notification, not on a tool). */
export const COLD_NO_TOOL_BUCKET = '(none)'

export type ColdGapKind = 'main' | 'subagent'

/** The billed-token fields of one request, the three the audit's billed-equivalent model prices. */
export interface ColdGapUsage {
  input: number
  cacheWrite: number
  cacheRead: number
  /** Share of {@link cacheWrite} the usage record puts in the 5-minute tier. */
  cacheWrite5m: number
  /** Share of {@link cacheWrite} the usage record puts in the 1-hour tier. */
  cacheWrite1h: number
}

/** Price weights of the audit's billed-equivalent model: base input 1, so a cache write is 1.25 and a cache read 0.1. Passed in so this module never imports session_audit.ts. */
export interface ColdGapWeights {
  cacheWrite: number
  cacheRead: number
}

/** One tool bucket's cold re-writes. */
export interface ColdGapToolRow {
  /** Tool name, `Bash:<class>` for a Bash call, or {@link COLD_NO_TOOL_BUCKET}. */
  tool: string
  coldRewrites: number
  /** Billed-equivalent tokens of the whole cold requests (input + 1.25 x cache-write + 0.1 x cache-read; output is not priced by the audit's model). */
  billedEquivTokens: number
  /** What the re-write cost over reading the same tokens from cache: cache-write tokens x (1.25 - 0.1). The upper bound a warm cache would have saved. */
  rewriteBilledEquivTokens: number
  /** billedEquivTokens over the whole kind's billed-equivalent tokens. */
  billedShare: number
}

export interface ColdGapKindRollup {
  /** Transcripts of this kind with at least one request. */
  sessions: number
  requests: number
  /** Billed-equivalent tokens of every request of this kind. */
  billedEquivTokens: number
  coldRewrites: number
  coldBilledEquivTokens: number
  coldRewriteBilledEquivTokens: number
  coldBilledShare: number
  /** Ranked by billedEquivTokens descending; complete. */
  byTool: ColdGapToolRow[]
}

export interface ColdGapSessionRow {
  /** Transcript file name without extension (a session or agent id, never content). */
  session: string
  kind: ColdGapKind
  requests: number
  coldRewrites: number
  billedEquivTokens: number
  coldBilledEquivTokens: number
  coldBilledShare: number
}

export interface ColdGapCensus {
  main: ColdGapKindRollup
  subagent: ColdGapKindRollup
  /** Only transcripts with at least one cold re-write, ranked by coldBilledEquivTokens descending; complete. */
  sessions: ColdGapSessionRow[]
}

interface UsageSum {
  input: number
  cacheWrite: number
  cacheRead: number
}

interface KindAcc {
  sessions: number
  requests: number
  total: UsageSum
  cold: number
  coldTotal: UsageSum
  byTool: Record<string, { cold: number; usage: UsageSum }>
}

interface SessionAcc {
  session: string
  kind: ColdGapKind
  requests: number
  total: UsageSum
  cold: number
  coldTotal: UsageSum
}

interface AccState {
  main: KindAcc
  subagent: KindAcc
  sessions: SessionAcc[]
}

const zeroSum = (): UsageSum => ({ input: 0, cacheWrite: 0, cacheRead: 0 })

const emptyKind = (): KindAcc => ({ sessions: 0, requests: 0, total: zeroSum(), cold: 0, coldTotal: zeroSum(), byTool: {} })

function addSum(into: UsageSum, u: ColdGapUsage): void {
  into.input += u.input
  into.cacheWrite += u.cacheWrite
  into.cacheRead += u.cacheRead
}

/** First words that identify a test runner. Judged from the first word only: `npm test` is `runner`, because `npm` alone cannot tell a test from a build. */
const TEST_HEADS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'tox', 'nox', 'phpunit', 'rspec', 'ava'])
const BUILD_HEADS = new Set(['tsc', 'make', 'cmake', 'msbuild', 'gradle', 'gradlew', 'mvn', 'webpack', 'vite', 'esbuild', 'rollup', 'turbo', 'ninja', 'bazel'])
const RUNNER_HEADS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'python', 'python3', 'py', 'uv', 'pip', 'cargo', 'go', 'dotnet', 'ruby', 'bundle', 'php'])
const GIT_HEADS = new Set(['git', 'gh'])
const WAIT_HEADS = new Set(['sleep', 'timeout', 'wait', 'start-sleep'])
const LOOP_HEADS = new Set(['until', 'while', 'for'])
const SHELL_WRAPPER_HEADS = new Set(['bash', 'sh', 'zsh', 'env', 'export', 'unset', 'time', 'nice', 'nohup', 'powershell', 'powershell.exe', 'pwsh'])
const FILE_OPS_HEADS = new Set(['rm', 'cp', 'mv', 'mkdir', 'cmp', 'touch', 'chmod'])
const NETWORK_HEADS = new Set(['curl', 'wget', 'ping'])
const SEARCH_READ_HEADS = new Set(['ls', 'cat', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'find', 'wc', 'sort', 'echo', 'pwd', 'cd', 'token-goat', 'tg'])

/** Coarse class of a Bash command from its first word (already stripped of env assignments and a cd prefix by the caller). Never the command text. */
export function bashCommandClass(head: string): string {
  const h = head.toLowerCase()
  if (TEST_HEADS.has(h)) return 'test'
  if (BUILD_HEADS.has(h)) return 'build'
  if (GIT_HEADS.has(h)) return 'git'
  if (RUNNER_HEADS.has(h)) return 'runner'
  if (WAIT_HEADS.has(h)) return 'wait'
  if (LOOP_HEADS.has(h)) return 'shell-loop'
  if (SHELL_WRAPPER_HEADS.has(h)) return 'shell-wrapper'
  if (FILE_OPS_HEADS.has(h)) return 'file-ops'
  if (NETWORK_HEADS.has(h)) return 'network'
  if (SEARCH_READ_HEADS.has(h)) return 'search-read'
  return 'other'
}

/** The tool bucket a tool_use falls in: its name, or `Bash:<class>` for Bash. `bashHead` is the command's first word, undefined for a non-Bash call or a Bash call that carried no command string. */
export function coldGapToolLabel(name: string, bashHead: string | undefined): string {
  if (name !== 'Bash') return name
  return `Bash:${bashHead === undefined ? 'other' : bashCommandClass(bashHead)}`
}

/** Mutable per-transcript tracker. One per file; call {@link ColdGapFile.end} once the file has streamed. */
export interface ColdGapFile {
  /** A new unique API request (first sight of its message id) on `lane`; `timestampMs` is null when the line carried no parsable timestamp. */
  request(lane: number, id: string, timestampMs: number | null, usage: ColdGapUsage): void
  /** Another assistant line of the request `id` already seen on `lane` (a streamed content block): moves the end of that request later. */
  line(lane: number, id: string, timestampMs: number | null): void
  /** A tool_use block of request `id`: the latest one is what the session waits on after that request. */
  toolUse(lane: number, id: string, label: string): void
  /** Folds this file into the accumulator. */
  end(): void
}

export interface ColdGapAccumulator {
  beginFile(session: string, kind: ColdGapKind): ColdGapFile
  /** Prices the counts with `weights` into a {@link ColdGapCensus}. */
  finish(weights: ColdGapWeights): ColdGapCensus
  /** Returns a function that puts the counts back to what they are now. */
  checkpoint(): () => void
}

interface LaneState {
  id: string
  /** Timestamp of the last assistant line of the request, null when none carried one. */
  lastMs: number | null
  tool: string | null
  /** Tier of the last request on this lane that named one, used when a request carries no tier split. */
  ttlMs: number
}

function toolRow(kind: KindAcc, tool: string): { cold: number; usage: UsageSum } {
  return (kind.byTool[tool] ??= { cold: 0, usage: zeroSum() })
}

/** The TTL of the tier a request wrote, or `fallback` when its usage record names no tier split. */
function tierTtl(u: ColdGapUsage, fallback: number): number {
  if (u.cacheWrite1h > u.cacheWrite5m) return COLD_TTL_MS_1H
  if (u.cacheWrite5m > 0 || u.cacheWrite1h > 0) return COLD_TTL_MS_5M
  return fallback
}

/** Whether `u`, arriving `gapMs` after the previous request, is a cold prefix re-write under `ttlMs`. */
export function isColdRewrite(gapMs: number, ttlMs: number, u: ColdGapUsage): boolean {
  if (gapMs <= ttlMs) return false
  if (u.cacheWrite < COLD_MIN_CACHE_WRITE_TOKENS) return false
  return u.cacheRead < COLD_MAX_READ_SHARE * (u.cacheRead + u.cacheWrite)
}

export function newColdGapAccumulator(): ColdGapAccumulator {
  const state: AccState = { main: emptyKind(), subagent: emptyKind(), sessions: [] }
  return {
    beginFile(session, kind) {
      const acc = emptyKind()
      const row: SessionAcc = { session, kind, requests: 0, total: zeroSum(), cold: 0, coldTotal: zeroSum() }
      const lanes = new Map<number, LaneState>()
      return {
        request(lane, id, timestampMs, usage) {
          const prev = lanes.get(lane)
          const ttlMs = tierTtl(usage, prev?.ttlMs ?? COLD_TTL_MS_5M)
          row.requests += 1
          addSum(row.total, usage)
          addSum(acc.total, usage)
          if (prev !== undefined && prev.lastMs !== null && timestampMs !== null && isColdRewrite(timestampMs - prev.lastMs, ttlMs, usage)) {
            const label = prev.tool ?? COLD_NO_TOOL_BUCKET
            row.cold += 1
            addSum(row.coldTotal, usage)
            acc.cold += 1
            addSum(acc.coldTotal, usage)
            const t = toolRow(acc, label)
            t.cold += 1
            addSum(t.usage, usage)
          }
          lanes.set(lane, { id, lastMs: timestampMs, tool: null, ttlMs })
        },
        line(lane, id, timestampMs) {
          const cur = lanes.get(lane)
          if (cur !== undefined && cur.id === id && timestampMs !== null) cur.lastMs = timestampMs
        },
        toolUse(lane, id, label) {
          const cur = lanes.get(lane)
          if (cur !== undefined && cur.id === id) cur.tool = label
        },
        end() {
          if (row.requests === 0) return
          const into = state[kind]
          into.sessions += 1
          into.requests += row.requests
          addUsageSums(into.total, acc.total)
          into.cold += acc.cold
          addUsageSums(into.coldTotal, acc.coldTotal)
          for (const [tool, t] of Object.entries(acc.byTool)) {
            const dst = toolRow(into, tool)
            dst.cold += t.cold
            addUsageSums(dst.usage, t.usage)
          }
          if (row.cold > 0) state.sessions.push(row)
        },
      }
    },
    checkpoint() {
      const saved = structuredClone(state)
      return () => {
        state.main = saved.main
        state.subagent = saved.subagent
        state.sessions = saved.sessions
      }
    },
    finish(weights) {
      const billed = (s: UsageSum): number => s.input + weights.cacheWrite * s.cacheWrite + weights.cacheRead * s.cacheRead
      const rewrite = (s: UsageSum): number => (weights.cacheWrite - weights.cacheRead) * s.cacheWrite
      const share = (part: number, whole: number): number => (whole === 0 ? 0 : part / whole)
      const rollup = (k: KindAcc): ColdGapKindRollup => {
        const total = billed(k.total)
        const byTool = Object.entries(k.byTool).map(([tool, t]) => ({
          tool,
          coldRewrites: t.cold,
          billedEquivTokens: Math.round(billed(t.usage)),
          rewriteBilledEquivTokens: Math.round(rewrite(t.usage)),
          billedShare: share(billed(t.usage), total),
        }))
        byTool.sort((a, b) => b.billedEquivTokens - a.billedEquivTokens || b.coldRewrites - a.coldRewrites || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0))
        return {
          sessions: k.sessions,
          requests: k.requests,
          billedEquivTokens: Math.round(total),
          coldRewrites: k.cold,
          coldBilledEquivTokens: Math.round(billed(k.coldTotal)),
          coldRewriteBilledEquivTokens: Math.round(rewrite(k.coldTotal)),
          coldBilledShare: share(billed(k.coldTotal), total),
          byTool,
        }
      }
      const sessions = state.sessions.map((s) => ({
        session: s.session,
        kind: s.kind,
        requests: s.requests,
        coldRewrites: s.cold,
        billedEquivTokens: Math.round(billed(s.total)),
        coldBilledEquivTokens: Math.round(billed(s.coldTotal)),
        coldBilledShare: share(billed(s.coldTotal), billed(s.total)),
      }))
      sessions.sort((a, b) => b.coldBilledEquivTokens - a.coldBilledEquivTokens || (a.session < b.session ? -1 : a.session > b.session ? 1 : 0))
      return { main: rollup(state.main), subagent: rollup(state.subagent), sessions }
    },
  }
}

function addUsageSums(into: UsageSum, from: UsageSum): void {
  into.input += from.input
  into.cacheWrite += from.cacheWrite
  into.cacheRead += from.cacheRead
}

export function emptyColdGapCensus(): ColdGapCensus {
  const empty = (): ColdGapKindRollup => ({ sessions: 0, requests: 0, billedEquivTokens: 0, coldRewrites: 0, coldBilledEquivTokens: 0, coldRewriteBilledEquivTokens: 0, coldBilledShare: 0, byTool: [] })
  return { main: empty(), subagent: empty(), sessions: [] }
}

const fmt = (n: number): string => n.toLocaleString('en-US')

const pct = (share: number): string => `${(share * 100).toFixed(2)}%`

/** Transcripts listed in the text form; the JSON form carries every one. */
const SESSION_ROWS_SHOWN = 10

/** Tool rows listed per kind in the text form; the JSON form carries every one. */
const TOOL_ROWS_SHOWN = 12

/** Text section for the session-audit report. */
export function formatColdGap(c: ColdGapCensus): string[] {
  const lines: string[] = []
  lines.push('## Cold cache re-writes (gap since the previous request outlived the cache TTL, then the prefix was written again)')
  lines.push(`TTL 5 min for 5-minute-tier writes, 1 h for 1-hour-tier writes; a re-write writes >=${fmt(COLD_MIN_CACHE_WRITE_TOKENS)} cache tokens and reads <${pct(COLD_MAX_READ_SHARE)} of (read + write). Billed-equivalent = input + 1.25 x cache-write + 0.1 x cache-read (output not priced). Attributed to the tool call the session waited on.`)
  for (const [label, k] of [['Main sessions', c.main], ['Subagents', c.subagent]] as const) {
    lines.push(`${label}: ${fmt(k.sessions)} transcripts, ${fmt(k.requests)} requests, cold re-writes ${fmt(k.coldRewrites)}, billed-equiv ${fmt(k.coldBilledEquivTokens)} of ${fmt(k.billedEquivTokens)} (${pct(k.coldBilledShare)}), avoidable write premium ${fmt(k.coldRewriteBilledEquivTokens)}`)
    for (const t of k.byTool.slice(0, TOOL_ROWS_SHOWN)) {
      lines.push(`  ${displaySafeText(t.tool).padEnd(28)} re-writes ${fmt(t.coldRewrites).padStart(8)}  billed-equiv ${fmt(t.billedEquivTokens).padStart(15)}  share ${pct(t.billedShare).padStart(7)}`)
    }
    if (k.byTool.length > TOOL_ROWS_SHOWN) lines.push(`  (${countNoun(k.byTool.length - TOOL_ROWS_SHOWN, 'smaller tool bucket')} omitted from this table; --json has all)`)
    if (k.byTool.length === 0) lines.push('  (no cold re-writes)')
  }
  if (c.sessions.length > 0) lines.push('Transcripts with the most cold re-writes:')
  for (const s of c.sessions.slice(0, SESSION_ROWS_SHOWN)) {
    lines.push(`  ${displaySafeText(s.kind).padEnd(8)} ${displaySafeText(s.session).padEnd(40)} re-writes ${fmt(s.coldRewrites).padStart(5)}  billed-equiv ${fmt(s.coldBilledEquivTokens).padStart(13)}  share ${pct(s.coldBilledShare).padStart(7)}`)
  }
  if (c.sessions.length > SESSION_ROWS_SHOWN) lines.push(`  (${countNoun(c.sessions.length - SESSION_ROWS_SHOWN, 'more transcript')} with cold re-writes omitted; --json has all)`)
  return lines
}
