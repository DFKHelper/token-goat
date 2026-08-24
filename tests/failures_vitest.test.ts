/**
 * `failures` did not recognize Vitest output: it fell through to the generic keyword extractor,
 * which reported framework `[unknown]`, inflated a single failing test into several (one per line
 * carrying FAILED/ERROR), and never kept the `AssertionError: expected 4 to be 3` detail line.
 *
 * This fixture is the real, verbatim output of a one-assertion Vitest failure (captured from
 * `vitest run`, ANSI already stripped), so the extractor is proven against the exact shape it ships
 * against rather than a hand-idealized one.
 */
import { describe, it, expect } from 'vitest'

import { extractFailures, getFailureCount } from '../src/failures.js'

const VITEST_ONE_FAILURE = ` RUN  v4.1.11 C:/tmp/proj

 ❯ f.test.ts (1 test | 1 failed) 4ms
   × adds numbers 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  f.test.ts > adds numbers
AssertionError: expected 4 to be 3 // Object.is equality

- Expected
+ Received

- 3
+ 4

 ❯ f.test.ts:2:40
      1| import { it, expect } from 'vitest'
      2| it('adds numbers', () => { expect(2+2).toBe(3) })
       |                                        ^
      3|

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯


 Test Files  1 failed (1)
      Tests  1 failed (1)
   Start at  00:37:35
   Duration  152ms
`

const VITEST_TWO_FAILURES = ` RUN  v4.1.11 C:/tmp/proj

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  a.test.ts > first case
AssertionError: expected 1 to be 2

 ❯ a.test.ts:3:10

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  b.test.ts > second case
AssertionError: expected "x" to be "y"

 ❯ b.test.ts:9:12

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯


 Test Files  2 failed (2)
      Tests  2 failed (2)
`

describe('vitest failure parsing', () => {
  it('detects the runner as vitest, not unknown', () => {
    expect(extractFailures(VITEST_ONE_FAILURE).runner).toBe('vitest')
  })

  it('counts exactly one failure for a single failing test', () => {
    const result = extractFailures(VITEST_ONE_FAILURE)
    expect(getFailureCount(result), 'one failing test must count as one, not several keyword lines').toBe(1)
  })

  it('keeps the AssertionError detail line in the failure body', () => {
    const result = extractFailures(VITEST_ONE_FAILURE)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0]?.name).toContain('adds numbers')
    expect(result.blocks[0]?.body, 'the assertion detail is the point of the report').toContain(
      'AssertionError: expected 4 to be 3',
    )
  })

  it('counts two failures as two and keeps both assertion details', () => {
    const result = extractFailures(VITEST_TWO_FAILURES)
    expect(getFailureCount(result)).toBe(2)
    expect(result.blocks.map((b) => b.name)).toEqual([
      'a.test.ts > first case',
      'b.test.ts > second case',
    ])
    expect(result.blocks[0]?.body).toContain('expected 1 to be 2')
    expect(result.blocks[1]?.body).toContain('expected "x" to be "y"')
  })

  it('records the Tests summary line as the stats line', () => {
    expect(extractFailures(VITEST_ONE_FAILURE).statsLine).toMatch(/Tests\s+1 failed/)
  })
})
