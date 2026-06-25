import { describe, expect, it } from 'vitest'

import { compressOutput, stripAnsiCodes } from '../src/bash_compress.js'

describe('stripAnsiCodes', () => {
  it('removes SGR colour escape sequences', () => {
    const colored = '\x1B[31mred\x1B[0m and \x1B[1;32mbold green\x1B[0m'
    expect(stripAnsiCodes(colored)).toBe('red and bold green')
  })

  it('removes OSC hyperlink/title sequences', () => {
    const osc = 'before\x1B]0;window title\x07after'
    expect(stripAnsiCodes(osc)).toBe('beforeafter')
  })

  it('returns plain text unchanged (fast path)', () => {
    expect(stripAnsiCodes('no escapes here')).toBe('no escapes here')
  })
})

describe('compressOutput', () => {
  it('returns empty string for empty input', () => {
    expect(compressOutput('')).toBe('')
  })

  it('strips ANSI codes by default', () => {
    expect(compressOutput('\x1B[31mhello\x1B[0m')).toBe('hello')
  })

  it('leaves ANSI codes when stripAnsi is false', () => {
    const out = compressOutput('\x1B[31mhello\x1B[0m', { stripAnsi: false })
    expect(out).toContain('\x1B[31m')
  })

  it('dedupes consecutive duplicate lines with a count marker', () => {
    const input = ['warn', 'warn', 'warn', 'done'].join('\n')
    const out = compressOutput(input)
    expect(out).toBe(['warn  (×3)', 'done'].join('\n'))
  })

  it('keeps a single occurrence verbatim (no spurious count)', () => {
    expect(compressOutput('only once')).toBe('only once')
  })

  it('does not dedupe when dedupeConsecutive is false', () => {
    const input = ['a', 'a'].join('\n')
    expect(compressOutput(input, { dedupeConsecutive: false })).toBe('a\na')
  })

  it('truncates lines longer than maxLineLength', () => {
    const longLine = 'x'.repeat(50)
    const out = compressOutput(longLine, { maxLineLength: 10 })
    expect(out).toContain('chars truncated')
    expect(out.startsWith('x'.repeat(10))).toBe(true)
  })

  it('truncates output exceeding maxLines with an elision marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const out = compressOutput(lines.join('\n'), { maxLines: 10 })
    const outLines = out.split('\n')
    // 10 kept lines + 1 elision marker.
    expect(outLines.length).toBe(11)
    expect(out).toContain('lines elided by token-goat')
    // Head and tail are preserved.
    expect(outLines[0]).toBe('line 0')
    expect(outLines[outLines.length - 1]).toBe('line 99')
  })

  it('strips git progress lines via FILTERS', () => {
    const input = [
      'remote: Counting objects: 100% (11/11), done.',
      'Receiving objects: 100% (11/11), done.',
      'Resolving deltas: 100% (3/3), done.',
      'Already up to date.',
    ].join('\n')
    const out = compressOutput(input)
    expect(out).toBe('Already up to date.')
  })

  it('collapses \\r progress to its final rendered state', () => {
    const input = 'Building [....] 10%\rBuilding [####] 100%'
    expect(compressOutput(input)).toBe('Building [####] 100%')
  })

  it('normalises CRLF line endings', () => {
    const out = compressOutput('a\r\nb\r\nc')
    expect(out).toBe('a\nb\nc')
  })
})
