/**
 * Terminal renderer for token-goat stats.
 *
 * Produces a multi-section ANSI display from a ``StatsData`` payload:
 *
 * 1. **KPI tiles** — three side-by-side cards (data saved, tokens saved, events)
 *    with period-over-period deltas and optional mini sparklines.
 * 2. **By event kind** — colour-barred table showing savings per tool-call type
 *    (Read, image_shrink, Grep, etc.).
 * 3. **By source** — collapsed view of the four user-facing mechanisms (image
 *    / hint / read / compact) plus an ``other`` catch-all.
 * 4. **By day** — tabular daily breakdown (top N rows by bytes).
 * 5. **By project** — tabular per-project breakdown (top N rows by bytes).
 * 6. **Insights** — motivational copy loaded from ``stats_messages.json``.
 *
 * Entry point: :func:`renderStats` — returns a ready-to-print ANSI string.
 *
 * Layout uses ``_CONTENT_W`` (clamped 80–140 columns) and a shared set of
 * column-width constants so all tables are visually aligned. Colour values
 * come from ``ansi.C`` (GitHub dark palette).
 */

import { RESET, C, fg, lerpRgb, padL, padR, stripAnsi, vlen } from './ansi.js'
import type { RGB } from './ansi.js'
import type { CommandStat, DayStat, KindStat, ProjectStat, SourceStat, StatsData } from './types.js'
import { toLocalDateKey } from '../stats.js'

// Statistics messages for insights section
interface StatsMessages {
  bytesModeOnlyNote: string
  sessionHintSplitNote: string
  insights: {
    biggestSaver: string
    mostActive: string
    tokenLeader: string
  }
}

const _STATS_MESSAGES_FALLBACK: StatsMessages = {
  bytesModeOnlyNote: 'tracks bytes, not vision tokens',
  sessionHintSplitNote:
    'session_hint shows realized savings; session_hint_overhead shows injected hint cost',
  insights: {
    biggestSaver: 'Biggest saver  ',
    mostActive: 'Most active    ',
    tokenLeader: 'Token leader   ',
  },
}

let _STATS_MESSAGES: StatsMessages = _STATS_MESSAGES_FALLBACK

// Load stats messages from inline JSON
export function setStatsMessages(messages: StatsMessages): void {
  _STATS_MESSAGES = messages
}

// Layout constants
const _TERM_W = process.stdout.columns || 100
const _CONTENT_W = Math.min(Math.max(_TERM_W, 80), 140)
const _M = '  ' // left margin

// Table column visible widths (chars)
const _COL_NAME = 18
const _COL_DATA = 10
const _COL_TOKENS = 12
const _COL_SHARE = 6
const _COL_EVENTS = 6
const _COLS_FIXED = _COL_NAME + 1 + 2 + _COL_DATA + 2 + _COL_TOKENS + 2 + _COL_SHARE + 2 + _COL_EVENTS
const _BAR_W = Math.max(16, _CONTENT_W - _M.length * 2 - _COLS_FIXED)
const _RULE = _M + fg(...C.TEXT_DIM) + '─'.repeat(_CONTENT_W - _M.length * 2) + RESET

// Byte/token tier formatters
interface Tier {
  threshold: number
  divisor: number
  unit: string
  color: RGB
}

const _BYTE_TIERS: Tier[] = [
  { threshold: 1_000_000_000_000_000, divisor: 1_000_000_000_000_000, unit: 'PB', color: C.PURPLE },
  { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, unit: 'TB', color: C.BLUE },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, unit: 'GB', color: C.TEAL },
  { threshold: 1_000_000, divisor: 1_000_000, unit: 'MB', color: C.GREEN4 },
  { threshold: 1_000, divisor: 1_000, unit: 'KB', color: C.TEXT_MUTED },
  { threshold: 0, divisor: 1, unit: 'B', color: C.TEXT_DIM },
]

