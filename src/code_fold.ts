/**
 * Body folding: keep a source file's structure, replace the inside of long function bodies with a pointer to the command that returns them in full.
 *
 * This exists because the re-read machinery cannot help a *first* read. Every dedup mechanism in hooks_read.ts keys on prior sight -- served runs, identical-read collapse, the heading-tree re-read deny -- and a first read has none, which is where 83.6% of hooked Read bytes are.
 *
 * The unit is the body, not the symbol. A skeleton (signatures only) is 12.0% of what a Read delivers, measured over this repo's 162 source files above 8 KB, so serving one withholds 88% of the file: that is a deny wearing a preview, and it carries a deny's costs (a round trip, an abandonment risk, an edit-error spike) without saying so. Keeping the first lines of each body instead leaves the reader everything a skeleton has plus enough of each implementation to judge whether it needs the rest -- and the rest is one named command away rather than a re-read of the whole file.
 *
 * Long comment blocks fold too, and that reverses an earlier decision recorded here. The old rule was that comments are never touched, on the grounds that they are 46% of this repo's source bytes and carry the design rationale, so removing them would be the largest available saving and the least honest one. That objection was aimed at *stripping*, and it still holds against stripping. What happens here is the same bargain the body fold already makes: the first `commentKeep` lines survive, which is the summary a doc block opens with, and only the rationale underneath is replaced by a notice carrying the exact line range to read back. The contract a reader needs in order to decide whether they want the rest stays on screen. Measured over this repo's 256 source files, folding blocks of 12 lines or more adds 9.9 percentage points of first-read savings, the largest single lever left.
 *
 * What is deliberately never folded:
 * - a `class` or `interface` span, which encloses its members: folding one would swallow every method signature in the type, exactly the structure this is supposed to preserve. Widening to those two kinds measures +6.4 points and is rejected for that reason.
 * - anything outside a symbol span or a comment block: imports and the code between declarations.
 * - a span shorter than `minSpan`, or a comment block shorter than `commentMinBlock`, where the notice costs more than the lines it removes.
 * - a span nested inside one already folded, which would double-count the same lines.
 */

/** An indexed symbol's line span, as `querySymbols` returns it. Line numbers are 1-based. */
export interface FoldSpan {
  readonly name: string
  readonly kind: string
  readonly lineStart: number
  readonly lineEnd: number
}

/** One stretch of rows to replace with a notice. Indices are into the row array, not line numbers. */
export interface BodyFold {
  readonly startIdx: number
  readonly len: number
  readonly name: string
  /** Which notice the renderer writes. A body fold points at `token-goat read "file::name"`; a comment fold has no symbol to name, so it points at a ranged Read of the line span instead; a prose fold replaces one long paragraph with its own opening sentence, held in {@link keep}. */
  readonly kind: 'body' | 'comment' | 'prose'
  /** For a prose fold, the opening sentence to keep in place of the paragraph. Absent on every other kind, which drop their rows outright. */
  readonly keep?: string
  /** 1-based file line numbers of the first and last folded line, for the notice text. */
  readonly firstLine: number
  readonly lastLine: number
}

/**
 * Kinds whose body is an implementation a reader can defer. A `class` or `interface` span encloses its members, so folding it would swallow every method signature in the type -- exactly the structure this is supposed to preserve.
 *
 * `variable` is here because a long one is a data literal: the declaration line says what it is and the rest is detail, which is body-shaped in every way that matters. In this repo it is 64 of the spans that clear a 20-line minimum, worth 3.5 points of first-read savings. A `variable` holding an arrow function is caught by this entry rather than by its nested `function` span, and the outermost-first ordering below makes the two agree instead of racing.
 *
 * `type` is NOT here, for the same reason `interface` is not: a long type alias is a union or an object shape, so folding it swallows exactly the member signatures this is meant to keep. It is also worth nothing here -- one span in this repo clears the minimum.
 */
const FOLDABLE_KINDS = new Set(['function', 'method', 'func', 'def', 'fn', 'procedure', 'constructor', 'variable'])

