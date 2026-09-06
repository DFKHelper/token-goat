/**
 * Turning a delivered slice of a source file into a folded one: pick the spans, render the notices.
 *
 * Split out of hooks_read.ts when the shell read path became a second caller. The two surfaces gate very differently (a Read is a whole file with a numbered rendering around it, a shell read is bare text from a command that may or may not pin its line numbers) but everything between "here are the delivered rows" and "here is the folded text" is identical, and that middle is where the index-freshness rule and the notice wording live. One copy, so a change to either reaches both.
 */
import { commentSyntaxFor, mergeFolds, planBodyFolds, planCommentFolds, type BodyFold, type FoldSpan } from './code_fold.js'
import { fingerprintFile } from './fingerprint.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { getFileEntry, querySymbols } from './index_reader.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'

/** Lines kept at the head of each folded body: the declaration plus enough to judge the rest. */
export const BODY_FOLD_KEEP_LINES = 8

/**
 * Shortest function span worth folding, in lines.
 *
 * Measured with this code path over the 162 source files in this repo above 8 KB, against an index written by the same parser build: keep=10/span>=25 removes 34.8% of delivered bytes across 150 files, keep=20/span>=40 removes 25.8% across 126, keep=6/span>=15 removes 41.0% across 152. The aggressive setting cuts into bodies short enough to read at a glance, which is where a fold costs the reader more than it saves; this is the middle one.
 */
export const BODY_FOLD_MIN_SPAN = 20

/** Rows kept at the head of each folded comment block: enough for the summary a doc block opens with, and for a banner's title. */
export const COMMENT_FOLD_KEEP_LINES = 2

/**
 * Shortest comment block worth folding, in rows.
 *
 * Measured over this repo's 256 source files, holding keep=10/span>=25 fixed and varying only this: >=30 rows adds 2.6 points of first-read savings, >=20 adds 5.1, >=12 adds 9.9, >=8 adds 14.2. The last of those starts folding ordinary eight-line explanations, which is where the notice costs a reader more than the rationale it defers; 12 is the point where a block is an essay rather than a note.
 */
export const COMMENT_FOLD_MIN_BLOCK = 12

/** Symbols pulled per file. Matches ALL_SYMBOLS_IN_FILE_LIMIT without importing graph_commands. */
const BODY_FOLD_SYMBOL_LIMIT = 10000

/**
 * The line standing in for a folded body.
 *
 * It names the symbol, the exact line range removed, and the command that returns it -- everything needed to undo the fold without re-reading the file. Unlike a re-read elision, the reader has never seen these lines, so the notice must read as "here is what is missing and how to get it", not as a pointer to something already in context.
 */
export function bodyFoldNotice(name: string, firstLine: number, lastLine: number, shownPath: string): string {
  const n = lastLine - firstLine + 1
  return `... ${n} more lines of ${name} (${firstLine}-${lastLine}) folded -- token-goat read "${shownPath}::${name}"`
}

/**
 * The line standing in for a folded comment block.
 *
 * A comment has no symbol to name, so there is no `token-goat read "file::symbol"` that returns it. What does return it is a ranged Read of the exact span, which is also the one Read shape this fold never touches -- offset/limit reads are left alone as already surgical -- so the pointer cannot loop back into another fold.
 */
export function commentFoldNotice(firstLine: number, lastLine: number, shownPath: string): string {
  const n = lastLine - firstLine + 1
  return `... ${n} more comment lines (${firstLine}-${lastLine}) folded -- Read "${shownPath}" with offset=${firstLine}, limit=${n}`
}

/** One delivered line. `raw` is the form the caller has to put back on the wire (numbered, for a Read); `text` is the file's own line, which is what the served-output store compares against. On a shell read the two are the same string. */
export interface FoldRow {
  readonly no: number
  readonly text: string
  readonly raw: string
}

