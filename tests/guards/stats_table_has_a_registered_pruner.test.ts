import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * S2 (gap_analysis_pass3.md section 4, finding 7): the `stats` table was never pruned (411,208
 * rows, ~54MB with indexes, measured growing forever on one real machine). The fix is
 * aggregation-before-deletion: `rollupAndPruneStats` rolls surviving rows into
 * `stats_daily_rollup` (day + kind + harness + tg_version, the same dimensions `summarize()`
 * already reports by) before deleting them, so `token-goat stats`'s historical totals survive the
 * prune instead of silently truncating to whatever raw rows happen to remain.
 *
 * This is static-analysis only (source text of stats.ts, no DB, no real timers) so it stays on
 * the fast pre-commit tier (tests/guards). It would not catch a rollup that aggregates the wrong
 * numbers -- that needs the real DB-backed regression tests in tests/stats.test.ts -- but it does
 * catch the three ways this specific defect (or its shape) could silently come back: an
 * unbounded-growth table gaining no pruner at all, a pruner that stops being wired into the
 * write path, or a rollup that deletes history `summarize()` never learns to read back.
 */

const STATS_SRC = readFileSync(new URL('../../src/stats.ts', import.meta.url), 'utf-8')

/**
 * Slice out just one top-level function's body, from `marker` (its declaration text, e.g.
 * `'function summarize'`) up to (but not including) the next top-level function declaration.
 * An unbounded `src.slice(start)` would let a match anywhere LATER in the file -- including
 * inside a completely unrelated function -- satisfy an assertion meant to be about this one
 * function's own body.
 */
function functionBody(src: string, marker: string): string {
  const start = src.indexOf(marker)
  if (start === -1) throw new Error(`marker not found: ${marker}`)
  const rest = src.slice(start + marker.length)
  const nextFnOffset = rest.search(/\n(export )?function /)
  return nextFnOffset === -1 ? rest : rest.slice(0, nextFnOffset)
}

describe('the stats table has a registered, wired-in, read-back-complete pruner (S2)', () => {
  it('finds the rollup/prune function, its throttle wrapper, and recordStat at all, so an empty scan cannot pass vacuously', () => {
    expect(STATS_SRC).toMatch(/export function rollupAndPruneStats/)
    expect(STATS_SRC).toMatch(/function maybeRunStatsMaintenance/)
    expect(STATS_SRC).toMatch(/export function recordStat/)
  })

  it('rollupAndPruneStats both INSERTs into stats_daily_rollup and DELETEs from stats, bounded by the same cutoff -- aggregation before deletion, not deletion alone', () => {
    const body = functionBody(STATS_SRC, 'function rollupAndPruneStats')
    expect(body, 'rollupAndPruneStats must aggregate into stats_daily_rollup before deleting -- a bare DELETE would silently truncate token-goat stats history').toMatch(
      /INSERT INTO stats_daily_rollup/,
    )
    expect(body, 'rollupAndPruneStats must actually delete the rows it just rolled up, or the stats table keeps growing unbounded exactly as before this fix').toMatch(
      /DELETE FROM stats\b/,
    )
  })

  it('recordStat calls the throttled maintenance wrapper, so the prune is actually reachable from the live write path, not just defined and never invoked', () => {
    const body = functionBody(STATS_SRC, 'export function recordStat')
    expect(body, 'recordStat must call maybeRunStatsMaintenance -- a pruner that exists but is never called from the write path is the same defect as no pruner at all').toMatch(
      /maybeRunStatsMaintenance\(/,
    )
  })

  it('the read paths that report totals (summarize, the "recorded outside window" message) both fold in stats_daily_rollup, so pruned history stays visible instead of silently vanishing from token-goat stats', () => {
    const summarizeBody = functionBody(STATS_SRC, 'function summarize')
    expect(summarizeBody, 'summarize() must read from stats_daily_rollup, or every row rollupAndPruneStats aggregated-and-deleted vanishes from reported totals').toMatch(
      /stats_daily_rollup/,
    )

    const noStatsBody = functionBody(STATS_SRC, 'function noStatsMessage')
    expect(
      noStatsBody,
      'noStatsMessage() must also count stats_daily_rollup rows, or a pruned-but-real history reports as "no stats recorded"',
    ).toMatch(/stats_daily_rollup/)
  })
})
