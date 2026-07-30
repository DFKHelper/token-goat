/**
 * Markdown heading extraction and formatting for large-file hints.
 *
 * Provides utilities to parse markdown/RST files, extract heading structure,
 * and format user-friendly hints suggesting the token-goat section command.
 */

import { eachUnfencedLine } from '../markdown_lines.js'

/** Extract markdown headings (H1-H3 by default; H1-H6 when `limit` is Infinity) with their byte offsets */
export interface MarkdownHeading {
  level: number // 1-3 for a display-hint (finite limit) call, 1-6 for an Infinity-limit call
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
 * Extract markdown headings.
 * Parses ATX headings (# through ######) only — no setext style.
 * Skips headings inside fenced code blocks (``` or ~~~ fences).
 * @param limit Maximum number of headings to extract. Defaults to MAX_HEADINGS (40) for display
 *              hints, which also restricts extraction to H1-H3 for a readable outline. Pass
 *              Infinity for indexing/embedding to capture all headings, H1 through H6.
 */
export function extractMarkdownHeadings(content: string, limit: number = MAX_HEADINGS): MarkdownHeading[] {
  const headings: MarkdownHeading[] = []
  const lines = content.split('\n')

  for (const [i, line] of eachUnfencedLine(lines)) {
    if (!line) continue
    const match = /^(#+)\s+(.+?)(?:\s+#+\s*)?$/.exec(line)
    if (!match || match.length < 3) continue

    const hashes = match[1]!
    const headingText = match[2]!

    const level = hashes.length
    // Display hints (finite `limit`, the MAX_HEADINGS default) show only H1-H3 for a readable
    // outline. A caller passing `limit: Infinity` (parser.ts's buildEmbeddingBoundaries, for
    // embedding chunk boundaries) needs every real markdown heading level (ATX headings are
    // valid up to H6) so a doc's H4/H5 subsections still get their own chunk boundary instead of
    // being silently folded into a coarser parent chunk -- the function's own doc comment already
    // promises "Pass Infinity ... to capture all headings", which a hardcoded H1-H3-only filter
    // here was quietly breaking.
    const maxLevel = limit === Infinity ? 6 : 3
    if (level > maxLevel) continue

    const text = headingText.trim()
    if (!text) continue

    headings.push({
      level,
      text,
      lineNumber: i + 1,
    })

    if (headings.length >= limit) break
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
  lines.push(`  Tip: an unambiguous heading prefix also resolves (e.g. "Lesson 16" instead of the full heading text) — shorter to type and avoids shell-quoting issues with punctuation in long headings.`)
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
 *
 * A changelog is not guaranteed to carry the Keep-a-Changelog "## [Unreleased]" placeholder --
 * many projects omit it once there's nothing pending, or never adopted the convention at all.
 * Requiring it as a precondition meant a changelog with real version headings but no Unreleased
 * section always returned '', silently disabling this hint. If no Unreleased header is ever
 * seen, fall back to the first version heading found -- the intent is "point at the most recent
 * real version", not "require the Unreleased placeholder to exist".
 */
export function extractChangelogVersionHint(content: string, filePath: string): string {
  const lines = content.split('\n')
  let foundUnreleased = false
  let firstVersion: string | null = null

  for (const line of lines) {
    const m = /^##\s+(\[?[\d]+\.[\d]+\.[\d]+\]?)/.exec(line)
    if (m) {
      if (foundUnreleased) {
        const ver = m[1]
        return ` | token-goat section "${filePath}::${ver}"`
      }
      if (firstVersion === null) firstVersion = m[1] as string
    }
    if (/^##\s+\[?unreleased\]?/i.test(line)) {
      foundUnreleased = true
    }
  }
  if (!foundUnreleased && firstVersion !== null) {
    return ` | token-goat section "${filePath}::${firstVersion}"`
  }
  return ''
}
