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
import type {
  CommandStat,
  DayStat,
  HarnessStat,
  KindStat,
  ProjectStat,
  SourceStat,
  StatsData,
} from './types.js'
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
      // Every other SOURCE_READ kind in stats.ts's KIND_TO_SOURCE: the surgical-read commands over documents, structured data and session/PR state. They were registered and produced but grouped nowhere, so `stats --full` printed the whole family under 'Other', away from the read-savings siblings they are measured against. image_meta/image_text sit here rather than under 'Images' because stats.ts files them as SOURCE_READ: they save read bytes, they do not shrink an image.
      'brief_view',
      'conflicts',
      'coverage_report_gaps',
      'csv_query',
      'csv_profile',
      'compact_doc',
      'docx_outline',
      'docx_text',
      'gdrive_sections',
      'image_meta',
      'image_text',
      'json_query',
      'json_outline',
      'note_read',
      'note_list',
      'openapi_op',
      'openapi_outline',
      'pdf_extract',
      'pdf_locate',
      'pdf_outline',
      'pdf_meta',
      'pptx_outline',
      'pptx_slide',
      'pptx_notes',
      'pptx_text',
      'pr_slice',
      'session_outline',
      'session_slice',
      'sqlite_query',
      'sqlite_schema',
      'transcript',
      'transcript_outline',
      'video_chapters',
      'xlsx_sheets',
      'xlsx_head',
      'xlsx_range',
      'xlsx_query',
      'xml_query',
      'xml_outline',
      'yaml_query',
      'yaml_outline',
      'zip_list',
      'zip_read',
    ]),
  },
  { label: 'Lookups', members: new Set(['symbol_lookup', 'semantic_search', 'map_lookup']) },
  {
    label: 'Images',
    members: new Set([
      'image_shrink',
      'gdrive_image',
      'webfetch_image',
      'image_shrink_skipped',
      'image_shrink_cache_hit',
      'image_ocr',
    ]),
  },
  {
    label: 'Hints',
    members: new Set([
      'session_hint',
      'session_hint_overhead',
      'session_hint_suppressed',
      'read_count_deny',
      'read_served_deny',
      'grep_dedup_hint',
      'glob_dedup_hint',
      'diff_hint',
      'predictive_prefetch_hit',
      'structured_file_hint',
      'write_rewrite_hint',
      'websearch_dedup_hint',
      'large_file_hint_followed',
      'large_file_hint_ignored',
      'evidence_cache_hit',
    ]),
  },
  // Empty for the same reason as MCP below: every live Bash kind arrives through _kindGroupLabel's `bash_compress:` prefix branch, not through a literal name. The fifteen literal names this set used to carry (bash_output_cached, bash_dedup_hint, env_probe_cache_hit and the rest) came over with the Python port and were never recorded or registered anywhere in this tree, so they grouped rows that could not exist.
  { label: 'Bash', members: new Set<string>() },
  {
    label: 'Web',
    members: new Set([
      'web_fetch',
      'injection_detected',
    ]),
  },
  // Membership comes from _kindGroupLabel's `mcp:` prefix branch, not from this set, which is why
  // it is empty. The entry still has to exist: _renderByKindSection iterates _KIND_GROUPS' labels
  // (plus 'Other') to decide what to print, so a label _kindGroupLabel returns but that is missing
  // here does not fall back to 'Other' -- its rows disappear from the table entirely.
  { label: 'MCP', members: new Set<string>() },
  {
    label: 'Compact / Skills',
    members: new Set([
      'skill_load',
      'skill_oversized_first_load',
      'skill_compact_inlined',
    ]),
  },
  // SOURCE_CONTENT: real rewrites of tool output that remove real bytes (agent report compaction, Grep fold, browser tab dedup, bash/content compression and the handoff pair). The by-source table has shown a 'content' row since the source was added, but the by-kind table had no member set for it, so every one of these kinds printed under 'Other'. The taskoutput: prefix branch in _kindGroupLabel routes here too.
  {
    label: 'Content',
    members: new Set([
      'content_compress',
      'content_retrieve',
      'agent_report_compact',
      'agent_report_compact_declined',
      'browser_tab_dedup',
      'grep:fold',
      'read:served_elide',
      'handoff_create',
      'handoff_resolve',
      'plan_echo_collapse',
    ]),
  },
]

