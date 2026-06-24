/**
 * Common rendering helpers for consistent CLI output formatting.
 *
 * This module provides unified, reusable components for building terminal UI:
 * - ``renderTable`` — Creates a formatted table string with consistent styling
 * - ``renderList`` — Formats a bulleted list as a string
 * - ``renderPanel`` — Creates a panel string with consistent styling
 *
 * All helpers follow a single design system (colors, spacing, borders) so panels,
 * tables, and lists match across all CLI outputs.
 */

import { fg, C, RESET, padR } from './ansi.js'

/**
 * Create a formatted table string with consistent styling.
 *
 * Args:
 *   headers: Column header strings.
 *   rows: Each row is an array of cell values (strings).
 *   title: Optional table title (currently unused but reserved for future expansion).
 *
 * Returns:
 *   A formatted string ready to print.
 *
 * Example:
 *   const table = renderTable(
 *     ['Name', 'Value'],
 *     [['foo', '100'], ['bar', '200']],
 *   )
 *   console.log(table)
 */
export function renderTable(
  headers: string[],
  rows: string[][],
  _title?: string,
): string {
  if (headers.length === 0) return ''

  // Compute column widths
  const colWidths = headers.map((h) => h.length)
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i]
      if (cell !== undefined) {
        colWidths[i] = Math.max(colWidths[i] || 0, cell.length)
      }
    }
  }

  const lines: string[] = []

  // Header row
  const headerRow = headers
    .map((h, i) => padR(h, colWidths[i] || 0))
    .join('  ')
  lines.push(`${fg(...C.TEXT_BRIGHT)}${headerRow}${RESET}`)

  // Data rows
  for (const row of rows) {
    const cells = row.map((cell, i) => padR(cell, colWidths[i] || 0)).join('  ')
    lines.push(cells)
  }

  return lines.join('\n')
}

/**
 * Format a bulleted list as a string.
 *
 * Args:
 *   items: List of item strings.
 *   title: Optional title (currently unused but reserved for future expansion).
 *   bullet: The bullet character to prepend to each item (default: "•").
 *
 * Returns:
 *   A multi-line string with each item prefixed by the bullet character and one space.
 *
 * Example:
 *   const text = renderList(['item 1', 'item 2'], undefined, '—')
 *   console.log(text)
 *   // Output:
 *   // — item 1
 *   // — item 2
 */
export function renderList(items: string[], title?: string, bullet: string = '•'): string {
  return items.map((item) => `${bullet} ${item}`).join('\n')
}

/**
 * Create a panel string with consistent styling.
 *
 * Args:
 *   content: The panel content (string).
 *   title: Optional panel title.
 *   style: Panel border style (default: "dim"). Common values: "dim", "bright_cyan", "bold green".
 *          Note: Style parameter is accepted for API compatibility but text color is fixed.
 *
 * Returns:
 *   A formatted string with borders ready to print.
 *
 * Example:
 *   const panel = renderPanel('Hello, World!', 'Greeting')
 *   console.log(panel)
 */
export function renderPanel(content: string, title?: string, _style?: string): string {
  const lines = content.split('\n')
  const width = Math.max(title ? title.length : 0, ...lines.map((l) => l.length)) + 2

  const borderColor = fg(...C.TEXT_DIM)
  const titleColor = fg(...C.TEXT_BRIGHT)

  const result: string[] = []

  if (title) {
    result.push(`${borderColor}╭─ ${titleColor}${title}${borderColor} ─╮${RESET}`)
  } else {
    result.push(`${borderColor}╭${'─'.repeat(width)}╮${RESET}`)
  }

  for (const line of lines) {
    result.push(`${borderColor}│${RESET} ${line} ${borderColor}│${RESET}`)
  }

  result.push(`${borderColor}╰${'─'.repeat(width)}╯${RESET}`)

  return result.join('\n')
}
