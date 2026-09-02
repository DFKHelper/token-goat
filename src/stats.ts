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
import type { SqliteDatabase } from './sqlite_driver.js'
import { getDb } from './db.js'
import { dataDir, dataDirForHome } from './constants.js'
import { VERSION } from './version.js'
import { renderStats as richRenderStats } from './render/stats_renderer.js'
import { fmtBytes } from './render/ansi.js'
import type { StatsData } from './render/types.js'
import { registerReset } from './reset.js'
import { getHarnessName } from './bridges/registry.js'
import { countNoun } from './util.js'

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
  /**
   * Savings split by the AI harness the hook fired under, so "token-goat saved 1.1 Gt" can be
   * asked per harness instead of only in aggregate. Rows written before this column existed
   * carry no harness and are bucketed under {@link HARNESS_UNRECORDED} rather than being
   * attributed to whichever harness happens to be running now -- an unmeasured row is not a
   * measured zero, and folding it into a real harness would overstate that harness's share.
   */
  by_harness: Record<string, StatsBucket>
  /**
   * Totals for kinds whose recorded number is a count rather than a token quantity, keyed by kind.
   * Reported here instead of in the token columns so a count is never summed into a token total;
   * see {@link COUNT_ONLY_KINDS}. Absent kinds simply had no rows in the window.
   */
  counts: Record<string, number>
  window_days: number
}

/**
 * Bucket for stat rows that predate the `harness` column. Deliberately not a harness name: it
 * marks the absence of a measurement, and any renderer showing it must not let it read as one.
 */
export const HARNESS_UNRECORDED = 'unrecorded (pre-2.8.1)'

export const SOURCE_IMAGE = 'image'
export const SOURCE_HINT = 'hint'
export const SOURCE_READ = 'read'
export const SOURCE_BASH = 'bash'
export const SOURCE_WEB = 'web'
export const SOURCE_MCP = 'mcp'
export const SOURCE_SKILL = 'skill'
export const SOURCE_CONTENT = 'content'
export const SOURCE_OTHER = 'other'

const _BYTES_MODE_ONLY_KINDS = new Set(['webfetch_image', 'gdrive_image'])

/**
 * Kinds whose third `recordStat` argument is a COUNT, not a number of tokens.
 *
 * There is one, and it is the reason this set exists rather than a comment: `secret_redacted`
 * passes the number of redaction placeholders it emitted, because the row has no other numeric slot
 * to put it in. That is fine as a per-kind figure and wrong the moment it is added to anything: a
 * count of placeholders summed into `total_tokens_saved` puts a unit-less quantity inside the one
 * headline number this project asks to be believed, which is the same defect class as pricing an
 * image in bytes -- a credit in a unit that does not bill.
 *
 * The codebase had already reached half of this conclusion: `secret_redacted` is deliberately left
 * out of the renderer's kind groups because "a redaction removes secret bytes, it does not save a
 * read". That reasoning stopped at grouping and never reached aggregation, so the display hid the
 * figure while the total kept adding it. {@link summarize} now routes these kinds into
 * {@link StatsSummary.counts} and contributes zero tokens to every aggregate, so no bucket, day,
 * source, command or harness carries it either.
 */
export const COUNT_ONLY_KINDS: ReadonlySet<string> = new Set(['secret_redacted'])

/**
 * Tokens to credit for `bytes` of text removed from what reaches the model.
 *
 * One function because the divisor is an assumption, and an assumption spelled out at each of forty
 * callsites drifts without anyone noticing. It drifted here: `bash_compress:generic` credited itself
 * through `estimateTokensFromLength`, which divides by three rather than four, so one kind was booked
 * roughly a third richer than every sibling inside a column that sums them all. On real data that was
 * 469,422 tokens over 520 events.
 *
 * Four, not three, and deliberately the more conservative of the two. `estimateTokensFromLength` is
 * an overflow guard's estimator, where over-estimating is the safe direction because the cost of
 * guessing low is blowing a budget. A saving is the mirror: over-estimating credits work that was
 * never done, so the safe direction reverses and the larger number is the wrong one to reach for.
 * Neither figure is a real tokenizer, and this is text only -- an image is billed in 28x28 pixel
 * patches and must go through `visionTokens` instead.
 */
