/**
 * Data-transfer types for the stats renderer.
 *
 * All types represent plain objects with no methods.  The rendering pipeline in
 * ``stats_renderer.ts`` consumes a ``StatsData`` object populated by caller code.
 *
 * Interfaces:
 * - ``TotalStats``: Aggregate events/bytes/tokens for a period with optional
 *   period-over-period deltas and sparkline data.
 * - ``KindStat``: Per-event-kind breakdown (e.g. Read, image_shrink).
 * - ``DayStat``: Daily activity row (date string, bytes, tokens, events).
 * - ``ProjectStat``: Per-project breakdown row.
 * - ``SourceStat``: Per-source (image/hint/read/compact/other) breakdown row.
 * - ``CommandStat``: Per-CLI-command breakdown row.
 * - ``Sparklines``: Normalised 0–1 float lists for the three KPI mini-charts.
 * - ``StatsData``: Top-level payload: totals + the breakdown lists.
 */

/**
 * Mini sparkline data: normalized 0.0–1.0 values for a small chart (8+ recent data points).
 * Each list represents the same time period (daily, weekly, etc.) for one metric type.
 */
export interface Sparklines {
  events: number[]
  bytes: number[]
  tokens: number[]
}

/**
 * Aggregate statistics for a reporting period (events, bytes, tokens, and optional deltas).
 * Deltas represent percentage change vs. the equivalent prior period (e.g., 12 means +12%).
 * Sparklines optionally provide 8+ mini-chart data points for visual trend display.
 */
export interface TotalStats {
  events: number
  bytes: number
  tokens: number
  events_delta?: number | null
  bytes_delta?: number | null
  tokens_delta?: number | null
  sparklines?: Sparklines | null
}

/**
 * Statistics for one event kind (e.g., 'Read', 'image_shrink', 'Grep').
 * If bytes_mode_only is true, tokens are not reported (render as "—") because they are
 * model-specific and not reliably measurable (used for vision-token kinds like image_shrink).
 */
export interface KindStat {
  kind: string
  bytes: number
  tokens: number
  events: number
  bytes_mode_only?: boolean
}

/**
 * Daily statistics: date string (YYYY-MM-DD), bytes processed, tokens saved, event count.
 */
export interface DayStat {
  date: string
  bytes: number
  tokens: number
  events: number
}

/**
 * Project-level statistics: name, hash (for tree display), absolute path, and metrics.
 * The hash is typically a short session or commit ID shown in the tree path line for identification.
 */
export interface ProjectStat {
  project: string
  hash: string
  path: string
  bytes: number
  tokens: number
  events: number
}

/**
 * Statistics for one user-facing source bucket (image / hint / read / compact / other).
 * Sources collapse the raw event kinds into the mechanisms token-goat ships
 * (plus an ``other`` catch-all). Renderer consumers can show "image vs hint vs
 * read vs compact" without re-walking the underlying data.
 */
export interface SourceStat {
  source: string
  bytes: number
  tokens: number
  events: number
}

/**
 * Statistics for one CLI command (symbol, read, section, semantic, outline, etc.).
 * CLI commands may record multiple underlying kinds (e.g., section_replacement +
 * section_read both map to the "section" command). This view shows which command
 * is most valuable for the user.
 */
export interface CommandStat {
  command: string
  bytes: number
  tokens: number
  events: number
}

/** One harness's share of the savings. `harness` is a HarnessName, or the pre-migration bucket. */
export interface HarnessStat {
  harness: string
  bytes: number
  tokens: number
  events: number
}

/**
 * Complete stats payload for a reporting period: totals, by-kind, by-day, and by-project breakdowns.
 * by_kind: All breakdown rows (no top-N applied); the renderer orders them by share.
 * by_day: Caller-filtered top-N rows; the renderer orders them by share.
 * by_project: Caller-filtered top-N rows; the renderer orders them by share.
 * by_source: Sorted desc by bytes; collapses raw kinds into image/hint/read/compact/other.
 * by_command: Sorted desc by bytes; breaks down savings by CLI command (symbol, read, section, etc.).
 * by_harness: Sorted desc by bytes; which harness each saving was recorded under. Populated only
 *   when more than one has been seen, because a single-harness install learns nothing from a
 *   breakdown that has one row equal to the total.
 * version: Loaded token-goat package version string (e.g. "0.6.1"); "" when unknown.
 * window_label: Human-readable window label, e.g. "last 30 days" or "all time".
 */
export interface StatsData {
  period_start: Date
  period_end: Date
  totals: TotalStats
  by_kind: KindStat[]
  by_day: DayStat[]
  by_project: ProjectStat[]
  by_source?: SourceStat[]
  by_command?: CommandStat[]
  by_harness?: HarnessStat[]
  version?: string
  window_label?: string
}
