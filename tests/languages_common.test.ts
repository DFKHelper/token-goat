import { describe, expect, it } from 'vitest'
import { stripBlockCommentSpan } from '../src/languages/common.js'

// ---------------------------------------------------------------------------
// stripBlockCommentSpan (and the private isInsideStringLiteral it delegates
// to) - shared by php.ts and csharp.ts to decide whether a `/*` on a line is
// a real block-comment opener or just two characters that happen to appear
// inside a string literal (e.g. `glob('src/*.php')`).
//
// isInsideStringLiteral must track "is a string open right now, and with
// which quote character" as a single state machine - not two independent
// odd/even parity counters for `"` and `'`. A real line of code can only be
// inside one kind of string at a time, since a `'` can't open a nested
// string while a `"`-delimited string is already open.
// ---------------------------------------------------------------------------

describe('stripBlockCommentSpan', () => {
  it('treats /* as a real comment opener after a closed double-quoted string containing an apostrophe (fail-on-buggy: independent single/double-quote parity counters misread the apostrophe in "don\'t" as an open single-quoted string)', () => {
    const line = `const msg = "don't panic"; /* real comment starts here`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(true)
    expect(result.code).toBe(`const msg = "don't panic"; `)
  })

  it('strips the full body of a comment opened after an apostrophe-containing double-quoted string, across lines', () => {
    const opening = stripBlockCommentSpan(`const msg = "don't panic"; /* start`, false)
    const middle = stripBlockCommentSpan(`  this line should be fully hidden`, opening.inComment)
    const closing = stripBlockCommentSpan(`end */ realCode()`, middle.inComment)
    expect(opening.inComment).toBe(true)
    expect(middle.inComment).toBe(true)
    expect(middle.code.trim()).toBe('')
    expect(closing.inComment).toBe(false)
    expect(closing.code.trim()).toBe('realCode()')
  })

  it('does not treat /* inside a single-quoted string as a comment opener (glob(\'src/*.php\'))', () => {
    const line = `$files = glob('src/*.php');`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).toBe(line)
  })

  it('handles a single-quoted string that contains a double quote', () => {
    const line = `$s = 'he said "hi" to /* not a comment */ me';`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).toBe(line)
  })

  it('handles empty strings without leaving the quote state stuck open', () => {
    const line = `const a = ""; const b = ''; /* real comment */ const c = 1`
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('real comment')
    expect(result.code.startsWith(`const a = ""; const b = ''; `)).toBe(true)
    expect(result.code.trimEnd().endsWith('const c = 1')).toBe(true)
  })

  it('does not toggle string state on an escaped quote', () => {
    const line = 'const s = "say \\"hi\\""; /* real comment */ const d = 1'
    const result = stripBlockCommentSpan(line, false)
    expect(result.inComment).toBe(false)
    expect(result.code).not.toContain('real comment')
  })
})