/**
 * Fewest rows a fold must remove to be worth its notice.
 *
 * The notice is roughly 60-90 bytes and a source line averages well above that, but a run of short lines (a closing brace, a bare `return`) can undercut it. The byte-level net-savings gate in the caller is the real arbiter; this only skips the cases that obviously cannot pay.
 */
const MIN_FOLDED_ROWS = 3

/**
 * Choose the body stretches to fold.
 *
 * `rows` is the delivered read in order, each carrying its 1-based file line number. It is not assumed to start at line 1 or to be contiguous with the file: a read that delivered a window still folds correctly, because every span is mapped through the rows actually present and a span reaching past them is clipped to what was delivered.
 *
 * Returns folds sorted by position and guaranteed non-overlapping.
 */
export function planBodyFolds(
  rows: ReadonlyArray<{ readonly no: number }>,
  spans: readonly FoldSpan[],
  keep: number,
  minSpan: number,
): BodyFold[] {
  if (rows.length === 0 || spans.length === 0 || keep < 1) return []

  // Line number -> row index. Built once: a per-span scan would be quadratic on a large file.
  const rowAt = new Map<number, number>()
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row !== undefined) rowAt.set(row.no, i)
  }

  // Outermost-first, so a nested helper is skipped by the containment test below rather than racing its parent. Ties on start go to the longer span for the same reason.
  const ordered = [...spans].sort((a, b) => a.lineStart - b.lineStart || b.lineEnd - a.lineEnd)

  // Lowest line number actually delivered, which is the earliest declaration a reader could have seen. Taken as a minimum rather than from `rows[0]` because nothing here promises the rows arrive in line order.
  let firstDeliveredLine: number | null = null
  for (const line of rowAt.keys()) if (firstDeliveredLine === null || line < firstDeliveredLine) firstDeliveredLine = line

  const folds: BodyFold[] = []
  let foldedThrough = -1
  for (const span of ordered) {
    if (!FOLDABLE_KINDS.has(span.kind)) continue
    if (span.lineEnd - span.lineStart + 1 < minSpan) continue
    // Nested inside a span already folded: its lines are gone, and a second notice for them would claim the same bytes twice.
    if (span.lineStart <= foldedThrough) continue

    // The declaration has to be one of the delivered rows. Clipping to the window below is what lets a span run past the end of a windowed read, but it says nothing about a window that sits *inside* a span: there every delivered row is body, the clip removes nothing, and the whole window folds to a notice pointing at a symbol whose declaration the reader never saw. A caller asking for lines 100-140 gets none of them back. A whole-file read starts at line 1, so no span can fail this and the shipped behaviour there is unchanged.
    if (firstDeliveredLine !== null && span.lineStart < firstDeliveredLine) continue

    // Keep the declaration plus `keep - 1` lines of body, fold from there to the end of the span. The closing line is folded with the rest: a lone `}` left behind reads as a truncation.
    const firstFolded = span.lineStart + keep
    if (firstFolded > span.lineEnd) continue

    // Clip to rows actually delivered. A span may run past the end of a windowed read.
    let startIdx = -1
    let endIdx = -1
    for (let line = firstFolded; line <= span.lineEnd; line++) {
      const idx = rowAt.get(line)
      if (idx === undefined) continue
      if (startIdx < 0) startIdx = idx
      endIdx = idx
    }
    if (startIdx < 0 || endIdx < startIdx) continue

    // The clipped run must be contiguous in the row array. A gap means the delivered rows skip a line inside the span, and folding across the gap would remove rows the span never covered.
    const len = endIdx - startIdx + 1
    const firstRow = rows[startIdx]
    const lastRow = rows[endIdx]
    if (firstRow === undefined || lastRow === undefined) continue
    if (lastRow.no - firstRow.no + 1 !== len) continue
    if (len < MIN_FOLDED_ROWS) continue

    folds.push({ startIdx, len, name: span.name, kind: 'body', firstLine: firstRow.no, lastLine: lastRow.no })
    foldedThrough = span.lineEnd
  }

  return folds
}

