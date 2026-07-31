/**
 * Token-savings telemetry: aggregate and render stats from the stats table.
 *
 * Stats are stored as rows in the ``stats`` table of each per-project SQLite DB
 * by hooks_common.record_stat(). This module reads those rows back, aggregates
 * them by event kind, and formats them for display.
 *
 * Public API:
 * - summarize(windowDays?) — load all stat rows from the global DB and return a
 *   StatsSummary with aggregations by kind, day, source, and command. `by_project`
 *   is always `[]`: the `stats` table (see GLOBAL_SCHEMA_SQL below) has no
 *   project-identifying column to aggregate by, so this dimension was never wired
 *   up. The field is kept on StatsSummary/the `--json` output for compatibility
 *   with callers that may depend on its presence, not because it carries data.
 * - renderShortStats(opts?) — print just the totals block + a hint to run --full.
 * - renderStats(opts?) — compute and print the full formatted breakdown to stdout.
 */

import * as path from 'node:path'
import type Database from 'better-sqlite3'
import { getDb } from './db.js'
import { dataDir, dataDirForHome } from './constants.js'
import { VERSION } from './version.js'
import { renderStats as richRenderStats } from './render/stats_renderer.js'
import { fmtBytes } from './render/ansi.js'
import type { StatsData } from './render/types.js'
import { registerReset } from './reset.js'

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
  image_ocr: SOURCE_IMAGE,
  webfetch_image: SOURCE_IMAGE,
  gdrive_image: SOURCE_IMAGE,
  session_hint: SOURCE_HINT,
  session_hint_suppressed: SOURCE_HINT,
  diff_hint: SOURCE_HINT,
  structured_file_hint: SOURCE_HINT,
  predictive_prefetch_hit: SOURCE_HINT,
  grep_dedup_hint: SOURCE_HINT,
  glob_dedup_hint: SOURCE_HINT,
  write_rewrite_hint: SOURCE_HINT,
  websearch_dedup_hint: SOURCE_HINT,
  large_file_hint_followed: SOURCE_HINT,
  large_file_hint_ignored: SOURCE_HINT,
  read_count_deny: SOURCE_HINT,
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
  imports: SOURCE_READ,
  dep_docs: SOURCE_READ,
  csv_query: SOURCE_READ,
  csv_profile: SOURCE_READ,
  pdf_extract: SOURCE_READ,
  pdf_outline: SOURCE_READ,
  pdf_meta: SOURCE_READ,
  xlsx_sheets: SOURCE_READ,
  xlsx_head: SOURCE_READ,
  xlsx_range: SOURCE_READ,
  xlsx_query: SOURCE_READ,
  pptx_outline: SOURCE_READ,
  pptx_slide: SOURCE_READ,
  pptx_notes: SOURCE_READ,
  pptx_text: SOURCE_READ,
  docx_outline: SOURCE_READ,
  docx_text: SOURCE_READ,
  transcript_outline: SOURCE_READ,
  transcript: SOURCE_READ,
  video_chapters: SOURCE_READ,
  coverage_report_gaps: SOURCE_READ,
  json_query: SOURCE_READ,
  json_outline: SOURCE_READ,
  yaml_query: SOURCE_READ,
  yaml_outline: SOURCE_READ,
  openapi_op: SOURCE_READ,
  openapi_outline: SOURCE_READ,
  zip_list: SOURCE_READ,
  zip_read: SOURCE_READ,
  sqlite_query: SOURCE_READ,
  sqlite_schema: SOURCE_READ,
  conflicts: SOURCE_READ,
  brief_view: SOURCE_READ,
  session_outline: SOURCE_READ,
  session_slice: SOURCE_READ,
  gdrive_sections: SOURCE_READ,
  pr_slice: SOURCE_READ,
  compact_doc: SOURCE_READ,
  note_read: SOURCE_READ,
  note_list: SOURCE_READ,
  // note-add is a write (like insert-section/replace, which record no stat at all -- neither
  // has a "full source it replaces" savings concept). It still gets an event-only entry here
  // (no bytesSaved/tokensSaved argument, same as skill_load) purely so `token-goat note-add`
  // usage is visible in `token-goat stats --full` at all -- SOURCE_OTHER, not SOURCE_READ,
  // since it is not a token-savings substitute for a read.
  note_write: SOURCE_OTHER,
  web_fetch: SOURCE_WEB,
  injection_detected: SOURCE_WEB,
  skill_load: SOURCE_SKILL,
  skill_oversized_first_load: SOURCE_SKILL,
  secret_redacted: SOURCE_OTHER,
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
  imports: new Set(['imports']),
  skeleton: new Set(['stub_view']),
  refs: new Set(['symbol_read']),
  map: new Set(['map_lookup']),
  changed: new Set(['changed_lookup']),
  'dep-docs': new Set(['dep_docs']),
  'csv-query': new Set(['csv_query']),
  'csv-profile': new Set(['csv_profile']),
  'pdf-extract': new Set(['pdf_extract']),
  'pdf-outline': new Set(['pdf_outline']),
  'pdf-meta': new Set(['pdf_meta']),
  'xlsx-sheets': new Set(['xlsx_sheets']),
  'xlsx-head': new Set(['xlsx_head']),
  'xlsx-range': new Set(['xlsx_range']),
  'xlsx-query': new Set(['xlsx_query']),
  'pptx-outline': new Set(['pptx_outline']),
  'pptx-slide': new Set(['pptx_slide']),
  'pptx-notes': new Set(['pptx_notes']),
  'pptx-text': new Set(['pptx_text']),
  'docx-outline': new Set(['docx_outline']),
  'docx-text': new Set(['docx_text']),
  'transcript-outline': new Set(['transcript_outline']),
  transcript: new Set(['transcript']),
  'video-chapters': new Set(['video_chapters']),
  'coverage-report-gaps': new Set(['coverage_report_gaps']),
  'json-query': new Set(['json_query']),
  'json-outline': new Set(['json_outline']),
  'yaml-query': new Set(['yaml_query']),
  'yaml-outline': new Set(['yaml_outline']),
  'openapi-op': new Set(['openapi_op']),
  'openapi-outline': new Set(['openapi_outline']),
  'zip-list': new Set(['zip_list']),
  'zip-read': new Set(['zip_read']),
  'sqlite-query': new Set(['sqlite_query']),
  'sqlite-schema': new Set(['sqlite_schema']),
  conflicts: new Set(['conflicts']),
  brief: new Set(['brief_view']),
  'session-outline': new Set(['session_outline']),
  'session-slice': new Set(['session_slice']),
  'gdrive-sections': new Set(['gdrive_sections']),
  'pr-slice': new Set(['pr_slice']),
  'compact-doc': new Set(['compact_doc']),
  'note-add': new Set(['note_write']),
  'note-get': new Set(['note_read']),
  'note-list': new Set(['note_list']),
  npm: new Set([
    'bash_compress:npm_install',
    'bash_compress:npm_ci',
    'bash_compress:npm_audit',
    'bash_compress:npm_ls',
    'bash_compress:npm_outdated',
    'bash_compress:npx',
  ]),
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

