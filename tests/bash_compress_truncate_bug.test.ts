import { describe, it, expect } from 'vitest'
import { compressOutput } from '../src/bash_compress.js'

describe('truncateLine output length constraint regression', () => {
  it('respects maxLineLength when adding truncation message', () => {
    // Regression test for bug: truncateLine appended "… [N chars truncated]" without accounting for the message length, causing the output to exceed maxLineLength.
    //
    // Example: with maxLineLength=500, a line of 1000 chars would produce: content[0:500] + "… [500 chars truncated]" = 500 + 23 chars = 523 chars which exceeds the 500 char limit.

    const longLine = 'x'.repeat(1000)
    const maxLineLength = 500

    const compressed = compressOutput(longLine, {
      stripAnsi: false,
      dedupeConsecutive: false,
      maxLines: 1000,
      maxLineLength,
    })

    const lines = compressed.split('\n')

    // All lines in output must respect maxLineLength
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(
        maxLineLength,
        `Line exceeds maxLineLength: ${line.length} > ${maxLineLength}`,
      )
    }

    // Should have a truncation message in the output
    expect(compressed).toContain('chars truncated')
  })
})
