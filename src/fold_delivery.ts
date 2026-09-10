/**
 * Turning a delivered slice of a source file into a folded one: pick the spans, render the notices.
 *
 * Split out of hooks_read.ts when the shell read path became a second caller. The two surfaces gate very differently (a Read is a whole file with a numbered rendering around it, a shell read is bare text from a command that may or may not pin its line numbers) but everything between "here are the delivered rows" and "here is the folded text" is identical, and that middle is where the index-freshness rule and the notice wording live. One copy, so a change to either reaches both.
 */
import { readFileSync, statSync } from 'node:fs'

import { commentSyntaxFor, mergeFolds, planBodyFolds, planCommentFolds, planProseFolds, type BodyFold, type FoldSpan } from './code_fold.js'
import { loadConfig } from './config.js'
import { fingerprintFile } from './fingerprint.js'
import { enqueueDirtyPathSafe } from './hooks_index.js'
import { getFileEntry, querySymbols } from './index_reader.js'
import { isTreeSitterAvailable, parseSourceSymbolsTreeSitterOnly } from './parser.js'
import { PARSER_FINGERPRINT } from './parser_fingerprint.js'
import { detectLanguage } from './parser_types.js'
import { findContainingSection } from './section_reader.js'

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
export function bodyFoldNotice(name: string, firstLine: number, lastLine: number, shownPath: string, declLine?: number): string {
  const n = lastLine - firstLine + 1
  // The anchor is emitted whenever the declaration line is known, never only when a duplicate name is detected: the fold sees one file's spans and cannot cheaply know whether a name is unique, and an anchored command resolves identically for one that is. The `file::symbol@LINE` grammar is resolveSymbolSpec's, adopted by graph_commands.ts for this same failure.
  const anchor = declLine === undefined ? '' : `@${declLine}`
  return `... ${n} more lines of ${name} (${firstLine}-${lastLine}) folded -- token-goat read "${shownPath}::${name}${anchor}"`
}

/**
 * The line standing in for a folded comment block.
 *
 * A comment has no symbol to name, so there is no `token-goat read "file::symbol"` that returns it. What does return it is a ranged Read of the exact span, which is also the one Read shape this fold never touches -- offset/limit reads are left alone as already surgical -- so the pointer cannot loop back into another fold.
 */
/** True when any of the three folds is enabled. The two hook entry points gate on this rather than on one setting each: which kind of fold a given file is eligible for is decided inside {@link foldDelivery} by what the file actually is, and a caller checking only one setting would make a file unfoldable no matter how the other two were left. */
export function foldingEnabled(): boolean {
  const hints = loadConfig().hints
  return hints.fold_code_bodies || hints.fold_comment_blocks || hints.fold_prose_paragraphs
}

/** Document extensions a prose fold applies to. Narrower than the shell path's `isDoc` classification, which also admits `.rst` and `.txt`: pointing a reader at `section` is harmless on any document, while folding one is only safe where the planner can recognise the structure it must leave alone, and every rule it has for that is markdown (fences, ATX headings, pipe tables, blockquotes). Against a `.txt` there is no markup at all to recognise, so a wrapped log record reads as a paragraph and folds to its first sentence with every stack frame after it discarded, and `.rst` marks its literal blocks by indentation and `..` directives that none of those rules see. */
const PROSE_FOLDABLE_EXT_RE = /\.(?:md|mdx|markdown)$/i

/** True for a path a prose fold may touch. */
export function isProseFoldablePath(normalizedPath: string): boolean {
  return PROSE_FOLDABLE_EXT_RE.test(normalizedPath)
}

/**
 * The opening sentence of a folded paragraph, followed by the pointer that returns the rest.
 *
 * Named a real, resolved heading via {@link findContainingSection} rather than a placeholder the reader has to work out themselves, which an earlier draft did and which this repo's own test suite caught as unactionable. A one-line ranged Read (`Read "file" with offset=N, limit=1`) looks more precise, and is the fallback below when no enclosing section can be resolved, but it is not safe as the default: prose folding only ever applies to a markdown/mdx document, and hooks_read.ts's large-markdown intercept hard-denies every re-read of a markdown file with 3+ headings regardless of how narrow the offset/limit window is (the branch's own comment says so: "regardless of size"). `token-goat section` is a CLI command, not a Read the intercept ever sees, so it is the one route guaranteed to round-trip for exactly the class of document this fold exists to shrink.
 */
