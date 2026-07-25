/**
 * filter_counts.ts has no importers exercising its arithmetic directly — the
 * only existing consumer (tests/guards/filter_count_readme_sync.test.ts)
 * checks TOTAL_FILTER_COUNT as a floor (`<=` the README's advertised number),
 * so it only catches the count going DOWN, never a computation bug that
 * inflates a constant (e.g. a duplicated term, or a static count bumped past
 * what its source module actually has). These tests pin the arithmetic
 * itself: each dynamic constant against the real source array length it
 * claims to mirror, and the two composite sums (PATH_PATTERN_COUNT,
 * TOTAL_FILTER_COUNT) against their own listed addends.
 */

import { describe, expect, it } from 'vitest'

import { FILTERS } from '../src/filters.js'
import {
  BASH_INTERCEPTOR_COUNT,
  BASH_OUTPUT_FILTER_COUNT,
  BUILD_RECALL_PATTERN_COUNT,
  FAILURE_RUNNER_COUNT,
  FILE_TYPE_HANDLER_COUNT,
  MONITORING_PATTERN_COUNT,
  PATH_PATTERN_COUNT,
  READ_HOOK_CONDITION_COUNT,
  TOTAL_FILTER_COUNT,
} from '../src/filter_counts.js'
import {
  BUILD_COMMAND_PATTERNS,
  BUILD_DIR_COUNT,
  GENERATED_EXT_COUNT,
  LOCK_FILE_COUNT,
  MANIFEST_FILE_COUNT,
  MONITORING_COMMAND_PATTERNS,
} from '../src/hints/lang_patterns.js'

describe('filter_counts.ts', () => {
  it('dynamic counts mirror the live length of their source arrays', () => {
    expect(BASH_OUTPUT_FILTER_COUNT).toBe(FILTERS.length)
    expect(BUILD_RECALL_PATTERN_COUNT).toBe(BUILD_COMMAND_PATTERNS.length)
    expect(MONITORING_PATTERN_COUNT).toBe(MONITORING_COMMAND_PATTERNS.length)
  })

  it('PATH_PATTERN_COUNT is the sum of all four path-pattern source counts', () => {
    expect(PATH_PATTERN_COUNT).toBe(
      LOCK_FILE_COUNT + MANIFEST_FILE_COUNT + BUILD_DIR_COUNT + GENERATED_EXT_COUNT
    )
  })

  it('TOTAL_FILTER_COUNT is the sum of every listed constant, with no term dropped or duplicated', () => {
    expect(TOTAL_FILTER_COUNT).toBe(
      BASH_OUTPUT_FILTER_COUNT +
        BUILD_RECALL_PATTERN_COUNT +
        MONITORING_PATTERN_COUNT +
        PATH_PATTERN_COUNT +
        FILE_TYPE_HANDLER_COUNT +
        BASH_INTERCEPTOR_COUNT +
        READ_HOOK_CONDITION_COUNT +
        FAILURE_RUNNER_COUNT
    )
  })
})