const _TOKEN_TIERS: Tier[] = [
  { threshold: 1_000_000_000_000, divisor: 1_000_000_000_000, unit: 'Tt', color: C.GREEN5 },
  { threshold: 1_000_000_000, divisor: 1_000_000_000, unit: 'Gt', color: C.TEAL },
  { threshold: 1_000_000, divisor: 1_000_000, unit: 'Mt', color: C.PURPLE },
  { threshold: 1_000, divisor: 1_000, unit: 'kt', color: C.BLUE },
  { threshold: 0, divisor: 1, unit: 't', color: C.TEXT_DIM },
]

// Formatters

/**
 * Format an integer as a human-readable magnitude string with ANSI color.
 */
function _fmtMagnitude(n: number, tiers: Tier[], zeroLabel?: string): string {
  if (zeroLabel !== undefined && n === 0) {
    return `${fg(...C.TEXT_DIM)}${zeroLabel}${RESET}`
  }
  if (n < 0) {
    const a = -n
    const color = C.TEXT_DIM
    for (const tier of tiers) {
      if (a >= tier.threshold && tier.threshold > 0) {
        return `${fg(...color)}-${(a / tier.divisor).toLocaleString('en', { maximumFractionDigits: 1 })} ${tier.unit}${RESET}`
      }
    }
    const lastTier = tiers[tiers.length - 1]
    if (lastTier) {
      return `${fg(...color)}-${a} ${lastTier.unit}${RESET}`
    }
    return `${fg(...color)}-${a}${RESET}`
  }
  for (const tier of tiers) {
    if (n >= tier.threshold && tier.threshold > 0) {
      return `${fg(...tier.color)}${(n / tier.divisor).toLocaleString('en', { maximumFractionDigits: 1 })} ${tier.unit}${RESET}`
    }
  }
  const lastTier = tiers[tiers.length - 1]
  if (lastTier) {
    return `${fg(...lastTier.color)}${n} ${lastTier.unit}${RESET}`
  }
  return `${n}${RESET}`
}

function _fmtBytes(n: number): string {
  return _fmtMagnitude(n, _BYTE_TIERS)
}

function _fmtTokens(n: number): string {
  return _fmtMagnitude(n, _TOKEN_TIERS, '0 t')
}

function _fmtPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

function _fmtDelta(delta: number | null | undefined): string {
  if (!delta && delta !== 0) {
    return ''
  }
  const up = (delta ?? 0) >= 0
  const color = up ? C.GREEN5 : C.RED
  const arrow = up ? '↑' : '↓'
  return ` ${fg(...color)}${arrow} ${Math.round(Math.abs(delta ?? 0))}%${RESET}`
}

function _fmtDate(d: Date): string {
  return toLocalDateKey(d)
}

// Bar renderer
const _EIGHTHS = ['▏', '▎', '▍', '▌', '▋', '▊', '▉']
const _BLOCK = '█'
const _TRACK = '░'
const _GRADIENT: RGB[] = [C.GREEN1, C.GREEN2, C.GREEN3, C.GREEN4, C.GREEN5]

/**
 * Distribute `total` chars across `n` gradient stops, extras to later (brighter) stops.
 */
function _distribute(total: number, n: number): number[] {
  if (total <= 0 || n <= 0) {
    return Array(Math.max(0, n)).fill(0)
  }
  const base = Math.floor(total / n)
  const rem = total % n
  return Array.from({ length: n }, (_, i) => base + (i >= n - rem ? 1 : 0))
}

/**
 * Render a uniform-width progress bar with a 5-stop green gradient fill and a dim track.
 */
