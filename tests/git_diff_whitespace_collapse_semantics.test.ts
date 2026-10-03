import { describe, expect, it } from 'vitest'

import { GitDiffFilter } from '../src/tool_filters/index.js'

const filter = new GitDiffFilter()
const COLLAPSED = 'whitespace/EOL-only change, collapsed'

function diffOf(removed: string[], added: string[]): string {
  return (
    'diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n' +
    `@@ -1,${removed.length} +1,${added.length} @@\n` +
    removed.map((l) => `-${l}`).join('\n') +
    '\n' +
    added.map((l) => `+${l}`).join('\n') +
    '\n'
  )
}
const run = (removed: string[], added: string[]): string => filter.apply(diffOf(removed, added), '', 0, ['git', 'diff']).text

// Provenance: HAND-DERIVED. The lines are made up; what each pair changes follows from the language rules (Python blocks are defined by indentation, a quoted literal's characters are its value), not from the matcher.
describe('git diff whitespace-only collapse keeps meaningful whitespace visible', () => {
  it('shows a dedent that moves a statement out of an if-block', () => {
    const result = run(['    refund(user, amount)'], ['refund(user, amount)'])
    expect(result).not.toContain(COLLAPSED)
    expect(result).toContain('-    refund(user, amount)')
    expect(result).toContain('+refund(user, amount)')
  })

  it('shows whitespace removed inside a string literal', () => {
    const result = run(['msg = "Total due"'], ['msg = "Totaldue"'])
    expect(result).not.toContain(COLLAPSED)
    expect(result).toContain('+msg = "Totaldue"')
  })

  it('shows whitespace changed inside a single-quoted literal with an escaped quote', () => {
    const result = run([String.raw`s = 'it\'s  ok'`], [String.raw`s = 'it\'s ok'`])
    expect(result).not.toContain(COLLAPSED)
  })

  it('shows two words being joined', () => {
    const result = run(['return x if y else z'], ['return xif y else z'])
    expect(result).not.toContain(COLLAPSED)
  })

  it('still collapses trailing whitespace, CRLF and spacing around operators', () => {
    expect(run(['x = 1  '], ['x = 1'])).toContain(COLLAPSED)
    expect(run(['x = 1\r'], ['x = 1'])).toContain(COLLAPSED)
    expect(run(['x = 1+2'], ['x  =  1  +  2'])).toContain(COLLAPSED)
    expect(run(['msg = "a  b"  '], ['msg = "a  b"'])).toContain(COLLAPSED)
  })
})
