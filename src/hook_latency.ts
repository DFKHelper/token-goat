/**
 * Read/render side of Batch S's hook wall-clock timing: `token-goat stats --hooks` and `doctor`'s
 * Hook latency check both go through hookLatencyBreakdown().
 *
 * Kept out of stats.ts on purpose. relay.ts's relayInProcess imports recordStat from stats.ts on
 * every hook invocation, which the hook entry bundle's regression-ceiling guard
 * (tests/guards/dist_chunks_deduped.test.ts) therefore loads eagerly for every hook call. This
 * module is CLI/doctor-only -- nothing on the hook path calls it -- so a separate chunk keeps it
 * out of that eager set instead of riding along with stats.ts just because it happens to read the
 * same table.
 */

import type { SqliteDatabase } from './sqlite_driver.js'
import { getGlobalDb, statsHasDurationColumn, statsHasHarnessColumn, HOOK_STATS_RETENTION_DAYS } from './stats.js'

/** Nearest-rank percentile of an ascending-sorted array. 0 for an empty array. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[idx]!
}

/** `Ns`/`Nm`/`Nh`/`Nd ago` for a duration in seconds, coarsest unit that keeps the number readable. */
function formatAgeSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

/** One (event, harness) pair's latency summary over the rows stats.ts's pruneHookStats has not yet aged out. */
export interface HookLatencyRow {
  event: string
  harness: string
  count: number
  median_ms: number
  p95_ms: number
  max_ms: number
  newest_ts: number
}

/**
 * Per-(event, harness) hook latency breakdown: how many invocations, the median/p95/slowest
 * duration, and how recently one was recorded -- the "how many, median, p95, slowest, how
 * recent" surface Batch S asks for. Reads raw `stats` rows directly rather than through
 * summarize()'s byte/token aggregation, since `duration_ms` is a distribution summarize() has no
 * notion of. Bounded by stats.ts's pruneHookStats retention window, so this never scans more than
 * a few days of hook traffic regardless of how long the install has run. Sorted worst-p95-first
 * so a bad tail is the first thing a reader sees. Returns `[]` on any error (including a database
 * that predates the `duration_ms` column), never throws -- this is a diagnostic view, not a path
 * anything else depends on.
 */
export function hookLatencyBreakdown(testDb?: SqliteDatabase, homeDir?: string): HookLatencyRow[] {
  try {
    const db = testDb ?? getGlobalDb(homeDir)
    if (!statsHasDurationColumn(db)) return []
    const harnessExpr = statsHasHarnessColumn(db) ? "COALESCE(harness, '')" : "''"
    const rows = db
      .prepare(
        `SELECT kind, ${harnessExpr} AS harness, duration_ms, ts FROM stats
         WHERE kind LIKE 'hook:%' AND duration_ms IS NOT NULL ORDER BY ts DESC`,
      )
      .all() as Array<{ kind: string; harness: string; duration_ms: number; ts: number }>
    const grouped = new Map<string, { event: string; harness: string; durations: number[]; newest_ts: number }>()
    for (const row of rows) {
      const event = row.kind.slice('hook:'.length)
      const key = `${event}::${row.harness}`
      let g = grouped.get(key)
      if (g === undefined) {
        g = { event, harness: row.harness, durations: [], newest_ts: row.ts }
        grouped.set(key, g)
      }
      g.durations.push(row.duration_ms)
      if (row.ts > g.newest_ts) g.newest_ts = row.ts
    }
    return [...grouped.values()]
      .map((g) => {
        const sorted = [...g.durations].sort((a, b) => a - b)
        return {
          event: g.event,
          harness: g.harness,
          count: sorted.length,
          median_ms: percentile(sorted, 50),
          p95_ms: percentile(sorted, 95),
          max_ms: sorted[sorted.length - 1]!,
          newest_ts: g.newest_ts,
        }
      })
      .sort((a, b) => b.p95_ms - a.p95_ms)
  } catch {
    return []
  }
}

/**
 * Plain-text hook latency breakdown for `token-goat stats --hooks`, worst p95 first. Always
 * plain, with no rich/box variant to fall back from: an agent piping this must see the same text
 * a human sees at a terminal, which is the plain-output-when-not-a-TTY rule this repo's other
 * renderers gate on -- there is simply nothing to gate here.
 */
export function renderHookLatencyStats(testDb?: SqliteDatabase, homeDir?: string): void {
  const rows = hookLatencyBreakdown(testDb, homeDir)
  if (rows.length === 0) {
    console.log(`No hook latency recorded in the last ${HOOK_STATS_RETENTION_DAYS} day(s) (or this database predates the duration_ms column).`)
    return
  }
  const nowTs = Math.floor(Date.now() / 1000)
  console.log(`Hook latency, last ${HOOK_STATS_RETENTION_DAYS} day(s) (worst p95 first):`)
  for (const r of rows) {
    const age = formatAgeSeconds(Math.max(0, nowTs - r.newest_ts))
    console.log(
      `  ${r.event.padEnd(22)} ${(r.harness || 'unrecorded').padEnd(12)} n=${String(r.count).padEnd(5)} median ${String(r.median_ms).padStart(5)}ms  p95 ${String(r.p95_ms).padStart(5)}ms  max ${String(r.max_ms).padStart(6)}ms  last seen ${age}`,
    )
  }
}
