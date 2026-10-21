import { describe, expect, it } from 'vitest'

import { ripgrepLines } from '../src/inline_grep_scan.js'

// CAPTURE: ripgrep 15.1.0 on the file "foo bar\r\nfoo\r\n": `rg -n 'foo$'` printed nothing and exited 1, so a line there ends at `\n` and keeps its `\r`; `rg --help` on --crlf says the same ("treat CRLF as a line terminator instead of just LF"). The other rows are HAND-DERIVED from that definition: a NUL byte is ripgrep's binary mark, and a lone CR is no terminator for ripgrep while the index counts it as one.
describe('ripgrepLines', () => {
  it('splits at LF only and keeps the CR of a CRLF line, so $ does not match before it', () => {
    const lines = ripgrepLines(Buffer.from('foo bar\r\nfoo\r\n'))
    expect(lines).toEqual(['foo bar\r', 'foo\r'])
    expect(/foo$/.test((lines ?? [])[1] ?? '')).toBe(false)
  })

  it('does not count the empty text after the final newline as a line', () => {
    expect(ripgrepLines(Buffer.from('a\nb\n'))).toEqual(['a', 'b'])
    expect(ripgrepLines(Buffer.from('a\nb'))).toEqual(['a', 'b'])
    expect(ripgrepLines(Buffer.from(''))).toEqual([])
  })

  it('drops a leading byte-order mark', () => {
    expect(ripgrepLines(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]))).toEqual(['a'])
  })

  it.each([
    ['a NUL byte', Buffer.from('a\0b\n')],
    ['a CR that is not part of CRLF', Buffer.from('a\rb\n')],
    ['a CR at the very end', Buffer.from('a\n\r')],
    ['bytes that are not UTF-8', Buffer.from([0x61, 0xff, 0x0a])],
  ])('refuses %s', (_label, bytes) => {
    expect(ripgrepLines(bytes)).toBeNull()
  })
})