export function proseFoldNotice(keep: string, line: number, shownPath: string, normalizedPath: string): string {
  const section = findContainingSection(normalizedPath, line, line)
  const pointer =
    section !== null
      ? `token-goat section "${shownPath}::${section.heading}"`
      : `Read "${shownPath}" with offset=${line}, limit=1`
  return `${keep} ... rest of paragraph folded (line ${line}) -- ${pointer}`
}

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

/** A folded delivery, as two renderings that are deliberately not parallel: `numbered` goes back to the model and carries a notice in place of each folded span, while `raw` goes to the served-output store and carries neither the folded lines nor the notice. That asymmetry is the point. The store answers "which lines of this file has the reader already been shown", so a folded line must be absent from it or a later read would withhold a line nobody ever saw, and the notice must be absent too because it is not a line of the file and would misalign every line after it. */
export interface FoldedDelivery {
  readonly numbered: string[]
  readonly raw: string[]
  readonly folds: readonly BodyFold[]
}

/** Largest file this will parse on the read path when the index cannot answer. A body fold is worth a few milliseconds and not a few hundred: past this the read stays whole and the enqueued reindex is left to serve the next one. */
const FOLD_SPAN_PARSE_MAX_BYTES = 400_000

/**
 * Symbol spans for a file the index cannot vouch for, parsed from disk on the spot.
 *
 * The index is the fast path and stays the fast path; this is what the miss falls back to. It exists because the miss is not the rare case it reads as. The freshness gate demands both a content hash and a parser stamp match, and the stamp changes whenever extraction logic does, which invalidates every already-indexed file at once. Measured on the live index while writing this: 46 of 17,952 files carried the shipping stamp, 0.3%, and 0 of 3,322 `.js` files did. Enqueueing the miss for reindex, which the caller does, heals a file for next time but returns nothing for this read, and a project that was never indexed at all is never healed by it either. So the lever that folds a long function body out of a delivered slice was firing on almost nothing.
 *
 * The whole file is parsed, never the delivered slice, and that is the point rather than an inefficiency. Spans have to be absolute file line numbers for {@link planBodyFolds} to place them, and a slice starting mid-body parses as a fragment whose recovered spans name the wrong lines. Parsing the file the reader is reading gives the same spans the indexer would have written, so a window is folded on the same evidence as a whole-file read.
 */
function parseFoldSpansFromDisk(normalizedPath: string, rows: readonly FoldRow[]): FoldSpan[] {
  try {
    if (statSync(normalizedPath).size > FOLD_SPAN_PARSE_MAX_BYTES) return []
    const language = detectLanguage(normalizedPath)
    if (!isTreeSitterAvailable(language)) return []
    const fileText = readFileSync(normalizedPath, 'utf-8')
    // The spans about to be produced are line numbers into this disk text, and they get applied to rows delivered by someone else. If the two disagree the fold cuts at a line the reader never saw, under a notice naming a symbol that is not there. So the delivered rows are checked against the file they claim to come from, and one mismatch abandons the whole file rather than a single span: once any line is displaced, every later line number is suspect too. Comparison ignores a trailing carriage return, which is the one difference a shell read legitimately introduces on this platform. This check is what makes the disk parse safer than the index path it falls back from, which only ever verified the index against disk and took delivered-equals-disk on trust.
    const diskLines = fileText.split('\n')
    for (const row of rows) {
      const disk = diskLines[row.no - 1]
      if (disk === undefined || disk.replace(/\r$/, '') !== row.text.replace(/\r$/, '')) return []
    }
    // Tree-sitter only, never the regex fallback: a regex adapter recovers a declaration line but not a reliable body end, and a body fold that trusts a wrong `lineEnd` withholds lines belonging to the next declaration under a notice naming this one.
    const symbols = parseSourceSymbolsTreeSitterOnly(fileText, normalizedPath, language)
    if (symbols === null) return []
    return symbols.slice(0, BODY_FOLD_SYMBOL_LIMIT).map((s) => ({ name: s.name, kind: s.kind, lineStart: s.lineStart, lineEnd: s.lineEnd }))
  } catch {
    // The file may have moved, been deleted or be unreadable since the read that delivered it, and a hook that already has the caller's output in hand must not turn that into a failure.
    return []
  }
}