function _renderBar(fraction: number, width: number = _BAR_W): string {
  const f = Math.max(0, Math.min(1, fraction))
  const raw = f * width
  let nFull = Math.floor(raw)
  const eighths = Math.round((raw - nFull) * 8)

  if (eighths >= 8) {
    nFull += 1
  }
  const hasPartial = eighths > 0 && eighths < 8
  const nTrack = Math.max(0, width - nFull - (hasPartial ? 1 : 0))

  const counts = _distribute(nFull, _GRADIENT.length)
  let bar = counts
    .map((count, i) => (count > 0 ? `${fg((_GRADIENT[i] as RGB)[0], (_GRADIENT[i] as RGB)[1], (_GRADIENT[i] as RGB)[2])}${_BLOCK.repeat(count)}` : ''))
    .join('')

  if (hasPartial) {
    const lastGrad = _GRADIENT[_GRADIENT.length - 1] as RGB
    bar += `${fg(lastGrad[0], lastGrad[1], lastGrad[2])}${_EIGHTHS[eighths - 1]}`
  }
  if (nTrack > 0) {
    bar += `${fg(...C.TRACK)}${_TRACK.repeat(nTrack)}`
  }

  return bar + RESET
}

// Sparkline renderer
const _SPARK = '▁▂▃▄▅▆▇█'

/**
 * Linearly resample *vals* to exactly *length* points.
 */
function _resample(vals: number[], length: number): number[] {
  if (vals.length === 0) {
    return Array(length).fill(0)
  }
  if (vals.length === length) {
    return [...vals]
  }
  const result: number[] = []
  for (let i = 0; i < length; i++) {
    const src = (i / (length - 1 || 1)) * (vals.length - 1)
    const lo = Math.floor(src)
    const hi = Math.min(vals.length - 1, lo + 1)
    const t = src - lo
    const loVal = vals[lo] ?? 0
    const hiVal = vals[hi] ?? 0
    result.push(loVal * (1 - t) + hiVal * t)
  }
  return result
}

/**
 * Render an 8-char mini sparkline.
 */
function _renderSparkline(values: number[], width: number = 8): string {
  const pts = _resample(values, width)
  const hi = pts.length > 0 ? Math.max(...pts) : 1
  const lo = pts.length > 0 ? Math.min(...pts) : 0
  const span = hi - lo || 1
  const chars: string[] = []
  for (let i = 0; i < pts.length; i++) {
    const v = pts[i]
    if (v === undefined) continue
    const idx = Math.min(7, Math.floor(((v - lo) / span) * 8))
    const color = lerpRgb(C.GREEN1, C.GREEN5, i / (width - 1 || 1))
    chars.push(`${fg(color[0], color[1], color[2])}${_SPARK[idx]}`)
  }
  return chars.join('') + RESET
}

// Share computation helpers

/**
 * Return the share fraction for one item relative to period totals.
 */
function _tokenOrByteShare(
  itemTokens: number,
  itemBytes: number,
  totalTokens: number,
  totalBytes: number,
): number {
  if (totalTokens > 0) {
    return itemTokens / totalTokens
  }
  if (totalBytes > 0) {
    return itemBytes / totalBytes
  }
  return 0
}

/**
 * Savings-bar fill fraction. Positive-only: overhead rows render as empty bar.
 */
function _barFraction(itemBytes: number, grossBytes: number): number {
  return itemBytes > 0 ? itemBytes / grossBytes : 0
}

interface ShareDenominators {
  grossBytes: number
  shareBytesDenom: number
  shareTokensDenom: number
}

/**
 * Single-pass aggregation for share denominators.
 */
function _computeShareDenominators(items: Array<{ bytes: number; tokens: number }>): ShareDenominators {
  let grossBytesSum = 0
  let shareByteSum = 0
  let shareTokensSum = 0
  for (const item of items) {
    if (item.bytes > 0) {
      grossBytesSum += item.bytes
    }
    shareByteSum += Math.abs(item.bytes)
    shareTokensSum += Math.abs(item.tokens)
  }
  return {
    grossBytes: Math.max(grossBytesSum, 1),
    shareBytesDenom: Math.max(shareByteSum, 1),
    shareTokensDenom: shareTokensSum,
  }
}

/**
 * Share fraction using absolute-value denominators.
 */
