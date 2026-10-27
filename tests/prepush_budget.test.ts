/** The pre-push time budget: scripts/prepush-budget.mjs does the arithmetic and scripts/prepush-select.mjs applies it to the priority list, so a wrong cut either skips a test that should run or blows the 600 s the push is held to. */
import { describe, expect, it } from 'vitest'
import { BUDGET_ENV, CALIBRATION, DEADLINE_ENV, DEFAULT_FILE_MS, ELAPSED_ENV, FIXED_OVERHEAD_S, HOOK_LIMIT_S, HOOK_OVERHEAD_S, LEG_BUDGET_S, MARGIN_SHARE, TOTAL_BUDGET_S, coldCostMs, costFn, fillBudget, legBudget, legDeadline, workersFor } from '../scripts/prepush-budget.mjs'
import { resolveMaxWorkers } from './setup/max-workers.js'
import { decideSelection } from '../scripts/prepush-select.mjs'

// Fixture provenance: every duration, budget and expected cut below is HAND-DERIVED from the arithmetic in the test (estimated seconds = FIXED_OVERHEAD_S + calibration x sum of file ms / 1000 / workers), not read off the implementation's output. The ref line is FORMAT-DERIVED from githooks(5) pre-push.
const HEAD = 'a'.repeat(40)
const PUSH = `refs/heads/feat ${HEAD} refs/heads/feat ${'b'.repeat(40)}\n`
const G1 = 'tests/guards/a.test.ts'
const G2 = 'tests/guards/b.test.ts'
const M1 = 'tests/command_matrix_e2e.1.test.ts'
const NEAR1 = 'tests/near1.test.ts'
const NEAR2 = 'tests/near2.test.ts'
const FAR1 = 'tests/far1.test.ts'
const FAR2 = 'tests/far2.test.ts'
const IMPORTERS = new Map([[FAR2, 3], [NEAR1, 1], [FAR1, 2], [NEAR2, 1]])
// Whole seconds (the budget variable takes plain digits only) the budget must allow for the never-cut files plus the given milliseconds more, with at least half a second of slack.
const budgetFor = (ms: number, workers = 1): string => String(Math.ceil(FIXED_OVERHEAD_S + (CALIBRATION * ms) / 1000 / workers + 0.5))

type Io = Parameters<typeof decideSelection>[0]
function select(over: Partial<Io> = {}, durations: Record<string, number> = {}): Extract<ReturnType<typeof decideSelection>, { full: false }> {
  const r = decideSelection({
    leg: 'win',
    headSha: HEAD,
    pushText: PUSH,
    env: {},
    changed: () => [{ status: 'M', path: 'src/a.ts' }],
    failed: () => [],
    unparsedFailure: () => false,
    exists: () => true,
    guards: () => [G1, G2],
    matrix: () => [M1],
    importers: () => IMPORTERS,
    setups: () => [],
    mergeBase: () => null,
    onRemote: () => false,
    allTests: () => [],
    readers: () => [],
    durations: () => durations,
    workers: 1,
    ...over,
  })
  if (r.full) throw new Error(`expected a focused selection, got full: ${r.why}`)
  return r
}
const TEN = { [G1]: 10_000, [G2]: 10_000, [M1]: 10_000, [NEAR1]: 10_000, [NEAR2]: 10_000, [FAR1]: 10_000, [FAR2]: 10_000 }