export function savedTokensFromBytes(bytes: number): number {
  return Math.round(Math.max(0, bytes) / 4)
}

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
  evidence_cache_hit: SOURCE_HINT,
  structured_file_hint: SOURCE_HINT,
  predictive_prefetch_hit: SOURCE_HINT,
  grep_dedup_hint: SOURCE_HINT,
  glob_dedup_hint: SOURCE_HINT,
  write_rewrite_hint: SOURCE_HINT,
  websearch_dedup_hint: SOURCE_HINT,
  large_file_hint_followed: SOURCE_HINT,
  large_file_hint_ignored: SOURCE_HINT,
  read_count_deny: SOURCE_HINT,
  read_served_deny: SOURCE_HINT,
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
  pdf_locate: SOURCE_READ,
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
  image_meta: SOURCE_READ,
  image_text: SOURCE_READ,
  coverage_report_gaps: SOURCE_READ,
  json_query: SOURCE_READ,
  json_outline: SOURCE_READ,
  yaml_query: SOURCE_READ,
  yaml_outline: SOURCE_READ,
  xml_query: SOURCE_READ,
  xml_outline: SOURCE_READ,
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
  // Cold first load of an oversized skill where preSkillHandler inlined the compact slice in its reply instead of pointing at `skill-body --compact`. Unlike its skill_oversized_first_load sibling (event-only, 0 bytes -- the pointer deny saves nothing by itself, the follow-up command does) this one records real savings: the full body never landed, the slice did, so bytesSaved is body minus slice.
  skill_compact_inlined: SOURCE_SKILL,
  secret_redacted: SOURCE_OTHER,
  // Fail-soft diagnostic counters from hooks_edit.ts: they record that a side task threw, never a byte saving, so "other" is the right home. Listed explicitly rather than left to kindToSource()'s fallback so the registration guard can tell a deliberate placement from an unregistered kind.
  dirty_queue_append_failed: SOURCE_OTHER,
  worker_healthcheck_failed: SOURCE_OTHER,
  known_root_record_failed: SOURCE_OTHER,
  // Measurement of what a compaction produced (hooks_compact.ts postCompactHandler): summary size and how many manifest paths survived into it. SOURCE_OTHER and always recorded at (0, 0) -- the summary was written whether or not token-goat was watching, so there is no counterfactual in which those bytes were saved. Filing it anywhere with a savings total would credit token-goat for the whole summary, which is the accounting mistake this registry exists to prevent.
  compact_summary: SOURCE_OTHER,
  // Envelope compaction of an oversized subagent report (hooks_agent_spawn.ts). SOURCE_CONTENT, not SOURCE_HINT: the handler's sibling session_hint entry is advisory (it only appends a recall pointer and genuinely saves nothing), whereas this kind records a real rewrite with real bytes removed, so filing it under the advisory bucket would understate the compaction and repeat the zero-savings desync this registry keeps getting bitten by.
  agent_report_compact: SOURCE_CONTENT,
  // Decline counterpart to agent_report_compact: the fence-collapse net-benefit gate ran and found at least one over-long fence, but declined to rewrite because net savings did not clear the notice cost. Always recorded at (0, 0) -- see the recordStat call site -- so it never contributes to any savings total; it exists purely to make gate hit-rate and near-misses visible instead of the decline being invisible.
  agent_report_compact_declined: SOURCE_CONTENT,
  content_compress: SOURCE_CONTENT,
  // Verbatim-repeat collapse of a browser tool's "Tab Context:" text block (hooks_browser_image.ts postBrowserImageHandler). SOURCE_CONTENT for the same reason as agent_report_compact above: it is a real rewrite with real bytes removed, not an advisory nudge. Deliberately not SOURCE_IMAGE -- it shares a handler with image_shrink but collapses text, and folding text bytes into the image ledger is the two-units-under-one-label mistake this file's image_shrink entry was just fixed for.
  browser_tab_dedup: SOURCE_CONTENT,
  // Collapse of the plan echo in an approved ExitPlanMode result (hooks_exitplanmode.ts). SOURCE_CONTENT for the same reason as agent_report_compact: real bytes removed from a tool result, not an advisory nudge. The handler shipped for releases emitting this rewrite and recording nothing at all, so the mechanism was invisible in `stats` and its net benefit could not be checked against the gate that admits it.
  plan_echo_collapse: SOURCE_CONTENT,

  // Lossless re-layout of Grep content-mode output (hooks_grep.ts foldGrepContentHandler). SOURCE_CONTENT, not SOURCE_HINT, for the same reason as agent_report_compact above: its sibling grep_dedup_hint is advisory and saves nothing directly, whereas this is a real rewrite with real bytes removed. Filing it under the advisory bucket would silently add non-hint savings to hint_stats.ts's savedBytes (which reads by_source[SOURCE_HINT] wholesale) and overstate the hint ledger's net benefit.
  'grep:fold': SOURCE_CONTENT,

  // Withholding of already-served stretches from a completed Read (hooks_read.ts
  // elideAlreadyServedLines). SOURCE_CONTENT, not SOURCE_HINT, for the same reason as
  // grep:fold above: its siblings read_count_deny and read_served_deny are decisions about
  // whether a read happens at all, whereas this is a rewrite of a result that did happen,
  // with real bytes removed from it. Filing it under the advisory bucket would add non-hint
  // savings to hint_stats.ts's savedBytes, which reads by_source[SOURCE_HINT] wholesale.
  'read:served_elide': SOURCE_CONTENT,
  content_retrieve: SOURCE_CONTENT,
  handoff_create: SOURCE_CONTENT,
  handoff_resolve: SOURCE_CONTENT,
}

