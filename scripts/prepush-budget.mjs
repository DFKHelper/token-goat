// The time budget of a pre-push suite leg, and the arithmetic that cuts a priority list to fit it. One place names every number: the budgets, the worker count assumed, the calibration of per-file timings against the real wall clock, and the cost of a file with no timing yet. Pure functions, built-in modules only. Seconds of test wall time a leg may be estimated to take. Lint and typecheck run beside the Windows leg and the WSL leg follows it only when a platform-sensitive path changed, so the two caps sum to TOTAL_BUDGET_S. The guards alone take 114.7 s on Windows and 73.3 s on WSL (measured on the 221-file guard and matrix set), 188 s together, so both caps leave room for tests beyond the guards and the matrix. Override with PREPUSH_BUDGET_S and PREPUSH_WSL_BUDGET_S.
export const LEG_BUDGET_S = { win: 330, wsl: 160 }
export const BUDGET_ENV = { win: 'PREPUSH_BUDGET_S', wsl: 'PREPUSH_WSL_BUDGET_S' }
// Whole seconds after a leg is planned at which its fill files stop starting (0 stops them at once), in place of the leg budget; the floor is never cut. For tests and for a push that must end sooner.
export const DEADLINE_ENV = 'PREPUSH_DEADLINE_S'
// The wall time the whole hook is held to, from hook start to hook exit (the owner's 10 minutes).
export const HOOK_LIMIT_S = 600
// Seconds the hook spends outside the suite legs, measured on a full run: external wall 671 s minus legs total 620 s = 51 s, rounded down to 50.
export const HOOK_OVERHEAD_S = 50
// Share of HOOK_LIMIT_S held back because the estimates err by about this much (see CALIBRATION_EVIDENCE).
export const MARGIN_SHARE = 0.1
// Seconds the legs may be estimated to take together, counted from the start of run-all-checks.sh: a leg's cap is cut again to what is left of it, and an override cannot raise it. The win and wsl caps sum to this.
export const TOTAL_BUDGET_S = HOOK_LIMIT_S - HOOK_OVERHEAD_S - HOOK_LIMIT_S * MARGIN_SHARE
// The environment variable run-all-checks.sh sets to the seconds already used when a leg is planned.
export const ELAPSED_ENV = 'PREPUSH_ELAPSED_S'
// Seconds a vitest invocation spends before its first test: the globalSetup bundle build plus worker start.
export const FIXED_OVERHEAD_S = 45
// Wall seconds per estimated second, where the estimate is the sum of per-file durations over the workers. Per-file durations are measured inside a contended parallel run and leave out the scheduling gaps between files, so the raw estimate is off by a constant; the evidence for this value is in CALIBRATION_EVIDENCE.
export const CALIBRATION = 1.4
export const CALIBRATION_EVIDENCE = 'measured 2026-10-25 on Windows 11 (4 workers, a second heavy vitest run on the host), real run-all-checks.sh: 213 files, table sum 109.6 s over 4 workers, win leg 201 s, so (201 - 45) / 109.6 = 1.42; 482 files, table sum 530 s over 4 workers, win leg 783 s, so (783 - 45) / 530 = 1.39; 379 files, table sum 362 s over 4 workers, win leg 395 s, so (395 - 45) / 362 = 0.97 (the host was lighter); the largest of the three is kept so the estimate errs towards cutting'
// Cost of an untimed file when the table is empty: the mean of the 256 timed files in durations.json on 2026-10-25 (sum 1582869 ms, mean 6183 ms, rounded up); the median (225 ms) undercut the real cost, as the doc-push run showed.
export const DEFAULT_FILE_MS = 6200
// Worker counts as tests/setup/max-workers.ts gives them on a machine below its roomy bar: 4 on Windows, 6 elsewhere, or TOKEN_GOAT_TEST_MAX_WORKERS. A roomier machine runs faster than this estimates, which only defers more to CI.
export const WORKERS = { win32: 4, other: 6 }