/**
 * Comment syntax by file extension, for {@link planCommentFolds}.
 *
 * Keyed on extension rather than sniffed from content on purpose. A run of lines starting with `#` is a comment block in Python and a run of headings in Markdown, and folding a document's headings would destroy the one structure a reader navigates by. An extension this map does not list gets no comment folding at all, which is the safe direction: the cost is a missed saving, not a mangled read.
 */
export interface CommentSyntax {
  readonly line: readonly string[]
  readonly open?: string
  readonly close?: string
}

const SLASH_STAR: CommentSyntax = { line: ['//'], open: '/*', close: '*/' }
const HASH: CommentSyntax = { line: ['#'] }
const DOUBLE_DASH: CommentSyntax = { line: ['--'] }

const COMMENT_SYNTAX: ReadonlyMap<string, CommentSyntax> = new Map<string, CommentSyntax>([
  ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'go', 'rs', 'swift', 'kt', 'scala', 'php', 'dart'].map(
    (ext): [string, CommentSyntax] => [ext, SLASH_STAR],
  ),
  ...['py', 'rb', 'sh', 'bash', 'zsh', 'pl', 'r'].map((ext): [string, CommentSyntax] => [ext, HASH]),
  ...['sql', 'lua', 'hs'].map((ext): [string, CommentSyntax] => [ext, DOUBLE_DASH]),
])

/** Comment syntax for `path`, or null when the extension is unknown -- see {@link COMMENT_SYNTAX} on why an unknown extension folds nothing. */
export function commentSyntaxFor(path: string): CommentSyntax | null {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return null
  return COMMENT_SYNTAX.get(path.slice(dot + 1).toLowerCase()) ?? null
}

/**
 * Choose the comment blocks to fold.
 *
 * A block is a run of consecutive delivered rows that are all comment, either line comments sharing a prefix or the inside of a `/* ... *\/` pair. The first `commentKeep` rows of the run survive, so a doc block keeps its summary and a banner keeps its title; everything after is folded into one notice.
 *
 * `occupied` carries the row indices already claimed by {@link planBodyFolds}, because a doc comment sitting inside a folded function body is gone already and a second notice for it would claim the same bytes twice. Passing an empty set is correct when body folds were not planned, which is what happens when the index is stale: comment blocks come from the delivered text itself and are never stale, so they still fold.
 *
 * Returns folds sorted by position and guaranteed neither overlapping each other nor anything in `occupied`.
 */
export function planCommentFolds(
  rows: ReadonlyArray<{ readonly no: number; readonly text: string }>,
  syntax: CommentSyntax | null,
  commentKeep: number,
  commentMinBlock: number,
  occupied: ReadonlySet<number>,
): BodyFold[] {
  if (syntax === null || rows.length === 0 || commentKeep < 1 || commentMinBlock < 1) return []

  const folds: BodyFold[] = []
  let i = 0
  let inBlock = false
  while (i < rows.length) {
    const start = i
    // Walk forward while rows stay comment. `inBlock` persists across the loop body so a `/* ... */` spanning many rows counts as one run rather than restarting at each line.
    while (i < rows.length) {
      const text = rows[i]?.text ?? ''
      const trimmed = text.trim()
      if (inBlock) {
        if (syntax.close !== undefined && trimmed.includes(syntax.close)) inBlock = false
        i++
        continue
      }
      if (syntax.open !== undefined && trimmed.startsWith(syntax.open)) {
        // A single-row `/* ... */` opens and closes on the same row and must not set `inBlock`.
        if (syntax.close === undefined || !trimmed.slice(syntax.open.length).includes(syntax.close)) inBlock = true
        i++
        continue
      }
      if (syntax.line.some(p => trimmed.startsWith(p))) {
        i++
        continue
      }
      break
    }

    const runLen = i - start
    if (runLen >= commentMinBlock) {
      const foldStart = start + commentKeep
      const len = i - foldStart
      const firstRow = rows[foldStart]
      const lastRow = rows[i - 1]
      // Same three guards planBodyFolds applies: enough rows to pay for the notice, a contiguous line range, and nothing already claimed by a body fold.
      if (len >= MIN_FOLDED_ROWS && firstRow !== undefined && lastRow !== undefined && lastRow.no - firstRow.no + 1 === len) {
        let clear = true
        for (let k = foldStart; k < i; k++) {
          if (occupied.has(k)) {
            clear = false
            break
          }
        }
        if (clear) folds.push({ startIdx: foldStart, len, name: 'comment', kind: 'comment', firstLine: firstRow.no, lastLine: lastRow.no })
      }
    }

    if (i === start) i++
  }

  return folds
}

