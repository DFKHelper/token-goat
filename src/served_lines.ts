/**
 * Finding the stretches of a delivered file window that this session has already served.
 *
 * Extracted from the Read hook so the shell surface can apply the same rule. Both surfaces deliver
 * file lines and both feed the same per-file served-output store, but only the Read hook could
 * withhold a partial overlap: the shell path had all-or-nothing containment, which fires only when
 * a whole read sits verbatim inside one earlier body. Measured over 201 session transcripts, that
 * caught 0.49 MB across 211 of 3,848 shell range reads, while another 1.96 MB of already-served
 * lines shipped again inside reads that merely overlapped rather than nested.
 *
 * Everything here is deliberately free of hook types and of any notion of which tool produced the
 * rows, so the two callers share the search and differ only in how they render the result.
 */

/** A delivered line: its number in the file, its text, and the form it occupies in the output. `no` is null when the caller cannot know the number, which costs only the notice's precision: the search itself is on text and never on position. */
export interface NumberedRow {
  readonly no: number | null
  readonly text: string
  readonly raw: string
}

/** Maximum line-to-line comparisons one elision search may spend before giving up and passing. */
export const SERVED_RUN_COMPARISON_BUDGET = 400_000

/** Anchors kept per distinct line of a served body. A line repeated more often than this in one
 *  body contributes nothing further: the run that matters still starts at one of the first few. */
const SERVED_RUN_ANCHORS_PER_LINE = 32

/** An already-served body, indexed by line text so a run can be anchored without scanning it. */
export interface ServedBody {
  readonly id: string
  readonly lines: string[]
  readonly positions: Map<string, number[]>
}

/** A stretch of the current read that appears, in the same order, inside one already-served body. */
export interface ServedRun {
  readonly start: number
  readonly len: number
  readonly id: string
}

export function indexServedBody(id: string, output: string): ServedBody {
  const lines = output.split('\n')
  const positions = new Map<string, number[]>()
  for (let j = 0; j < lines.length; j++) {
    const key = lines[j] ?? ''
    let at = positions.get(key)
    if (at === undefined) {
      at = []
      positions.set(key, at)
    }
    if (at.length < SERVED_RUN_ANCHORS_PER_LINE) at.push(j)
  }
  return { id, lines, positions }
}

/**
 * The longest run of `rows[from..to)` that appears as a contiguous line run inside some served body.
 *
 * Anchored on exact line text and extended forward, which is what makes it safe on a file full of
 * repeated lines: a lone `}` matching a `}` somewhere in a served body proves nothing on its own,
 * and only becomes a run when the lines around it match too. This is the same whole-line
 * containment rule `containsLineRun` applies for the deny path, generalised from "is the whole
 * window there" to "which part of it is".
 *
 * `budget` bounds the work rather than the input: a pathological file (thousands of identical
 * lines) would otherwise make this quadratic inside a hook that has to finish in milliseconds.
 * Exhausting it returns the best run found so far, so the outcome degrades to a smaller saving
 * rather than a wrong one.
 */
export function longestServedRun(
  rows: readonly NumberedRow[],
  from: number,
  to: number,
  bodies: readonly ServedBody[],
  budget: { left: number },
): ServedRun | null {
  let best: ServedRun | null = null
  for (const body of bodies) {
    for (let i = from; i < to; i++) {
      if (best !== null && to - i <= best.len) break
      const anchors = body.positions.get(rows[i]?.text ?? '')
      if (anchors === undefined) continue
      for (const j of anchors) {
        let k = 0
        while (i + k < to && j + k < body.lines.length && rows[i + k]?.text === body.lines[j + k]) {
          k++
          if (--budget.left <= 0) return best !== null && best.len > 0 ? best : null
        }
        if (best === null || k > best.len) best = { start: i, len: k, id: body.id }
      }
    }
  }
  return best !== null && best.len > 0 ? best : null
}

/** Most runs one result may have withheld. Past this the result reads as a list of notices. */
export const MAX_SERVED_ELISIONS = 3