/** A folded delivery, as two parallel renderings: `numbered` goes back to the model, `raw` goes to the served-output store so a later read is matched against what was actually shown. Notices appear in both, because the reader did not see those lines either way. */
export interface FoldedDelivery {
  readonly numbered: string[]
  readonly raw: string[]
  readonly folds: readonly BodyFold[]
}

/**
 * The symbol spans to fold against, or an empty list when the index cannot vouch for them.
 *
 * The spans come from the index, so they describe the file the indexer last parsed. Fold only when that is still this file, on BOTH freshness keys: files.sha answers "has the content changed", parser_sha answers "did different extraction logic write these rows". Content alone is not enough -- measured on a real index, 37 of 237 source files disagreed with what the current parser produced while their content sha still matched. A stale span cuts at the wrong line, and on a first read there is no earlier copy for the reader to notice that against.
 *
 * On a miss the file is queued for the worker's next drain, so the NEXT read of it can fold bodies too. Without this the miss is permanent for any file nothing happens to edit: measured over 201 session transcripts, 32 whole-file reads folded and another 22 would have once reindexed, worth 76% more folded bytes than the fold currently produces. Gated on a known comment syntax so reads of files the parser does not handle at all do not append to the queue on every read.
 */
function resolveFoldSpans(normalizedPath: string, hasCommentSyntax: boolean): FoldSpan[] {
  try {
    const entry = getFileEntry(normalizedPath)
    if (entry !== null && entry.sha !== '' && entry.sha === fingerprintFile(normalizedPath) && entry.parserSha === PARSER_FINGERPRINT) {
      return querySymbols({ filePath: normalizedPath, limit: BODY_FOLD_SYMBOL_LIMIT })
    }
    if (hasCommentSyntax) enqueueDirtyPathSafe(normalizedPath)
  } catch {
    // A missing or locked index is not a reason to fail a read that already succeeded. An unusable index costs the body folds and nothing else: comment blocks are read off the delivered text, so they cannot be stale and do not need the index at all, which is what keeps this working on a file the indexer has never seen.
  }
  return []
}

/**
 * Fold the long bodies and long comment blocks out of one delivered slice of a file.
 *
 * Returns null when nothing is worth folding, which the callers treat as "leave the output exactly as it arrived". Header and trailer lines are the caller's business: a Read result carries a preamble this never sees, and a shell read has none.
 */
export function foldDelivery(rows: readonly FoldRow[], normalizedPath: string, shownPath: string): FoldedDelivery | null {
  const syntax = commentSyntaxFor(normalizedPath)
  const spans = resolveFoldSpans(normalizedPath, syntax !== null)

  const bodyFolds = planBodyFolds(rows, spans, BODY_FOLD_KEEP_LINES, BODY_FOLD_MIN_SPAN)
  const claimed = new Set<number>()
  for (const fold of bodyFolds) for (let i = fold.startIdx; i < fold.startIdx + fold.len; i++) claimed.add(i)
  const folds = mergeFolds(bodyFolds, planCommentFolds(rows, syntax, COMMENT_FOLD_KEEP_LINES, COMMENT_FOLD_MIN_BLOCK, claimed))
  if (folds.length === 0) return null

  const numbered: string[] = []
  const raw: string[] = []
  let at = 0
  for (const fold of folds) {
    for (let i = at; i < fold.startIdx; i++) {
      numbered.push(rows[i]?.raw ?? '')
      raw.push(rows[i]?.text ?? '')
    }
    const notice = fold.kind === 'comment' ? commentFoldNotice(fold.firstLine, fold.lastLine, shownPath) : bodyFoldNotice(fold.name, fold.firstLine, fold.lastLine, shownPath)
    numbered.push(notice)
    at = fold.startIdx + fold.len
  }
  for (let i = at; i < rows.length; i++) {
    numbered.push(rows[i]?.raw ?? '')
    raw.push(rows[i]?.text ?? '')
  }
  return { numbered, raw, folds }
}