/** Merge body and comment folds into one position-ordered, non-overlapping list. Body folds win a tie: they carry a symbol name, so their notice names the command that returns the lines, while a comment notice can only give a line range. */
export function mergeFolds(body: readonly BodyFold[], comment: readonly BodyFold[]): BodyFold[] {
  const merged = [...body, ...comment].sort((a, b) => a.startIdx - b.startIdx || b.len - a.len)
  const out: BodyFold[] = []
  let through = -1
  for (const fold of merged) {
    if (fold.startIdx <= through) continue
    out.push(fold)
    through = fold.startIdx + fold.len - 1
  }
  return out
}

/** Longest `detail` this writes, so one pathological file cannot bloat the stats row. */
export const MAX_FOLD_DETAIL = 400

/** Room reserved inside {@link MAX_FOLD_DETAIL} for the `,+N more` suffix, so the cap is a hard bound rather than one the suffix can overshoot. */
const FOLD_DETAIL_SUFFIX_BUDGET = 16

/**
/** Longest paragraph line left alone. Below this a fold cannot clear the net-benefit floor once its marker is added, and short paragraphs are where a document's structure lives. */
const PROSE_FOLD_MIN_CHARS = 400

/** A kept opening may not run past this share of the paragraph. Beyond it the fold is mostly marker, and the reader pays a recall pointer for almost the whole text anyway. */
const PROSE_FOLD_MAX_KEEP_RATIO = 0.6

/** Shortest opening accepted as a summary. A bare "Deprecated." or "Note." says less than the words after it, so the scan moves on to the next sentence. Matches the floor `outline`'s doc-summary clip uses, for the same reason. */
const PROSE_FOLD_MIN_SENTENCE = 40

/** Structural lines a prose fold never touches, however long: headings, fenced code, table rows, block quotes, and a bare list marker. Folding any of these would remove the document's shape, which is the part a reader scanning it is actually after. */
const PROSE_STRUCTURAL_RE = /^\s*(?:#{1,6}\s|```|~~~|\||>|\d+[.)]\s*$|[-*+]\s*$)/

/** A fenced-block delimiter, in either markdown spelling. Kept separate from {@link PROSE_STRUCTURAL_RE} because these two rules answer different questions: that one asks whether this line may be folded, this one asks whether the lines after it may be. */
const PROSE_FENCE_RE = /^\s*(?:```|~~~)/

/** A period that ends an abbreviation or an initial rather than a sentence. Same three shapes the outline doc-summary scan skips. */
const PROSE_ABBREV_RE = /(?:\b(?:e\.g|i\.e|vs|cf|etc|approx|al|Dr|Mr|Ms|St|Fig|No)\.|\b[^\W\d_]\.)$/

/** End offset of the first real sentence in `text`, or `null` when it has none. */
function proseSentenceEnd(text: string): number | null {
  // The terminator may be followed by closing inline markup before the space: a changelog entry leads with `**Bold sentence.**`, and a lookahead demanding whitespace immediately after the full stop walks straight past it into the next sentence, keeping most of the paragraph. Any run of closers is consumed and returned as part of the kept text, so the emphasis it closes is not left hanging open.
  for (const m of text.matchAll(/[.!?][*_`)\]"'”’]*(?=\s|$)/gu)) {
    const term = m.index + 1
    const end = m.index + m[0].length
    if (end < PROSE_FOLD_MIN_SENTENCE) continue
    if (PROSE_ABBREV_RE.test(text.slice(0, term))) continue
    return end
  }
  return null
}