/** The notice standing in for a withheld run, phrased so the line numbers it replaces stay visible. A caller that cannot know them passes null and gets a count instead: a wrong line number reads exactly like a right one, so there is no honest way to guess. */
export function servedRunNotice(firstLine: number | null, lastLine: number | null, id: string, len: number): string {
  const which = firstLine !== null && lastLine !== null ? 'lines ' + firstLine + '-' + lastLine : len + ' lines here'
  return (
    '[token-goat] ' + which +
    ' were already served verbatim in this session; withheld here. ' +
    // `--full` is load-bearing, not decoration: without it every render path in cmdBashOutput elides the middle past head+tail, so the command this notice names returns less than the notice just withheld and following our own instruction still loses lines.
    'Recall them with `token-goat bash-output ' + id + ' --full`.'
  )
}

/**
 * Bytes a run removes from the result, which is what a notice replacing it has to beat.
 *
 * Measured on the rendered rows rather than the file's lines, because those rows are what is
 * actually leaving the output. The two differ by the line-number prefix on every row, and on a file
 * of short lines that prefix is a large fraction of each one -- exactly the case where a cut is
 * closest to not paying for itself.
 */
export function renderedRunBytes(rows: readonly NumberedRow[], start: number, len: number): number {
  let bytes = 0
  for (let i = start; i < start + len; i++) bytes += Buffer.byteLength(rows[i]?.raw ?? '', 'utf-8') + 1
  return bytes
}

/**
 * Which stretches of `rows` to withhold, in row order, or an empty array when none pays for itself.
 *
 * Repeatedly takes the longest remaining served run, then splits the span it came from so a later
 * pass can still reach lines on either side of it.
 */
export function planServedElisions(rows: readonly NumberedRow[], bodies: readonly ServedBody[]): ServedRun[] {
  if (rows.length === 0 || bodies.length === 0) return []
  const budget = { left: SERVED_RUN_COMPARISON_BUDGET }
  // Row spans still eligible for a run. An elision splits its span in two, so a later pass can
  // still reach lines on either side of it.
  let spans: Array<[number, number]> = [[0, rows.length]]
  const cuts: ServedRun[] = []
  for (let pass = 0; pass < MAX_SERVED_ELISIONS; pass++) {
    let bestRun: ServedRun | null = null
    let bestSpan = -1
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s]
      if (span === undefined) continue
      const run = longestServedRun(rows, span[0], span[1], bodies, budget)
      if (run !== null && (bestRun === null || run.len > bestRun.len)) {
        bestRun = run
        bestSpan = s
      }
    }
    if (bestRun === null || bestSpan < 0) break
    // Every cut pays for itself. The net-savings gate the callers apply judges the rewrite as a whole, which a
    // cut that loses bytes can hide inside as long as an earlier one won enough: this is what stops
    // a five-line overlap of short lines from costing a ~130-byte notice to remove ~45 bytes.
    const first = rows[bestRun.start]
    const last = rows[bestRun.start + bestRun.len - 1]
    if (first === undefined || last === undefined) break
    const noticeBytes = Buffer.byteLength(servedRunNotice(first.no, last.no, bestRun.id, bestRun.len), 'utf-8') + 1
    if (renderedRunBytes(rows, bestRun.start, bestRun.len) <= noticeBytes) break
    cuts.push(bestRun)
    const chosen = spans[bestSpan]
    if (chosen === undefined) break
    const rebuilt: Array<[number, number]> = []
    for (let s = 0; s < spans.length; s++) {
      const span = spans[s]
      if (span === undefined) continue
      if (s !== bestSpan) {
        rebuilt.push(span)
        continue
      }
      if (bestRun.start > chosen[0]) rebuilt.push([chosen[0], bestRun.start])
      if (bestRun.start + bestRun.len < chosen[1]) rebuilt.push([bestRun.start + bestRun.len, chosen[1]])
    }
    spans = rebuilt
  }
  cuts.sort((a, b) => a.start - b.start)
  return cuts
}
