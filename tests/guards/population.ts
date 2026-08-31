/**
 * Shared floor for guards that scan a population.
 *
 * A guard of the shape "enumerate every X, assert each one satisfies P" has a silent failure mode
 * that no assertion inside the loop can catch: if the enumeration returns nothing, the loop body
 * never runs and the guard passes. It keeps passing, forever, reporting green while checking
 * nothing. This has already happened in this repo -- a guard gated on a call name that a refactor
 * renamed emptied its own population and went on passing (see the `guard gate keyed on the
 * pre-refactor call name` case).
 *
 * The enumeration can empty for reasons that have nothing to do with the guard's author: a
 * directory moves, a glob's extension list drifts, a helper's filter tightens, a build step stops
 * emitting the artifact being walked. None of those produce an error. They produce a zero-length
 * array and a green check.
 *
 * `pinnedPopulation` makes the population itself an assertion. Two independent checks, because
 * either alone is defeatable:
 *
 *  - `floor` catches collapse. A count that drops below the pinned number fails loudly with the
 *    old and new counts, so the maintainer sees the size change rather than inferring it.
 *  - `mustInclude` catches *silent substitution*, which a count floor cannot see. A population
 *    that keeps its size while losing the specific members the guard exists to cover still passes
 *    a floor -- this repo has shipped exactly that ("aggregate guard floor hides coverage loss:
 *    pin the set"). Naming a few load-bearing members closes it.
 *
 * Floors are ratchets, deliberately set a little below the live count: a legitimate deletion or
 * two should not break an unrelated guard, but a collapse must. When a floor does fire because
 * the population genuinely shrank, lower it *and* say why in the same commit -- an unexplained
 * floor edit is indistinguishable from silencing the check.
 */
import { expect } from 'vitest'

export interface PinnedPopulationSpec {
  /** What is being enumerated, in the words a failure message should use ("src/**\/*.ts files"). */
  readonly what: string
  /** The enumerated population. */
  readonly items: readonly string[]
  /**
   * Minimum size. Pin below the live count so ordinary churn does not fire it, high enough that a
   * collapse does. Zero is never a valid floor -- that is the state this helper exists to catch.
   */
  readonly floor: number
  /**
   * Members that must be present, matched as substrings so callers can name a path tail
   * (`src/parser.ts`) without knowing the absolute prefix. These are the members whose absence
   * would hollow out the guard while leaving its count intact.
   */
  readonly mustInclude?: readonly string[]
}

/**
 * Assert a scanned population is real, then return it for iteration.
 *
 * Returns `items` unchanged so a guard reads `for (const f of pinnedPopulation({...}))` and cannot
 * accidentally iterate the unchecked array instead -- the check is on the path to the data, not
 * beside it.
 */
export function pinnedPopulation(spec: PinnedPopulationSpec): readonly string[] {
  const { what, items, floor, mustInclude = [] } = spec

  // A zero floor would let the empty population this helper exists to catch pass the check, so it
  // is rejected as a spec error rather than honoured.
  expect(floor, `pinnedPopulation("${what}") was given a floor of ${floor}; a floor must be >= 1`).toBeGreaterThan(0)

  expect(
    items.length,
    `the "${what}" population collapsed to ${items.length} (floor ${floor}). A guard that scans an ` +
      `empty population passes without checking anything, so this is a failure even though nothing ` +
      `it scanned was wrong. Either the enumeration broke (moved directory, drifted filter, missing ` +
      `build artifact) or the population genuinely shrank -- if genuinely, lower the floor and say ` +
      `why in the same commit.`,
  ).toBeGreaterThanOrEqual(floor)

  for (const needle of mustInclude) {
    expect(
      items.some((i) => i.includes(needle)),
      `the "${what}" population no longer contains "${needle}". The count still meets its floor, so ` +
        `this is a substitution rather than a collapse: the guard is still scanning something, just ` +
        `not the member it was pinned to cover. Restore the member, or repin the anchor and say why.`,
    ).toBe(true)
  }

  return items
}