function _absShare(
  itemBytes: number,
  itemTokens: number,
  shareBytesDenom: number,
  shareTokensDenom: number,
): number {
  if (shareTokensDenom === 0) {
    return itemBytes / shareBytesDenom
  }
  return itemTokens / shareTokensDenom
}

// Section header helper

function _sectionHeader(title: string, subtitle: string = ''): string[] {
  const sub = subtitle ? `  ${fg(...C.TEXT_MUTED)}${subtitle}${RESET}` : ''
  return [
    '',
    `${_M}${fg(...C.TEXT_BRIGHT)}${title}${RESET}${sub}`,
    _RULE,
  ]
}

// Table header / row helpers

function _tableHeader(firstColLabel: string): string {
  return [
    _M,
    padR(`${fg(...C.TEXT_DIM)}${firstColLabel}${RESET}`, _COL_NAME),
    ' ',
    padR(`${fg(...C.TEXT_DIM)}savings${RESET}`, _BAR_W),
    '  ',
    padL(`${fg(...C.TEXT_DIM)}data saved${RESET}`, _COL_DATA),
    '  ',
    padL(`${fg(...C.TEXT_DIM)}tokens saved${RESET}`, _COL_TOKENS),
    '  ',
    padL(`${fg(...C.TEXT_DIM)}share${RESET}`, _COL_SHARE),
    '  ',
    padL(`${fg(...C.TEXT_DIM)}events${RESET}`, _COL_EVENTS),
  ].join('')
}

interface TableRowParams {
  name: string
  fraction: number
  bytes: number
  tokens: number
  events: number
  share: number
  bytesModeOnly?: boolean
  namePrefix?: string
  nameColor?: RGB
}

function _tableRow({
  name,
  fraction,
  bytes,
  tokens,
  events,
  share,
  bytesModeOnly = false,
  namePrefix = '',
  nameColor = C.TEXT_PRIMARY,
}: TableRowParams): string {
  const prefixW = vlen(namePrefix)
  const maxName = _COL_NAME - prefixW
  const truncated = name.length > maxName ? name.slice(0, maxName - 1) + '…' : name
  const nameStr = padR(`${namePrefix}${fg(...nameColor)}${truncated}${RESET}`, _COL_NAME)

  const dataStr = padL(_fmtBytes(bytes), _COL_DATA)

  const tokStr = bytesModeOnly
    ? padL(`${fg(...C.TEXT_DIM)}—${RESET}`, _COL_TOKENS)
    : padL(_fmtTokens(tokens), _COL_TOKENS)

  const sharePct = share * 100
  let shareColor: RGB
  if (sharePct < 0) {
    shareColor = C.RED
  } else if (sharePct >= 50) {
    shareColor = C.GREEN5
  } else if (sharePct >= 10) {
    shareColor = C.TEXT_PRIMARY
  } else {
    shareColor = C.TEXT_MUTED
  }
  const shareStr = padL(`${fg(...shareColor)}${_fmtPct(share)}${RESET}`, _COL_SHARE)

  const evStr = padL(`${fg(...C.TEXT_PRIMARY)}${events.toLocaleString()}${RESET}`, _COL_EVENTS)

  return [_M, nameStr, ' ', _renderBar(fraction), '  ', dataStr, '  ', tokStr, '  ', shareStr, '  ', evStr].join('')
}

// Section: KPI tiles