/** Every kind name literally listed in a {@link _KIND_GROUPS} member set. Exported for guards/rendered_stat_kind_is_registered.test.ts, the third mirror in the stat-registry guard family: a name the renderer groups but that stats.ts never registered has no source, no producer, and can only ever render as an empty row. */
export function _renderedKindNames(): string[] {
  return _KIND_GROUPS.flatMap((g) => [...g.members])
}

/** The "By kind" group heading a stat kind renders under, or 'Other' when no literal member set and no prefix branch claims it. Exported for guards/every_registered_stat_kind_is_grouped.test.ts, the fourth mirror in the stat-registry guard family: a kind stats.ts registers but the renderer groups nowhere falls to 'Other', so it prints away from its siblings and reads as uncategorised. */
export function _kindGroupLabel(kind: string): string {
  if (kind.startsWith('bash_compress:') || kind.startsWith('bashoutput:')) {
    return 'Bash'
  }
  // Mirrors the bash_compress: special case above for stats.ts's other live colon-prefixed kind
  // (webfetch:recall) -- KIND_PREFIX_TO_SOURCE maps it to SOURCE_WEB, but without this branch it
  // fell through every literal _KIND_GROUPS member set to 'Other' instead of 'Web'.
  if (kind.startsWith('webfetch:') || kind.startsWith('gdrive:')) {
    return 'Web'
  }
  // Same special case for the mcp: prefix (mcp:compress, mcp:recall). KIND_PREFIX_TO_SOURCE maps
  // it to SOURCE_MCP, which the by-source table shows, but the by-kind table -- the one users
  // read -- has no literal member set for it, so without this branch every MCP row would land
  // under 'Other' and the mechanism would still be effectively unreadable.
  if (kind.startsWith('mcp:')) {
    return 'MCP'
  }
  // Same special case for the skill_body: prefix (skill_body:compact). Its literal siblings below
  // already sit in the 'Compact / Skills' set, so without this branch a colon-prefixed skill kind
  // would render under 'Other', separated from the very rows it belongs beside.
  if (kind.startsWith('skill_body:') || kind.startsWith('skill_compact:')) {
    return 'Compact / Skills'
  }
  // taskoutput: is KIND_PREFIX_TO_SOURCE's other SOURCE_CONTENT entry (subagent report recall); it groups with the literal Content names below.
  if (kind.startsWith('taskoutput:')) {
    return 'Content'
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

// Section: by harness

function _renderByHarnessSection(stats: StatsData): string[] {
  // One row equal to the total teaches nothing, so a single-harness install sees no section at all.
  if (!stats.by_harness || stats.by_harness.length < 2) {
    return []
  }

  const lines = [..._sectionHeader('By harness'), _tableHeader('harness')]

  const { grossBytes, shareBytesDenom, shareTokensDenom } = _computeShareDenominators(stats.by_harness)

  function share(h: HarnessStat): number {
    return _absShare(h.bytes, h.tokens, shareBytesDenom, shareTokensDenom)
  }

  for (const h of [...stats.by_harness].sort((a, b) => share(b) - share(a))) {
    lines.push(
      _tableRow({
        name: h.harness,
        fraction: _barFraction(h.bytes, grossBytes),
        bytes: h.bytes,
        tokens: h.tokens,
        events: h.events,
        share: share(h),
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

  // Ordinal (not locale-aware) sort -- an unlocaled localeCompare() orders differently across Node's small-icu vs full-icu builds and different system default locales, which would make the "By day" ordering nondeterministic across machines/CI runners.
  for (const d of [...stats.by_day].sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0))) {
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

  // Only kinds that actually saved something can lead a savings ranking. Some kinds are pure
  // measurements recorded at (0, 0) -- compact_summary, which records how large a compaction
  // summary was -- and a store holding only those would otherwise crown one of them "Biggest
  // saver ... 0.0%", which reads as a result rather than as an empty ranking.
  const savingKinds = stats.by_kind.filter((k) => k.bytes > 0)
  const topKind = savingKinds.reduce((max, k) => (k.bytes > (max?.bytes || -Infinity) ? k : max), savingKinds[0])
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

  const tokenKinds = stats.by_kind.filter((k) => !k.bytes_mode_only && k.tokens > 0)
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
    _renderByHarnessSection(stats),
    _renderByDaySection(stats),
    _renderByProjectSection(stats),
    _renderInsightsSection(stats),
    [''],
  ]
  return sections.flatMap((s) => s).join('\n')
}
