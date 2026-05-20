/**
 * Data types consumed by the stats renderer.
 * Populate these from your database query layer and pass to renderStats().
 */

export interface StatsData {
  period: { start: Date; end: Date }
  totals: TotalStats
  /** Sorted desc by bytes. Pass all rows — renderer applies no top-N limit here. */
  byKind: KindStat[]
  /** Sorted desc by bytes. Caller decides top-N before passing in. */
  byDay: DayStat[]
  /** Sorted desc by bytes. Caller decides top-N before passing in. */
  byProject: ProjectStat[]
  /** Loaded token-goat package version (e.g. "0.6.1"); omit to hide the version suffix. */
  version?: string
}

export interface TotalStats {
  events: number
  bytes: number
  tokens: number
  /** % change vs the equivalent prior period, e.g. 12 means +12%. Omit if not available. */
  eventsDelta?: number
  bytesDelta?: number
  tokensDelta?: number
  /**
   * Optional: 8+ recent data points for the mini sparklines under each KPI.
   * If omitted the sparkline row is skipped.
   */
  sparklines?: {
    events: number[]
    bytes: number[]
    tokens: number[]
  }
}

export interface KindStat {
  kind: string
  bytes: number
  tokens: number
  events: number
  /**
   * Set to true for kinds like image_shrink where bytes are tracked but
   * vision token counts are model-specific and not reliably measurable.
   * Renders the tokens column as "—" instead of a number.
   */
  bytesModeOnly?: boolean
}

export interface DayStat {
  date: string  // YYYY-MM-DD
  bytes: number
  tokens: number
  events: number
}

export interface ProjectStat {
  project: string
  /** Short session/commit id displayed in the tree path line. */
  hash: string
  path: string
  bytes: number
  tokens: number
  events: number
}
