/**
 * CLI handler for `token-goat hint-stats`.
 *
 * Presentation only — efficacy tracking, suppression, and the manual-mark ledger all live in
 * hint_stats.ts; see that module's doc comment for what is measured automatically vs.
 * approximated per category, and why "harness" stands in for "model" here.
 */

import { getHintStatsSummary, getHintStatsTotals, resetHintStats, markCategoryEffective, markCategoryIneffective, isSuppressionCategory, type CategoryEfficacy, type HintCategory, type HintStatsTotals } from './hint_stats.js'
import { pad } from './util.js'
import { displaySafeJson } from './paths.js'

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

/**
 * Renders the suppressed cell so the two opposite meanings of "suppressed" are distinguishable.
 * With probe occasions configured, a suppressed category still emits on those occasions and can
 * earn its way back, so it is throttled. With `hints.backoff_thresholds = []` it never emits
 * again until someone runs `hint-stats --reset`, so it is off. Both used to print a bare 'yes',
 * which is how a reader of this table concluded the suppression path was broken when it was in
 * fact a supported setting doing exactly what it says.
 */
function suppressedCell(row: CategoryEfficacy): string {
  if (!row.suppressed) return 'no'
  return row.suppressionPermanent ? 'yes (permanent)' : 'yes'
}

/**
 * Renders a category's efficacy cell, marked when the number behind it is scored on an absence.
 *
 * A suppression category asks the agent NOT to do something, so its window expiring counts as compliance and books `acted_on = 1`; a redirect category asks the agent to run a specific command, and only that command counts. The two percentages therefore sit on incomparable scales, and printing them in one column with nothing to tell them apart invites the reading that a 99% suppression row is sixty times better than a 2% redirect row. That reading has been made off this table, and went into a brief before anyone caught it, so the marker is not decorative.
 */
function efficacyCell(row: CategoryEfficacy): string {
  const pct = row.efficacyPct === null ? 'n/a' : `${row.efficacyPct}%`
  return isSuppressionCategory(row.category) ? `${pct} *` : pct
}

/**
 * Renders a category's emitted cell, marked when some of what it emitted is not in that count.
 *
 * `emitted` counts the rows efficacy was actually scored on. A hint that carried no correlator names nothing a later command could match, so it is excluded from both sides of the percentage rather than given an invented verdict -- but it was still emitted, and it still spent its bytes. Without a marker the two populations are indistinguishable: `bash_redirect` reads as 524 emissions when 698 were really pushed at the agent, and a reader sizing the category off this column undercounts it by a quarter.
 */
function emittedCell(row: CategoryEfficacy): string {
  return row.unobservable > 0 ? `${row.emitted} ~${row.unobservable}` : String(row.emitted)
}

/**
 * Renders how often a category's trigger fired, against how often the agent was actually told.
 *
 * A suppressed category emits nothing, so every other column on its row freezes and stays frozen. That leaves the two questions a reader has -- has the trigger stopped firing, or is it firing constantly into a mute -- answered identically, and they call for opposite actions. This column counts the zero-byte rows written for detections that never reached the agent: a large figure says the trigger is alive and the mute is doing the work, a 0 says it has gone quiet on its own. Rendered as `-` rather than `0` when there are none, so a column of zeros does not read as a measured absence on the categories that have no gate to decline at.
 */
function detectedCell(row: CategoryEfficacy): string {
  return row.detected === 0 ? '-' : String(row.detected)
}

function printSummary(rows: readonly CategoryEfficacy[]): void {
  const w = (text: string) => {
    process.stdout.write(text)
  }
  w(pad('category', 22) + pad('emitted', 9) + pad('undisplayed', 13) + pad('acted-on', 10) + pad('efficacy', 12) + pad('suppressed', 17) + pad('manual+', 9) + pad('manual-', 9) + 'spent-bytes\n')
  for (const row of rows) {
    w(
      pad(row.category, 22) +
        pad(emittedCell(row), 9) +
        pad(detectedCell(row), 13) +
        pad(String(row.actedOn), 10) +
        pad(efficacyCell(row), 12) +
        pad(suppressedCell(row), 17) +
        pad(String(row.manualEffective), 9) +
        pad(String(row.manualIneffective), 9) +
        formatSpentCell(row) +
        '\n',
    )
  }
}

/**
 * Prints the all-time saved/spent summary line. Both figures are byte counts, and the column names say so: the schema calls the underlying field `bytes_emitted` and the docs have always described it as bytes, but the printed line said only `spent=5490`, which a reader sitting next to token figures elsewhere in the same tool reads as tokens. A number whose unit is only recoverable from the schema is a number that will be misread.
 *
 * `saved` reuses the pre-existing `stats` ledger
 * (unaffected by this feature) and spans every hint kind; `spent` sums only the much smaller
 * hint_emissions ledger and renders 'n/a', never a fake 0, when nothing has been tracked yet or
 * the store is entirely pre-migration legacy rows. The two figures cover disjoint populations and
 * are deliberately never netted against each other -- see hint_stats.ts's getHintStatsTotals doc
 * comment for the regression this guards against.
 */
