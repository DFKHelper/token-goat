/**
 * Guard against the README's advertised filter count silently becoming a lie.
 *
 * README.md's intro line advertises a floor claim like "**180+** filter &
 * interception rules", bumped by hand whenever filters are added. Nothing
 * previously checked that number against reality: src/filter_counts.ts
 * computes TOTAL_FILTER_COUNT from the real source arrays (src/filters.ts,
 * src/hints/lang_patterns.ts) plus a handful of manually-maintained static
 * counts, but had zero importers anywhere in the repo. This test makes that
 * module a genuine dependency: it fails loudly if someone bumps the README's
 * number ahead of actually adding that many filters/interceptors, or if
 * filters are later removed and the README's claim becomes an overstatement.
 *
 * A one-sided check has one blind spot, and both claims had drifted into it:
 * a floor that is too LOW is always true, so nothing objected while the real
 * total reached 210 against an advertised 180, and the tool-CLI count reached
 * 157 filters against an advertised 130. Each claim is therefore held inside a
 * band -- at or under the real count, and not more than a stated slack below
 * it. The slack is what a claim needs to survive removing a filter without
 * failing the build; drift past it means the README is underselling work that
 * shipped, which is a defect in the other direction and not a safe default.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOTAL_FILTER_COUNT } from '../../src/filter_counts.js'
import { TOOL_FILTERS } from '../../src/tool_filters/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const README = fs.readFileSync(path.join(HERE, '..', '..', 'README.md'), 'utf8')

/**
 * How far below the real count a "NNN+" floor may sit. Large enough that
 * retiring a filter does not fail the build on the same commit, small enough
 * that a year of additions cannot hide inside it.
 */
const MAX_SLACK = 15

function extract(re: RegExp, what: string): number {
  const m = re.exec(README)
  if (!m || m[1] === undefined) {
    throw new Error(
      `Could not find the ${what} claim in README.md. Either the wording changed (update the ` +
      'regex in tests/guards/filter_count_readme_sync.test.ts) or the claim was removed (update ' +
      'or delete this guard).'
    )
  }
  return Number(m[1])
}

/** The "**NNN+**" number immediately preceding the "filter & interception rules" claim. */
function readmeAdvertisedFilterCount(): number {
  return extract(/\*\*(\d+)\+\*\*\s+filter\s*&\s*interception rules/, '"**NNN+** filter & interception rules"')
}

/** The "NNN+" number in the "covers NNN+ dev tool CLIs" sentence. */
function readmeAdvertisedToolCliCount(): number {
  return extract(/covers\s+(\d+)\+\s+dev tool CLIs/, '"covers NNN+ dev tool CLIs"')
}

const CLAIMS: readonly { readonly what: string, readonly advertised: () => number, readonly real: () => number, readonly source: string }[] = [
  {
    what: 'filter & interception rules',
    advertised: readmeAdvertisedFilterCount,
    real: () => TOTAL_FILTER_COUNT,
    source: 'src/filter_counts.ts (TOTAL_FILTER_COUNT; bump its static counts if they under-count)',
  },
  {
    what: 'dev tool CLIs',
    advertised: readmeAdvertisedToolCliCount,
    // Filters, not binaries: TOOL_FILTERS covers 260 binary names, but many of those are aliases
    // of one tool (`py.test`, `docker-compose`) and several filters split one tool by subcommand,
    // so the filter count is the conservative reading of "CLIs covered".
    real: () => TOOL_FILTERS.length,
    source: 'src/tool_filters/index.ts (TOOL_FILTERS.length)',
  },
]

describe('filter count / README sync', () => {
  it.each(CLAIMS)('the advertised $what count is neither an overstatement nor stale', ({ what, advertised, real, source }) => {
    const readmeCount = advertised()
    const realCount = real()

    expect(
      readmeCount,
      `README.md advertises "${readmeCount}+" ${what}, but the real count is ${realCount} per ` +
      `${source}. The "NNN+" claim is a floor and must never exceed reality: lower it, or add the ` +
      'filters the claim already promises.'
    ).toBeLessThanOrEqual(realCount)

    expect(
      readmeCount,
      `README.md advertises "${readmeCount}+" ${what} while the real count is ${realCount}, ` +
      `${realCount - readmeCount} more than claimed. A floor that low is true and useless, which ` +
      'is exactly why nobody notices it drifting. Raise the README number to within ' +
      `${MAX_SLACK} of ${realCount}.`
    ).toBeGreaterThanOrEqual(realCount - MAX_SLACK)
  })
})
