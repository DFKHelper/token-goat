/**
 * CLI handler for `token-goat hint-stats`.
 *
 * Presentation only — efficacy tracking, suppression, and the manual-mark ledger all live in
 * hint_stats.ts; see that module's doc comment for what is measured automatically vs.
 * approximated per category, and why "harness" stands in for "model" here.
 */

import { getHintStatsSummary, resetHintStats, markCategoryEffective, markCategoryIneffective, type CategoryEfficacy, type HintCategory } from './hint_stats.js'

export interface HintStatsCommandOptions {
  json?: boolean
  reset?: boolean
  markEffective?: HintCategory
  markIneffective?: HintCategory
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function printSummary(rows: readonly CategoryEfficacy[]): void {
  const w = (text: string) => {
    process.stdout.write(text)
  }
  w(pad('category', 22) + pad('emitted', 9) + pad('acted-on', 10) + pad('efficacy', 10) + pad('suppressed', 12) + pad('manual+', 9) + 'manual-\n')
  for (const row of rows) {
    const pct = row.efficacyPct === null ? 'n/a' : `${row.efficacyPct}%`
    w(
      pad(row.category, 22) +
        pad(String(row.emitted), 9) +
        pad(String(row.actedOn), 10) +
        pad(pct, 10) +
        pad(row.suppressed ? 'yes' : 'no', 12) +
        pad(String(row.manualEffective), 9) +
        String(row.manualIneffective) +
        '\n',
    )
  }
}

/** Run the `token-goat hint-stats` command. */
export function runHintStatsCommand(opts: HintStatsCommandOptions = {}): void {
  if (opts.reset === true) {
    resetHintStats()
    process.stdout.write('hint-stats: cleared all tracked emissions and manual marks.\n')
    return
  }
  if (opts.markEffective !== undefined) {
    markCategoryEffective(opts.markEffective)
    process.stdout.write(`hint-stats: recorded a manual "effective" vote for '${opts.markEffective}'.\n`)
    return
  }
  if (opts.markIneffective !== undefined) {
    markCategoryIneffective(opts.markIneffective)
    process.stdout.write(`hint-stats: recorded a manual "ineffective" vote for '${opts.markIneffective}'.\n`)
    return
  }

  const rows = getHintStatsSummary()
  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify(rows)}\n`)
    return
  }
  printSummary(rows)
}
