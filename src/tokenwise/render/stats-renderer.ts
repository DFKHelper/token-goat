import { fg, bg, padL, padR, vlen, lerpRGB, RESET, C } from './ansi.js'
import type { RGB } from './ansi.js'
import type { StatsData, DayStat, KindStat } from './types.js'

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

  for (const k of byKind) {
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
    lines.push(`${M}${fg(...C.textDim)}i  ${names} tracks bytes, not vision tokens (model-specific math)${RESET}`)
  }

  if (byKind.some(k => k.kind === 'session_hint') && byKind.some(k => k.kind === 'session_hint_overhead')) {
    lines.push(`${M}${fg(...C.textDim)}i  session_hint shows realized savings; session_hint_overhead shows injected hint cost; headline totals are net${RESET}`)
  }

  return lines
}

// ── Section: activity heatmap ─────────────────────────────────────────────────

const PROJECT_COLORS: RGB[] = [C.purple, C.teal, C.blue, C.green4, C.textMuted]

/** Stable colour assignment based on hash string. */
const hashColor = (hash: string): RGB => {
  const n = hash.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0)
  return PROJECT_COLORS[n % PROJECT_COLORS.length] as RGB
}

const heatCellColor = (intensity: number): RGB => {
  if (intensity <= 0) return C.bgTile
  const stops = [C.green1, C.green2, C.green3, C.green4, C.green5]
  const idx = intensity * (stops.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.min(stops.length - 1, lo + 1)
  return lerpRGB(stops[lo] as RGB, stops[hi] as RGB, idx - lo)
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

const renderActivitySection = (stats: StatsData): string[] => {
  const { byDay, period, totals } = stats
  if (!byDay.length) return []

  // Aggregate all-days list (byDay may be top-N; build a complete date map)
  const sorted = [...byDay].sort((a, b) => a.date.localeCompare(b.date))
  const byDate = new Map(sorted.map(d => [d.date, d]))
  const maxEvents = Math.max(...sorted.map(d => d.events), 1)

  // Build a 7-row × N-week grid anchored to the Monday before `period.start`
  const first = new Date(period.start.toISOString().slice(0, 10) + 'T00:00:00')
  const dow0 = (first.getDay() + 6) % 7  // Mon=0, Sun=6
  const gridStart = new Date(first)
  gridStart.setDate(gridStart.getDate() - dow0)

  const last = new Date(period.end.toISOString().slice(0, 10) + 'T00:00:00')
  const dowLast = (last.getDay() + 6) % 7
  const daysSpanned = Math.round((last.getTime() - gridStart.getTime()) / 86_400_000) + 1 + (6 - dowLast)
  const rawWeeks = Math.ceil(daysSpanned / 7)

  // Cap weeks to what fits in the terminal (each week = 2 chars cell + 1 space = 3 chars)
  const availForCells = CONTENT_W - M.length - 4  // subtract margin + "Mon " label
  const maxWeeks = Math.max(1, Math.floor(availForCells / 3))
  const nWeeks = Math.min(rawWeeks, maxWeeks)
  // Show the most recent nWeeks
  const weekOffset = rawWeeks - nWeeks

  // grid[dow][week] — week 0 is oldest displayed week
  const grid: Array<Array<DayStat | null>> = Array.from({ length: 7 }, (_, dow) =>
    Array.from({ length: nWeeks }, (_, w) => {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + (w + weekOffset) * 7 + dow)
      return byDate.get(d.toISOString().slice(0, 10)) ?? null
    }),
  )

  // Total calendar days in the requested period (not just rows passed in byDay)
  const totalPeriodDays = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000) + 1

  // Right panel: top days + rhythm analysis
  const activeDays = sorted.filter(d => d.events > 0)
  const topDays = [...activeDays].sort((a, b) => b.events - a.events).slice(0, 3)

  const panelLines: string[] = []
  if (topDays.length) {
    panelLines.push(`${fg(...C.textBright)}Top days${RESET}`)
    for (const d of topDays) {
      const c: RGB = d.events / maxEvents > 0.5 ? C.green5 : C.green4
      panelLines.push(`${fg(...C.textMuted)}${d.date.slice(5)}  ${fg(...c)}●${RESET}  ${fg(...C.textMuted)}${d.events} ev · ${fmtBytes(d.bytes)}${RESET}`)
    }
    panelLines.push('')
    panelLines.push(`${fg(...C.textBright)}Rhythm${RESET}`)

    const totalEv = activeDays.reduce((s, d) => s + d.events, 0)
    const weekdayEv = activeDays
      .filter(d => { const dow = new Date(d.date + 'T00:00:00').getDay(); return dow !== 0 && dow !== 6 })
      .reduce((s, d) => s + d.events, 0)
    const mean = totalEv / (activeDays.length || 1)
    const cv = Math.sqrt(
      activeDays.reduce((s, d) => s + (d.events - mean) ** 2, 0) / (activeDays.length || 1),
    ) / (mean || 1)

    const rhythm = cv > 1.0 ? 'Burst pattern' : cv > 0.5 ? 'Moderate bursts' : 'Steady usage'
    const weekdayBias = totalEv === 0 ? 'No data'
      : weekdayEv / totalEv > 0.8 ? 'Weekday-heavy'
      : weekdayEv / totalEv > 0.5 ? 'Mostly weekdays'
      : 'Spread across week'

    panelLines.push(`${fg(...C.textMuted)}${rhythm}${RESET}`)
    panelLines.push(`${fg(...C.textMuted)}${weekdayBias}${RESET}`)
    panelLines.push(`${fg(...C.textMuted)}${activeDays.length} active day${activeDays.length !== 1 ? 's' : ''} of ${totalPeriodDays}${RESET}`)
  }

  // Visible width of the grid portion of each row: M + "Mon " + n cols × 2 + (n-1) spaces
  const gridVisW = M.length + 4 + nWeeks * 2 + (nWeeks - 1)

  const activeDayCount = activeDays.length
  const subtitle = `·  ${fmtDate(period.start)} → ${fmtDate(period.end)}  ·  ${totals.events} events across ${activeDayCount} active day${activeDayCount !== 1 ? 's' : ''}`

  const lines: string[] = [...sectionHeader('Activity', subtitle)]

  for (let dow = 0; dow < 7; dow++) {
    const label = padR(fg(...C.textDim) + DAY_LABELS[dow] + RESET, 3)
    const cells = grid[dow]
      .map(cell => {
        const intensity = cell ? cell.events / maxEvents : 0
        const [r, g, b] = heatCellColor(intensity)
        return `${bg(r, g, b)}  ${RESET}`
      })
      .join(' ')

    const leftPart = `${M}${label} ${cells}`
    const panelPart = dow < panelLines.length ? `  ${panelLines[dow]}` : ''
    lines.push(padR(leftPart, gridVisW) + panelPart)
  }

  // Any remaining panel lines below the 7 grid rows
  for (let i = 7; i < panelLines.length; i++) {
    lines.push(' '.repeat(gridVisW) + `  ${panelLines[i]}`)
  }

  // Legend
  const legendCells = [0, 0.25, 0.5, 0.75, 1.0].map(t => {
    const [r, g, b] = heatCellColor(t)
    return `${bg(r, g, b)}  ${RESET}`
  }).join(' ')
  lines.push('')
  lines.push(`${M}${' '.repeat(4)}${fg(...C.textDim)}Less${RESET}  ${legendCells}  ${fg(...C.textDim)}More${RESET}`)

  return lines
}

