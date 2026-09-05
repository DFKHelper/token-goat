/**
 * Body folding: keep a source file's structure, replace the inside of long function bodies with a pointer to the command that returns them in full.
 *
 * This exists because the re-read machinery cannot help a *first* read. Every dedup mechanism in hooks_read.ts keys on prior sight -- served runs, identical-read collapse, the heading-tree re-read deny -- and a first read has none, which is where 83.6% of hooked Read bytes are.
 *
 * The unit is the body, not the symbol. A skeleton (signatures only) is 12.0% of what a Read delivers, measured over this repo's 162 source files above 8 KB, so serving one withholds 88% of the file: that is a deny wearing a preview, and it carries a deny's costs (a round trip, an abandonment risk, an edit-error spike) without saying so. Keeping the first lines of each body instead leaves the reader everything a skeleton has plus enough of each implementation to judge whether it needs the rest -- and the rest is one named command away rather than a re-read of the whole file.
 *
 * What is deliberately never folded:
 * - anything outside a symbol span: imports, types, top-level constants, and the comments between declarations. In this repo comments are 44.8% of source bytes and carry design rationale, so stripping them would be the largest single "saving" available and the least honest one.
 * - a span shorter than `minSpan`, where the notice costs more than the lines it removes.
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
  /** 1-based file line numbers of the first and last folded line, for the notice text. */
  readonly firstLine: number
  readonly lastLine: number
}

/**
 * Kinds whose body is an implementation a reader can defer. A `class` or `interface` span encloses its members, so folding it would swallow every method signature in the type -- exactly the structure this is supposed to preserve.
 */
const FOLDABLE_KINDS = new Set(['function', 'method', 'func', 'def', 'fn', 'procedure', 'constructor'])

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

  const folds: BodyFold[] = []
  let foldedThrough = -1
  for (const span of ordered) {
    if (!FOLDABLE_KINDS.has(span.kind)) continue
    if (span.lineEnd - span.lineStart + 1 < minSpan) continue
    // Nested inside a span already folded: its lines are gone, and a second notice for them would claim the same bytes twice.
    if (span.lineStart <= foldedThrough) continue

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

    folds.push({ startIdx, len, name: span.name, firstLine: firstRow.no, lastLine: lastRow.no })
    foldedThrough = span.lineEnd
  }

  return folds
}
