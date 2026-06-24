/**
 * Token-savings telemetry: aggregate and render stats from the stats table.
 *
 * Stats are stored as rows in the ``stats`` table of each per-project SQLite DB
 * by hooks_common.record_stat(). This module reads those rows back, aggregates
 * them by event kind, and formats them for display.
 *
 * Public API:
 * - summarize(windowDays?) — load all stat rows from the global DB and return a
 *   StatsSummary with aggregations by kind, day, project, source, and command.
 * - renderStats(opts?) — compute and print formatted stats to stdout.
 */

import * as path from 'node:path'
import type Database from 'better-sqlite3'
import { getDb } from './db.js'
import { dataDir } from './constants.js'

interface StatsBucket {
  events: number
  bytes_saved: number
  tokens_saved: number
}

interface DayRow extends StatsBucket {
  date: string
}

interface ProjectRow extends StatsBucket {
  project_hash: string
  project_root: string
}

interface CommandRow extends StatsBucket {
  command: string
}

export interface StatsSummary {
  total_events: number
  total_bytes_saved: number
  total_tokens_saved: number
  by_kind: Record<string, StatsBucket>
  by_day: DayRow[]
  by_project: ProjectRow[]
  by_source: Record<string, StatsBucket>
  by_command: CommandRow[]
  window_days: number
}

export const SOURCE_IMAGE = 'image'
export const SOURCE_HINT = 'hint'
export const SOURCE_READ = 'read'
export const SOURCE_COMPACT = 'compact'
export const SOURCE_BASH = 'bash'
export const SOURCE_WEB = 'web'
export const SOURCE_MCP = 'mcp'
export const SOURCE_SKILL = 'skill'
export const SOURCE_OTHER = 'other'

const _BYTES_MODE_ONLY_KINDS = new Set(['webfetch_image', 'gdrive_image'])

const KIND_TO_SOURCE: Record<string, string> = {
  image_shrink: SOURCE_IMAGE,
  image_shrink_cache_hit: SOURCE_IMAGE,
  image_shrink_skipped: SOURCE_IMAGE,
  webfetch_image: SOURCE_IMAGE,
  gdrive_image: SOURCE_IMAGE,
  session_hint: SOURCE_HINT,
  session_hint_suppressed: SOURCE_HINT,
  diff_hint: SOURCE_HINT,
  structured_file_hint: SOURCE_HINT,
  predictive_prefetch_hit: SOURCE_HINT,
  grep_dedup_hint: SOURCE_HINT,
  read_replacement: SOURCE_READ,
  section_replacement: SOURCE_READ,
  symbol_read: SOURCE_READ,
  section_read: SOURCE_READ,
  stub_view: SOURCE_READ,
  symbol_lookup: SOURCE_READ,
  semantic_search: SOURCE_READ,
  map_lookup: SOURCE_READ,
  changed_lookup: SOURCE_READ,
  outline: SOURCE_READ,
  exports: SOURCE_READ,
}

const KIND_PREFIX_TO_SOURCE: Array<[string, string]> = [
  ['bash_compress:', SOURCE_BASH],
  ['webfetch:', SOURCE_WEB],
  ['gdrive:', SOURCE_WEB],
  ['mcp:', SOURCE_MCP],
  ['skill_body:', SOURCE_SKILL],
  ['skill_compact:', SOURCE_SKILL],
]

const COMMAND_KINDS: Record<string, Set<string>> = {
  symbol: new Set(['symbol_lookup']),
  read: new Set(['read_replacement']),
  section: new Set(['section_replacement', 'section_read']),
  semantic: new Set(['semantic_search']),
  outline: new Set(['outline']),
  exports: new Set(['exports']),
  skeleton: new Set(['stub_view']),
  refs: new Set(['symbol_read']),
  map: new Set(['map_lookup']),
  changed: new Set(['changed_lookup']),
}

const OVERHEAD_SUFFIX = '_overhead'

export function kindToSource(kind: string): string {
  const src = KIND_TO_SOURCE[kind]
  if (src !== undefined) return src

  if (kind.endsWith(OVERHEAD_SUFFIX)) {
    const base = kind.slice(0, -OVERHEAD_SUFFIX.length)
    const baseSrc = KIND_TO_SOURCE[base]
    if (baseSrc !== undefined) return baseSrc
  }

  for (const [prefix, prefixSrc] of KIND_PREFIX_TO_SOURCE) {
    if (kind.startsWith(prefix)) return prefixSrc
  }

  return SOURCE_OTHER
}

function zeroBucket(): StatsBucket {
  return { events: 0, bytes_saved: 0, tokens_saved: 0 }
}

function incBucket(bucket: StatsBucket, bytesSaved: number, tokensSaved: number): void {
  bucket.events += 1
  bucket.bytes_saved += bytesSaved
  bucket.tokens_saved += tokensSaved
}

function getGlobalDb(): Database.Database {
  const dbPath = path.join(dataDir(), 'global.db')
  return getDb(dbPath)
}