/**
 * Fold each long prose paragraph down to its opening sentence.
 *
 * Documents have no symbol spans, so {@link planBodyFolds} has nothing to work with and a markdown read arrives whole however long it is. What they do have is paragraphs, and a paragraph's opening sentence is its summary by the same convention that makes a docstring's first sentence one. Measured over 814 sessions, shell reads of markdown carry 9.62 MB, of which 1,153 reads holding 6.40 MB contain a paragraph long enough to fold; folding them removes 51.1% of those bytes.
 *
 * One paragraph is one row here, which is how markdown is normally written and is what lets the opening sentence stay in place rather than being dropped with the rest. Every structural line is left alone ({@link PROSE_STRUCTURAL_RE}), so headings, code fences and tables survive intact: on this project's own changelog the fold keeps every heading and every entry's bolded lead while removing 83% of the body text.
 *
 * `claimed` carries the row indices an earlier planner already took, so a document that also holds indexed spans cannot have the same row folded twice.
 */
export function planProseFolds(rows: ReadonlyArray<{ readonly no: number; readonly text: string }>, claimed: ReadonlySet<number>): BodyFold[] {
  const folds: BodyFold[] = []
  // Inside a fenced block nothing is prose: a long line there is a JSON payload, a log record or a command, and cutting it at the first full stop corrupts the one kind of content a writer fenced specifically to keep intact. The structural rule declines the delimiter lines themselves but says nothing about what sits between them, which let 70 fenced lines fold across the 2,032 real document reads this was measured on. A window that begins part-way through a block has no delimiter to open the state, so this reads as unfenced; that is the residue, and it is bounded by the fold being one line wide.
  let inFence = false
  for (let i = 0; i < rows.length; i++) {
    if (claimed.has(i)) continue
    const row = rows[i]
    if (row === undefined) continue
    const text = row.text
    if (PROSE_FENCE_RE.test(text)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    if (text.length < PROSE_FOLD_MIN_CHARS) continue
    if (PROSE_STRUCTURAL_RE.test(text)) continue
    const end = proseSentenceEnd(text)
    if (end === null || end > text.length * PROSE_FOLD_MAX_KEEP_RATIO) continue
    folds.push({ startIdx: i, len: 1, name: 'paragraph', kind: 'prose', keep: text.slice(0, end), firstLine: row.no, lastLine: row.no })
  }
  return folds
}

/**
 * Identify what a fold removed, for the `detail` column of its stats row.
 *
 * The bytes a fold saved were always recorded and what it folded was not, so the cost side -- how often a reader has to come back for a span that was folded away -- could not be computed from the ledger however long the feature ran. That is the specific gap keeping `hints.fold_code_bodies` off by default: the benefit is measured and the harm is not yet measurable.
 *
 * The shape deliberately matches the command a recovery read would use, `file::name`, so a later `read` can be joined back to the fold that provoked it. A comment fold has no symbol to name, so it carries the line span its notice points at instead, in the same `#first-last` form the notice prints.
 */
export function foldDetail(path: string, folds: readonly BodyFold[], maxLen: number = MAX_FOLD_DETAIL): string {
  const head = `${path}::`
  // Only a body fold has a symbol to name. A comment and a prose fold are both identified by their line span, and for prose that is also what keeps the paragraph's own words out of the ledger: `name` there holds document text, which has no business in a stats row.
  const ids = folds.map((f) => (f.kind === 'body' ? f.name : `#${f.firstLine}-${f.lastLine}`))
  // A path long enough to eat the whole budget still has to identify the file, which is the part a join needs; drop every id rather than return something unjoinable.
  const budget = maxLen - head.length - FOLD_DETAIL_SUFFIX_BUDGET
  const kept: string[] = []
  let used = 0
  for (const id of ids) {
    const add = kept.length === 0 ? id.length : id.length + 1
    if (used + add > budget) break
    kept.push(id)
    used += add
  }
  const dropped = ids.length - kept.length
  if (kept.length === 0) return `${head}+${ids.length} folds`
  return dropped > 0 ? `${head}${kept.join(',')},+${dropped} more` : `${head}${kept.join(',')}`
}