function _renderKpiSection(stats: StatsData): string[] {
  const totals = stats.totals
  const colW = Math.floor((_CONTENT_W - _M.length * 2) / 3)

  function card(label: string, value: string, delta: string, spark: string | null): [string, string, string] {
    return [
      padR(`${fg(C.TEXT_MUTED[0], C.TEXT_MUTED[1], C.TEXT_MUTED[2])}${label}${RESET}`, colW),
      padR(`${fg(C.TEXT_BRIGHT[0], C.TEXT_BRIGHT[1], C.TEXT_BRIGHT[2])}${value}${RESET}${delta}`, colW),
      spark !== null ? padR(spark, colW) : padR('', colW),
    ]
  }

  const spark = totals.sparklines
  const c1 = card(
    'events',
    `${totals.events.toLocaleString()}`,
    _fmtDelta(totals.events_delta ?? null),
    spark ? _renderSparkline(spark.events) : null,
  )
  const c2 = card(
    'data saved',
    _fmtBytes(totals.bytes),
    _fmtDelta(totals.bytes_delta ?? null),
    spark ? _renderSparkline(spark.bytes) : null,
  )
  const c3 = card(
    'tokens saved',
    _fmtTokens(totals.tokens),
    _fmtDelta(totals.tokens_delta ?? null),
    spark ? _renderSparkline(spark.tokens) : null,
  )

  const border = fg(C.TEXT_DIM[0], C.TEXT_DIM[1], C.TEXT_DIM[2])
  const frameBar = '─'.repeat(colW * 3 + 2)

  function framed(content: string): string {
    return `${_M}${border}│${RESET} ${content} ${border}│${RESET}`
  }

  const lines = [
    '',
    `${_M}${border}╭${frameBar}╮${RESET}`,
    framed(c1[0] + c2[0] + c3[0]),
    framed(c1[1] + c2[1] + c3[1]),
  ]
  if (spark) {
    lines.push(framed(c1[2] + c2[2] + c3[2]))
  }
  lines.push(`${_M}${border}╰${frameBar}╯${RESET}`)
  return lines
}

// Kind grouping

interface KindGroup {
  label: string
  members: Set<string>
}

const _KIND_GROUPS: KindGroup[] = [
  {
    label: 'Read savings',
    members: new Set([
      'read_replacement',
      'section_replacement',
      'symbol_read',
      'section_read',
      'stub_view',
      'outline',
      'exports',
      'imports',
      'changed_lookup',
      'dep_docs',
    ]),
  },
  { label: 'Lookups', members: new Set(['symbol_lookup', 'semantic_search', 'map_lookup']) },
  {
    label: 'Images',
    members: new Set(['image_shrink', 'gdrive_image', 'webfetch_image', 'image_shrink_skipped']),
  },
  {
    label: 'Hints',
    members: new Set([
      'session_hint',
      'session_hint_overhead',
      'read_count_deny',
      'read_dedup_hint',
      'grep_dedup_hint',
      'diff_hint',
      'predictive_prefetch_hit',
      'read_partial_overlap_hint',
    ]),
  },
  {
    label: 'Bash',
    members: new Set([
      'bash_dedup_hint',
      'bash_output_cached',
      'bash_output_recall',
      'bash_output_recall_miss',
      'bash_dedup_stale',
      'bash_range_read_hint',
      'bash_streak_hint',
      'bash_poll_hint',
      'env_probe_cache_hit',
      'git_diff_scope_hint',
      'dep_list_cache_hit',
      'bash_read_equiv_already_read',
      'bash_grep_result_cache_hit',
      'git_diff_context_trimmed',
    ]),
  },
  {
    label: 'Web',
    members: new Set([
      'web_dedup_hint',
      'web_output_cached',
      'web_output_recall',
      'web_output_recall_miss',
      'web_dedup_stale',
    ]),
  },
  {
    label: 'Compact / Skills',
    members: new Set([
      'compact_manifest',
      'compact_assist',
      'compact_recovery',
      'skill_body_recall',
      'skill_compact_served',
      'skill_cached',
      'resume_packet',
      'decision_log',
    ]),
  },
]

function _kindGroupLabel(kind: string): string {
  if (kind.startsWith('bash_compress:')) {
    return 'Bash'
  }
  for (const group of _KIND_GROUPS) {
    if (group.members.has(kind)) {
      return group.label
    }
  }
  return 'Other'
}

function _groupSeparator(label: string): string {
  return `${_M}  ${fg(...C.TEXT_DIM)}${label}${RESET}`
}