describe('prepush budget: priority order and the cut', () => {
  it('adds importers nearest first and defers the rest in that order', () => {
    // never cut 30 s + near1 10 s + near2 10 s fits; far1 would cross it
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(50_000) } }, TEN)
    expect(r.files).toEqual([G1, G2, M1, NEAR1, NEAR2].sort())
    expect(r.deferred).toEqual([FAR1, FAR2])
    expect(r.note).toContain(`estimated ~${Math.round(FIXED_OVERHEAD_S + CALIBRATION * 50)} s of a`)
  })

  it('within one distance the cheaper file goes first, so more files fit', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(40_000) } }, { ...TEN, [NEAR1]: 25_000 })
    expect(r.files).toContain(NEAR2)
    expect(r.files).not.toContain(NEAR1)
    expect(r.deferred).toEqual([NEAR1, FAR1, FAR2])
  })

  it('stops at the first file that crosses the budget, so a lower tier never runs while a higher one is deferred', () => {
    // near1 is too big for the room left; far1 would fit alone but sits behind it
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(45_000) } }, { ...TEN, [NEAR1]: 30_000, [NEAR2]: 30_000 })
    expect(r.files).not.toContain(FAR1)
    expect(r.deferred).toEqual([NEAR1, NEAR2, FAR1, FAR2])
  })

  it('never cuts the guards or the matrix, and defers failed files then changed tests ahead of the importers once the budget is gone', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '1' }, failed: () => ['tests/old.test.ts'], changed: () => [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'tests/new.test.ts' }] }, TEN)
    expect(r.files).toEqual([G1, G2, M1].sort())
    expect(r.deferred).toEqual(['tests/old.test.ts', 'tests/new.test.ts', NEAR1, NEAR2, FAR1, FAR2])
  })

  it('a test-only push has no matrix to keep, and its changed test fills the budget before anything else', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '1' }, changed: () => [{ status: 'M', path: 'tests/new.test.ts' }] }, TEN)
    expect(r.files).toEqual([G1, G2].sort())
    expect(r.deferred[0]).toBe('tests/new.test.ts')
    const roomy = select({ changed: () => [{ status: 'M', path: 'tests/new.test.ts' }] }, TEN)
    expect(roomy.files).toEqual(['tests/new.test.ts', G1, G2].sort())
  })

  it('a file with no timing is costed at the mean of the table, not at zero and not at the default', () => {
    // mean of the table is 10 s; NEAR1 is untimed, so it costs 10 s and the 5 s of room left cannot hold it
    const table = { [G1]: 10_000, [G2]: 10_000, [M1]: 10_000, [NEAR2]: 10_000, [FAR1]: 10_000, [FAR2]: 10_000 }
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(35_000) } }, table)
    expect(r.deferred).toContain(NEAR1)
    expect(costFn(table)(NEAR1)).toBe(10_000)
  })

  it('an untimed file costs the mean, not the median, of a skewed table', () => {
    // HAND-DERIVED: median of 225, 225, 10000 is 225 ms but the mean is 3483 ms (10450 / 3, rounded)
    expect(costFn({ 'tests/a.test.ts': 225, 'tests/b.test.ts': 225, 'tests/c.test.ts': 10_000 })('tests/x.test.ts')).toBe(3483)
    expect(coldCostMs({ 'tests/a.test.ts': 225, 'tests/b.test.ts': 225, 'tests/c.test.ts': 10_000 })).toBe(3483)
  })

  it('an empty table costs a file at the default', () => {
    expect(costFn({})('tests/x.test.ts')).toBe(DEFAULT_FILE_MS)
    expect(DEFAULT_FILE_MS).toBe(6200)
  })

  it('with no duration table the selection note says every file is costed at the default', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '600' } }, {})
    expect(r.note).toContain(`no duration table, every file costed at the default ${Math.round(DEFAULT_FILE_MS / 1000)} s`)
  })

  it('divides the work over the workers', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(50_000, 2) }, workers: 2 }, TEN)
    expect(r.files).toEqual([G1, G2, M1, NEAR1, NEAR2].sort())
    expect(r.deferred).toEqual([FAR1, FAR2])
  })
})

