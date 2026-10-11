/** Pure checks behind the Write/Edit pre-hook's partial-view guard (hooks_write.ts): a placeholder standing in for content the model did not write, and a whole-file Write that deletes lines the session never saw. Nothing here reads the disk or the session; the caller supplies old text, new text and the ranges served. */

import { removedLineIndexes } from './line_diff.js'
import { displaySafePath } from './paths.js'
import { echoedValue, fencedCommand, fileSubject, quotedArg } from './hint_suggestion_guard.js'

const ELLIPSIS = String.raw`(?:\.{3}|…)`
const COMMENT_LEAD = String.raw`(?:/{2,}|#+|/\*+|\*+|<!--|--|;+|%+|"""|''')`
const COMMENT_CLOSE = String.raw`(?:\*+/|-->|"""|''')`
const KEYWORD = String.raw`(?:rest|remainder|remaining|existing|unchanged|omitted|truncated|previous|same as)`
const SUBJECT = String.raw`(?:rest of (?:the )?(?:file|code|content|function|class|module|implementation|method)|existing (?:code|content|implementation)|remaining (?:code|content|lines|implementation)|previous (?:code|content))`
const TRAILER = String.raw`(?:(?:is |remains |stays |goes )?(?:unchanged|here|omitted|as[- ]is|the same|same as before|as before|above|below))`

const MAX_ELISION_LINE_CHARS = 120

const LEADING_COMMENT = new RegExp(`^${COMMENT_LEAD}`)
const TRAILING_COMMENT = new RegExp(`${COMMENT_CLOSE}$`)
const ANY_ELLIPSIS = new RegExp(ELLIPSIS, 'g')
const STARTS_WITH_ELLIPSIS = new RegExp(`^${ELLIPSIS}`)
const LOOSE_ELLIPSIS_COMMENT = new RegExp(`^${ELLIPSIS}\\s*\\S.{0,80}$`)
const LOOSE_NEEDS = new RegExp(`\\b${KEYWORD}\\b`, 'i')
const SUBJECT_ONLY = new RegExp(`^${SUBJECT}(?: ${TRAILER})?$`, 'i')
const BRACKET_NOTE = new RegExp(`^(?:truncated|omitted|content (?:truncated|omitted)|(?:remaining|rest of)[^\\]]{0,60}(?:omitted|truncated|unchanged)|\\d+ (?:more )?lines? (?:omitted|truncated|folded))$`, 'i')
const BARE_SUBJECT = /^(?:rest of|remaining|existing|unchanged)\b.{0,60}$/i
const FOLD_MARKER = new RegExp(`^${ELLIPSIS}\\s*\\d+\\s+(?:more\\s+)?lines?\\b.*\\bfolded\\b`, 'i')
const TOKEN_GOAT_NOTICE = /^\[token-goat[: ].{0,200}\]$/

/** The text with every ellipsis taken out and runs of whitespace folded to one space, so a pattern can name its words with a single space between them. */
function spaced(text: string): string {
  return text.replace(ANY_ELLIPSIS, ' ').replace(/\s+/g, ' ').trim()
}

