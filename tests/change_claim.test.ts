// What a subagent's final report has to say before it is taken to claim a change of its own. Provenance: every report string is HAND-DERIVED, written independently of the matcher from the sentence shapes a read-only agent and a working agent produce.

import { describe, expect, it } from 'vitest'

import { claimsOwnChange } from '../src/change_claim.js'

const NOT_A_CLAIM = [
  'We updated nothing',
  'Fixed: nothing',
  'Deleted files: none',
  'We removed nothing',
  'We updated no files.',
  'Summary: updated nothing, read only.',
  'Renamed symbols are listed below.',
  'Replaced by foo in the cache layer.',
  'Findings:\n- Removed code at line 5 is dead\n- Updated docs are stale',
  'Quoted for reference:\n```diff\n- removed foo\n+ added bar\n```',
  'Quoted for reference:\n- removed foo\n+ added bar\n@@ -1 +1 @@',
  'Quoted from the log:\n```\nI fixed the parser\n```',
  'Quoted commit:\n- I removed the dead branch\n+ we added a guard',
  'Changed: none',
  'Changes made: none',
  'Changes made:\n- None',
  "I'll add the guard next.",
  'I did not fix anything.',
  'The handler adds a header to each request.',
]

const A_CLAIM = ['I renamed foo to bar.', "I've also added a guard.", 'We fixed the parser bug in x.ts', 'Changes made: added a guard to y.ts', 'Changes made:\n- Updated the README.', 'I have implemented the new feature']

describe('claimsOwnChange', () => {
  it.each(NOT_A_CLAIM)('does not take %j for a claim', (report) => {
    expect(claimsOwnChange(report)).toBe(false)
  })

  it.each(A_CLAIM)('takes %j for a claim', (report) => {
    expect(claimsOwnChange(report)).toBe(true)
  })
})
