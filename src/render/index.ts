/**
 * Stats renderer package — ANSI truecolor terminal output.
 *
 * Exports:
 * - ``renderList``, ``renderPanel``, ``renderStats``, ``renderTable`` — Common rendering helpers.
 * - Type definitions from ``types.ts`` — ``StatsData`` and related interfaces.
 */

export { renderList, renderPanel, renderTable } from './common.js'
export { renderStats, setStatsMessages } from './stats_renderer.js'
export * from './types.js'
export { C, RESET, USE_COLOR, fg, stripAnsi, vlen } from './ansi.js'
