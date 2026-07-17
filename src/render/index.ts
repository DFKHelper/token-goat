/**
 * Stats renderer package — ANSI truecolor terminal output.
 *
 * Exports:
 * - ``renderStats`` — Stats panel renderer.
 * - Type definitions from ``types.ts`` — ``StatsData`` and related interfaces.
 */

export { renderStats, setStatsMessages } from './stats_renderer.js'
export * from './types.js'
export { C, RESET, fg, stripAnsi, vlen } from './ansi.js'
