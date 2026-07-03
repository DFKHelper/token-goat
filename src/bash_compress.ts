/**
 * Bash output compression pipeline.
 *
 * Ports the universal pre-filter pipeline from the Python `bash_compress`
 * module: collapse `\r`-overwrite progress to its final state, strip ANSI/VT
 * escape sequences, drop noise lines via {@link FILTERS}, dedupe consecutive
 * repeats, truncate over-long lines, and cap the total line count. The result
 * is the output a human would actually have cared about from a shell command,
 * not every byte the command emitted.
 *
 * Pure module: string in, string out, no I/O.
 */

import { FILTERS } from './filters.js'

/** Tunables for {@link compressOutput}. All have defaults matching the spec. */
export interface CompressOptions {
  /** Hard cap on a single line's length before it is truncated. Default 500. */
  maxLineLength?: number
  /** Max number of lines kept; the middle is elided past this. Default 2000. */
  maxLines?: number
  /** Strip ANSI/VT escape sequences. Default true. */
  stripAnsi?: boolean
  /** Collapse runs of identical consecutive lines. Default true. */
  dedupeConsecutive?: boolean
}

const DEFAULTS: Required<CompressOptions> = {
  maxLineLength: 500,
  maxLines: 2000,
  stripAnsi: true,
  dedupeConsecutive: true,
}

/**
 * Full VT/ANSI escape-sequence pattern.
 *
 * Ported verbatim from `render/ansi.py::_ANSI_ESCAPE_RE`. Covers CSI sequences
 * (SGR colour, cursor, erase), OSC sequences (terminal title / hyperlinks used
 * by pip/docker/cargo progress UIs), DCS/SOS/PM/APC strings, and bare two-byte
 * ESC sequences. The `s` (dotAll) flag lets OSC/DCS bodies span line breaks;
 * `g` is required for `String.replace` to remove every match.
 */
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex -- intentionally matches ESC (\x1B) and BEL (\x07) control bytes
  /\x1B\[[0-?]*[ -/]*[@-~]|\x1B\].*?(?:\x07|\x1B\\)|\x1B[PX^_].*?\x1B\\|\x1B[@-Z\\-_]/gs

/**
 * Remove all ANSI/VT escape sequences from `text`.
 *
 * Fast-pathed: if no ESC byte is present the input is returned unchanged so
 * the common case of already-clean output costs one `indexOf`.
 */
export function stripAnsiCodes(text: string): string {
  if (!text.includes('\x1B')) return text
  return text.replace(ANSI_ESCAPE_RE, '')
}

/**
 * Collapse `\r`-overwrite progress lines to their final rendered state.
 *
 * Terminal progress renderers emit `state1\rstate2\rstate3` so each update
 * overwrites the previous one on a real terminal; in a captured stream only the
 * segment after the last `\r` was ever visible. Lines without `\r` pass through.
 */
function stripProgress(text: string): string {
  if (!text.includes('\r')) return text
  return text
    .split('\n')
    .map((line) => {
      const idx = line.lastIndexOf('\r')
      return idx === -1 ? line : line.slice(idx + 1)
    })
    .join('\n')
}

/**
 * Collapse runs of identical consecutive lines to `line  (×N)`.
 *
 * Runs shorter than `minRun` (2) are emitted verbatim so a single line never
 * gets a spurious `(×1)`. The marker is appended after two spaces, preserving
 * the original line text so line-anchored greps still match. Non-consecutive
 * duplicates are left alone — their separation can carry meaning.
 */
function dedupeConsecutiveLines(lines: readonly string[], minRun = 2): string[] {
  const out: string[] = []
  let prev: string | null = null
  let count = 0

  const flush = (): void => {
    if (prev === null) return
    if (count >= minRun) {
      out.push(`${prev}  (×${count})`)
    } else {
      for (let i = 0; i < count; i++) out.push(prev)
    }
  }

  for (const line of lines) {
    if (line === prev) {
      count++
      continue
    }
    flush()
    prev = line
    count = 1
  }
  flush()
  return out
}

/**
 * Run every {@link FILTERS} entry over one line.
 *
 * The first filter whose `pattern` matches (or whose `pattern` is `null`) gets
 * to transform the line: it returns a replacement string or `null` to drop the
 * line. Returns the (possibly rewritten) line, or `null` when a filter removed
 * it. A line matching no filter is returned unchanged.
 */
function applyFilters(line: string): string | null {
  for (const filter of FILTERS) {
    if (filter.pattern === null || filter.pattern.test(line)) {
      return filter.replacer(line)
    }
  }
  return line
}

/** Truncate one line to `maxLineLength`, appending a count of elided chars. */
const safeSlice = (str: string, endIndex: number): string => {
  // Ensure we don't split a UTF-16 surrogate pair. If the code unit at endIndex
  // is a low surrogate (0xDC00-0xDFFF), back up one so the high surrogate stays with it.
  if (endIndex > 0 && endIndex < str.length) {
    const codeUnit = str.charCodeAt(endIndex)
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      endIndex--
    }
  }
  return str.slice(0, endIndex)
}

function truncateLine(line: string, maxLineLength: number): string {
  if (line.length <= maxLineLength) return line
  // The elided count itself sits in the message, and its digit width affects how much content fits. Reserve digits for the worst case (eliding the whole line) so the rendered message never overflows maxLineLength, then report the exact number of characters actually dropped (line.length - contentLength) — larger than the naive line.length - maxLineLength, since the message also costs budget.
  const reservedMessageLen = `… [${'9'.repeat(String(line.length).length)} chars truncated]`.length

  // If even the message alone can't fit, hard-slice (rare edge case).
  if (reservedMessageLen >= maxLineLength) {
    return safeSlice(line, maxLineLength)
  }

  const contentLength = maxLineLength - reservedMessageLen
  const elided = line.length - contentLength
  return `${safeSlice(line, contentLength)}… [${elided} chars truncated]`
}