describe('prepush budget: the environment override', () => {
  it('PREPUSH_BUDGET_S replaces the default and the note names it', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '480' } }, TEN)
    expect(r.deferred).toEqual([])
    expect(r.note).toContain('of a 480 s budget (PREPUSH_BUDGET_S=480)')
  })

  it('an override above the pre-push total is capped to it, and the source says so', () => {
    const b = legBudget('win', { PREPUSH_BUDGET_S: '100000' })
    expect(b.seconds).toBe(TOTAL_BUDGET_S)
    expect(b.source).toContain(`cut to ${TOTAL_BUDGET_S} s by the ${TOTAL_BUDGET_S} s pre-push total`)
  })

  it('without an override the leg default applies', () => {
    expect(legBudget('win', {})).toEqual({ seconds: LEG_BUDGET_S['win'], source: 'default' })
    expect(legBudget('wsl', {}).seconds).toBe(LEG_BUDGET_S['wsl'])
  })

  it.each(['abc', '0', '-5', 'Infinity', '0x10', ' 5 ', '1e3', '5.5', '+5'])('ignores %s and says so', (raw) => {
    const b = legBudget('win', { PREPUSH_BUDGET_S: raw })
    expect(b.seconds).toBe(LEG_BUDGET_S['win'])
    expect(b.source).toContain('ignored')
  })

  it('the WSL leg reads its own variable and its own timings', () => {
    const r = select({ leg: 'wsl', env: { PREPUSH_BUDGET_S: '1', PREPUSH_WSL_BUDGET_S: '1000' } }, TEN)
    expect(r.deferred).toEqual([])
    expect(BUDGET_ENV['wsl']).toBe('PREPUSH_WSL_BUDGET_S')
  })

  it('PREPUSH_FULL=1 still runs everything, budget or not', () => {
    const r = decideSelection({ ...({} as Io), leg: 'win', env: { PREPUSH_FULL: '1', PREPUSH_BUDGET_S: '1' }, pushText: PUSH, headSha: HEAD } as Io)
    expect(r).toMatchObject({ full: true, why: 'PREPUSH_FULL=1' })
  })
})

describe('prepush budget: what was cut is printed', () => {
  it('lists every deferred file with the count and the seconds saved', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(50_000) } }, TEN)
    const saved = Math.round(CALIBRATION * 20)
    expect(r.deferredReport).toBe(`deferred to CI: 2 files (~${saved} s)\n  ${FAR1}\n  ${FAR2}\n`)
    expect(r.note).toContain('deferred to CI: 2 files')
  })

  it('prints nothing extra when nothing was cut, but the note still says 0', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '500' } }, TEN)
    expect(r.deferredReport).toBe('')
    expect(r.note).toContain('deferred to CI: 0 files')
  })
})

describe('prepush budget: the pre-push total', () => {
  it('a WSL leg planned after 300 s keeps its own 160 s cap, since 190 s of the total remain', () => {
    expect(legBudget('wsl', { [ELAPSED_ENV]: '300' }).seconds).toBe(LEG_BUDGET_S['wsl'])
  })

  it('a WSL leg planned after 400 s gets only the 90 s that remain of the total', () => {
    const b = legBudget('wsl', { [ELAPSED_ENV]: '400' })
    expect(b.seconds).toBe(90)
    expect(b.source).toContain(`cut to 90 s by the ${TOTAL_BUDGET_S} s pre-push total after 400 s`)
  })

  it('a leg planned past the total gets 0 s, so only the never-cut files are planned', () => {
    expect(legBudget('wsl', { [ELAPSED_ENV]: '600' }).seconds).toBe(0)
  })

  it('an elapsed value that is not whole seconds is ignored and said so', () => {
    const b = legBudget('win', { [ELAPSED_ENV]: 'soon' })
    expect(b.seconds).toBe(LEG_BUDGET_S['win'])
    expect(b.source).toContain(`${ELAPSED_ENV}=soon is not whole seconds, ignored`)
  })

  it('the per-leg caps alone fit the total, with room for the lint and typecheck overhead', () => {
    expect(LEG_BUDGET_S['win']! + LEG_BUDGET_S['wsl']!).toBeLessThanOrEqual(TOTAL_BUDGET_S)
    expect(TOTAL_BUDGET_S).toBe(490)
  })

  it('the hook overhead is the 50 s measured outside the suite legs (measured: 671 s external wall minus 620 s of legs, rounded down)', () => {
    expect(HOOK_OVERHEAD_S).toBe(50)
  })

  it('the total, the hook overhead and the calibration margin add up to the 600 s the whole hook is held to', () => {
    expect(HOOK_LIMIT_S).toBe(600)
    expect(TOTAL_BUDGET_S + HOOK_OVERHEAD_S + HOOK_LIMIT_S * MARGIN_SHARE).toBeLessThanOrEqual(HOOK_LIMIT_S)
  })

  it('an override cannot lift a leg past what the total leaves', () => {
    expect(legBudget('win', { PREPUSH_BUDGET_S: '900' }).seconds).toBe(TOTAL_BUDGET_S)
    expect(legBudget('wsl', { PREPUSH_WSL_BUDGET_S: '900', [ELAPSED_ENV]: '400' }).seconds).toBe(TOTAL_BUDGET_S - 400)
  })
})

