import { readFileSync } from 'node:fs'
import { fg, padL, padR, vlen, lerpRGB, RESET, C } from './ansi.js'
import type { RGB } from './ansi.js'
import type { StatsData, DayStat, KindStat } from './types.js'

type StatsMessages = {
  insights: {
    biggestSaver: string
    mostActive: string
    tokenLeader: string
  }
  bytesModeOnlyNote: string
  sessionHintSplitNote: string
}

const statsMessages = JSON.parse(
  readFileSync(new URL('./stats_messages.json', import.meta.url), 'utf8'),
) as StatsMessages

// ── Layout constants ──────────────────────────────────────────────────────────

const TERM_W = (process.stdout.columns ?? 0) > 0 ? process.stdout.columns : 100
const CONTENT_W = Math.min(Math.max(TERM_W, 80), 140)
const M = '  ' // left margin

// Table column visible widths (chars).
// "data saved" = 10, "tokens saved" = 12 — column widths match their headers.
const COL_NAME   = 18
const COL_DATA   = 10
const COL_TOKENS = 12
const COL_EVENTS =  6
const COL_SHARE  =  6
// Gaps: 1 (name→bar) + 2 (bar→data) + 2 (data→tokens) + 2 (tokens→events) + 2 (events→share)
const COLS_FIXED = COL_NAME + 1 + 2 + COL_DATA + 2 + COL_TOKENS + 2 + COL_EVENTS + 2 + COL_SHARE
const BAR_W = Math.max(16, CONTENT_W - M.length * 2 - COLS_FIXED)
const RULE = M + fg(...C.textDim) + '─'.repeat(CONTENT_W - M.length * 2) + RESET

// ── Formatters ────────────────────────────────────────────────────────────────

