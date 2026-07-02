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
    const longLine = 'x'.repeat(100)
    // Use a realistic maxLineLength that can fit the message
    const out = compressOutput(longLine, { maxLineLength: 50 })
    expect(out).toContain('chars truncated')
    // The output should not exceed maxLineLength
    expect(out.length).toBeLessThanOrEqual(50)
    // Should have some x's before the message
    expect(out).toMatch(/^x+…/)
  })

  it('truncates output exceeding maxLines with an elision marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const out = compressOutput(lines.join('\n'), { maxLines: 10 })
    const outLines = out.split('\n')
    expect(outLines.length).toBe(10)
    expect(out).toContain('lines elided by token-goat')
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

  it('compresses a large git diff: adds summary header and truncates each file hunk', () => {
    const lines = [
      'diff --git a/src/file.ts b/src/file.ts',
      '--- a/src/file.ts',
      '+++ b/src/file.ts',
    ]
    for (let i = 0; i < 200; i++) lines.push(`+line ${i}`)
    const out = compressOutput(lines.join('\n'))
    expect(out).toContain('[Git diff:')
    expect(out).toContain('truncated to 50 lines/file')
    // The truncation marker names the file once and cleanly. Pre-fix it read "more lines in a/src/file.ts b/src/file.ts" (the doubled header tail), so this exact substring is absent unless the filename is parsed correctly.
    expect(out).toContain('more lines in src/file.ts —')
    expect(out.split('\n').length).toBeLessThan(lines.length)
  })

  it('names a file with spaces correctly in the git-diff truncation marker', () => {
    const lines = ['diff --git a/my dir/my file.ts b/my dir/my file.ts']
    for (let i = 0; i < 200; i++) lines.push(`+line ${i}`)
    const out = compressOutput(lines.join('\n'))
    expect(out).toContain('more lines in my dir/my file.ts')
  })

  it('leaves a small git diff (<= 200 lines) unchanged by the git fast-path', () => {
    const lines = [
      'diff --git a/file.ts b/file.ts',
      '--- a/file.ts',
      '+++ b/file.ts',
      '+added line',
    ]
    const out = compressOutput(lines.join('\n'))
    expect(out).not.toContain('[Git diff:')
    expect(out).toContain('diff --git')
  })

  it('compresses multi-file git diff with per-file markers', () => {
    const lines: string[] = []
    for (let f = 0; f < 3; f++) {
      lines.push(`diff --git a/file${f}.ts b/file${f}.ts`)
      lines.push(`--- a/file${f}.ts`)
      lines.push(`+++ b/file${f}.ts`)
      for (let i = 0; i < 100; i++) lines.push(`+line ${i}`)
    }
    const out = compressOutput(lines.join('\n'))
    expect(out).toContain('[Git diff: 3 files changed')
    const markers = out.split('\n').filter(l => l.includes('more lines in'))
    expect(markers.length).toBe(3)
  })

  it('bounds total output on the git-diff fast path even when no single file hits the per-file cap', () => {
    // 300 files, each with only 4 lines (well under the 50-line/file cap) — the
    // per-file truncation alone never kicks in, so pre-fix this fast path
    // returned all ~1200 lines completely unbounded regardless of maxLines.
    const lines: string[] = []
    for (let f = 0; f < 300; f++) {
      lines.push(`diff --git a/file${f}.ts b/file${f}.ts`)
      lines.push(`--- a/file${f}.ts`)
      lines.push(`+++ b/file${f}.ts`)
      lines.push(`+line ${f}`)
    }
    const out = compressOutput(lines.join('\n'), { maxLines: 100 })
    const outLines = out.split('\n')
    expect(outLines.length).toBeLessThanOrEqual(100)
    expect(out).toContain('elided by token-goat')
  })

  it('falls back to the general path instead of a false "0 files changed" for an unrecognized diff format', () => {
    // A plain unified diff (only `--- a/`/`+++ b/` headers, no `diff --git`
    // line) still trips the fast-path's format sniff on its first line, but
    // the per-file parser can't find any `diff --git ` header to count.
    const lines = ['--- a/file1.ts', '+++ b/file1.ts']
    for (let i = 0; i < 200; i++) lines.push(`+line ${i}`)
    const out = compressOutput(lines.join('\n'))
    expect(out).not.toContain('0 files changed')
    expect(out).toContain('--- a/file1.ts')
    expect(out).toContain('+line 0')
  })
})