/**
 * Keep the head and tail of an over-long line list, eliding the middle.
 *
 * Errors and a command's final summary usually sit at the two ends, so a 40/60
 * head/tail split keeps the most diagnostically useful lines. The elided count
 * is reported in a single marker line so the agent knows output was dropped.
 */
function truncateLines(lines: readonly string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return [...lines]
  if (maxLines < 2) {
    return [`... [${lines.length} lines elided by token-goat]`]
  }
  const headKeep = Math.max(1, Math.floor((maxLines - 1) * 0.4))
  const tailKeep = Math.max(0, maxLines - 1 - headKeep)
  const elided = lines.length - headKeep - tailKeep
  return [
    ...lines.slice(0, headKeep),
    `... [${elided} lines elided by token-goat]`,
    ...lines.slice(lines.length - tailKeep),
  ]
}

/**
 * Compress a large git diff output to keep the first 50 lines per file-diff hunk.
 *
 * Triggered when line count > 200 and the first line starts with `diff --git `
 * or `--- a/`. Each per-file hunk is capped at 50 lines; the remainder is
 * replaced by a single `[... N more lines in <name>]` marker. A summary
 * header is prepended so the reader knows how many files changed.
 */
// Returns null when the input doesn't contain a recognizable `diff --git `
// file header — callers should fall back to the general compression path
// rather than emit a misleading "0 files changed" summary for a diff format
// variant this parser doesn't understand (e.g. a plain unified diff with only
// `--- a/`/`+++ b/` headers and no `diff --git` line).
function compressGitDiff(lines: readonly string[]): string[] | null {
  const fileHeaders = lines.filter(l => l.startsWith('diff --git '))
  const nFiles = fileHeaders.length
  if (nFiles === 0) return null
  const result: string[] = [
    `[Git diff: ${nFiles} file${nFiles !== 1 ? 's' : ''} changed, truncated to 50 lines/file]`,
  ]

  let currentFileName = ''
  let currentHunk: string[] = []

  const flushHunk = (): void => {
    if (currentHunk.length === 0) return
    if (currentHunk.length <= 50) {
      result.push(...currentHunk)
    } else {
      result.push(...currentHunk.slice(0, 50))
      result.push(
        `[... ${currentHunk.length - 50} more lines in ${currentFileName} — use \`token-goat bash-output <id> --grep PATTERN\` to search]`,
      )
    }
    currentHunk = []
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushHunk()
      // A "diff --git a/<path> b/<path>" header repeats the path; show it once. Split on " b/" (not on a bare space) so paths containing spaces survive.
      currentFileName = line.slice('diff --git '.length).split(' b/')[0]?.replace(/^a\//, '') ?? ''
    }
    currentHunk.push(line)
  }
  flushHunk()

  return result
}

/**
 * Compress raw bash command output for low-token presentation.
 *
 * Pipeline order (each step assumes the previous ran):
 *   1. `\r`-progress collapse → final rendered state of each line.
 *   2. ANSI/VT escape stripping (when `stripAnsi`).
 *   3. CRLF/CR normalisation → `\n` line splitting.
 *   4. Git diff fast-path: if > 200 lines and output is a git diff, cap each
 *      file hunk at 50 lines instead of the generic head/tail truncation.
 *   5. Per-line {@link FILTERS}: drop/replace noise lines.
 *   6. Per-line length truncation at `maxLineLength`.
 *   7. Consecutive-duplicate dedupe (when `dedupeConsecutive`).
 *   8. Total line-count cap at `maxLines` with a middle elision marker.
 *
 * Empty or whitespace-only input returns the empty string.
 */
export function compressOutput(output: string, opts: CompressOptions = {}): string {
  if (output.length === 0) return ''

  const cfg: Required<CompressOptions> = { ...DEFAULTS, ...opts }

  // Normalise CRLF → LF FIRST so a trailing `\r` from a Windows line ending is not mistaken for a carriage-return overwrite. After this, the only `\r` left is a true mid-stream overwrite, which stripProgress collapses.
  let text = output.replace(/\r\n/g, '\n')
  text = stripProgress(text)
  if (cfg.stripAnsi) text = stripAnsiCodes(text)

  // Any remaining lone `\r` (rare) is treated as a line break for splitting.
  const rawLines = text.replace(/\r/g, '\n').split('\n')

  // Git diff fast-path: large diffs get per-file truncation instead of head/tail.
  // The per-file cap alone doesn't bound total output when a diff touches many
  // files, so the result still goes through the same per-line-length and overall
  // maxLines truncation as the general path below — no code path may emit
  // unbounded output. If the parser can't recognize the diff format
  // (compressGitDiff returns null), fall through to the general path instead of
  // returning a misleading "0 files changed" summary.
  if (rawLines.length > 200) {
    const firstLine = rawLines[0] ?? ''
    if (firstLine.startsWith('diff --git ') || firstLine.startsWith('--- a/')) {
      const diffLines = compressGitDiff(rawLines)
      if (diffLines !== null) {
        const capped = diffLines.map((l) => truncateLine(l, cfg.maxLineLength))
        return truncateLines(capped, cfg.maxLines).join('\n')
      }
    }
  }

  let lines: string[] = []
  for (const raw of rawLines) {
    const filtered = applyFilters(raw)
    if (filtered === null) continue
    lines.push(truncateLine(filtered, cfg.maxLineLength))
  }

  if (cfg.dedupeConsecutive) lines = dedupeConsecutiveLines(lines)
  lines = truncateLines(lines, cfg.maxLines)

  return lines.join('\n')
}