describe('prepush budget: the wall-clock deadline of a leg', () => {
  const NOW = 1_800_000_000_000

  it('the WSL deadline is the time actually left: the clock at planning plus the total minus the real elapsed seconds, capped by the leg budget', () => {
    // HAND-DERIVED: 490 s total minus 400 s real elapsed leaves 90 s, under the 160 s cap
    const d = legDeadline('wsl', { [ELAPSED_ENV]: '400' }, NOW)
    expect(d.seconds).toBe(90)
    expect(d.atMs).toBe(NOW + 90_000)
  })

  it('the WSL deadline does not depend on any estimate of the Windows leg, only on the elapsed seconds the hook measured', () => {
    // two different real elapsed values give two different deadlines from the same everything else
    expect(legDeadline('wsl', { [ELAPSED_ENV]: '100' }, NOW).seconds).toBe(160)
    expect(legDeadline('wsl', { [ELAPSED_ENV]: '450' }, NOW).seconds).toBe(40)
    expect(legDeadline('wsl', { [ELAPSED_ENV]: '490' }, NOW).seconds).toBe(0)
  })

  it('the Windows leg with no elapsed value gets its own budget from the clock it was given', () => {
    const d = legDeadline('win', {}, NOW)
    expect(d.seconds).toBe(LEG_BUDGET_S['win'])
    expect(d.atMs).toBe(NOW + LEG_BUDGET_S['win']! * 1000)
  })

  it(`${DEADLINE_ENV} replaces the budget: 0 stops the fill at once, and a value that is not whole seconds is ignored`, () => {
    expect(legDeadline('win', { [DEADLINE_ENV]: '0' }, NOW)).toMatchObject({ atMs: NOW, seconds: 0, source: `${DEADLINE_ENV}=0` })
    expect(legDeadline('win', { [DEADLINE_ENV]: '12' }, NOW).atMs).toBe(NOW + 12_000)
    for (const bad of ['soon', '-3', '1.5', '']) expect(legDeadline('win', { [DEADLINE_ENV]: bad }, NOW).seconds).toBe(LEG_BUDGET_S['win'])
  })

  it(`${DEADLINE_ENV} cannot lift the deadline past what the pre-push total leaves`, () => {
    // HAND-DERIVED: 490 s total minus 400 s elapsed leaves 90 s, and no elapsed value leaves all 490 s
    const d = legDeadline('wsl', { [DEADLINE_ENV]: '99999', [ELAPSED_ENV]: '400' }, NOW)
    expect(d.seconds).toBe(90)
    expect(d.atMs).toBe(NOW + 90_000)
    expect(d.source).toContain('cut to 90 s')
    expect(legDeadline('win', { [DEADLINE_ENV]: '99999' }, NOW).seconds).toBe(TOTAL_BUDGET_S)
    expect(legDeadline('win', { [DEADLINE_ENV]: '30' }, NOW).seconds).toBe(30)
  })
})

describe('prepush budget arithmetic', () => {
  it('fillBudget keeps the fixed files even when they alone exceed the budget', () => {
    const out = fillBudget({ fixed: ['a', 'b'], ordered: ['c'], cost: () => 1_000_000, workers: 1, budgetS: 10 })
    expect(out.kept).toEqual([])
    expect(out.deferred).toEqual(['c'])
    expect(out.estimateS).toBeGreaterThan(10)
  })

  it('the worker count follows tests/setup/max-workers.ts on a machine below its roomy bar', () => {
    for (const platform of ['win32', 'linux', 'darwin']) expect(workersFor({}, platform)).toBe(resolveMaxWorkers(platform, 8, 16))
    expect(workersFor({ TOKEN_GOAT_TEST_MAX_WORKERS: '3' }, 'win32')).toBe(3)
    expect(workersFor({ TOKEN_GOAT_TEST_MAX_WORKERS: 'x' }, 'win32')).toBe(4)
  })

  it('the two default budgets leave room under the 600 s hook limit for the overhead and the margin', () => {
    expect(LEG_BUDGET_S['win']! + LEG_BUDGET_S['wsl']!).toBeLessThanOrEqual(HOOK_LIMIT_S - HOOK_OVERHEAD_S - HOOK_LIMIT_S * MARGIN_SHARE)
  })
})
