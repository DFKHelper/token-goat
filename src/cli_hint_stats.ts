/**
 * CLI handler for `token-goat hint-stats`.
 *
 * Presentation only — efficacy tracking, suppression, and the manual-mark ledger all live in
 * hint_stats.ts; see that module's doc comment for what is measured automatically vs.
 * approximated per category, and why "harness" stands in for "model" here.
 */

import { getHintStatsSummary, getHintStatsTotals, resetHintStats, markCategoryEffective, markCategoryIneffective, type CategoryEfficacy, type HintCategory, type HintStatsTotals } from './hint_stats.js'
import { pad } from './util.js'

export interface HintStatsCommandOptions {
  json?: boolean
  reset?: boolean
  markEffective?: HintCategory
  markIneffective?: HintCategory
}



/** Renders a category's spend cell honestly: 'n/a' when nothing has been recorded at all (never a fake 0), 'n/a (legacy)' when every emission predates spend tracking, and the real tracked sum -- annotated with however many legacy rows were excluded from it -- otherwise. See hint_emissions.bytes_emitted's schema comment in db.ts for why a legacy row is never counted as a zero spend. */
function formatSpentCell(row: CategoryEfficacy): string {
  if (row.emitted === 0) return 'n/a'
  if (row.bytesEmitted === null) return 'n/a (legacy)'
  return row.legacyEmissions > 0 ? `${row.bytesEmitted} (${row.legacyEmissions} legacy)` : String(row.bytesEmitted)
}

function printSummary(rows: readonly CategoryEfficacy[]): void {
  const w = (text: string) => {
    process.stdout.write(text)
  }
  w(pad('category', 22) + pad('emitted', 9) + pad('acted-on', 10) + pad('efficacy', 10) + pad('suppressed', 12) + pad('manual+', 9) + pad('manual-', 9) + 'spent\n')
  for (const row of rows) {
    const pct = row.efficacyPct === null ? 'n/a' : `${row.efficacyPct}%`
    w(
      pad(row.category, 22) +
        pad(String(row.emitted), 9) +
        pad(String(row.actedOn), 10) +
        pad(pct, 10) +
        pad(row.suppressed ? 'yes' : 'no', 12) +
        pad(String(row.manualEffective), 9) +
        pad(String(row.manualIneffective), 9) +
        formatSpentCell(row) +
        '\n',
    )
  }
}

/**
 * Prints the all-time saved/spent/net summary line -- the actual answer to "are hints
 * net-positive?" this feature exists to surface. `saved` reuses the pre-existing `stats` ledger
 * (unaffected by this feature); `spent`/`net` render 'n/a', never a fake 0, when nothing has
 * been tracked yet or the store is entirely pre-migration legacy rows (see
 * hint_stats.ts's getHintStatsTotals doc comment).
 */
function printTotals(totals: HintStatsTotals): void {
  const spent = totals.spentBytes === null ? 'n/a' : String(totals.spentBytes)
  const net = totals.netBytes === null ? 'n/a' : String(totals.netBytes)
  const legacyNote = totals.legacyEmissions > 0 ? ` (excludes ${totals.legacyEmissions} legacy emission(s) recorded before spend tracking)` : ''
  process.stdout.write(`\nTOTAL   saved=${totals.savedBytes}   spent=${spent}   net=${net}${legacyNote}\n`)
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
  // Categories are registered statically, so an untouched store still renders a full table of
  // zeros -- which reads as "these hints fire and never work" rather than "nothing recorded yet".
  // Those two conclusions call for opposite actions (retire the hints vs. go collect data), so
  // say which one it is. The table still prints underneath: the registered category list is
  // useful on its own, and dropping it would narrow existing output.
  if (rows.every((r) => r.emitted === 0 && r.actedOn === 0)) {
    process.stdout.write('No hint emissions recorded yet — the zeros below are absence of data, not measured ineffectiveness.\n')
  }
  printSummary(rows)
  printTotals(getHintStatsTotals())
}
