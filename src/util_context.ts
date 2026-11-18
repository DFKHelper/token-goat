/** Source context window building and rendering. */

import { readFileSync } from 'node:fs'

import { redactIfDotenv } from './dotenv_redact.js'
import { redactReadText } from './fence_cap.js'
import { indexedSourceText } from './indexed_source.js'
import { displaySafeText } from './paths.js'
import { assertReadAllowed } from './read_deny.js'

/** One line of a source-context window: its 1-indexed line number and verbatim text. */
export interface SourceContextLine {
  readonly line: number
  readonly text: string
}

/** The source lines within `contextLines` of `line` in `absPath`, redacted whole; null if none can be shown. */
export function buildContextWindow(absPath: string, line: number, contextLines: number): SourceContextLine[] | null {
  if (!Number.isFinite(contextLines) || contextLines <= 0) return null
  let text: string
  try {
    // A file the host denies, or a settings loader that throws, yields no window rather than its text.
    assertReadAllowed(absPath)
    text = redactReadText(redactIfDotenv(absPath, indexedSourceText(absPath, readFileSync(absPath, 'utf-8'))))
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

/** Render a context window in `grep`'s established form: the matched line as `file:N: text` (plus `matchSuffix`), every surrounding line as `file-N- text`. */
export function renderContextWindow(
  displayFile: string,
  matchLine: number,
  window: readonly SourceContextLine[],
  matchSuffix = '',
  indent = '',
): string[] {
  const shown = displaySafeText(displayFile)
  return window.map((c) =>
    c.line === matchLine
      ? `${indent}${shown}:${c.line}: ${c.text}${matchSuffix}`
      : `${indent}${shown}-${c.line}- ${c.text}`,
  )
}