// ── Section: by day ───────────────────────────────────────────────────────────

const renderByDaySection = (stats: StatsData): string[] => {
  const { byDay, totals } = stats
  if (!byDay.length) return []

  const lines: string[] = [
    ...sectionHeader('By day (top 7)'),
    tableHeader('date'),
  ]

  for (const d of byDay) {
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

  for (const p of byProject) {
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
      `${M}${bullet} ${dim('Biggest saver  ')}${fg(...C.textPrimary)}${topKind.kind}${RESET}${dim(' — ')}${fg(...C.green5)}${fmtPct(share)}${RESET}${dim(` of saved data across ${topKind.events} events`)}`,
    )
  }

  // Most active day
  const topDay = [...byDay].sort((a, b) => b.events - a.events)[0] as DayStat | undefined
  if (topDay) {
    lines.push(
      `${M}${bullet} ${dim('Most active    ')}${fg(...C.textPrimary)}${topDay.date}${RESET}${dim(' — ')}${topDay.events} events, ${fg(...C.green5)}${fmtBytes(topDay.bytes)}${RESET}${dim(' saved')}`,
    )
  }

  // Token leader (excluding bytesModeOnly kinds)
  const topToken = [...byKind]
    .filter(k => !k.bytesModeOnly)
    .sort((a, b) => b.tokens - a.tokens)[0] as KindStat | undefined
  if (topToken) {
    lines.push(
      `${M}${bullet} ${dim('Token leader   ')}${fg(...C.textPrimary)}${topToken.kind}${RESET}${dim(' — ')}${fg(...C.blue)}${fmtTokens(topToken.tokens)}${RESET}${dim(` saved in ${topToken.events} events`)}`,
    )
  }

  return lines
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Render a complete tokenwise stats report to a single string ready for console.log().
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
    ...renderKpiSection(stats),
    ...renderByKindSection(stats),
    ...renderActivitySection(stats),
    ...renderByDaySection(stats),
    ...renderByProjectSection(stats),
    ...renderInsightsSection(stats),
    '',
  ].join('\n')
