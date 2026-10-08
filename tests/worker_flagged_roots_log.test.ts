import { describe, expect, it } from 'vitest'

import { flaggedRootsLogLine } from '../src/worker.js'

// HAND-DERIVED: the expected lines are written out from the sentence the worker error log has always carried, with the noun made to agree with the count.
describe('flaggedRootsLogLine', () => {
  it('says "1 root" for one flagged root', () => {
    expect(flaggedRootsLogLine(['/a'], 'T')).toBe('T sweepKnownRoots flagged 1 root for anomalously large dead-row ratio (skipped, not pruned): /a\n')
  })

  it('says "2 roots" for two flagged roots', () => {
    expect(flaggedRootsLogLine(['/a', '/b'], 'T')).toBe('T sweepKnownRoots flagged 2 roots for anomalously large dead-row ratio (skipped, not pruned): /a, /b\n')
  })
})