// Formats a Date's local (not UTC) calendar day as YYYY-MM-DD. Stats are bucketed and displayed by the user's wall-clock day, so a UTC-based toISOString() split would push any event recorded after local midnight-minus-UTC-offset into the next day's bucket.
export function toLocalDateKey(d: Date): string {
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Same local-timezone rationale as toLocalDateKey, extended with a wall-clock time-of-day
// (HH:MM:SS) for timestamp displays that need more than just the calendar day.
export function formatLocalTimestamp(d: Date): string {
  const hours = String(d.getHours()).padStart(2, '0')
  const minutes = String(d.getMinutes()).padStart(2, '0')
  const seconds = String(d.getSeconds()).padStart(2, '0')
  return `${toLocalDateKey(d)}T${hours}:${minutes}:${seconds}`
}

function zeroBucket(): StatsBucket {
  return { events: 0, bytes_saved: 0, tokens_saved: 0 }
}

function incBucket(bucket: StatsBucket, bytesSaved: number, tokensSaved: number): void {
  bucket.events += 1
  bucket.bytes_saved += bytesSaved
  bucket.tokens_saved += tokensSaved
}

const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_ts ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_kind ON stats(kind);
`

const _globalSchemaApplied = new Set<string>()
registerReset(() => _globalSchemaApplied.clear())

function getGlobalDb(homeDir?: string): Database.Database {
  const basePath = homeDir ? dataDirForHome(homeDir) : dataDir()
  const dbPath = path.join(basePath, 'global.db')
  const db = getDb(dbPath)
  if (!_globalSchemaApplied.has(dbPath)) {
    db.exec(GLOBAL_SCHEMA_SQL)
    _globalSchemaApplied.add(dbPath)
  }
  return db
}

/**
 * Record a stat event in the global database.
 *
 * Silently no-ops on any error so hook paths are never blocked.
 * Pass `_testDb` in tests to inject a pre-initialized database.
 */
export function recordStat(
  kind: string,
  bytesSaved = 0,
  tokensSaved = 0,
  _testDb?: Database.Database,
  detail?: string,
): void {
  try {
    const db = _testDb ?? getGlobalDb()
    db.prepare(
      'INSERT INTO stats (ts, kind, bytes_saved, tokens_saved, detail) VALUES (?, ?, ?, ?, ?)',
    ).run(Math.floor(Date.now() / 1000), kind, bytesSaved, tokensSaved, detail ?? null)
  } catch {
    // Best-effort — never block the hook path.
  }
}

export function summarize(windowDays: number = 30, testDb?: Database.Database, homeDir?: string): StatsSummary {
  const t0 = Date.now()
  const sinceTs =
    windowDays > 0 ? Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000) : null

  const byKind: Record<string, StatsBucket> = {}
  const byDay: Record<string, StatsBucket> = {}
  let totalEvents = 0
  let totalBytes = 0
  let totalTokens = 0

  const db = testDb ?? getGlobalDb(homeDir)
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
    const tsRaw = (row as { ts?: number }).ts
    if (tsRaw === undefined) continue
    const ts = tsRaw

    totalEvents += 1
    totalBytes += bytesSaved
    totalTokens += tokensSaved

    if (!byKind[kind]) {
      byKind[kind] = zeroBucket()
    }
    incBucket(byKind[kind], bytesSaved, tokensSaved)

    const dateKey = tsToDateCache[ts] || toLocalDateKey(new Date(ts * 1000))
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

  // Always empty by design, not a bug: the `stats` table has no project-identifying column (see GLOBAL_SCHEMA_SQL), so there is no data source to aggregate by project from. Kept on StatsSummary/the `--json` output for shape compatibility — see the module docstring above.
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



/** The short totals block shared by the plain-text and short-default renderers. */
function _totalsLines(summary: StatsSummary): string[] {
  return [
    '# token-goat stats',
    `Total events:   ${summary.total_events}`,
    `Bytes saved:    ${fmtBytes(summary.total_bytes_saved)}`,
    `Tokens saved:   ${summary.total_tokens_saved}`,
    `Window:         ${summary.window_days} days`,
  ]
}

/**
 * Whether stats output should use the rich, ANSI-colored renderer.
 * `isTTY === true` is an explicit, unambiguous terminal -- always rich. When
 * `isTTY` is `undefined` (Claude Code's own terminal, which sets no isTTY at
 * all -- see 9f8589a5) treat it as rich too, but not when `CI` is set: CI
 * runners are also non-TTY and would otherwise be misread as Claude Code's
 * terminal, sending colorized box-table output through what test/log
 * consumers expect to be plain text.
 */
function _useRichStats(): boolean {
  if (process.env['NO_COLOR']) return false
  if (process.stdout.isTTY === true) return true
  return process.stdout.isTTY === undefined && !process.env['CI']
}

function _renderShortTotals(summary: StatsSummary): void {
  const lines = [
    ..._totalsLines(summary),
    '',
    "Run 'token-goat stats --full' for the full breakdown (by source, by command, by day).",
  ]
  console.log(lines.join('\n'))
}

function _plainTextStats(summary: StatsSummary): void {
  const lines: string[] = _totalsLines(summary)

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
  } else {
    // Hints fired but no direct command was ever invoked -- surface this as a
    // gap instead of letting the section vanish silently (see CHANGELOG).
    const hintBucket = summary.by_source[SOURCE_HINT]
    if (hintBucket && hintBucket.events > 0) {
      lines.push(
        '',
        '## By Command',
        `  0 direct command invocations this window -- ${hintBucket.events} hint(s) fired but not acted on.`,
        '  Run token-goat symbol/read/section/semantic/outline/skeleton directly to capture these savings.',
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

/** Build the StatsData payload consumed by the rich TTY renderer from a StatsSummary. */
function _buildStatsData(summary: StatsSummary, windowDays: number): StatsData {
  const now = new Date()
  const periodStart =
    windowDays > 0 ? new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000) : new Date(0)

  // Build sparklines from by_day (reverse from newest-first to oldest-first)
  const sparkDays = [...summary.by_day].reverse().slice(-30)
  const sparklines =
    sparkDays.length > 1
      ? {
          events: sparkDays.map((d) => d.events),
          bytes: sparkDays.map((d) => d.bytes_saved),
          tokens: sparkDays.map((d) => d.tokens_saved),
        }
      : null

  return {
    period_start: periodStart,
    period_end: now,
    version: VERSION,
    window_label: windowDays > 0 ? `last ${windowDays} days` : 'all time',
    totals: {
      events: summary.total_events,
      bytes: summary.total_bytes_saved,
      tokens: summary.total_tokens_saved,
      sparklines,
    },
    by_kind: Object.entries(summary.by_kind)
      .map(([kind, bucket]) => ({
        kind,
        bytes: bucket.bytes_saved,
        tokens: bucket.tokens_saved,
        events: bucket.events,
        bytes_mode_only: _BYTES_MODE_ONLY_KINDS.has(kind),
      }))
      .sort((a, b) => b.bytes - a.bytes),
    by_day: summary.by_day.map((d) => ({
      date: d.date,
      bytes: d.bytes_saved,
      tokens: d.tokens_saved,
      events: d.events,
    })),
    by_project: [],
    by_source: Object.entries(summary.by_source)
      .filter(([, b]) => b.events > 0)
      .map(([source, bucket]) => ({
        source,
        bytes: bucket.bytes_saved,
        tokens: bucket.tokens_saved,
        events: bucket.events,
      }))
      .sort((a, b) => b.bytes - a.bytes),
    by_command: summary.by_command.map((c) => ({
      command: c.command,
      bytes: c.bytes_saved,
      tokens: c.tokens_saved,
      events: c.events,
    })),
  }
}

/**
 * Bare ``token-goat stats`` default: totals + hints only, no by-source/
 * by-command/by-day breakdown. On a TTY this uses the same rich header + KPI
 * section as ``--full`` (just without the detail sections); on a pipe it
 * stays flat plain text.
 */
export function renderShortStats(opts?: { windowDays?: number; homeDir?: string; force?: boolean }): void {
  const windowDays = opts?.windowDays ?? 30
  const summary = summarize(windowDays, undefined, opts?.homeDir)

  if (summary.total_events === 0) {
    console.log('No stats recorded yet.')
    return
  }

  // `force` (wired from `--short`) bypasses only the TTY/CI half of the gate -- an agent caller invoking through a pipe has no isTTY signal to spoof, so this is the only way it can reach the richer KPI view without reverse-engineering _useRichStats. NO_COLOR still wins even when forced: an explicit no-color preference should never be overridden.
  const useTty = process.env['NO_COLOR'] ? false : opts?.force === true ? true : _useRichStats()
  if (!useTty) {
    _renderShortTotals(summary)
    return
  }

  const statsData = _buildStatsData(summary, windowDays)
  process.stdout.write(richRenderStats(statsData, { short: true }) + '\n')
}

export function renderStats(opts?: { windowDays?: number; homeDir?: string }): void {
  const windowDays = opts?.windowDays ?? 30
  const summary = summarize(windowDays, undefined, opts?.homeDir)

  if (summary.total_events === 0) {
    console.log('No stats recorded yet.')
    return
  }

  const useTty = _useRichStats()
  if (!useTty) {
    _plainTextStats(summary)
    return
  }

  const statsData = _buildStatsData(summary, windowDays)
  process.stdout.write(richRenderStats(statsData) + '\n')
}
