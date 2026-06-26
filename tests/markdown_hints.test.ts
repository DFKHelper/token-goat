import { describe, expect, it } from 'vitest'

import {
  extractMarkdownHeadings,
  formatHeadingTree,
  getWellKnownSections,
  extractChangelogVersionHint,
  MARKDOWN_SIZE_THRESHOLD,
} from '../src/hints/markdown_hints.js'

describe('extractMarkdownHeadings', () => {
  it('extracts H1-H3 ATX headings with line numbers', () => {
    const content = `# Heading 1
Some text here
## Heading 2
More text
### Heading 3
Even more text`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(3)
    expect(headings[0]).toEqual({
      level: 1,
      text: 'Heading 1',
      lineNumber: 1,
    })
    expect(headings[1]).toEqual({
      level: 2,
      text: 'Heading 2',
      lineNumber: 3,
    })
    expect(headings[2]).toEqual({
      level: 3,
      text: 'Heading 3',
      lineNumber: 5,
    })
  })

  it('skips H4+ headings', () => {
    const content = `# Title
#### Skipped H4
##### Skipped H5`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(1)
    expect(headings[0].text).toBe('Title')
  })

  it('handles headings with trailing whitespace', () => {
    const content = `# Title   \n## Heading  `
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(2)
    expect(headings[0].text).toBe('Title')
    expect(headings[1].text).toBe('Heading')
  })

  it('skips empty or whitespace-only headings', () => {
    const content = `# Valid
#
## Also Valid
###`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(2)
  })

  it('stops at MAX_HEADINGS (40)', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `# Heading ${i + 1}`)
    const content = lines.join('\n')
    const headings = extractMarkdownHeadings(content)
    expect(headings.length).toBe(40)
  })

  it('returns empty array for content with no headings', () => {
    const content = `Just plain text
No headings here`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(0)
  })

  it('handles .rst-style headings (they should NOT match ATX)', () => {
    const content = `Title
=====

Subtitle
--------`
    const headings = extractMarkdownHeadings(content)
    expect(headings).toHaveLength(0)
  })
})

describe('formatHeadingTree', () => {
  it('formats headings with proper indentation', () => {
    const headings = [
      { level: 1, text: 'Title', lineNumber: 1 },
      { level: 2, text: 'Section', lineNumber: 3 },
      { level: 3, text: 'Subsection', lineNumber: 5 },
    ]
    const result = formatHeadingTree(headings, '/project/README.md')
    expect(result).toContain('Large markdown file (3 headings)')
    expect(result).toContain('token-goat section "/project/README.md::Heading Name"')
    expect(result).toContain('# Title')
    expect(result).toContain('  ## Section')
    expect(result).toContain('    ### Subsection')
  })

  it('handles duplicate headings with #2, #3 suffixes', () => {
    const headings = [
      { level: 2, text: 'Usage', lineNumber: 2 },
      { level: 2, text: 'Usage', lineNumber: 10 },
      { level: 2, text: 'Usage', lineNumber: 20 },
    ]
    const result = formatHeadingTree(headings, '/README.md')
    expect(result).toContain('## Usage')
    expect(result).toContain('## Usage #2')
    expect(result).toContain('## Usage #3')
  })

  it('caps output at MAX_OUTPUT_LINES (60)', () => {
    const headings = Array.from({ length: 100 }, (_, i) => ({
      level: 1,
      text: `Heading ${i + 1}`,
      lineNumber: i + 1,
    }))
    const result = formatHeadingTree(headings, '/README.md')
    const lines = result.split('\n')
    expect(lines.length).toBeLessThanOrEqual(60)
    expect(result).toContain('... (')
    expect(result).toContain('more headings)')
  })

  it('returns empty string for empty headings array', () => {
    const result = formatHeadingTree([], '/README.md')
    expect(result).toBe('')
  })
})

describe('getWellKnownSections', () => {
  it('returns Unreleased for CHANGELOG.md', () => {
    const sections = getWellKnownSections('CHANGELOG.md')
    expect(sections).toEqual(['Unreleased'])
  })

  it('returns expected sections for README.md', () => {
    const sections = getWellKnownSections('README.md')
    expect(sections).toContain('Install')
    expect(sections).toContain('Usage')
    expect(sections).toContain('API')
  })

  it('returns expected sections for CONTRIBUTING.md', () => {
    const sections = getWellKnownSections('CONTRIBUTING.md')
    expect(sections).toContain('Setup')
    expect(sections).toContain('Commands')
  })

  it('returns expected sections for CLAUDE.md', () => {
    const sections = getWellKnownSections('CLAUDE.md')
    expect(sections).toContain('Commands')
    expect(sections).toContain('Architecture')
  })

  it('returns expected sections for CLAUDE.arch.md', () => {
    const sections = getWellKnownSections('CLAUDE.arch.md')
    expect(sections).toContain('Component Map')
    expect(sections).toContain('Architecture')
  })

  it('returns empty array for unknown file', () => {
    const sections = getWellKnownSections('random.md')
    expect(sections).toEqual([])
  })

  it('returns empty array for non-markdown files', () => {
    const sections = getWellKnownSections('index.ts')
    expect(sections).toEqual([])
  })
})

describe('extractChangelogVersionHint', () => {
  it('finds the most recent version after Unreleased', () => {
    const content = `# Changelog

## [Unreleased]

## [1.2.3] - 2024-01-15

Some changes here

## [1.2.2] - 2023-12-01`
    const hint = extractChangelogVersionHint(content, '/CHANGELOG.md')
    expect(hint).toContain('[1.2.3]')
    expect(hint).toContain('token-goat section')
    expect(hint).toContain('/CHANGELOG.md')
  })

  it('handles version without brackets', () => {
    const content = `## [Unreleased]

## 2.0.0 - 2024-06-01`
    const hint = extractChangelogVersionHint(content, '/CHANGELOG.md')
    expect(hint).toContain('2.0.0')
  })

  it('returns empty string when no version found', () => {
    const content = `# Changelog

Only unreleased changes here`
    const hint = extractChangelogVersionHint(content, '/CHANGELOG.md')
    expect(hint).toBe('')
  })

  it('skips Unreleased and finds the first real version', () => {
    const content = `## Unreleased

Changes here

## 1.0.0 - 2024-01-01`
    const hint = extractChangelogVersionHint(content, '/CHANGELOG.md')
    expect(hint).toContain('1.0.0')
  })

  it('returns empty string when file has no Unreleased but no versions', () => {
    const content = `# Changelog

Some prose about versioning`
    const hint = extractChangelogVersionHint(content, '/CHANGELOG.md')
    expect(hint).toBe('')
  })
})

describe('MARKDOWN_SIZE_THRESHOLD', () => {
  it('is set to 8000 bytes', () => {
    expect(MARKDOWN_SIZE_THRESHOLD).toBe(8000)
  })
})