/**
 * The symbol spans to fold against: from the index when it can vouch for them, otherwise parsed from disk.
 *
 * The spans come from the index, so they describe the file the indexer last parsed. Fold only when that is still this file, on BOTH freshness keys: files.sha answers "has the content changed", parser_sha answers "did different extraction logic write these rows". Content alone is not enough -- measured on a real index, 37 of 237 source files disagreed with what the current parser produced while their content sha still matched. A stale span cuts at the wrong line, and on a first read there is no earlier copy for the reader to notice that against.
 *
 * On a miss the file is queued for the worker's next drain, so the NEXT read of it can fold bodies too. Without this the miss is permanent for any file nothing happens to edit: measured over 201 session transcripts, 32 whole-file reads folded and another 22 would have once reindexed, worth 76% more folded bytes than the fold currently produces. Gated on a known comment syntax so reads of files the parser does not handle at all do not append to the queue on every read.
 *
 * A miss is not a decline. It falls through to {@link parseFoldSpansFromDisk}, which answers the same question from the file itself, so a project the indexer has never touched folds on its first read rather than on some later one.
 */
function resolveFoldSpans(normalizedPath: string, hasCommentSyntax: boolean, rows: readonly FoldRow[]): FoldSpan[] {
  try {
    const entry = getFileEntry(normalizedPath)
    if (entry !== null && entry.sha !== '' && entry.sha === fingerprintFile(normalizedPath) && entry.parserSha === PARSER_FINGERPRINT) {
      return querySymbols({ filePath: normalizedPath, limit: BODY_FOLD_SYMBOL_LIMIT })
    }
    if (hasCommentSyntax) enqueueDirtyPathSafe(normalizedPath)
  } catch {
    // A missing or locked index is not a reason to fail a read that already succeeded. An unusable index costs the body folds and nothing else: comment blocks are read off the delivered text, so they cannot be stale and do not need the index at all, which is what keeps this working on a file the indexer has never seen.
  }
  return parseFoldSpansFromDisk(normalizedPath, rows)
}

/**
 * Drop any fold touching the first or last delivered row, on a window only.
 *
 * This is what lets a windowed read fold comment blocks and prose paragraphs at all. The two notices point at a ranged Read of exactly the span they replaced, so before this the only way to stop a recall read from re-folding its own answer was to decline every window. A recall read delivers precisely the folded span, so any fold it plans spans every row it was given and touches both ends -- filtered here, and the reader gets the lines the notice promised. A fold strictly inside a wider window has no such loop: its recall is narrower than the window that produced it, and narrows again to nothing foldable.
 *
 * Deliberately keyed on row position rather than on a line-number comparison against the requested offset. The rows are what the reader is actually holding, so an off-by-one in an offset the harness reported cannot turn a fold that touches the edge into one that looks interior.
 */
function strictlyInteriorOnWindow(folds: readonly BodyFold[], rowCount: number, windowed: boolean): BodyFold[] {
  if (!windowed) return [...folds]
  return folds.filter((f) => f.startIdx > 0 && f.startIdx + f.len < rowCount)
}

/**
 * Fold the long bodies and long comment blocks out of one delivered slice of a file.
 *
 * Returns null when nothing is worth folding, which the callers treat as "leave the output exactly as it arrived". Header and trailer lines are the caller's business: a Read result carries a preamble this never sees, and a shell read has none.
 */
