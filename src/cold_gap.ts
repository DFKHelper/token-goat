/** Cold-cache re-write accounting behind `session-audit`. A request is a cold re-write when the gap since the previous request on its lane outlived the prompt-cache TTL of its tier and the request then wrote most of its prefix back instead of reading it. Each one is attributed to the tool call the session was waiting on during the gap (the last tool_use of the previous request), by tool name and, for Bash, a coarse class of the command's first word. Aggregates only: no command text, prompt or path is stored. Transcript fields read (CAPTURE: field names read off real Claude Code transcript lines, 2026-10-22): the line's top-level `timestamp` (ISO 8601), and the assistant message's `usage.cache_creation.ephemeral_5m_input_tokens` / `usage.cache_creation.ephemeral_1h_input_tokens`, which split `usage.cache_creation_input_tokens` by TTL tier. */

import { displaySafeText } from './paths.js'
import { countNoun } from './util.js'

/** Cache TTL of the 5-minute tier (Anthropic prompt-caching docs: "5-minute cache duration"; the 1-hour tier is the longer option). */
export const COLD_TTL_MS_5M = 5 * 60 * 1000

/** Cache TTL of the 1-hour tier. */
export const COLD_TTL_MS_1H = 60 * 60 * 1000

/** A request writing fewer cache tokens than this is not a prefix re-write, whatever else it reads (the API will not cache a shorter prefix at all). */
export const COLD_MIN_CACHE_WRITE_TOKENS = 1024

/** A request is a re-write only when it writes at least this share of what the previous request had cached (read + written): a warm request appends a few turns, a cold one writes most of the prefix again even when a shared system-prompt prefix is still read. */
export const COLD_MIN_REWRITE_SHARE_OF_PREV = 0.5

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

/** Cache-write price of the 1-hour tier in base-input units (Anthropic prompt-caching docs, https://platform.claude.com/docs/en/build-with-claude/prompt-caching, read 2026-10-22: "1-hour cache writes cost 2x base input tokens"). */
export const COLD_WRITE_MULTIPLIER_1H = 2

/** Price weights in base-input units: a 5-minute-tier cache write 1.25 (docs: "5-minute cache writes cost 25 percent more than base input tokens"), a 1-hour-tier write 2, a cache read 0.1. The 5-minute and read weights are the audit's own constants, passed in so this module never imports session_audit.ts. */
export interface ColdGapWeights {
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
}