const KIND_PREFIX_TO_SOURCE: Array<[string, string]> = [
  ['bash_compress:', SOURCE_BASH],
  ['webfetch:', SOURCE_WEB],
  ['gdrive:', SOURCE_WEB],
  ['mcp:', SOURCE_MCP],
  ['skill_body:', SOURCE_SKILL],
  ['skill_compact:', SOURCE_SKILL],
  ['bashoutput:', SOURCE_BASH],
  ['taskoutput:', SOURCE_CONTENT],
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
  'pdf-locate': new Set(['pdf_locate']),
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
  'image-meta': new Set(['image_meta']),
  'image-text': new Set(['image_text']),
  'coverage-report-gaps': new Set(['coverage_report_gaps']),
  'json-query': new Set(['json_query']),
  'json-outline': new Set(['json_outline']),
  'yaml-query': new Set(['yaml_query']),
  'yaml-outline': new Set(['yaml_outline']),
  'xml-query': new Set(['xml_query']),
  'xml-outline': new Set(['xml_outline']),
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
  'compress-text': new Set(['content_compress']),
  retrieve: new Set(['content_retrieve']),
  'handoff-create': new Set(['handoff_create']),
  'handoff-resolve': new Set(['handoff_resolve']),
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

/** Exported so a test can stand up a real `stats` table without restating this DDL, which would then drift from it silently. */
export const GLOBAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tokens_saved INTEGER NOT NULL DEFAULT 0,
  bytes_saved INTEGER NOT NULL DEFAULT 0,
  detail TEXT,
  harness TEXT,
  traceparent TEXT,
  tg_version TEXT
);
CREATE INDEX IF NOT EXISTS idx_stats_ts ON stats(ts);
CREATE INDEX IF NOT EXISTS idx_stats_kind ON stats(kind);
CREATE TABLE IF NOT EXISTS unmapped_tools (
  harness TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  event_name TEXT NOT NULL,
  near_miss TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (harness, tool_name, event_name)
);
`

const _globalSchemaApplied = new Set<string>()
registerReset(() => _globalSchemaApplied.clear())

/**
 * Bring an already-created `global.db` up to the shape {@link GLOBAL_SCHEMA_SQL} describes.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so adding a column
 * to the DDL above reaches brand-new databases only. Every database created by an earlier release
 * keeps the old shape, and an INSERT naming the new column then fails on it -- which {@link
 * recordStat} swallows by design, so the visible symptom would be every existing user's telemetry
 * silently stopping. Hence an explicit column add here, and the independent capability check in
 * {@link statsHasHarnessColumn} so a database this function never touched (a caller's injected
 * `_testDb`) degrades to "harness not recorded" instead of "nothing recorded".
 *
 * Unlike the per-project database there is no schema-version stamp on `global.db` to key
 * migrations off, so each step must be individually idempotent: swallow exactly a duplicate-column
 * failure -- the column already being present from the CREATE TABLE on a fresh database -- and
 * rethrow anything else, so a genuine failure is never lost.
 */
function migrateGlobalSchema(db: SqliteDatabase): void {
  try {
    db.exec('ALTER TABLE stats ADD COLUMN harness TEXT')
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
  }
  try {
    db.exec('ALTER TABLE stats ADD COLUMN traceparent TEXT')
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
  }
  // Which token-goat wrote this row. Left nullable with no default rather than backfilled with
  // the running version: rows written before this column existed came from an unknown release,
  // and stamping today's version onto them would manufacture a provenance that was never
  // measured -- the same reasoning as hint_emissions.bytes_emitted's deliberate NULL in db.ts.
  // Without it, a change to how a kind computes bytes_saved (such as the counterfactual cap in
  // util.ts's cappedSourceBytesSaved) silently mixes old and new accounting in one column, and
  // no query can separate them after the fact.
  try {
    db.exec('ALTER TABLE stats ADD COLUMN tg_version TEXT')
  } catch (err) {
    if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err
  }
}

/**
 * Does this database's `stats` table carry the `harness` column?
 *
 * Cached per database handle: on the normal path {@link migrateGlobalSchema} has already run, so
 * this answers `true` once and never queries again. It exists for the path that bypasses
 * `getGlobalDb` entirely -- a caller-supplied `_testDb` -- where guessing wrong turns every write
 * into a swallowed exception.
 */
const _harnessColumnByDb = new WeakMap<object, boolean>()
function statsHasHarnessColumn(db: SqliteDatabase): boolean {
  const cached = _harnessColumnByDb.get(db as unknown as object)
  if (cached !== undefined) return cached
  let present: boolean
  try {
    present = (db.prepare('PRAGMA table_info(stats)').all() as { name?: string }[]).some(
      (c) => c.name === 'harness',
    )
  } catch {
    present = false
  }
  _harnessColumnByDb.set(db as unknown as object, present)
  return present
}

const _traceparentColumnByDb = new WeakMap<object, boolean>()
function statsHasTraceparentColumn(db: SqliteDatabase): boolean {
  const cached = _traceparentColumnByDb.get(db as unknown as object)
  if (cached !== undefined) return cached
  let present: boolean
  try {
    present = (db.prepare('PRAGMA table_info(stats)').all() as { name?: string }[]).some(
      (c) => c.name === 'traceparent',
    )
  } catch {
    present = false
  }
  _traceparentColumnByDb.set(db as unknown as object, present)
  return present
}

/** Same capability probe as {@link statsHasHarnessColumn}, for the `tg_version` provenance stamp. */
const _versionColumnByDb = new WeakMap<object, boolean>()
function statsHasVersionColumn(db: SqliteDatabase): boolean {
  const cached = _versionColumnByDb.get(db as unknown as object)
  if (cached !== undefined) return cached
  let present: boolean
  try {
    present = (db.prepare('PRAGMA table_info(stats)').all() as { name?: string }[]).some(
      (c) => c.name === 'tg_version',
    )
  } catch {
    present = false
  }
  _versionColumnByDb.set(db as unknown as object, present)
  return present
}

function getGlobalDb(homeDir?: string): SqliteDatabase {
  const basePath = homeDir ? dataDirForHome(homeDir) : dataDir()
  const dbPath = path.join(basePath, 'global.db')
  const db = getDb(dbPath)
  if (!_globalSchemaApplied.has(dbPath)) {
    db.exec(GLOBAL_SCHEMA_SQL)
    migrateGlobalSchema(db)
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
// Distinguishes "genuinely no stats ever recorded" from "stats exist but every one falls outside
// the requested --window-days" -- same empty-vs-filtered-store distinction already made for
// dead/types (--exclude-tests, --grep) so a caller sees a bare "no stats" as a filter artifact
// rather than a broken telemetry pipeline. Only queried once summarize() already found zero rows
// in-window, so the common (non-empty) path pays nothing extra.
function noStatsMessage(windowDays: number, homeDir?: string): string {
  if (windowDays <= 0) return 'No stats recorded yet.'
  const db = getGlobalDb(homeDir)
  const total = (db.prepare('SELECT COUNT(*) as c FROM stats').get() as { c: number }).c
  if (total === 0) return 'No stats recorded yet.'
  return `No stats in the last ${countNoun(windowDays, 'day')} (${total} recorded outside this window; use --window-days 0 for all time).`
}

export function recordStat(
  kind: string,
  bytesSaved = 0,
  tokensSaved = 0,
  _testDb?: SqliteDatabase,
  detail?: string,
  traceparent?: string,
): void {
  try {
    const db = _testDb ?? getGlobalDb()
    const ts = Math.floor(Date.now() / 1000)
    const tp = traceparent ?? process.env['TRACEPARENT'] ?? process.env['traceparent'] ?? null
    // Built from whichever optional columns this database actually has rather than one branch per
    // combination: with harness, traceparent and tg_version all optional that would be eight
    // arms, and the arm for any un-exercised combination is exactly where a silently-dropped
    // column hides. Column names here are literals, never caller input.
    const cols = ['ts', 'kind', 'bytes_saved', 'tokens_saved', 'detail']
    const vals: unknown[] = [ts, kind, bytesSaved, tokensSaved, detail ?? null]
    if (statsHasHarnessColumn(db)) {
      cols.push('harness')
      vals.push(getHarnessName())
    }
    if (statsHasTraceparentColumn(db)) {
      cols.push('traceparent')
      vals.push(tp)
    }
    if (statsHasVersionColumn(db)) {
      cols.push('tg_version')
      vals.push(VERSION)
    }
    db.prepare(
      `INSERT INTO stats (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    ).run(...vals)
  } catch {
    // Best-effort — never block the hook path.
  }
}