export function summarize(windowDays: number = 30, testDb?: Database.Database): StatsSummary {
  const t0 = Date.now()
  const sinceTs =
    windowDays > 0 ? Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000) : null

  const byKind: Record<string, StatsBucket> = {}
  const byDay: Record<string, StatsBucket> = {}
  let totalEvents = 0
  let totalBytes = 0
  let totalTokens = 0

  const db = testDb ?? getGlobalDb()
  const query =
    sinceTs !== null
      ? 'SELECT ts, kind, bytes_saved, tokens_saved FROM stats WHERE ts >= ? ORDER BY ts DESC'
      : 'SELECT ts, kind, bytes_saved, tokens_saved FROM stats ORDER BY ts DESC'

  const stmt = db.prepare(query)
  const rows = sinceTs !== null ? stmt.all(sinceTs) : stmt.all()

  const tsToDateCache: Record<number, string> = {}

  for (const row of rows) {
    const bytesSaved = (row as { bytes_saved?: number }).bytes_saved ?? 0
    const tokensSaved = (row as { tokens_saved?: number }).tokens_saved ?? 0
    const kind = (row as { kind: string }).kind
    const ts = (row as { ts: number }).ts

    totalEvents += 1
    totalBytes += bytesSaved
    totalTokens += tokensSaved

    if (!byKind[kind]) {
      byKind[kind] = zeroBucket()
    }
    incBucket(byKind[kind], bytesSaved, tokensSaved)

    const dateKey = tsToDateCache[ts] || new Date(ts * 1000).toISOString().split('T')[0]!
    tsToDateCache[ts] = dateKey

    if (!byDay[dateKey]) {
      byDay[dateKey] = zeroBucket()
    }
    incBucket(byDay[dateKey], bytesSaved, tokensSaved)
  }

  const bySourceDict: Record<string, StatsBucket> = {}
  for (const [kind, bucket] of Object.entries(byKind)) {
    const source = kindToSource(kind)
    if (!bySourceDict[source]) {
      bySourceDict[source] = zeroBucket()
    }
    bySourceDict[source].events += bucket.events
    bySourceDict[source].bytes_saved += bucket.bytes_saved
    bySourceDict[source].tokens_saved += bucket.tokens_saved
  }

  const byCommandDict: Record<string, StatsBucket> = {}
  for (const [cmd, kinds] of Object.entries(COMMAND_KINDS)) {
    byCommandDict[cmd] = zeroBucket()
    for (const kind of kinds) {
      if (byKind[kind]) {
        byCommandDict[cmd].events += byKind[kind].events
        byCommandDict[cmd].bytes_saved += byKind[kind].bytes_saved
        byCommandDict[cmd].tokens_saved += byKind[kind].tokens_saved
      }
    }
  }

  const byDayList: DayRow[] = Object.entries(byDay)
    .map(([date, bucket]) => ({ ...bucket, date }))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const byProjectList: ProjectRow[] = []

  const t1 = Date.now()
  if (t1 - t0 > 1000) {
    console.warn(`summarize took ${t1 - t0}ms (window=${windowDays}d, total=${totalEvents} rows)`)
  }

  return {
    total_events: totalEvents,
    total_bytes_saved: totalBytes,
    total_tokens_saved: totalTokens,
    by_kind: byKind,
    by_day: byDayList,
    by_project: byProjectList,
    by_source: bySourceDict,
    by_command: Object.entries(byCommandDict)
      .map(([command, bucket]) => ({ ...bucket, command }))
      .filter((r) => r.events > 0),
    window_days: windowDays,
  }
}

export function renderStats(opts?: { windowDays?: number }): void {
  const summary = summarize(opts?.windowDays ?? 30)

  if (summary.total_events === 0) {
    console.log('No stats recorded yet.')
    return
  }

  const fmtBytes = (n: number): string => {
    if (n < 1024) return `${n}B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
    return `${(n / (1024 * 1024)).toFixed(1)}MB`
  }

  const lines: string[] = [
    '# token-goat stats',
    `Total events:   ${summary.total_events}`,
    `Bytes saved:    ${fmtBytes(summary.total_bytes_saved)}`,
    `Tokens saved:   ${summary.total_tokens_saved}`,
    `Window:         ${summary.window_days} days`,
  ]

  if (Object.keys(summary.by_source).length > 0) {
    lines.push('', '## By Source')
    const sources = Object.entries(summary.by_source)
      .filter(([, b]) => b.events > 0)
      .sort((a, b) => b[1].tokens_saved - a[1].tokens_saved)
    for (const [source, bucket] of sources) {
      lines.push(
        `  ${source.padEnd(8)} ${bucket.events.toString().padStart(6)} events  ${fmtBytes(bucket.bytes_saved).padStart(8)}  ${bucket.tokens_saved.toString().padStart(8)} tokens`,
      )
    }
  }

  if (summary.by_command.length > 0) {
    lines.push('', '## By Command')
    for (const row of summary.by_command) {
      lines.push(
        `  ${row.command.padEnd(12)} ${row.events.toString().padStart(6)} events  ${fmtBytes(row.bytes_saved).padStart(8)}  ${row.tokens_saved.toString().padStart(8)} tokens`,
      )
    }
  }

  if (summary.by_day.length > 0) {
    lines.push('', '## Last 7 Days')
    for (const row of summary.by_day.slice(0, 7)) {
      lines.push(
        `  ${row.date} ${row.events.toString().padStart(6)} events  ${fmtBytes(row.bytes_saved).padStart(8)}  ${row.tokens_saved.toString().padStart(8)} tokens`,
      )
    }
  }

  console.log(lines.join('\n'))
}
