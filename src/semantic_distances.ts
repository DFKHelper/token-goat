/** The `semantic_queries` ledger: one text-free row per semantic query, and the `semantic --distances` report that turns those rows into something a user can tune `semantic.weak_distance` against. */

import { loadConfig } from './config.js'
import { projectHash, resolveProjectRoot } from './project.js'
import { getGlobalDb, withTelemetryWriteDb } from './stats.js'
import { countNoun } from './util.js'

/** Below this many recorded queries the percentiles are noise, so the report says so instead of suggesting a value. */
export const MIN_QUERIES_FOR_ADVICE = 20

/** Band edges, fixed rather than derived from the thresholds so the table reads the same before and after a user retunes them. */
const BAND_LOW = 0.7
const BAND_HIGH = 0.85

export interface SemanticQueryRow {
  closest_distance: number | null
}

export interface DistanceBand {
  range: string
  count: number
  pct: number
}

export interface DistanceSummary {
  total: number
  percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number } | null
  bands: DistanceBand[]
  /** Fraction of the queries that returned a match whose closest distance is above the threshold the summary was built with, or null when none returned one. */
  weakShare: number | null
}

/** Linear interpolation between closest ranks (index = p * (n - 1)) over an ascending-sorted array. */
function percentile(sorted: readonly number[], p: number): number {
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

/** Pure aggregation over recorded rows. `weakDistance` is the threshold the weak share is judged against, so it reflects the current setting rather than what each row was labelled when written. */
export function summarizeDistances(rows: readonly SemanticQueryRow[], weakDistance: number): DistanceSummary {
  const distances = rows.flatMap((r) => (r.closest_distance === null ? [] : [r.closest_distance])).sort((a, b) => a - b)
  const counts = [0, 0, 0, rows.length - distances.length]
  for (const d of distances) counts[d < BAND_LOW ? 0 : d < BAND_HIGH ? 1 : 2]!++
  const ranges = [`< ${BAND_LOW.toFixed(2)}`, `${BAND_LOW.toFixed(2)} - ${BAND_HIGH.toFixed(2)}`, `>= ${BAND_HIGH.toFixed(2)}`, 'none returned']
  const weak = distances.filter((d) => d > weakDistance).length
  return {
    total: rows.length,
    percentiles:
      distances.length === 0
        ? null
        : { p10: percentile(distances, 0.1), p25: percentile(distances, 0.25), p50: percentile(distances, 0.5), p75: percentile(distances, 0.75), p90: percentile(distances, 0.9) },
    bands: ranges.map((range, i) => ({ range, count: counts[i]!, pct: rows.length === 0 ? 0 : (counts[i]! / rows.length) * 100 })),
    weakShare: distances.length === 0 ? null : weak / distances.length,
  }
}

export function formatDistanceReport(summary: DistanceSummary, thresholds: { weakDistance: number; maxDistance: number }, scope = 'this project'): string {
  const lines = [`Recorded semantic queries (${scope}): ${countNoun(summary.total, 'query', 'queries')}`, `Current semantic.weak_distance: ${thresholds.weakDistance}   semantic.max_distance: ${thresholds.maxDistance}`]
  if (summary.total < MIN_QUERIES_FOR_ADVICE) {
    lines.push(`${summary.total === 0 ? 'None' : `Only ${summary.total}`} recorded, which is fewer than ${MIN_QUERIES_FOR_ADVICE}: too few to judge a threshold from. Run more semantic queries and check again.`)
    return lines.join('\n')
  }
  if (summary.percentiles !== null) {
    const p = summary.percentiles
    lines.push(`Closest distance: p10 ${p.p10.toFixed(3)}  p25 ${p.p25.toFixed(3)}  p50 ${p.p50.toFixed(3)}  p75 ${p.p75.toFixed(3)}  p90 ${p.p90.toFixed(3)}`)
  }
  lines.push('Band            Queries  Share')
  for (const b of summary.bands) lines.push(`${b.range.padEnd(15)} ${String(b.count).padStart(7)}  ${b.pct.toFixed(1)}%`)
  if (summary.weakShare !== null) lines.push(`Labelled weak at the current weak_distance: ${(summary.weakShare * 100).toFixed(1)}% of queries that returned a match`)
  return lines.join('\n')
}

/** Best-effort, like recordStat, and on the same short-budget connection: a failed or contended write must never fail or stall the query it describes. No query text is accepted, so none can be stored. */
export function recordSemanticQuery(row: { projectRoot: string; closestDistance: number | null; floorRejectedMin: number | null; weak: boolean }): void {
  try {
    withTelemetryWriteDb((db) => {
      db.prepare('INSERT INTO semantic_queries (ts, project_hash, closest_distance, floor_rejected_min, weak) VALUES (?, ?, ?, ?, ?)')
        .run(Math.floor(Date.now() / 1000), projectHash(row.projectRoot), row.closestDistance, row.floorRejectedMin, row.weak ? 1 : 0)
    })
  } catch {
    // Telemetry only: nothing to do with a failed write.
  }
}

/** `semantic --distances`: the report for the current project, or every project with `all`. */
export function runSemanticDistances(opts: { all?: boolean }): { text: string; code: number } {
  const { weak_distance: weakDistance, max_distance: maxDistance } = loadConfig().semantic
  const db = getGlobalDb()
  const rows = (
    opts.all === true
      ? db.prepare('SELECT closest_distance FROM semantic_queries').all()
      : db.prepare('SELECT closest_distance FROM semantic_queries WHERE project_hash = ?').all(projectHash(resolveProjectRoot({ project: process.cwd() })))
  ) as SemanticQueryRow[]
  const scope = opts.all === true ? 'all projects' : 'this project'
  return { text: formatDistanceReport(summarizeDistances(rows, weakDistance), { weakDistance, maxDistance }, scope), code: 0 }
}
