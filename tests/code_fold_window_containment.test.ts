/**
 * A fold must never remove a line the caller explicitly asked for.
 *
 * `planBodyFolds` clips a symbol span to the rows actually delivered, which is what lets it work on
 * a windowed read at all. The clipping alone is not enough: when the window sits *inside* a large
 * symbol, every delivered row is inside the span, the clip removes nothing, and the whole window
 * folds to a notice. The caller asked for those exact lines and gets none of them back.
 *
 * This was never reachable from the Read hook, which declines any read carrying offset or limit
 * (`src/hooks_read.ts`, the `readIntToolInput` guard) and so only ever folds whole files. The shell
 * read path cannot buy safety the same way: measured over 814 session transcripts, 14.61 MB of the
 * 15.61 MB of source read through a shell arrives as a range, so exempting ranges there would
 * exempt the surface. The guard below is what makes folding a range safe instead.
 *
 * Fixture provenance:
 *   - HAND-DERIVED. Row numbers and span bounds are chosen arithmetically to place the window
 *     strictly inside the span; nothing here is read back off `planBodyFolds`.
 *   - `BODY_FOLD_KEEP_LINES` (8) and `BODY_FOLD_MIN_SPAN` (20) are FORMAT-DERIVED from their
 *     declarations in `src/hooks_read.ts`, restated here because they are module-private. The
 *     assertions do not depend on their exact values, only on the window sitting inside the span.
 */
import { describe, expect, it } from 'vitest'

import { planBodyFolds, type FoldSpan } from '../src/code_fold.js'

const KEEP = 8
const MIN_SPAN = 20

/** Delivered rows for the inclusive line range [from, to], as a windowed read produces them. */
function rows(from: number, to: number): { no: number }[] {
  return Array.from({ length: to - from + 1 }, (_, i) => ({ no: from + i }))
}

describe('planBodyFolds: a delivered window is never emptied', () => {
  it('folds nothing when the window sits strictly inside one symbol', () => {
    // `sed -n '100,140p' file.ts` over a function spanning 90-200: every delivered row is body.
    const spans: FoldSpan[] = [{ name: 'wide', kind: 'function', lineStart: 90, lineEnd: 200 }]
    const folds = planBodyFolds(rows(100, 140), spans, KEEP, MIN_SPAN)
    const removed = folds.reduce((n, f) => n + f.len, 0)
    expect(removed).toBe(0)
  })

  it('still folds a symbol that begins inside the window, keeping its declaration', () => {
    // Calibration for the case above: without it, that test passes for a fold that does nothing at
    // all. Here the symbol starts at 110, so its declaration plus KEEP-1 body lines are delivered
    // and only the remainder is folded -- a real fold, on the same code path.
    const spans: FoldSpan[] = [{ name: 'inner', kind: 'function', lineStart: 110, lineEnd: 200 }]
    const folds = planBodyFolds(rows(100, 140), spans, KEEP, MIN_SPAN)
    const removed = folds.reduce((n, f) => n + f.len, 0)
    expect(removed).toBeGreaterThan(0)
    // Row index 0 is line 100 and row index 18 is line 118 (110 + KEEP): everything before the
    // first folded line survives, so the declaration is still on screen.
    expect(folds[0]?.startIdx).toBe(18)
    expect(folds[0]?.firstLine).toBe(118)
  })

  it('folds a symbol that both begins and ends inside the window', () => {
    const spans: FoldSpan[] = [{ name: 'contained', kind: 'function', lineStart: 105, lineEnd: 135 }]
    const folds = planBodyFolds(rows(100, 140), spans, KEEP, MIN_SPAN)
    expect(folds).toHaveLength(1)
    expect(folds[0]?.firstLine).toBe(113)
    expect(folds[0]?.lastLine).toBe(135)
  })

  it('leaves a whole-file read unchanged, which is the shipped Read behaviour', () => {
    const spans: FoldSpan[] = [{ name: 'top', kind: 'function', lineStart: 10, lineEnd: 60 }]
    const folds = planBodyFolds(rows(1, 200), spans, KEEP, MIN_SPAN)
    expect(folds).toHaveLength(1)
    expect(folds[0]?.firstLine).toBe(18)
    expect(folds[0]?.lastLine).toBe(60)
  })
})
