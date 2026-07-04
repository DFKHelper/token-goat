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
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { TOTAL_FILTER_COUNT } from '../../src/filter_counts.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const README = fs.readFileSync(path.join(HERE, '..', '..', 'README.md'), 'utf8')

/** Extracts the "**NNN+**" number immediately preceding the "filter & interception rules" claim in README.md. */
function readmeAdvertisedFilterCount(): number {
  const m = /\*\*(\d+)\+\*\*\s+filter\s*&\s*interception rules/.exec(README)
  if (!m || m[1] === undefined) {
    throw new Error(
      'Could not find the "**NNN+** filter & interception rules" claim in README.md. ' +
      'Either the wording changed (update the regex in tests/guards/filter_count_readme_sync.test.ts) ' +
      'or the claim was removed (update or delete this guard).'
    )
  }
  return Number(m[1])
}

describe('filter count / README sync', () => {
  it('README\'s advertised filter count is not an overstatement of the real total', () => {
    const readmeCount = readmeAdvertisedFilterCount()

    expect(
      readmeCount,
      `README.md advertises "${readmeCount}+" filter & interception rules, but src/filter_counts.ts ` +
      `computes the real TOTAL_FILTER_COUNT as ${TOTAL_FILTER_COUNT}. The "NNN+" claim is a floor, so ` +
      `it must never exceed the real count. Either bump src/filter_counts.ts's static counts if filters ` +
      `were actually added and TOTAL_FILTER_COUNT is under-counting, or lower the number in README.md ` +
      `if filters/interceptors were removed and the advertised count is now an overstatement.`
    ).toBeLessThanOrEqual(TOTAL_FILTER_COUNT)
  })
})