/** One row of the unrecognized-tool histogram, newest activity first. */
export interface UnmappedToolRow {
  harness: string
  tool_name: string
  event_name: string
  /** A tool token-goat *does* handle for this event whose name differs only by case or separators, or `null`. */
  near_miss: string | null
  hits: number
  last_seen: number
}

/** Longest tool name stored. The name comes from the harness, so it is bounded here rather than trusted. */
const MAX_TOOL_NAME_CHARS = 200

/**
 * Note that a tool name reached a hook event for which token-goat registers named handlers, and
 * matched none of them.
 *
 * This is the one detector in the codebase that does not encode a belief about a harness. Every
 * other check -- the bridge capability matrix, the hook/harness fixture matrix, even the derived
 * Copilot shape manifest -- describes what this repo thinks a harness sends. This records what
 * actually arrived. That matters most for the nine bridges nobody can dogfood: the histogram is
 * the only ground truth about their real tool vocabulary.
 *
 * Keyed rather than appended, so the table is bounded by the number of *distinct* names ever seen
 * (tens of rows) instead of growing one row per tool call.
 */
export function recordUnmappedTool(
  toolName: string,
  eventName: string,
  nearMiss: string | null,
  _testDb?: SqliteDatabase,
): void {
  try {
    if (!toolName) return
    const db = _testDb ?? getGlobalDb()
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO unmapped_tools (harness, tool_name, event_name, near_miss, first_seen, last_seen, hits)
       VALUES (?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(harness, tool_name, event_name) DO UPDATE SET
         hits = hits + 1,
         last_seen = excluded.last_seen,
         near_miss = excluded.near_miss`,
    ).run(getHarnessName(), toolName.slice(0, MAX_TOOL_NAME_CHARS), eventName, nearMiss, now, now)
  } catch {
    // Best-effort — an observation must never block or fail the hook path it observes.
  }
}

/** Read the unrecognized-tool histogram back, busiest first. Returns `[]` when the table is absent. */
export function readUnmappedTools(dbPath?: string, homeDir?: string): UnmappedToolRow[] {
  try {
    const db = dbPath ? getDb(dbPath) : getGlobalDb(homeDir)
    return db
      .prepare(
        'SELECT harness, tool_name, event_name, near_miss, hits, last_seen FROM unmapped_tools ORDER BY hits DESC, tool_name ASC',
      )
      .all() as UnmappedToolRow[]
  } catch {
    // No table yet (a database from before this release, read without going through getGlobalDb).
    return []
  }
}

export function summarize(windowDays: number = 30, testDb?: SqliteDatabase, homeDir?: string): StatsSummary {
  const t0 = Date.now()
  const sinceTs =
    windowDays > 0 ? Math.floor((Date.now() - windowDays * 24 * 60 * 60 * 1000) / 1000) : null

  const byKind: Record<string, StatsBucket> = {}
  const byDay: Record<string, StatsBucket> = {}
  const byHarness: Record<string, StatsBucket> = {}
  let totalEvents = 0
  let totalBytes = 0
  let totalTokens = 0

  const db = testDb ?? getGlobalDb(homeDir)
  // Selected only when the column is actually there: an injected `testDb` may carry a table this
  // module never migrated, and naming a missing column would throw out of summarize() entirely
  // rather than degrading to "harness not recorded".
  const hasHarness = statsHasHarnessColumn(db)
  const cols = hasHarness
    ? 'ts, kind, bytes_saved, tokens_saved, harness'
    : 'ts, kind, bytes_saved, tokens_saved'
  const query =
    sinceTs !== null
      ? `SELECT ${cols} FROM stats WHERE ts >= ? ORDER BY ts DESC`
      : `SELECT ${cols} FROM stats ORDER BY ts DESC`

  const stmt = db.prepare(query)
  const rows = sinceTs !== null ? stmt.all(sinceTs) : stmt.all()

  const tsToDateCache: Record<number, string> = {}
  const counts: Record<string, number> = {}

  for (const row of rows) {
    const bytesSaved = (row as { bytes_saved?: number }).bytes_saved ?? 0
    const recorded = (row as { tokens_saved?: number }).tokens_saved ?? 0
    const kind = (row as { kind: string }).kind
    // A count-only kind contributes its number to `counts` and zero tokens to everything else, so no
    // aggregate below has to remember to exclude it. See COUNT_ONLY_KINDS for why.
    const isCount = COUNT_ONLY_KINDS.has(kind)
    if (isCount) counts[kind] = (counts[kind] ?? 0) + recorded
    const tokensSaved = isCount ? 0 : recorded
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

    // A NULL harness is a row written before the column existed. It is bucketed as unrecorded
    // rather than dropped (which would make the per-harness events undercount the total) or
    // attributed to the current harness (which would invent a measurement that was never taken).
    const harness = (row as { harness?: string | null }).harness || HARNESS_UNRECORDED
    if (!byHarness[harness]) {
      byHarness[harness] = zeroBucket()
    }
    incBucket(byHarness[harness], bytesSaved, tokensSaved)
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
    by_harness: byHarness,
    counts,
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
    // Printed on its own line, below the token total and never inside it, because it counts
    // placeholders rather than tokens. Omitted entirely when nothing was redacted, so the line is
    // information rather than a permanent zero. See COUNT_ONLY_KINDS.
    ...(summary.counts['secret_redacted']
      ? [`Secrets hidden: ${summary.counts['secret_redacted']} (a count, not tokens)`]
      : []),
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
export function _useRichStats(): boolean {
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

  // Only worth printing once there is something to compare. A single-harness install would just
  // read "claudecode: 100% of the total already printed above", and a lone `unrecorded` bucket
  // says only that these rows predate the column -- neither is information.
  const harnesses = Object.entries(summary.by_harness)
    .filter(([, b]) => b.events > 0)
    .sort((a, b) => b[1].tokens_saved - a[1].tokens_saved)
  if (harnesses.length > 1) {
    lines.push('', '## By Harness')
    for (const [harness, bucket] of harnesses) {
      lines.push(
        `  ${harness.padEnd(22)} ${bucket.events.toString().padStart(6)} events  ${fmtBytes(bucket.bytes_saved).padStart(8)}  ${bucket.tokens_saved.toString().padStart(8)} tokens`,
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
/** Test seam for the builder: exported so a test can pin summarize -> build -> render as one chain. */
export const _buildStatsDataForTest = (summary: StatsSummary, windowDays: number): StatsData =>
  _buildStatsData(summary, windowDays)

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
    window_label: windowDays > 0 ? `last ${countNoun(windowDays, 'day')}` : 'all time',
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
    by_harness: Object.entries(summary.by_harness)
      .filter(([, b]) => b.events > 0)
      .map(([harness, bucket]) => ({
        harness,
        bytes: bucket.bytes_saved,
        tokens: bucket.tokens_saved,
        events: bucket.events,
      }))
      .sort((a, b) => b.bytes - a.bytes),
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
    console.log(noStatsMessage(windowDays, opts?.homeDir))
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
    console.log(noStatsMessage(windowDays, opts?.homeDir))
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

// True when `kind` resolves to a source through an explicit KIND_TO_SOURCE entry, the `_overhead` suffix rule, or a KIND_PREFIX_TO_SOURCE prefix. kindToSource() falls back to SOURCE_OTHER for anything unregistered, so an unregistered kind is silently misfiled rather than rejected; this predicate is what lets a guard tell "deliberately filed under other" apart from "nobody registered it".
export function isRegisteredKind(kind: string): boolean {
  if (KIND_TO_SOURCE[kind] !== undefined) return true
  if (kind.endsWith(OVERHEAD_SUFFIX) && KIND_TO_SOURCE[kind.slice(0, -OVERHEAD_SUFFIX.length)] !== undefined) return true
  return KIND_PREFIX_TO_SOURCE.some(([prefix]) => kind.startsWith(prefix))
}

/** Every explicitly registered kind name, in declaration order. Exported for the reverse registration guard: isRegisteredKind() answers "is this recorded kind known", which cannot detect the mirror failure of a registered name that no producer ever records. */
export function _registeredKinds(): string[] {
  return Object.keys(KIND_TO_SOURCE)
}

/** Every registered kind prefix, in declaration order. Companion to {@link _registeredKinds} for the reverse registration guard. */
export function _registeredKindPrefixes(): string[] {
  return KIND_PREFIX_TO_SOURCE.map(([prefix]) => prefix)
}