// Section: by kind

function _renderByKindSection(stats: StatsData): string[] {
  if (stats.by_kind.length === 0) {
    return []
  }

  const lines = [..._sectionHeader('By kind'), _tableHeader('name')]

  const { grossBytes, shareBytesDenom, shareTokensDenom } = _computeShareDenominators(stats.by_kind)
  const kindNames = new Set(stats.by_kind.map((k) => k.kind))
  const bytesModeKinds = stats.by_kind.filter((k) => k.bytes_mode_only).map((k) => k.kind)

  function share(k: KindStat): number {
    if (k.bytes_mode_only) {
      return k.bytes / shareBytesDenom
    }
    return _absShare(k.bytes, k.tokens, shareBytesDenom, shareTokensDenom)
  }

  const byGroup: Map<string, KindStat[]> = new Map()
  for (const k of stats.by_kind) {
    const grp = _kindGroupLabel(k.kind)
    if (!byGroup.has(grp)) {
      byGroup.set(grp, [])
    }
    byGroup.get(grp)!.push(k)
  }

  for (const grpKinds of byGroup.values()) {
    grpKinds.sort((a, b) => share(b) - share(a))
  }

  // Include 'Other' after the defined groups so kinds that _kindGroupLabel falls back to
  // 'Other' for (i.e. not a member of any _KIND_GROUPS set) still get rendered instead of
  // silently vanishing from this table while still being nameable by the Insights section.
  const groupLabels = [..._KIND_GROUPS.map((g) => g.label), 'Other']

  let firstGroup = true
  for (const label of groupLabels) {
    const groupKinds = byGroup.get(label)
    if (!groupKinds || groupKinds.length === 0) {
      continue
    }
    if (!firstGroup) {
      lines.push('')
    }
    firstGroup = false
    lines.push(_groupSeparator(label))
    for (const k of groupKinds) {
      const s = share(k)
      lines.push(
        _tableRow({
          name: k.kind,
          fraction: _barFraction(k.bytes, grossBytes),
          bytes: k.bytes,
          tokens: k.tokens,
          events: k.events,
          share: s,
          bytesModeOnly: k.bytes_mode_only ?? false,
        }),
      )
    }
  }

  if (bytesModeKinds.length > 0) {
    const names = bytesModeKinds.join(', ')
    lines.push(`${_M}${fg(...C.TEXT_DIM)}i  ${names} ${_STATS_MESSAGES.bytesModeOnlyNote}${RESET}`)
  }

  if (kindNames.has('session_hint') && kindNames.has('session_hint_overhead')) {
    lines.push(`${_M}${fg(...C.TEXT_DIM)}i  ${_STATS_MESSAGES.sessionHintSplitNote}${RESET}`)
  }

  return lines
}

// Section: by source

const _SOURCE_COLORS: Record<string, RGB> = {
  image: C.PURPLE,
  hint: C.BLUE,
  read: C.GREEN4,
  compact: C.TEAL,
  bash: C.ORANGE,
  web: C.YELLOW,
  other: C.TEXT_MUTED,
}

function _sourceColor(source: string): RGB {
  const color = _SOURCE_COLORS[source]
  return color || C.TEXT_MUTED
}

function _renderBySourceSection(stats: StatsData): string[] {
  if (!stats.by_source || stats.by_source.length === 0) {
    return []
  }

  const lines = [..._sectionHeader('By source'), _tableHeader('source')]

  const { grossBytes, shareBytesDenom, shareTokensDenom } = _computeShareDenominators(stats.by_source)

  function share(s: SourceStat): number {
    return _absShare(s.bytes, s.tokens, shareBytesDenom, shareTokensDenom)
  }

  for (const s of [...stats.by_source].sort((a, b) => share(b) - share(a))) {
    const s_val = share(s)
    const color = _sourceColor(s.source)
    lines.push(
      _tableRow({
        name: s.source,
        fraction: _barFraction(s.bytes, grossBytes),
        bytes: s.bytes,
        tokens: s.tokens,
        events: s.events,
        share: s_val,
        namePrefix: `${fg(...color)}●${RESET} `,
        nameColor: C.TEXT_PRIMARY,
      }),
    )
  }

  return lines
}

