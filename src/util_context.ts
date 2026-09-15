/**
 * Source context window building and rendering.
 */

import { readFileSync } from 'node:fs'

import { indexedSourceText } from './indexed_source.js'

/** One line of a source-context window: its 1-indexed line number and verbatim text. */
export interface SourceContextLine {
  readonly line: number
  readonly text: string
}

/**
 * Read an inclusive window of `contextLines` source lines either side of `line` (1-indexed)
 * out of `absPath`. Returns null when `contextLines` is not positive, the file cannot be read,
 * or `line` falls outside the file.
 */
export function buildContextWindow(absPath: string, line: number, contextLines: number): SourceContextLine[] | null {
  if (!Number.isFinite(contextLines) || contextLines <= 0) return null
  let text: string
  try {
    text = indexedSourceText(absPath, readFileSync(absPath, 'utf-8'))
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const idx = line - 1
  if (idx < 0 || idx >= lines.length) return null
  const start = Math.max(0, idx - contextLines)
  const end = Math.min(lines.length - 1, idx + contextLines)
  const out: SourceContextLine[] = []
  for (let i = start; i <= end; i++) out.push({ line: i + 1, text: lines[i] ?? '' })
  return out
}

/**
 * Render a context window in `grep`'s established form: the matched line as
 * `file:N: text` (plus `matchSuffix`), every surrounding line as `file-N- text`.
 */
export function renderContextWindow(
  displayFile: string,
  matchLine: number,
  window: readonly SourceContextLine[],
  matchSuffix = '',
  indent = '',
): string[] {
  return window.map((c) =>
    c.line === matchLine
      ? `${indent}${displayFile}:${c.line}: ${c.text}${matchSuffix}`
      : `${indent}${displayFile}-${c.line}- ${c.text}`,
  )
}
