/** The pre-push time budget: scripts/prepush-budget.mjs does the arithmetic and scripts/prepush-select.mjs applies it to the priority list, so a wrong cut either skips a test that should run or blows the 1200 s the push is held to. */
import { describe, expect, it } from 'vitest'
import { BUDGET_ENV, CALIBRATION, DEFAULT_FILE_MS, FIXED_OVERHEAD_S, LEG_BUDGET_S, costFn, fillBudget, legBudget, workersFor } from '../scripts/prepush-budget.mjs'
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
    mergeBase: () => null,
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

  it('never cuts failed files, changed tests, guards or the matrix, whatever the budget', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '1' }, failed: () => ['tests/old.test.ts'], changed: () => [{ status: 'M', path: 'src/a.ts' }, { status: 'M', path: 'tests/new.test.ts' }] }, TEN)
    expect(r.files).toEqual(['tests/old.test.ts', 'tests/new.test.ts', G1, G2, M1].sort())
    expect(r.deferred).toEqual([NEAR1, NEAR2, FAR1, FAR2])
  })

  it('a test-only push has no matrix to keep', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '1' }, changed: () => [{ status: 'M', path: 'tests/new.test.ts' }] }, TEN)
    expect(r.files).toEqual(['tests/new.test.ts', G1, G2].sort())
  })

  it('a file with no timing is costed at the median of the table, not at zero and not at the default', () => {
    // table median is 10 s; NEAR1 is untimed, so it costs 10 s and the 5 s of room left cannot hold it
    const table = { [G1]: 10_000, [G2]: 10_000, [M1]: 10_000, [NEAR2]: 10_000, [FAR1]: 10_000, [FAR2]: 10_000 }
    expect(DEFAULT_FILE_MS).toBeLessThan(5_000)
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(35_000) } }, table)
    expect(r.deferred).toContain(NEAR1)
    expect(costFn(table)(NEAR1)).toBe(10_000)
  })

  it('an empty table costs a file at the default', () => {
    expect(costFn({})('tests/x.test.ts')).toBe(DEFAULT_FILE_MS)
  })

  it('divides the work over the workers', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: budgetFor(50_000, 2) }, workers: 2 }, TEN)
    expect(r.files).toEqual([G1, G2, M1, NEAR1, NEAR2].sort())
    expect(r.deferred).toEqual([FAR1, FAR2])
  })
})

describe('prepush budget: the environment override', () => {
  it('PREPUSH_BUDGET_S replaces the default and the note names it', () => {
    const r = select({ env: { PREPUSH_BUDGET_S: '100000' } }, TEN)
    expect(r.deferred).toEqual([])
    expect(r.note).toContain('of a 100000 s budget (PREPUSH_BUDGET_S=100000)')
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
    const r = select({ leg: 'wsl', env: { PREPUSH_BUDGET_S: '1', PREPUSH_WSL_BUDGET_S: '100000' } }, TEN)
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
    const r = select({ env: { PREPUSH_BUDGET_S: '100000' } }, TEN)
    expect(r.deferredReport).toBe('')
    expect(r.note).toContain('deferred to CI: 0 files')
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

  it('the two default budgets and the fixed overhead leave room under 1200 s', () => {
    expect(LEG_BUDGET_S['win']! + LEG_BUDGET_S['wsl']!).toBeLessThanOrEqual(900)
  })
})
