/**
 * Markdown heading extraction and formatting for large-file hints.
 *
 * Provides utilities to parse markdown/RST files, extract heading structure,
 * and format user-friendly hints suggesting the token-goat section command.
 */

import { eachUnfencedLine } from '../markdown_lines.js'

/** Extract H1-H3 headings from markdown content with their byte offsets */
export interface MarkdownHeading {
  level: number // 1, 2, or 3
  text: string // heading text (stripped of #s)
  lineNumber: number // 1-based
}

/** Size threshold (bytes) above which to analyze markdown files for structure. */
export const MARKDOWN_SIZE_THRESHOLD = 8000

/** Maximum number of headings to extract and display. */
const MAX_HEADINGS = 40

/** Maximum number of output lines in the formatted heading tree. */
const MAX_OUTPUT_LINES = 60

/**
 * Extract H1-H3 headings from markdown content.
 * Parses ATX headings (# ## ###) only — no setext style.
 * Skips headings inside fenced code blocks (``` or ~~~ fences).
 * Returns up to MAX_HEADINGS headings.
 */
export function extractMarkdownHeadings(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  const lines = content.split('\n')

  for (const [i, line] of eachUnfencedLine(lines)) {
    if (!line) continue
    const match = /^(#+)\s+(.+?)\s*$/.exec(line)
    if (!match || match.length < 3) continue

    const hashes = match[1]!
    const headingText = match[2]!

    const level = hashes.length
    if (level > 3) continue // Only H1-H3

    const text = headingText.trim()
    if (!text) continue

    headings.push({
      level,
      text,
      lineNumber: i + 1,
    })

    if (headings.length >= MAX_HEADINGS) break
  }

  return headings
}

/**
 * Format headings as a compact hint block for user display.
 * Handles duplicate headings by appending #2, #3 etc.
 * Caps output at MAX_OUTPUT_LINES.
 */
export function formatHeadingTree(headings: MarkdownHeading[], filePath: string): string {
  if (headings.length === 0) return ''

  const seenTexts = new Map<string, number>()
  const dedupedHeadings: Array<{ text: string; level: number }> = []

  for (const h of headings) {
    const count = (seenTexts.get(h.text) ?? 0) + 1
    seenTexts.set(h.text, count)

    const suffix = count > 1 ? ` #${count}` : ''
    dedupedHeadings.push({
      text: h.text + suffix,
      level: h.level,
    })
  }

  const lines: string[] = []
  lines.push(`Large markdown file (${headings.length} headings). Use token-goat section to read a specific section:`)
  lines.push(`  token-goat section "${filePath}::Heading Name"`)
  lines.push(``)
  lines.push(`Sections:`)

  let headingsAdded = 0
  for (const h of dedupedHeadings) {
    // Check if adding this heading would exceed the limit Account for the 5 lines of header + this line
    if (lines.length + 1 >= MAX_OUTPUT_LINES) {
      const remaining = dedupedHeadings.length - headingsAdded
      lines.push(`  ... (${remaining} more headings)`)
      break
    }

    const indent = h.level === 1 ? '' : h.level === 2 ? '  ' : '    '
    const marker = '#'.repeat(h.level)
    lines.push(`  ${indent}${marker} ${h.text}`)
    headingsAdded++
  }

  return lines.join('\n')
}

/** Per-file well-known section shortcuts */
export const WELL_KNOWN_SECTIONS: Record<string, string[]> = {
  'CHANGELOG.md': ['Unreleased'],
  'README.md': ['Install', 'Usage', 'API', 'Configuration', 'Getting Started'],
  'CONTRIBUTING.md': ['Setup', 'Commands', 'Testing', 'Development'],
  'CLAUDE.md': ['Commands', 'Architecture'],
  'CLAUDE.arch.md': ['Component Map', 'Architecture'],
}

/**
 * Get well-known sections for a given basename.
 * Returns an empty array if the file is not recognized.
 */
export function getWellKnownSections(basename: string): string[] {
  return WELL_KNOWN_SECTIONS[basename] ?? []
}

/**
 * Extract the most recent versioned heading from CHANGELOG.md content.
 * Returns a section command string for the most recent version after Unreleased,
 * or empty string if none found.
 */
export function extractChangelogVersionHint(content: string, filePath: string): string {
  const lines = content.split('\n')
  let foundUnreleased = false

  for (const line of lines) {
    const m = /^##\s+(\[?[\d]+\.[\d]+\.[\d]+\]?)/.exec(line)
    if (m) {
      if (foundUnreleased && !line.toLowerCase().includes('unreleased')) {
        const ver = m[1]
        return ` | token-goat section "${filePath}::${ver}"`
      }
    }
    if (/^##\s+\[?unreleased\]?/i.test(line)) {
      foundUnreleased = true
    }
  }
  return ''
}