export function foldDelivery(rows: readonly FoldRow[], normalizedPath: string, shownPath: string, windowed = false): FoldedDelivery | null {
  const syntax = commentSyntaxFor(normalizedPath)
  // Resolved only when a body fold could use it. Spans cost a whole-file hash against the index plus, on a miss, an append to the dirty reindex queue, and both are pure waste for the caller that cannot fold bodies. That caller is now every stock install: prose folding ships on, so `foldingEnabled` is true everywhere and each read of a source file reaches this line, where the old default left it unreachable. A miss is also the common case rather than the rare one (measured on a real index, the parser stamp was stale on 95% of this project's files), so an unguarded call would enqueue most source files for reindex on every read and fold nothing at all in return.
  const foldBodies = loadConfig().hints.fold_code_bodies
  const spans = foldBodies ? resolveFoldSpans(normalizedPath, syntax !== null, rows) : []

  const bodyFolds = foldBodies ? planBodyFolds(rows, spans, BODY_FOLD_KEEP_LINES, BODY_FOLD_MIN_SPAN) : []
  const claimed = new Set<number>()
  for (const fold of bodyFolds) for (let i = fold.startIdx; i < fold.startIdx + fold.len; i++) claimed.add(i)
  const commentFolds = loadConfig().hints.fold_comment_blocks ? strictlyInteriorOnWindow(planCommentFolds(rows, syntax, COMMENT_FOLD_KEEP_LINES, COMMENT_FOLD_MIN_BLOCK, claimed), rows.length, windowed) : []
  for (const fold of commentFolds) for (let i = fold.startIdx; i < fold.startIdx + fold.len; i++) claimed.add(i)
  // Prose folding is the only thing that reaches a document, which has no symbol spans for the body planner and no comment syntax for the comment planner. It carries its own setting because the trade differs from code's: a folded body is recovered by naming its symbol, while a folded paragraph is recovered from the cached original.
  // Admitted on a window through {@link strictlyInteriorOnWindow} rather than declined outright. The decline this replaces was justified on the grounds that both notices point at a ranged Read of their own span, so a recall would re-fold and hand back less than was promised. That holds for the PROSE fold, whose pointer is `limit=1` on the very row it folded, which the planner would fold again to the same opening sentence. It does NOT hold for the comment fold, and the old comment here was wrong to claim it did: the recall range starts after the kept `/**` and summary line, and planCommentFolds needs an opening marker to enter a block, so the recalled rows are not a comment run and fold to nothing. Measured, not reasoned -- the test's positive control failed when it asserted otherwise. The edge filter is kept for both anyway, since it costs one predicate and makes the property structural rather than dependent on where a planner happens to place its kept lines. A body fold is never filtered, its pointer being a `token-goat read "file::symbol"` that does not re-enter this path.
  const proseFolds = isProseFoldablePath(normalizedPath) && loadConfig().hints.fold_prose_paragraphs ? strictlyInteriorOnWindow(planProseFolds(rows, claimed), rows.length, windowed) : []
  const folds = mergeFolds(mergeFolds(bodyFolds, commentFolds), proseFolds)
  if (folds.length === 0) return null

  const numbered: string[] = []
  const raw: string[] = []
  let at = 0
  for (const fold of folds) {
    for (let i = at; i < fold.startIdx; i++) {
      numbered.push(rows[i]?.raw ?? '')
      raw.push(rows[i]?.text ?? '')
    }
    // Written as an exhaustive switch rather than a ternary chain: a new fold kind added to `BodyFold` must fail to compile here instead of silently rendering as a body fold and naming a symbol that does not exist.
    let notice: string
    switch (fold.kind) {
      case 'comment':
        notice = commentFoldNotice(fold.firstLine, fold.lastLine, shownPath)
        break
      case 'prose':
        notice = proseFoldNotice(fold.keep ?? '', fold.firstLine, shownPath, normalizedPath)
        break
      case 'body':
        notice = bodyFoldNotice(fold.name, fold.firstLine, fold.lastLine, shownPath, fold.declLine)
        break
      default: {
        const unreachable: never = fold.kind
        throw new Error(`unhandled fold kind: ${String(unreachable)}`)
      }
    }
    numbered.push(notice)
    at = fold.startIdx + fold.len
  }
  for (let i = at; i < rows.length; i++) {
    numbered.push(rows[i]?.raw ?? '')
    raw.push(rows[i]?.text ?? '')
  }
  return { numbered, raw, folds }
}