// Section: by command

function _renderByCommandSection(stats: StatsData): string[] {
  if (!stats.by_command || stats.by_command.length === 0) {
    return []
  }

  const lines = [..._sectionHeader('By command'), _tableHeader('command')]

  const { grossBytes, shareBytesDenom, shareTokensDenom } = _computeShareDenominators(stats.by_command)

  function share(c: CommandStat): number {
    return _absShare(c.bytes, c.tokens, shareBytesDenom, shareTokensDenom)
  }

  for (const c of [...stats.by_command].sort((a, b) => share(b) - share(a))) {
    const s_val = share(c)
    lines.push(
      _tableRow({
        name: c.command,
        fraction: _barFraction(c.bytes, grossBytes),
        bytes: c.bytes,
        tokens: c.tokens,
        events: c.events,
        share: s_val,
        nameColor: C.TEXT_PRIMARY,
      }),
    )
  }

  return lines
}

// Section: by day

function _renderByDaySection(stats: StatsData): string[] {
  if (stats.by_day.length === 0) {
    return []
  }

  const lines = [..._sectionHeader('By day'), _tableHeader('date')]

  function share(d: DayStat): number {
    return _tokenOrByteShare(d.tokens, d.bytes, stats.totals.tokens, stats.totals.bytes)
  }

  for (const d of [...stats.by_day].sort((a, b) => b.date.localeCompare(a.date))) {
    const s = share(d)
    lines.push(
      _tableRow({
        name: d.date,
        fraction: s,
        bytes: d.bytes,
        tokens: d.tokens,
        events: d.events,
        share: s,
      }),
    )
  }

  return lines
}

// Section: by project

const _PROJECT_COLORS: RGB[] = [C.PURPLE, C.TEAL, C.BLUE, C.GREEN4, C.TEXT_MUTED]

function _hashColor(hashStr: string): RGB {
  let n = 0
  for (const c of hashStr) {
    n += c.charCodeAt(0)
  }
  return _PROJECT_COLORS[n % _PROJECT_COLORS.length] ?? C.TEXT_MUTED
}

function _renderByProjectSection(stats: StatsData): string[] {
  if (stats.by_project.length === 0) {
    return []
  }

  const lines = [..._sectionHeader(`By project (top ${stats.by_project.length})`), _tableHeader('project')]

  function share(p: ProjectStat): number {
    return _tokenOrByteShare(p.tokens, p.bytes, stats.totals.tokens, stats.totals.bytes)
  }

  for (const p of [...stats.by_project].sort((a, b) => share(b) - share(a))) {
    const s = share(p)
    const color = _hashColor(p.hash)
    lines.push(
      _tableRow({
        name: p.project,
        fraction: s,
        bytes: p.bytes,
        tokens: p.tokens,
        events: p.events,
        share: s,
        namePrefix: `${fg(...color)}●${RESET} `,
        nameColor: C.TEXT_PRIMARY,
      }),
    )
    lines.push(`${_M}  ${fg(...C.TEXT_DIM)}└─ ${p.hash}  ${stripAnsi(p.path)}${RESET}`)
  }

  return lines
}

// Section: insights

