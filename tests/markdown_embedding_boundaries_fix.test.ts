/**
 * Regression test for markdown semantic-embedding boundaries capped at 40 headings.
 *
 * Bug: buildEmbeddingBoundaries was reusing extractMarkdownHeadings, which had a hard
 * cap of MAX_HEADINGS=40 for display hints. For markdown files with >40 headings, only
 * the first 40 boundaries were produced; section #41+ were collapsed into a single chunk
 * boundary with end=Number.MAX_SAFE_INTEGER, diluting semantic-search relevance.
 *
 * Fix: Pass Infinity limit to extractMarkdownHeadings for indexing so all headings
 * become section boundaries, not just the first 40.
 */

import { describe, expect, it } from 'vitest'
import { extractMarkdownHeadings } from '../src/hints/markdown_hints.js'

describe('extractMarkdownHeadings with custom limit for embedding boundaries', () => {
  it('respects the limit parameter defaulting to MAX_HEADINGS (40)', () => {
    // Create a doc with 50 headings
    const lines = Array.from({ length: 50 }, (_, i) => `# Heading ${i + 1}`)
    const content = lines.join('\n')

    // Default call (no limit param) should stop at 40
    const withDefaultLimit = extractMarkdownHeadings(content)
    expect(withDefaultLimit.length).toBe(40)
    expect(withDefaultLimit[39].text).toBe('Heading 40')
  })

  it('extracts all headings when limit is Infinity (for indexing use case)', () => {
    // Create a doc with 50 headings
    const lines = Array.from({ length: 50 }, (_, i) => `# Heading ${i + 1}`)
    const content = lines.join('\n')

    // With Infinity limit should get all 50
    const allHeadings = extractMarkdownHeadings(content, Infinity)
    expect(allHeadings.length).toBe(50)

    // Verify all headings are present, including past heading 40
    for (let i = 0; i < 50; i++) {
      expect(allHeadings[i].text).toBe(`Heading ${i + 1}`)
      expect(allHeadings[i].lineNumber).toBe(i + 1)
    }

    // Specific check: headings 40, 41, 42 should all be present
    expect(allHeadings[39].text).toBe('Heading 40')
    expect(allHeadings[40].text).toBe('Heading 41')
    expect(allHeadings[41].text).toBe('Heading 42')
  })

  it('respects custom numeric limits', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `# Heading ${i + 1}`)
    const content = lines.join('\n')

    // Custom limit of 20
    const withLimit20 = extractMarkdownHeadings(content, 20)
    expect(withLimit20.length).toBe(20)
    expect(withLimit20[19].text).toBe('Heading 20')

    // Custom limit of 100 (more than available)
    const withLimit100 = extractMarkdownHeadings(content, 100)
    expect(withLimit100.length).toBe(50) // Only 50 headings exist
  })

  it('produces distinct section boundaries when extracting >40 headings for embedding', () => {
    // Create markdown with 45 H2 sections, each with some body content
    // This simulates a real large API reference or changelog
    const sections: string[] = []
    for (let i = 1; i <= 45; i++) {
      sections.push(`## API Method ${i}`)
      sections.push('Parameters: ...something...')
      sections.push('Returns: ...value...')
      sections.push('')
    }
    const content = sections.join('\n')

    // Extract with Infinity (as buildEmbeddingBoundaries does for indexing)
    const headings = extractMarkdownHeadings(content, Infinity)

    // Should get all 45 headings
    expect(headings.length).toBe(45)

    // Verify line numbers are sequential and distinct
    for (let i = 0; i < headings.length; i++) {
      expect(headings[i].text).toBe(`API Method ${i + 1}`)
      if (i > 0) {
        // Each heading's line number should be greater than the previous
        expect(headings[i].lineNumber).toBeGreaterThan(headings[i - 1].lineNumber)
      }
    }

    // Specifically verify that headings 41-45 (past the old 40 cap) are present
    expect(headings[40].text).toBe('API Method 41')
    expect(headings[41].text).toBe('API Method 42')
    expect(headings[42].text).toBe('API Method 43')
    expect(headings[43].text).toBe('API Method 44')
    expect(headings[44].text).toBe('API Method 45')
  })
})
