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
  'Files changed: 0',
  'Files changed: --',
  'Changes made: (none)',
  'I wrote a report of the findings.',
  'I created the summary below',
  'I added that this is read-only',
  'I changed my mind about the approach',
  'I updated my understanding of the flow',
  'If I fixed this the tests would pass; I have not.',
  'The user asked whether I fixed the bug; I did not.',
  '> I fixed the parser',
  '    I fixed the parser',
  'Updated nothing',
  '- Fixed in v2 upstream',
  'Fixed in v2 upstream',
  '> Fixed the parser',
  'Changed nothing; read only.',
  'Added the following findings:',
  'Changes:\n- none',
  '~~~\nI fixed the parser\n```\nstill inside\n~~~',
  'Quoted:\n```\nI fixed it\n~~~\nstill inside the backtick fence\n```',
  'Quoted:\n```\n~~~\nI fixed the parser\n```',
  '~~~\n```\nI fixed the parser\n~~~',
  'Added the following notes: a',
  'I noted the following issues I found:\n- a',
  'Changes:\n- Recommend renaming foo to bar',
  'Changes:\n- Should rename foo to bar',
  'Changes: I only read files',
  'Changes: none made, read-only review',
  '+ item one\n+ item two',
]

const A_CLAIM = ['I renamed foo to bar.', "I've also added a guard.", 'We fixed the parser bug in x.ts', 'Changes made: added a guard to y.ts', 'Changes made:\n- Updated the README.', 'I have implemented the new feature',
  'Done:\n- I fixed the parser\n- I added tests',
  'Done.\n\n- We updated widget.ts',
  'Fixed the parser bug.',
  'Updated widget.ts to use X',
  'Added a guard in foo()',
  'Removed `bar` from the index',
  '## Changes\n- a.ts',
  'Changes made:\n\n- widget.ts',
  'I made the changes in widget.ts',
  'I made some edits',
  'I updated the following files: a.ts, b.ts',
  'I fixed the following bugs:\n- a',
  'I added the following tests:\n- a',
  'I created the following files: a.ts',
  'Added the following tests to a.ts',
  'I made the following changes:\n- a',
  'I made the following edits:\n- a',
  'Fixed the parser bug.\n+ item one',
  'diff --git a/x b/x\n+ a\nFixed the parser bug.',
  'Changes:\n- Renamed foo to bar',
  'Done:\n+ I fixed the parser',
]

describe('claimsOwnChange', () => {
  it.each(NOT_A_CLAIM)('does not take %j for a claim', (report) => {
    expect(claimsOwnChange(report)).toBe(false)
  })

  it.each(A_CLAIM)('takes %j for a claim', (report) => {
    expect(claimsOwnChange(report)).toBe(true)
  })
})
