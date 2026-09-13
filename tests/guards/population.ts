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
   * Optional upper bound, for a population whose size is a MEASUREMENT rather than a growing list.
   *
   * A floor alone cannot tell "pinned a little below the live count" from "pinned at a number the
   * author guessed and never checked". This repo shipped the second: a call-graph closure pinned at
   * 40 against a believed population of 45, whose real size was 111 -- so the floor could have lost
   * 71 members, 64% of the guard's subject matter, without saying a word. Nothing was wrong with
   * the floor's arithmetic; the belief behind it was never falsifiable.
   *
   * A ceiling makes it falsifiable. Pin it a little ABOVE the count you actually measured, and the
   * author who guessed 45 gets a red test at 111 instead of a silent 64% hole. Growth past it is
   * not a defect -- it is the prompt to re-measure and re-pin BOTH numbers together, which is the
   * step that was skipped.
   *
   * Opt-in, and deliberately so: a population that is "every file under tests/" legitimately grows
   * without bound, and a ceiling there would be noise. Use it where the number means something --
   * a call-graph closure, a call-site set, an adapter registry.
   */
  readonly ceiling?: number
  /**
   * Members that must be present, matched as substrings so callers can name a path tail
   * (`src/parser.ts`) without knowing the absolute prefix. These are the members whose absence
   * would hollow out the guard while leaving its count intact.
   *
   * SUBSTRING MATCHING IS A HAZARD FOR ANY NEEDLE ENDING IN AN IDENTIFIER, and it has already cost
   * this repo a live near-miss. `mustInclude: ['vscode_install.ts::installVscode']` went on passing
   * after a refactor moved every write out of `installVscode` into a new `installVscodeScoped`
   * wrapper -- because the new name CONTAINS the old one. The anchor was pinned to a function that
   * no longer had a single write site in it, and it would equally have survived deleting
   * `installVscode` outright as long as any similarly-prefixed sibling remained. Use
   * {@link mustIncludeExact} for a needle that names a symbol; keep this one for path tails, where
   * a prefix match is what you actually want.
   */
  readonly mustInclude?: readonly string[]
  /**
   * Members that must be present as an EXACT equality against at least one item, or -- for an item
   * built by joining fields with `::` -- as an exact match on a leading run of those fields.
   *
   * The `::`-prefix form is what makes this usable: a population of
   * `file::fn::call` items wants to be anchored at `file::fn` without restating the call text, but
   * "starts with `file::fn`" must not also accept `file::fnScoped`. Requiring the next character to
   * be a `::` separator gives the prefix a boundary, so `vscode_install.ts::installVscode` matches
   * `src/bridges/vscode_install.ts::installVscode::backupFile(mcpPath)` and does NOT match
   * `src/bridges/vscode_install.ts::installVscodeScoped::backupFile(mcpPath)`.
   */
  readonly mustIncludeExact?: readonly string[]
}

/**
 * Does `item` match `needle` exactly, or at a `::` field boundary?
 *
 * The trailing-separator rule is the same one `isInsideRoot` uses to stop `/srv/project-secrets`
 * reading as inside `/srv/project`: a prefix without a boundary is not containment, it is a string
 * coincidence waiting for a rename.
 */
function matchesExactly(item: string, needle: string): boolean {
  if (item === needle) return true
  const tail = item.startsWith(needle) ? item.slice(needle.length) : null
  if (tail === null) return false
  // The needle may name a path tail of a `/`-joined item, or a leading field run of a `::`-joined
  // one; either way the character after it has to be a separator rather than more identifier.
  return tail.startsWith('::')
}

/**
 * Assert a scanned population is real, then return it for iteration.
 *
 * Returns `items` unchanged so a guard reads `for (const f of pinnedPopulation({...}))` and cannot
 * accidentally iterate the unchecked array instead -- the check is on the path to the data, not
 * beside it.
 */
export function pinnedPopulation(spec: PinnedPopulationSpec): readonly string[] {
  const { what, items, floor, ceiling, mustInclude = [], mustIncludeExact = [] } = spec

  // "Did this guard's population shrink" has been the decisive question in two consecutive audit
  // rounds, and answering it has meant hand-extracting the guard's own regexes into a scratch
  // script each time -- a procedure that re-derives the population from a COPY of the rule and so
  // can disagree with the rule actually shipping. `TG_POPULATION_REPORT=1 npx vitest run tests/guards`
  // prints the real count and members from inside the real guard instead. It reports and does not
  // assert: the floor/ceiling/anchors below still run, so this cannot become a way to pass.
  if (process.env['TG_POPULATION_REPORT'] === '1') {
    console.log(`[population] ${items.length}\t(floor ${floor}${ceiling === undefined ? '' : `, ceiling ${ceiling}`})\t${what}`)
    for (const item of items) {
      console.log(`[population]   ${item}`)
    }
  }

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

  if (ceiling !== undefined) {
    expect(
      ceiling,
      `pinnedPopulation("${what}") was given a ceiling of ${ceiling} below its floor of ${floor}`,
    ).toBeGreaterThanOrEqual(floor)
    expect(
      items.length,
      `the "${what}" population is ${items.length}, past the ${ceiling} it was measured at. This is ` +
        `not "too many things" -- it is that the FLOOR below it is now a stale guess about a ` +
        `population that has moved. Re-measure the live count (raise the floor to 9999 and read it ` +
        `out of the failure), then re-pin the floor and this ceiling around it in the same commit.`,
    ).toBeLessThanOrEqual(ceiling)
  }

  for (const needle of mustInclude) {
    expect(
      items.some((i) => i.includes(needle)),
      `the "${what}" population no longer contains "${needle}". The count still meets its floor, so ` +
        `this is a substitution rather than a collapse: the guard is still scanning something, just ` +
        `not the member it was pinned to cover. Restore the member, or repin the anchor and say why.`,
    ).toBe(true)
  }

  for (const needle of mustIncludeExact) {
    expect(
      items.some((i) => matchesExactly(i, needle)),
      `the "${what}" population no longer contains "${needle}" as an exact member (or as a complete ` +
        `"::"-delimited prefix of one). A SUBSTRING match would still find it -- that is precisely ` +
        `what this anchor refuses, because a rename to a longer name containing the old one leaves ` +
        `the substring form green while the member it was pinned to is gone. Restore the member, or ` +
        `repin the anchor and say why.`,
    ).toBe(true)
  }

  return items
}