/** @param {Record<string, string | undefined>} env @param {string} platform @returns {number} */
export function workersFor(env, platform) {
  const n = Number.parseInt(env['TOKEN_GOAT_TEST_MAX_WORKERS'] ?? '', 10)
  if (Number.isInteger(n) && n > 0) return n
  return platform === 'win32' ? WORKERS.win32 : WORKERS.other
}

/** @param {Record<string, string | undefined>} env @returns {{seconds: number, note: string}} the seconds already used from PREPUSH_ELAPSED_S; absent is 0, and a value that is not whole seconds is 0 with that said (the per-leg caps still bound the push) */
function elapsedOf(env) {
  const raw = env[ELAPSED_ENV]
  if (raw === undefined || raw === '') return { seconds: 0, note: '' }
  if (/^[0-9]+$/.test(raw)) return { seconds: Number(raw), note: '' }
  return { seconds: 0, note: `; ${ELAPSED_ENV}=${raw} is not whole seconds, ignored` }
}

/** @param {string} leg @param {Record<string, string | undefined>} env @returns {{seconds: number, source: string}} the leg's budget: its override or default, cut to what is left of TOTAL_BUDGET_S; an override that is not a positive number is ignored and said so in source */
export function legBudget(leg, env) {
  const name = BUDGET_ENV[leg] ?? BUDGET_ENV.win
  const raw = env[name]
  let seconds = LEG_BUDGET_S[leg] ?? LEG_BUDGET_S.win
  let source = 'default'
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (/^[0-9]+$/.test(raw) && Number.isFinite(n) && n > 0) {
      seconds = n
      source = `${name}=${raw}`
    } else {
      source = `default (${name}=${raw} is not a positive number, ignored)`
    }
  }
  const used = elapsedOf(env)
  const left = Math.max(0, TOTAL_BUDGET_S - used.seconds)
  if (seconds > left) {
    source = `${source}; cut to ${left} s by the ${TOTAL_BUDGET_S} s pre-push total after ${used.seconds} s`
    seconds = left
  }
  return { seconds, source: `${source}${used.note}` }
}

/** @param {string} leg @param {Record<string, string | undefined>} env @param {number} nowMs the clock at planning time, taken from the caller so a test can fix it @returns {{atMs: number, seconds: number, source: string}} the wall-clock instant after which the leg's fill files start no more: the leg budget counted from now, so the WSL leg's share is what is really left of TOTAL_BUDGET_S (PREPUSH_ELAPSED_S is the hook's own $SECONDS) and not an estimate of the Windows leg; PREPUSH_DEADLINE_S replaces it */
export function legDeadline(leg, env, nowMs) {
  const raw = env[DEADLINE_ENV]
  if (raw !== undefined && raw !== '' && /^[0-9]+$/.test(raw)) {
    // Like the budget override, never past what is left of the pre-push total.
    const used = elapsedOf(env)
    const left = Math.max(0, TOTAL_BUDGET_S - used.seconds)
    const seconds = Math.min(Number(raw), left)
    const capped = seconds < Number(raw) ? `; cut to ${left} s by the ${TOTAL_BUDGET_S} s pre-push total after ${used.seconds} s` : ''
    return { atMs: nowMs + seconds * 1000, seconds, source: `${DEADLINE_ENV}=${raw}${capped}` }
  }
  const b = legBudget(leg, env)
  return { atMs: nowMs + b.seconds * 1000, seconds: b.seconds, source: b.source }
}

/** @param {number[]} values @returns {number | null} the arithmetic mean rounded to whole ms, or null for no values */
function meanOf(values) {
  if (values.length === 0) return null
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
}

/** @param {Record<string, number>} table test file -> ms @returns {number} the cost of an untimed file: the mean of the timed files, which is what a sum over files needs (the median is 225 ms here and far under it), or DEFAULT_FILE_MS for an empty table */
export function coldCostMs(table) {
  return meanOf(Object.values(table)) ?? DEFAULT_FILE_MS
}

/** @param {Record<string, number>} table test file -> ms @returns {(file: string) => number} a file's cost in ms: its table entry, else coldCostMs(table) */
export function costFn(table) {
  const cold = coldCostMs(table)
  return (file) => table[file] ?? cold
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