const fmtBytes = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB`
  : n >= 1_000   ? `${(n / 1_000).toFixed(1)} KB`
  :                `${n} B`

const fmtTokens = (n: number): string =>
  n === 0      ? `${fg(...C.textDim)}0 t${RESET}`
  : n >= 1_000 ? `${(n / 1_000).toFixed(1)} kt`
  :              `${n} t`

const fmtPct = (fraction: number): string =>
  `${(fraction * 100).toFixed(1)}%`

const fmtDelta = (delta: number | undefined): string => {
  if (delta === undefined) return ''
  const up = delta >= 0
  return ` ${fg(...(up ? C.green5 : C.red))}${up ? '↑' : '↓'} ${Math.abs(Math.round(delta))}%${RESET}`
}

const fmtDate = (d: Date): string => d.toISOString().slice(0, 10)

// ── Bar renderer ──────────────────────────────────────────────────────────────

const EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
const BLOCK = '█'
const GRADIENT: RGB[] = [C.green1, C.green2, C.green3, C.green4, C.green5]

/** Distribute `total` chars across `n` gradient stops, giving extras to later (brighter) stops. */
const distribute = (total: number, n: number): number[] => {
  if (total <= 0 || n <= 0) return new Array(Math.max(0, n)).fill(0)
  const base = Math.floor(total / n)
  const rem = total % n
  return Array.from({ length: n }, (_, i) => base + (i >= n - rem ? 1 : 0))
}

/**
 * Render a uniform-width progress bar with a 5-stop green gradient fill and a dim track.
 * Sub-block characters (▏▎▍▌▋▊▉) provide sub-character precision at the boundary.
 *
 * @param fraction - Fill level 0–1
 * @param width    - Total character width; all bars must share the same value for alignment
 */
const renderBar = (fraction: number, width = BAR_W): string => {
  const f = Math.max(0, Math.min(1, fraction))
  const raw = f * width
  let nFull = Math.floor(raw)
  const eighths = Math.round((raw - nFull) * 8)

  // Normalize: round-up partial if it reached a full block
  if (eighths >= 8) nFull++
  const hasPartial = eighths > 0 && eighths < 8
  const nTrack = Math.max(0, width - nFull - (hasPartial ? 1 : 0))

  const counts = distribute(nFull, GRADIENT.length)
  let bar = counts
    .map((n, i) => n > 0 ? fg(...GRADIENT[i]) + BLOCK.repeat(n) : '')
    .join('')

  if (hasPartial) bar += fg(...GRADIENT[GRADIENT.length - 1]) + EIGHTHS[eighths - 1]
  if (nTrack > 0) bar += fg(...C.track) + BLOCK.repeat(nTrack)

  return bar + RESET
}

// ── Sparkline renderer ────────────────────────────────────────────────────────

const SPARK = '▁▂▃▄▅▆▇█'

const resample = (vals: number[], len: number): number[] => {
  if (!vals.length) return new Array(len).fill(0)
  if (vals.length === len) return [...vals]
  return Array.from({ length: len }, (_, i) => {
    const src = (i / (len - 1 || 1)) * (vals.length - 1)
    const lo = Math.floor(src)
    const hi = Math.min(vals.length - 1, lo + 1)
    const t = src - lo
    return vals[lo] * (1 - t) + vals[hi] * t
  })
}

/**
 * Render an 8-char mini sparkline from an array of values.
 * Values are resampled to `width` and normalised to fill the vertical range.
 */
const renderSparkline = (values: number[], width = 8): string => {
  const pts = resample(values, width)
  const max = Math.max(...pts, 1)
  const min = Math.min(...pts)
  const range = max - min || 1
  return pts.map((v, i) => {
    const idx = Math.min(7, Math.floor(((v - min) / range) * 8))
    const color = lerpRGB(C.green1, C.green5, i / (width - 1 || 1))
    return fg(...color) + SPARK[idx]
  }).join('') + RESET
}

// ── Section header helper ─────────────────────────────────────────────────────

const sectionHeader = (title: string, subtitle = ''): string[] => [
  '',
  `${M}${fg(...C.textBright)}${title}${RESET}${subtitle ? `  ${fg(...C.textMuted)}${subtitle}${RESET}` : ''}`,
  RULE,
]

// ── Table header / row helpers ────────────────────────────────────────────────

const tableHeader = (firstColLabel: string): string =>
  [
    M,
    padR(fg(...C.textDim) + firstColLabel + RESET, COL_NAME),
    ' ',
    padR(fg(...C.textDim) + 'savings' + RESET, BAR_W),
    '  ',
    padL(fg(...C.textDim) + 'data saved' + RESET, COL_DATA),
    '  ',
    padL(fg(...C.textDim) + 'tokens saved' + RESET, COL_TOKENS),
    '  ',
    padL(fg(...C.textDim) + 'events' + RESET, COL_EVENTS),
    '  ',
    padL(fg(...C.textDim) + 'share' + RESET, COL_SHARE),
  ].join('')

interface TableRowOpts {
  fraction: number
  bytes: number
  tokens: number
  events: number
  share: number         // 0–1
  bytesModeOnly?: boolean
  namePrefix?: string   // e.g. coloured bullet "● "
  nameColor?: RGB
}

const tableRow = (name: string, opts: TableRowOpts): string => {
  const { fraction, bytes, tokens, events, share, bytesModeOnly, namePrefix = '', nameColor = C.textPrimary } = opts

  const truncated = name.length > COL_NAME - vlen(namePrefix)
    ? name.slice(0, COL_NAME - vlen(namePrefix) - 1) + '…'
    : name
  const nameStr = padR(namePrefix + fg(...nameColor) + truncated + RESET, COL_NAME)

  const dataStr = padL(fg(...C.textPrimary) + fmtBytes(bytes) + RESET, COL_DATA)

  const tokStr = bytesModeOnly
    ? padL(fg(...C.textDim) + '—' + RESET, COL_TOKENS)
    : padL(fg(...C.blue) + fmtTokens(tokens) + RESET, COL_TOKENS)

  const evStr = padL(fg(...C.textPrimary) + String(events) + RESET, COL_EVENTS)

  const sharePct = share * 100
  const shareColor: RGB = sharePct >= 50 ? C.green5 : sharePct >= 10 ? C.textPrimary : C.textMuted
  const shareStr = padL(fg(...shareColor) + fmtPct(share) + RESET, COL_SHARE)

  return [M, nameStr, ' ', renderBar(fraction), '  ', dataStr, '  ', tokStr, '  ', evStr, '  ', shareStr].join('')
}

// ── Section: KPI tiles ────────────────────────────────────────────────────────

const renderKpiSection = (stats: StatsData): string[] => {
  const { totals } = stats
  const colW = Math.floor((CONTENT_W - M.length * 2) / 3)

  const card = (
    label: string,
    value: string,
    delta: string,
    spark: string | null,
  ): [string, string, string] => [
    padR(fg(...C.textMuted) + label + RESET, colW),
    padR(fg(...C.textBright) + value + RESET + delta, colW),
    spark !== null ? padR(spark, colW) : padR('', colW),
  ]

  const c1 = card('events', String(totals.events), fmtDelta(totals.eventsDelta),
    totals.sparklines ? renderSparkline(totals.sparklines.events) : null)
  const c2 = card('data saved', fmtBytes(totals.bytes), fmtDelta(totals.bytesDelta),
    totals.sparklines ? renderSparkline(totals.sparklines.bytes) : null)
  const c3 = card('tokens saved', fmtTokens(totals.tokens), fmtDelta(totals.tokensDelta),
    totals.sparklines ? renderSparkline(totals.sparklines.tokens) : null)

  const lines: string[] = [
    '',
    M + c1[0] + c2[0] + c3[0],  // labels
    M + c1[1] + c2[1] + c3[1],  // values + deltas
  ]
  if (totals.sparklines) lines.push(M + c1[2] + c2[2] + c3[2])
  return lines
}

// ── Section: by kind ─────────────────────────────────────────────────────────

const renderByKindSection = (stats: StatsData): string[] => {
  const { byKind, totals } = stats
  if (!byKind.length) return []

  const lines: string[] = [
    ...sectionHeader('By kind'),
    tableHeader('name'),
  ]

  // Rows are ordered by share of the period total, largest first (share is
  // byte-proportional in this renderer, so descending bytes gives share order).
  for (const k of [...byKind].sort((a, b) => b.bytes - a.bytes)) {
    const share = totals.bytes > 0 ? k.bytes / totals.bytes : 0
    lines.push(tableRow(k.kind, {
      fraction: share,
      bytes: k.bytes,
      tokens: k.tokens,
      events: k.events,
      share,
      bytesModeOnly: k.bytesModeOnly,
    }))
  }

  const hasBytesModeOnly = byKind.some(k => k.bytesModeOnly)
  if (hasBytesModeOnly) {
    const names = byKind.filter(k => k.bytesModeOnly).map(k => k.kind).join(', ')
    lines.push(`${M}${fg(...C.textDim)}i  ${names} ${statsMessages.bytesModeOnlyNote}${RESET}`)
  }

  if (byKind.some(k => k.kind === 'session_hint') && byKind.some(k => k.kind === 'session_hint_overhead')) {
    lines.push(`${M}${fg(...C.textDim)}i  ${statsMessages.sessionHintSplitNote}${RESET}`)
  }

  return lines
}

// ── Shared: project bullet colours ─────────────────────────────────────────────────

const PROJECT_COLORS: RGB[] = [C.purple, C.teal, C.blue, C.green4, C.textMuted]

/** Stable colour assignment based on hash string. */
const hashColor = (hash: string): RGB => {
  const n = hash.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return PROJECT_COLORS[n % PROJECT_COLORS.length] as RGB
}

// ── Section: by day ───────────────────────────────────────────────────────────

const renderByDaySection = (stats: StatsData): string[] => {
  const { byDay, totals } = stats
  if (!byDay.length) return []

  const lines: string[] = [
    ...sectionHeader('By day (top 7)'),
    tableHeader('date'),
  ]

  // Rows are ordered by share of the period total, largest first.
  for (const d of [...byDay].sort((a, b) => b.bytes - a.bytes)) {
    const share = totals.bytes > 0 ? d.bytes / totals.bytes : 0
    lines.push(tableRow(d.date, {
      fraction: share,
      bytes: d.bytes,
      tokens: d.tokens,
      events: d.events,
      share,
    }))
  }

  return lines
}

// ── Section: by project ───────────────────────────────────────────────────────

const renderByProjectSection = (stats: StatsData): string[] => {
  const { byProject } = stats
  if (!byProject.length) return []

  const projectTotal = byProject.reduce((s, p) => s + p.bytes, 0)

  const lines: string[] = [
    ...sectionHeader('By project (top 5)'),
    tableHeader('project'),
  ]

  // Rows are ordered by share of the cross-project total, largest first.
  for (const p of [...byProject].sort((a, b) => b.bytes - a.bytes)) {
    const share = projectTotal > 0 ? p.bytes / projectTotal : 0
    const color = hashColor(p.hash)
    lines.push(tableRow(p.project, {
      fraction: share,
      bytes: p.bytes,
      tokens: p.tokens,
      events: p.events,
      share,
      namePrefix: `${fg(...color)}●${RESET} `,
      nameColor: C.textPrimary,
    }))
    lines.push(`${M}  ${fg(...C.textDim)}└─ ${p.hash}  ${p.path}${RESET}`)
  }

  return lines
}

// ── Section: insights ─────────────────────────────────────────────────────────

const renderInsightsSection = (stats: StatsData): string[] => {
  const { byKind, byDay, totals } = stats
  const lines: string[] = [...sectionHeader('Insights')]
  const bullet = `${fg(...C.green3)}▸${RESET}`
  const dim = (s: string) => `${fg(...C.textMuted)}${s}${RESET}`

  // Biggest saver by bytes
  const topKind = [...byKind].sort((a, b) => b.bytes - a.bytes)[0] as KindStat | undefined
  if (topKind) {
    const share = totals.bytes > 0 ? topKind.bytes / totals.bytes : 0
    lines.push(
      `${M}${bullet} ${dim(statsMessages.insights.biggestSaver)}${fg(...C.textPrimary)}${topKind.kind}${RESET}${dim(' — ')}${fg(...C.green5)}${fmtPct(share)}${RESET}${dim(` of saved data across ${topKind.events} events`)}`,
    )
  }

  // Most active day
  const topDay = [...byDay].sort((a, b) => b.events - a.events)[0] as DayStat | undefined
  if (topDay) {
    lines.push(
      `${M}${bullet} ${dim(statsMessages.insights.mostActive)}${fg(...C.textPrimary)}${topDay.date}${RESET}${dim(' — ')}${topDay.events} events, ${fg(...C.green5)}${fmtBytes(topDay.bytes)}${RESET}${dim(' saved')}`,
    )
  }

  // Token leader (excluding bytesModeOnly kinds)
  const topToken = [...byKind]
    .filter(k => !k.bytesModeOnly)
    .sort((a, b) => b.tokens - a.tokens)[0] as KindStat | undefined
  if (topToken) {
    lines.push(
      `${M}${bullet} ${dim(statsMessages.insights.tokenLeader)}${fg(...C.textPrimary)}${topToken.kind}${RESET}${dim(' — ')}${fg(...C.blue)}${fmtTokens(topToken.tokens)}${RESET}${dim(` saved in ${topToken.events} events`)}`,
    )
  }

  return lines
}

// ── Report header ─────────────────────────────────────────────────────────────

/**
 * Render the report header line: the token-goat name and loaded version.
 * `stats.version` is the installed token-goat package version; an empty or
 * omitted value renders just the name with no version suffix.
 */
const renderHeader = (stats: StatsData): string[] => {
  let line = `${M}${fg(...C.textBright)}token-goat${RESET}`
  if (stats.version) line += `  ${fg(...C.textMuted)}v${stats.version}${RESET}`
  return [line]
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render a complete token-goat stats report to a single string ready for console.log().
 *
 * @example
 * ```ts
 * import { renderStats } from './render/stats-renderer.js'
 * const stats = await buildStatsData(options)
 * console.log(renderStats(stats))
 * ```
 */
export const renderStats = (stats: StatsData): string =>
  [
    ...renderHeader(stats),
    ...renderKpiSection(stats),
    ...renderByKindSection(stats),
    ...renderByDaySection(stats),
    ...renderByProjectSection(stats),
    ...renderInsightsSection(stats),
    '',
  ].join('\n')