function _renderInsightsSection(stats: StatsData): string[] {
  const lines = [..._sectionHeader('Insights')]
  const bullet = `${fg(...C.GREEN3)}▸${RESET}`

  function dim(s: string): string {
    return `${fg(...C.TEXT_MUTED)}${s}${RESET}`
  }

  const topKind = stats.by_kind.reduce((max, k) => (k.bytes > (max?.bytes || -Infinity) ? k : max), stats.by_kind[0])
  if (topKind) {
    const share = stats.totals.bytes > 0 ? topKind.bytes / stats.totals.bytes : 0
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.biggestSaver)}${fg(...C.TEXT_PRIMARY)}${topKind.kind}${RESET}` +
        `${dim(' — ')}${fg(...C.GREEN5)}${_fmtPct(share)}${RESET}` +
        `${dim(` of saved data across ${topKind.events.toLocaleString()} events`)}`,
    )
  }

  const topDay = stats.by_day.reduce((max, d) => (d.events > (max?.events || -Infinity) ? d : max), stats.by_day[0])
  if (topDay) {
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.mostActive)}${fg(...C.TEXT_PRIMARY)}${topDay.date}${RESET}` +
        `${dim(' — ')}${topDay.events.toLocaleString()} events, ${_fmtBytes(topDay.bytes)}${dim(' saved')}`,
    )
  }

  const tokenKinds = stats.by_kind.filter((k) => !k.bytes_mode_only)
  const topToken = tokenKinds.reduce((max, k) => (k.tokens > (max?.tokens || -Infinity) ? k : max), tokenKinds[0])
  if (topToken) {
    lines.push(
      `${_M}${bullet} ${dim(_STATS_MESSAGES.insights.tokenLeader)}${fg(...C.TEXT_PRIMARY)}${topToken.kind}${RESET}` +
        `${dim(' — ')}${_fmtTokens(topToken.tokens)}` +
        `${dim(` saved in ${topToken.events.toLocaleString()} events`)}`,
    )
  }

  // Hints fired but zero direct commands were ever invoked -- the "By command"
  // section would otherwise vanish silently instead of flagging the gap.
  if ((stats.by_command?.length ?? 0) === 0) {
    const hintSource = stats.by_source?.find((s) => s.source === 'hint')
    if (hintSource && hintSource.events > 0) {
      lines.push(
        `${_M}${fg(...C.YELLOW)}▸${RESET} ${dim('0 direct commands   ')}${fg(...C.TEXT_PRIMARY)}${hintSource.events.toLocaleString()}${RESET}` +
          `${dim(' hint(s) fired but not acted on — run symbol/read/section/semantic/outline/skeleton directly to capture these savings')}`,
      )
    }
  }

  return lines
}

// Report header

function _renderHeader(stats: StatsData): string[] {
  let line = `${_M}${fg(...C.TEXT_BRIGHT)}token-goat${RESET}`
  if (stats.version) {
    line += `  ${fg(...C.TEXT_MUTED)}v${stats.version}${RESET}`
  }
  if (stats.window_label) {
    line += `  ${fg(...C.TEXT_DIM)}·  ${stats.window_label}${RESET}`
  }
  return [line]
}

// Short-mode hint

function _renderShortHint(): string[] {
  return [
    '',
    `${_M}${fg(...C.TEXT_MUTED)}Run 'token-goat stats --full' for the full breakdown (by source, by command, by day).${RESET}`,
  ]
}

// Main export

/**
 * Render a complete token-goat stats report to a string ready for print().
 *
 * Pass ``{ short: true }`` to render only the header and KPI section (totals,
 * bars, sparklines) plus a hint pointing at ``--full`` -- used by the bare
 * ``token-goat stats`` default on a TTY.
 */
export function renderStats(stats: StatsData, opts?: { short?: boolean }): string {
  if (opts?.short) {
    const sections = [_renderHeader(stats), _renderKpiSection(stats), _renderShortHint(), ['']]
    return sections.flatMap((s) => s).join('\n')
  }

  const sections = [
    _renderHeader(stats),
    _renderKpiSection(stats),
    _renderByKindSection(stats),
    _renderBySourceSection(stats),
    _renderByCommandSection(stats),
    _renderByDaySection(stats),
    _renderByProjectSection(stats),
    _renderInsightsSection(stats),
    [''],
  ]
  return sections.flatMap((s) => s).join('\n')
}