function printTotals(totals: HintStatsTotals): void {
  const spent = totals.spentBytes === null ? 'n/a' : String(totals.spentBytes)
  const legacyNote = totals.legacyEmissions > 0 ? ` (excludes ${totals.legacyEmissions} legacy emission(s) recorded before spend tracking)` : ''
  // saved and spent are deliberately NOT netted against each other: saved is an all-time total
  // across every hint kind stats.ts maps to SOURCE_HINT, while spent sums only the much smaller
  // hint_emissions ledger. They are disjoint populations -- see getHintStatsTotals's doc comment.
  process.stdout.write(
    `\nTOTAL   saved-bytes=${totals.savedBytes} (all-time, every hint kind)   spent-bytes=${spent} (hint_emissions ledger only)${legacyNote}\n`,
  )
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
    process.stdout.write(`${displaySafeJson(rows, 0)}\n`)
    return
  }
  // Categories are registered statically, so an untouched store still renders a full table of
  // zeros -- which reads as "these hints fire and never work" rather than "nothing recorded yet".
  // Those two conclusions call for opposite actions (retire the hints vs. go collect data), so
  // say which one it is. The table still prints underneath: the registered category list is
  // useful on its own, and dropping it would narrow existing output.
  // `unobservable` belongs in this test: a store holding only correlator-less rows has recorded
  // plenty, it just scored none of it, and calling that "absence of data" would send a reader to
  // collect more of exactly the data that is already there and still unscoreable.
  if (rows.every((r) => r.emitted === 0 && r.actedOn === 0 && r.unobservable === 0 && r.detected === 0)) {
    process.stdout.write('No hint emissions recorded yet — the zeros below are absence of data, not measured ineffectiveness.\n')
  }
  printSummary(rows)
  // The polarity split is documented in hint_stats.ts, which says it is disclosed "here and in the CLI output". It was not: the table printed both scales in one column with nothing to separate them, and a reader comparing them straight across drew the opposite of the truth.
  if (rows.some((r) => isSuppressionCategory(r.category) && r.emitted > 0)) {
    process.stdout.write(
      '\n* Scored on an absence: these hints ask the agent NOT to do something, so a window that ' +
      'expires with no re-read counts as compliance. Their percentage is not comparable with the ' +
      'unmarked rows, which only count when the agent runs the command the hint named. A high ' +
      'starred figure means "the warned-against read was not seen", not "this hint persuaded anyone".\n',
    )
  }
  // Without this, the emitted column silently shrinks: 174 of bash_redirect's 698 rows leave the
  // count and nothing says where they went, which looks like data loss rather than a scoping rule.
  // Same both-halves rule as the markers above: a note that prints whether or not the column has
  // anything in it is boilerplate, and stops being read.
  if (rows.some((r) => r.detected > 0)) {
    process.stdout.write(
      '\nundisplayed: detections that never reached the agent -- auto-suppressed, or declined by ' +
      'the hint\'s own net-benefit gate because the substitute it would have proposed was not ' +
      'smaller than the read it was redirecting. They cost nothing and are scored nowhere. A large ' +
      'figure against a small emitted count means the trigger is alive and the mute is doing the ' +
      'work; a `-` means it has gone quiet on its own.\n',
    )
  }
  if (rows.some((r) => r.unobservable > 0)) {
    process.stdout.write(
      '\n~N: N further emissions in that category carried no correlator -- no pointer a later ' +
      'command could have matched -- so no verdict about them was ever observed. They are not in ' +
      'the emitted or acted-on counts and not in the efficacy figure, which is scored only on the ' +
      'rows that could have gone either way. They ARE in the spend column: an unobservable hint ' +
      'costs the agent its bytes all the same.\n',
    )
  }
  // A permanently-suppressed category emits nothing at all, so its efficacy can never rise and
  // the table above will look identical forever. Name the one action that changes it, rather than
  // leaving a reader to trace four source files and two databases to find out -- which is what
  // happened once, and produced a wrong diagnosis on the way.
  const permanent = rows.filter((r) => r.suppressionPermanent)
  if (permanent.length > 0) {
    const names = permanent.map((r) => r.category).join(', ')
    process.stdout.write(`\nhints.backoff_thresholds is empty, so suppression here is permanent rather than a self-healing throttle: ${names} will not emit again on any occasion. Set backoff_thresholds to re-enable probe emissions, or run \`token-goat hint-stats --reset\` to clear the ledger.\n`)
  }
  printTotals(getHintStatsTotals())
}
