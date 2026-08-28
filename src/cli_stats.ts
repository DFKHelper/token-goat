/**
 * CLI handler for ``token-goat stats``.
 *
 * Thin layer over the aggregation logic in ``stats.ts``.  Adds:
 * - ``writeRaw`` — bypass any buffering and write directly to stdout
 * - ``renderTopSessionFiles`` — pull the in-memory session read-counts and
 *   format the top-N most-read files as a brief nudge
 * - ``runStats`` — the CLI entry-point wiring flags to the stats module
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { summarize, renderStats, renderShortStats, type StatsSummary } from './stats.js'
import { dataDir } from './constants.js'
import { getSessionFiles } from './session.js'
import { ensureNewline } from './util.js'
import { colorStdout, stripAnsi } from './render/ansi.js'

// ---- helpers ----------------------------------------------------------------

/** Write ``text`` directly to stdout (no colorama buffering layer needed in TS). */
export function writeRaw(text: string): void {
  const payload = colorStdout() ? text : stripAnsi(text)
  process.stdout.write(ensureNewline(payload))
}

/** Filter to entries read more than once, sort by count descending, and take the top N.
 * Shared by {@link renderTopSessionFiles} and {@link renderTopSessionFilesFromDisk}, which
 * each do their own source-specific extraction into {path, count} pairs before ranking. */
function rankByReadCount(entries: Array<{ path: string; count: number }>, topN: number): Array<{ path: string; count: number }> {
  return entries
    .filter((e) => e.count > 1)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}

/** Format ranked (path, count) entries as the "Top files this session:" block, or "" if empty. */
function formatTopFiles(ranked: Array<{ path: string; count: number }>): string {
  if (ranked.length === 0) return ''
  const lines = ['Top files this session:']
  for (const { path: filePath, count } of ranked) {
    const basename = path.basename(filePath)
    lines.push(`  ${count.toString().padStart(3)}x  ${basename}  (${filePath})`)
  }
  return lines.join('\n')
}

/**
 * Return a plain-text summary of the top N most-read files in the current
 * session.  Uses the in-memory session state (``getSessionFiles``).
 *
 * Returns an empty string when no file has been read more than once — single-
 * access sessions produce no actionable nudge.  Fail-soft: errors return "".
 */
export function renderTopSessionFiles(topN: number = 5): string {
  try {
    const sessionFiles = getSessionFiles()
    if (sessionFiles.size === 0) return ''

    const entries = [...sessionFiles.values()].map((e) => ({ path: e.path, count: e.readCount }))
    return formatTopFiles(rankByReadCount(entries, topN))
  } catch {
    return ''
  }
}

/**
 * Return the top-N most-read files from the most recently modified session
 * JSON on disk (used when the in-process session state is empty, e.g. when
 * ``stats`` is invoked as a standalone command).
 */