/** Lines that say "something was left out here" instead of being the thing: a comment led by an ellipsis and an elision word, a comment that is only "rest of file" / "existing code" (with an optional "unchanged"-style tail), a bracketed `[truncated]` note, a bare `... rest of` line, and token-goat's own fold and notice markers, which a model copying a folded Read into a Write would carry along. Each form is anchored to the whole line and the line length is capped, so a comment that merely uses the words ("existing code path handles X") is not one. */
function isElisionLine(trimmed: string): boolean {
  if (trimmed === '' || trimmed.length > MAX_ELISION_LINE_CHARS) return false
  if (TOKEN_GOAT_NOTICE.test(trimmed) || FOLD_MARKER.test(trimmed)) return true
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return BRACKET_NOTE.test(spaced(trimmed.slice(1, -1)))
  if (STARTS_WITH_ELLIPSIS.test(trimmed)) return BARE_SUBJECT.test(trimmed.replace(STARTS_WITH_ELLIPSIS, '').replace(/^[\s[(]+/, ''))
  if (!LEADING_COMMENT.test(trimmed)) return false
  const body = trimmed.replace(LEADING_COMMENT, '').replace(TRAILING_COMMENT, '').trim()
  if (LOOSE_ELLIPSIS_COMMENT.test(body) && LOOSE_NEEDS.test(body)) return true
  return SUBJECT_ONLY.test(spaced(body))
}

/** The first placeholder line of `newText` whose trimmed text occurs nowhere in `knownText` (the file as it is now, plus an Edit's old_string), or null. A marker the file already carries is the file's own content, not something the model substituted. */
export function findNewElisionLine(newText: string, knownText: string): string | null {
  let known: Set<string> | undefined
  for (const raw of newText.split(/\r\n|\r|\n/)) {
    const trimmed = raw.trim()
    if (!isElisionLine(trimmed)) continue
    known ??= new Set(knownText.split(/\r\n|\r|\n/).map((l) => l.trim()))
    if (!known.has(trimmed)) return trimmed
  }
  return null
}

/** The lines an `apply_patch` patch adds, per file, in order. V4A marks an added line with a leading `+`, a file with a `*** Add File:` / `*** Update File:` header; a moved file is attributed to its new path. */
export function patchAddedLines(patch: string): Array<{ path: string; added: string[] }> {
  const files: Array<{ path: string; added: string[] }> = []
  let current: { path: string; added: string[] } | undefined
  for (const line of patch.split(/\r\n|\r|\n/)) {
    const header = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line)
    const moved = /^\*\*\* Move to: (.+)$/.exec(line)
    if (header !== null) {
      current = { path: header[1]!.trim(), added: [] }
      files.push(current)
    } else if (moved !== null && current !== undefined) {
      current.path = moved[1]!.trim()
    } else if (line.startsWith('*** ')) {
      current = undefined
    } else if (current !== undefined && line.startsWith('+')) {
      current.added.push(line.slice(1))
    }
  }
  return files
}

/** Inclusive 1-based line runs of `oldLines` that a rewrite into `newLines` removes and that fall outside every served range. Empty when nothing unseen is removed. */
export function unseenRemovedRuns(oldLines: string[], newLines: string[], served: ReadonlyArray<readonly [number, number]>): Array<[number, number]> {
  const unseen = removedLineIndexes(oldLines, newLines)
    .map((i) => i + 1)
    .filter((line) => !served.some(([s, e]) => line >= s && line <= e))
  const runs: Array<[number, number]> = []
  for (const line of unseen) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last[1] === line - 1) last[1] = line
    else runs.push([line, line])
  }
  return runs
}

/** Lines of unseen content a Write must drop before the guard speaks; below it the rewrite is a normal edit of a partly read file. */
export const BLIND_DROP_MIN_LINES = 5

export function countRunLines(runs: ReadonlyArray<readonly [number, number]>): number {
  return runs.reduce((sum, [s, e]) => sum + (e - s + 1), 0)
}

const ELISION_ADVICE = 'Write the real content, or change only the part you mean to with `Edit` or `token-goat replace`. If this exact text is intended, repeat the identical call and it goes through.'

export function placeholderMessage(line: string): string {
  const shown = echoedValue(line.length > 100 ? line.slice(0, 100) + '...' : line)
  return `This call writes a placeholder line (${shown}) that is not in the file now. Written as it stands, that line replaces whatever it stands for. ${ELISION_ADVICE}`
}

export function blindDropMessage(filePath: string, runs: ReadonlyArray<readonly [number, number]>): string {
  const total = countRunLines(runs)
  const named = [...runs].sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 3).sort((a, b) => a[0] - b[0])
  const shownPath = displaySafePath(filePath)
  const commands = named.map(([s, e]) => fencedCommand('token-goat read ' + quotedArg(`${shownPath}@${s}-${e}`)))
  return `This Write would delete ${total} lines of ${fileSubject(commands.join(' '), shownPath, filePath)} that this session never read in full (lines ${named.map(([s, e]) => (s === e ? String(s) : `${s}-${e}`)).join(', ')}). ` +
    `Read them first with ${commands.join(' or ')}, or change only what you mean to with \`Edit\` or \`token-goat replace\`. If dropping them is intended, repeat the identical call and it goes through.`
}
