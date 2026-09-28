/** Renders the `token-goat stats` report from a {@link StatsSummary}: the plain-text totals and breakdown printed to a pipe, and the payload the rich ANSI renderer in render/stats_renderer.ts draws on a terminal. stats.ts records the rows, keeps the table and aggregates it; this module only formats what `summarize` returns. The hooks import stats.ts to record a stat on nearly every tool call and never render a report, so the rich renderer stays off the hook entry's eager set. */

import { renderStats as richRenderStats } from './render/stats_renderer.js'
import { fmtBytes } from './render/ansi.js'
import type { StatsData } from './render/types.js'
import { PRICING_VERSION_UNRECORDED, SOURCE_HINT, hasMixedPricingEras, noStatsMessage, summarize, type StatsSummary } from './stats.js'
import { countNoun } from './util.js'
import { VERSION } from './version.js'

const _BYTES_MODE_ONLY_KINDS = new Set(['webfetch_image', 'gdrive_image'])

/** The short totals block shared by the plain-text and short-default renderers. */
/** The `Stale answers:` totals line, from the `stale_served:` kinds recordStaleServed books, or nothing when there are none in the window. */
function staleAnswersLine(summary: StatsSummary): string[] {
  const changed = summary.by_kind['stale_served:stale']?.events ?? 0
  const deleted = summary.by_kind['stale_served:deleted']?.events ?? 0
  if (changed + deleted === 0) return []
  return [`Stale answers:  ${changed + deleted} (${changed} changed on disk, ${deleted} deleted)`]
}

function _totalsLines(summary: StatsSummary): string[] {
  return [
    '# token-goat stats',
    `Total events:   ${summary.total_events}`,
    `Bytes saved:    ${fmtBytes(summary.total_bytes_saved)}`,
    `Tokens saved:   ${summary.total_tokens_saved}`,
    // Disclosure, not a correction: `total_tokens_saved` above sums rows written under whichever pricing formula was live when each was recorded, and `tg_version` cannot be read back into "which formula" for a row from before this disclosure existed (PRICING_VERSION_UNRECORDED is the overwhelming majority of all-time rows). Excluding those rows from the headline would discard nearly the whole figure rather than fix it, so the honest move is to keep the sum and say plainly that it spans more than one era, not to quietly present a mixed total as single-formula.
    ...(hasMixedPricingEras(summary)
      ? [
          `Pricing note:   totals mix ${countNoun(Object.keys(summary.by_pricing_version).length, 'tg_version era')} ` +
            `(${countNoun(summary.by_pricing_version[PRICING_VERSION_UNRECORDED]?.events ?? 0, 'row')} unrecorded); ` +
            `see 'token-goat stats --json' -> by_pricing_version for the breakdown`,
        ]
      : []),
    // Printed on its own line, below the token total and never inside it, because it counts placeholders rather than tokens. Omitted entirely when nothing was redacted, so the line is information rather than a permanent zero. See COUNT_ONLY_KINDS.
    ...(summary.counts['secret_redacted']
      ? [`Secrets hidden: ${summary.counts['secret_redacted']} (a count, not tokens)`]
      : []),
    // Omitted when nothing was served stale, like the line above. Counts answers, not tokens, so it stays out of the totals.
    ...staleAnswersLine(summary),
    `Window:         ${summary.window_days} days`,
  ]
}

/** Whether stats output should use the rich, ANSI-colored renderer. `isTTY === true` is an explicit, unambiguous terminal -- always rich. `isTTY` is `undefined` for every non-TTY stdout (a pipe, a redirected file, or an agent harness reading the child's stdout, not just a real terminal -- Node leaves the property unset on any stream that isn't a TTY), so treating `undefined` as rich sent 80KB of ANSI box-table output through `token-goat stats --full | ...` and overflowed a harness's output cap; only an explicit `FORCE_COLOR` (set and not `'0'`) can opt a non-TTY stream into rich output. */
export function _useRichStats(): boolean {
  if (process.env['NO_COLOR']) return false
  if (process.stdout.isTTY === true) return true
  const forceColor = process.env['FORCE_COLOR']
  return forceColor !== undefined && forceColor !== '0'
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

  // Only worth printing once there is something to compare. A single-harness install would just read "claudecode: 100% of the total already printed above", and a lone `unrecorded` bucket says only that these rows predate the column -- neither is information.
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
    // Hints fired but no direct command was ever invoked -- surface this as a gap instead of letting the section vanish silently (see CHANGELOG).
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

/** Bare ``token-goat stats`` default: totals + hints only, no by-source/ by-command/by-day breakdown. On a TTY this uses the same rich header + KPI section as ``--full`` (just without the detail sections); on a pipe it stays flat plain text. */
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
