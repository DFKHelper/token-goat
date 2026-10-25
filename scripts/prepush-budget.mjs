// The time budget of a pre-push suite leg, and the arithmetic that cuts a priority list to fit it. One place names every number: the budgets, the worker count assumed, the calibration of per-file timings against the real wall clock, and the cost of a file with no timing yet. Pure functions, built-in modules only.
import { medianMs } from './test-durations.mjs'

// Seconds of test wall time a leg may be estimated to take. Lint and typecheck run beside the Windows leg (measured 56 s and 35 s) and the WSL leg follows it only when a platform-sensitive path changed, so 600 + 300 leaves about 300 s under the 1200 s the whole push is held to for the legs' own startup, the secrets scan and the other machine users. Override with PREPUSH_BUDGET_S and PREPUSH_WSL_BUDGET_S.
export const LEG_BUDGET_S = { win: 600, wsl: 300 }
export const BUDGET_ENV = { win: 'PREPUSH_BUDGET_S', wsl: 'PREPUSH_WSL_BUDGET_S' }
// Seconds a vitest invocation spends before its first test: the globalSetup bundle build plus worker start.
export const FIXED_OVERHEAD_S = 45
// Wall seconds per estimated second, where the estimate is the sum of per-file durations over the workers. Per-file durations are measured inside a contended parallel run and leave out the scheduling gaps between files, so the raw estimate is off by a constant; the evidence for this value is in CALIBRATION_EVIDENCE.
export const CALIBRATION = 1.4
export const CALIBRATION_EVIDENCE = 'measured 2026-10-25 on Windows 11 (4 workers, a second heavy vitest run on the host), real run-all-checks.sh: 213 files, table sum 109.6 s over 4 workers, win leg 201 s, so (201 - 45) / 109.6 = 1.42; 482 files, table sum 530 s over 4 workers, win leg 783 s, so (783 - 45) / 530 = 1.39; 379 files, table sum 362 s over 4 workers, win leg 395 s, so (395 - 45) / 362 = 0.97 (the host was lighter); the largest of the three is kept so the estimate errs towards cutting'
// The cost of a file the table has never timed when the table is empty too; otherwise the table's median is used.
export const DEFAULT_FILE_MS = 3000
// Worker counts as tests/setup/max-workers.ts gives them on a machine below its roomy bar: 4 on Windows, 6 elsewhere, or TOKEN_GOAT_TEST_MAX_WORKERS. A roomier machine runs faster than this estimates, which only defers more to CI.
export const WORKERS = { win32: 4, other: 6 }

/** @param {Record<string, string | undefined>} env @param {string} platform @returns {number} */
export function workersFor(env, platform) {
  const n = Number.parseInt(env['TOKEN_GOAT_TEST_MAX_WORKERS'] ?? '', 10)
  if (Number.isInteger(n) && n > 0) return n
  return platform === 'win32' ? WORKERS.win32 : WORKERS.other
}

/** @param {string} leg @param {Record<string, string | undefined>} env @returns {{seconds: number, source: string}} the leg's budget; an override that is not a positive number is ignored and said so in source */
export function legBudget(leg, env) {
  const name = BUDGET_ENV[leg] ?? BUDGET_ENV.win
  const raw = env[name]
  if (raw === undefined || raw === '') return { seconds: LEG_BUDGET_S[leg] ?? LEG_BUDGET_S.win, source: 'default' }
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return { seconds: n, source: `${name}=${raw}` }
  return { seconds: LEG_BUDGET_S[leg] ?? LEG_BUDGET_S.win, source: `default (${name}=${raw} is not a positive number, ignored)` }
}

/** @param {Record<string, number>} table test file -> ms @returns {(file: string) => number} a file's cost in ms: its table entry, else the table's median, else DEFAULT_FILE_MS */
export function costFn(table) {
  const median = medianMs(Object.values(table)) ?? DEFAULT_FILE_MS
  return (file) => table[file] ?? median
}

/** @param {number} totalMs sum of file costs @param {number} workers @returns {number} estimated wall seconds of the work alone */
export function workSeconds(totalMs, workers) {
  return (CALIBRATION * totalMs) / 1000 / workers
}

/** @param {{ fixed: string[], ordered: string[], cost: (f: string) => number, workers: number, budgetS: number }} a fixed files are never cut; ordered is the priority list, highest first @returns {{ kept: string[], deferred: string[], estimateS: number, deferredS: number }} the longest prefix of ordered whose estimate stays within budget; the first file that would cross it and every file after it are deferred, so a lower tier never runs while a higher one is deferred */
export function fillBudget({ fixed, ordered, cost, workers, budgetS }) {
  let ms = fixed.reduce((sum, f) => sum + cost(f), 0)
  const kept = []
  let i = 0
  for (; i < ordered.length; i += 1) {
    const next = ms + cost(ordered[i])
    if (FIXED_OVERHEAD_S + workSeconds(next, workers) > budgetS) break
    ms = next
    kept.push(ordered[i])
  }
  const deferred = ordered.slice(i)
  const deferredMs = deferred.reduce((sum, f) => sum + cost(f), 0)
  return { kept, deferred, estimateS: FIXED_OVERHEAD_S + workSeconds(ms, workers), deferredS: workSeconds(deferredMs, workers) }
}