/** One tool bucket's cold re-writes. */
export interface ColdGapToolRow {
  /** Tool name, `Bash:<class>` for a Bash call, or {@link COLD_NO_TOOL_BUCKET}. */
  tool: string
  coldRewrites: number
  /** Billed-equivalent tokens of the whole cold requests (input + tier-priced cache-write + 0.1 x cache-read; output is not priced by the audit's model). */
  billedEquivTokens: number
  /** What the re-write cost over reading the same tokens from cache: cache-write tokens x (their tier's write weight - 0.1). The upper bound a warm cache would have saved. */
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
  /** The part of cacheWrite priced at the 1-hour tier rate; the rest is priced at the 5-minute rate. */
  cacheWrite1h: number
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

const zeroSum = (): UsageSum => ({ input: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 })

const emptyKind = (): KindAcc => ({ sessions: 0, requests: 0, total: zeroSum(), cold: 0, coldTotal: zeroSum(), byTool: {} })

const snapshotKind = (k: KindAcc): KindAcc => ({
  sessions: k.sessions,
  requests: k.requests,
  total: { ...k.total },
  cold: k.cold,
  coldTotal: { ...k.coldTotal },
  byTool: Object.fromEntries(Object.entries(k.byTool).map(([tool, t]) => [tool, { cold: t.cold, usage: { ...t.usage } }])),
})

function addSum(into: UsageSum, u: ColdGapUsage): void {
  into.input += u.input
  into.cacheWrite += u.cacheWrite
  into.cacheWrite1h += Math.min(u.cacheWrite1h, u.cacheWrite)
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

/** Segment classes from most to least significant: a chain is classed by its highest-ranked segment, so a wait or a polling loop is never hidden behind `cd` or `echo`. */
const CLASS_RANK = ['shell-loop', 'wait', 'test', 'build', 'runner', 'git', 'network', 'file-ops', 'shell-wrapper', 'other', 'search-read']

const WRAPPER_DEPTH = 3

/** Splits on `;`, `&&`, `||` and newlines outside quotes. */
function splitSegments(raw: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    if (quote !== '') {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < raw.length) cur += raw.charAt(++i)
      else if (c === quote) quote = ''
      continue
    }
    if (c === '"' || c === "'") quote = c
    if (c === ';' || c === '\n' || (c === '&' && raw.charAt(i + 1) === '&') || (c === '|' && raw.charAt(i + 1) === '|')) {
      out.push(cur)
      cur = ''
      if (c === '&' || c === '|') i++
      continue
    }
    cur += c
  }
  out.push(cur)
  return out.map((x) => x.trim()).filter((x) => x !== '')
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s*/

/** The first word of `s` (a quoted word is taken whole, quotes dropped) and the text after it. */
function takeWord(s: string): [string, string] {
  const t = s.trimStart()
  const q = t.charAt(0)
  if (q === '"' || q === "'") {
    const end = t.indexOf(q, 1)
    if (end > 0) return [t.slice(1, end), t.slice(end + 1)]
  }
  let i = 0
  while (i < t.length && !/\s/.test(t.charAt(i))) i++
  return [t.slice(0, i), t.slice(i)]
}

/** Drops leading options (words starting with a dash) and, when `assigns`, VAR=value words. */
function skipOptions(s: string, assigns: boolean): string {
  let rest = s.trimStart()
  for (let guard = 0; guard < 20; guard++) {
    if (assigns && ENV_ASSIGN.test(rest)) rest = rest.replace(ENV_ASSIGN, '')
    else if (rest.startsWith('-')) rest = takeWord(rest)[1].trimStart()
    else break
  }
  return rest
}

const STRIPPED_QUOTES = new Set(['"', "'"])

/** The command a wrapper (`bash -c`, `sh -c`, `env`, `timeout N`, `nohup`, `time`) runs, or null when `seg` is not a wrapper around one. */
function unwrap(seg: string): string | null {
  let s = seg.replace(/^[(\s]+/, '')
  for (let guard = 0; guard < 20 && ENV_ASSIGN.test(s); guard++) s = s.replace(ENV_ASSIGN, '')
  const [first, after] = takeWord(s)
  const word = first.split(/[\\/]/).pop()!.replace(/\.exe$/i, '').toLowerCase()
  if (word === 'bash' || word === 'sh' || word === 'zsh') {
    let rest = after.trimStart()
    for (let guard = 0; guard < 10 && rest.startsWith('-'); guard++) {
      const [flag, next] = takeWord(rest)
      rest = next.trimStart()
      if (/^-[A-Za-z]+$/.test(flag) && flag.includes('c')) {
        const arg = rest.trim()
        return STRIPPED_QUOTES.has(arg.charAt(0)) && arg.length > 1 && arg.endsWith(arg.charAt(0)) ? arg.slice(1, -1) : arg
      }
    }
    return null
  }
  if (word === 'env') {
    const rest = skipOptions(after, true)
    return rest === '' ? null : rest
  }
  if (word === 'timeout') {
    const [duration, rest] = takeWord(skipOptions(after, false))
    return /^\d+(?:\.\d+)?[smhd]?$/.test(duration) && rest.trim() !== '' ? rest.trim() : null
  }
  if (word === 'nohup' || word === 'time') return after.trim() === '' ? null : after.trim()
  return null
}

/** Class of a raw Bash command line: wrappers are looked through to the command they run, a `;`/`&&`/`||` chain takes its most significant segment's class. `headOf` reduces one segment to its first binary (session_audit's commandHead, injected so this module never imports it). The command text is read, never stored or returned. */
export function bashCommandClassOf(raw: string, headOf: (segment: string) => string, depth = 0): string {
  let best = CLASS_RANK.length
  for (const seg of splitSegments(raw)) {
    const inner = depth < WRAPPER_DEPTH ? unwrap(seg) : null
    const cls = inner === null ? bashCommandClass(headOf(seg)) : bashCommandClassOf(inner, headOf, depth + 1)
    const rank = CLASS_RANK.indexOf(cls)
    if (rank >= 0 && rank < best) best = rank
  }
  return best === CLASS_RANK.length ? 'other' : (CLASS_RANK[best] ?? 'other')
}

/** The tool bucket a tool_use falls in: its name, or `Bash:<class>` for Bash. `command` is the raw Bash command string, undefined for a non-Bash call or a Bash call that carried none. */
export function coldGapToolLabel(name: string, command: string | undefined, headOf: (segment: string) => string): string {
  if (name !== 'Bash') return name
  return `Bash:${command === undefined ? 'other' : bashCommandClassOf(command, headOf)}`
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
  /** TTL of the tier the last request on this lane that named one wrote; null until one does. */
  ttlMs: number | null
  /** Tokens the request had cached (read + written): the prefix the next request would have to find warm. */
  cached: number
}

function toolRow(kind: KindAcc, tool: string): { cold: number; usage: UsageSum } {
  return (kind.byTool[tool] ??= { cold: 0, usage: zeroSum() })
}

/** The TTL of the tier a request wrote, or null when its usage record names no tier split. */
function tierTtl(u: ColdGapUsage): number | null {
  if (u.cacheWrite1h > u.cacheWrite5m) return COLD_TTL_MS_1H
  if (u.cacheWrite5m > 0 || u.cacheWrite1h > 0) return COLD_TTL_MS_5M
  return null
}

/** Whether `u`, arriving `gapMs` after the previous request, is a cold prefix re-write: the gap outlived `ttlMs` (the tier the PREVIOUS request wrote, whose cache expired) and `u` wrote at least {@link COLD_MIN_REWRITE_SHARE_OF_PREV} of the `prevCachedTokens` that request had cached. A negative gap is never cold. */
export function isColdRewrite(gapMs: number, ttlMs: number, u: ColdGapUsage, prevCachedTokens: number): boolean {
  if (gapMs <= ttlMs) return false
  if (u.cacheWrite < COLD_MIN_CACHE_WRITE_TOKENS) return false
  return u.cacheWrite >= COLD_MIN_REWRITE_SHARE_OF_PREV * prevCachedTokens
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
          const named = tierTtl(usage)
          row.requests += 1
          addSum(row.total, usage)
          addSum(acc.total, usage)
          if (prev !== undefined && prev.lastMs !== null && timestampMs !== null && isColdRewrite(timestampMs - prev.lastMs, prev.ttlMs ?? named ?? COLD_TTL_MS_5M, usage, prev.cached)) {
            const label = prev.tool ?? COLD_NO_TOOL_BUCKET
            row.cold += 1
            addSum(row.coldTotal, usage)
            acc.cold += 1
            addSum(acc.coldTotal, usage)
            const t = toolRow(acc, label)
            t.cold += 1
            addSum(t.usage, usage)
          }
          lanes.set(lane, { id, lastMs: timestampMs, tool: null, ttlMs: named ?? prev?.ttlMs ?? null, cached: usage.cacheRead + usage.cacheWrite })
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
      // Per-kind numbers and the tool buckets (bounded by distinct tool labels) are copied; the session rows only ever grow, so their length is enough.
      const sessionCount = state.sessions.length
      const saved = { main: snapshotKind(state.main), subagent: snapshotKind(state.subagent) }
      return () => {
        state.main = saved.main
        state.subagent = saved.subagent
        state.sessions.length = sessionCount
      }
    },
    finish(weights) {
      const writeCost = (s: UsageSum): number => weights.cacheWrite * (s.cacheWrite - s.cacheWrite1h) + weights.cacheWrite1h * s.cacheWrite1h
      const billed = (s: UsageSum): number => s.input + writeCost(s) + weights.cacheRead * s.cacheRead
      const rewrite = (s: UsageSum): number => writeCost(s) - weights.cacheRead * s.cacheWrite
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
  into.cacheWrite1h += from.cacheWrite1h
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
  lines.push(`TTL 5 min for 5-minute-tier writes, 1 h for 1-hour-tier writes, judged by the previous request's tier; a re-write writes >=${fmt(COLD_MIN_CACHE_WRITE_TOKENS)} cache tokens and at least ${pct(COLD_MIN_REWRITE_SHARE_OF_PREV)} of what the previous request had cached. Billed-equivalent = input + cache-write (1.25 x for the 5-minute tier, 2 x for the 1-hour tier) + 0.1 x cache-read (output not priced). Attributed to the tool call the session waited on.`)
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