export function renderTopSessionFilesFromDisk(topN: number = 5, overrideSessionsDir?: string): string {
  try {
    const sessionsDir = overrideSessionsDir ?? path.join(dataDir(), 'sessions')
    if (!fs.existsSync(sessionsDir)) return ''

    const files = fs
      .readdirSync(sessionsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ name: f, mtime: fs.statSync(path.join(sessionsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 3)

    for (const { name } of files) {
      try {
        const raw = fs.readFileSync(path.join(sessionsDir, name), 'utf-8')
        const data = JSON.parse(raw) as Record<string, unknown>
        const filesList = data['files']
        if (!Array.isArray(filesList)) continue

        const entries = (filesList as Array<Record<string, unknown>>)
          .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
          .filter((f) => typeof f['readCount'] === 'number')
          .map((f) => ({ path: String(f['path'] ?? ''), count: Number(f['readCount']) }))

        const rendered = formatTopFiles(rankByReadCount(entries, topN))
        if (rendered === '') continue
        return rendered
      } catch {
        continue
      }
    }
    return ''
  } catch {
    return ''
  }
}

// ---- public entry point -----------------------------------------------------

export interface StatsOptions {
  /** Days to include (0 = all time). */
  windowDays?: number
  /** Emit JSON instead of human-readable output. */
  json?: boolean
  /** Home directory (injectable for tests). */
  homeDir?: string
  /** Show the full breakdown (by source/command/day) instead of just totals. */
  full?: boolean
  /**
   * Force the rich short KPI view even when stdout isn't a TTY (e.g. piped). Without this, a
   * non-interactive caller (every AI agent invocation) silently falls back to the flat
   * plain-text totals dump with no way to opt into the richer view.
   */
  short?: boolean
  /** Explain how local savings estimates are calculated. */
  methodology?: boolean
}

const METHODOLOGY = {
  estimate_scope: 'Local estimate of content avoided or reduced by token-goat.',
  billing: 'They are not GitHub Copilot usage, provider-reported token consumption, or billing data.',
  byte_derived_formula: 'Most read, hook, and command entries go through savedTokensFromBytes in src/stats.ts, which is Math.round(bytes_saved / 4).',
  filter_estimates: 'Output compressors record their filter-calculated delta; image entries use the byte-derived approximation unless the source provides a narrower estimate.',
  advisory_events: 'Zero-byte, zero-token advisory events show that guidance fired, not that an agent followed it.',
  audit: 'Use stats --full or stats --json for source and command breakdowns; reconcile billing with provider-exported usage data.',
} as const

function renderMethodology(json = false): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ methodology: METHODOLOGY })}\n`)
    return
  }

  process.stdout.write([
    '# token-goat savings methodology',
    '',
    `\`tokens saved\` is a ${METHODOLOGY.estimate_scope.toLowerCase()} ${METHODOLOGY.billing}`,
    '',
    `- ${METHODOLOGY.byte_derived_formula}`,
    `- ${METHODOLOGY.filter_estimates}`,
    `- ${METHODOLOGY.advisory_events}`,
    `- ${METHODOLOGY.audit}`,
    '',
  ].join('\n'))
}

/** Run the ``token-goat stats`` command. */

/**
 * The object `stats --json` prints.
 *
 * Spelled out field by field rather than emitting the summary directly, because the JSON shape is a
 * published surface that `src/vscode_savings.ts` and any script a user has written both parse: a
 * field renamed inside StatsSummary must not silently rename itself on the wire. The cost of that
 * choice is that this is a whitelist, so a new summary field ships dead here unless it is added --
 * which is exactly what happened to `counts`, caught only by running the built binary rather than by
 * any of the 11,000 tests. The guard in tests/stats_json_payload_covers_summary.test.ts now fails on
 * the next omission instead.
 */
export function statsJsonPayload(summary: StatsSummary): Record<string, unknown> {
  return {
    total_events: summary.total_events,
    total_bytes_saved: summary.total_bytes_saved,
    total_tokens_saved: summary.total_tokens_saved,
    by_kind: summary.by_kind,
    by_day: summary.by_day,
    by_project: summary.by_project,
    by_command: summary.by_command,
    by_source: summary.by_source,
    by_harness: summary.by_harness,
    counts: summary.counts,
    window_days: summary.window_days,
  }
}

export function runStats(opts: StatsOptions = {}): void {
  if (opts.methodology === true) {
    renderMethodology(opts.json === true)
    return
  }
  const window = opts.windowDays ?? 30
  const summary = summarize(window, undefined, opts.homeDir)

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(statsJsonPayload(summary)) + '\n')
    return
  }

  const renderOpts: Parameters<typeof renderStats>[0] = { windowDays: window }
  if (opts.homeDir !== undefined) {
    renderOpts.homeDir = opts.homeDir
  }
  // `--short` always wins: it exists specifically to force the short KPI view regardless of
  // `--full` or TTY status. Otherwise bare `stats` shows totals only; `--full` gates the
  // existing rich/plain breakdown.
  if (opts.short === true) {
    renderShortStats({ ...renderOpts, force: true })
  } else if (opts.full === true) {
    renderStats(renderOpts)
  } else {
    renderShortStats(renderOpts)
  }

  const topFilesText = renderTopSessionFiles(5) || renderTopSessionFilesFromDisk(5)
  if (topFilesText) {
    writeRaw(topFilesText)
  }
}
