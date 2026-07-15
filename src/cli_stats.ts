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
import { summarize, renderStats, renderShortStats } from './stats.js'
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

    const ranked = [...sessionFiles.values()]
      .filter((e) => e.readCount > 1)
      .sort((a, b) => b.readCount - a.readCount)
      .slice(0, topN)

    if (ranked.length === 0) return ''

    const lines = ['Top files this session:']
    for (const entry of ranked) {
      const basename = path.basename(entry.path)
      lines.push(`  ${entry.readCount.toString().padStart(3)}x  ${basename}  (${entry.path})`)
    }
    return lines.join('\n')
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

        const ranked = (filesList as Array<Record<string, unknown>>)
          .filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null)
          .filter((f) => typeof f['readCount'] === 'number' && f['readCount'] > 1)
          .map((f) => ({ path: String(f['path'] ?? ''), count: Number(f['readCount'] ?? 0) }))
          .sort((a, b) => b.count - a.count)
          .slice(0, topN)

        if (ranked.length === 0) continue

        const lines = ['Top files this session:']
        for (const { path: filePath, count } of ranked) {
          const basename = path.basename(filePath)
          lines.push(`  ${count.toString().padStart(3)}x  ${basename}  (${filePath})`)
        }
        return lines.join('\n')
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
}

/** Run the ``token-goat stats`` command. */
export function runStats(opts: StatsOptions = {}): void {
  const window = opts.windowDays ?? 30
  const summary = summarize(window, undefined, opts.homeDir)

  if (opts.json === true) {
    const out = {
      total_events: summary.total_events,
      total_bytes_saved: summary.total_bytes_saved,
      total_tokens_saved: summary.total_tokens_saved,
      by_kind: summary.by_kind,
      by_day: summary.by_day,
      by_project: summary.by_project,
      by_command: summary.by_command,
      by_source: summary.by_source,
      window_days: summary.window_days,
    }
    process.stdout.write(JSON.stringify(out) + '\n')
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
