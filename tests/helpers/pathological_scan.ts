/**
 * The shared pathological-input timing backstop, previously copied verbatim into five adapter
 * suites.
 *
 * What it guards is the ONE failure mode these inputs produce: a scan whose cost is superlinear in
 * the line length. Every shape passed to it is 50 KB of a single repeated token with no newline --
 * an unterminated quote, an unclosed brace, a run of comment openers -- which is exactly what turns
 * an end-anchored regex or a rescan-from-the-start loop from milliseconds into minutes. The adapters
 * that have regressed here did so by orders of magnitude, not by tens of percent.
 *
 * THE BUDGET IS RELATIVE, NOT A WALL-CLOCK NUMBER. It used to be an absolute figure, and an absolute
 * figure on a shared runner measures the runner. 100 ms held on a developer box and failed the first
 * time CI saw this suite -- Groovy's dollar-slashy scan is ~30 ms locally BY DESIGN (each opener
 * scans to a 1 KB bound, so 25,000 openers cost 25 M character reads: linear, and intended), and a
 * three-way-sharded runner took 316-563 ms for the same work. Raising it to 2 s bought quiet at the
 * price of meaning: 2 s is so far above any correct adapter that only a catastrophic regression
 * trips it, and it would still go red on a runner that stalled for an unrelated reason.
 *
 * So the scan is priced against a LINEAR REFERENCE measured in this same process, on this same
 * machine, under this same load: `REFERENCE_PASSES` scalar passes over a 50 KB string, the
 * cheapest possible shape of the work an adapter is doing. A loaded runner slows the reference and
 * the scan together, so the ratio is stable where a millisecond count is not; a superlinear
 * regression is by definition NOT shared by the reference, so the ratio is exactly what moves.
 */
import { expect } from 'vitest'

/** Every pathological fixture is one 50,000-character line. */
export const LINE_50K = 50_000

/** 10 M character reads: 200 passes over a 50 KB string. Big enough that the timer is not the noise. */
const REFERENCE_PASSES = 200
const REFERENCE_LINE = 'x'.repeat(LINE_50K)

/** One pass of the cheapest linear work an adapter could be doing over the same input size. */
function referenceMs(): number {
  const t0 = performance.now()
  let sink = 0
  for (let pass = 0; pass < REFERENCE_PASSES; pass++) {
    for (let i = 0; i < REFERENCE_LINE.length; i++) sink += REFERENCE_LINE.charCodeAt(i)
  }
  // Consume the accumulator so the loop cannot be optimized away.
  if (sink === -1) throw new Error('unreachable')
  return performance.now() - t0
}

/**
 * Measured once per process, warmed first. Re-measuring per call would triple the suite's cost for
 * a quantity that is a property of the machine, not of the assertion.
 */
let referenceCache: number | undefined
function reference(): number {
  if (referenceCache === undefined) {
    referenceMs()
    referenceCache = Math.max(referenceMs(), 0.5)
  }
  return referenceCache
}

/**
 * How many reference units a single pathological scan may cost.
 *
 * Calibrated, not chosen. PROVENANCE: CAPTURE -- every `expectFast` call in the six suites that use
 * this helper was instrumented (`TG_REPORT_SCAN_UNITS=1`) and its ratio recorded, n=129. The slowest
 * correct adapter is Groovy at 3.50 units, which is the intentionally-linear dollar-slashy scan
 * described above; the runner-up is Fortran's long-continuation case at 2.21 and everything else
 * sits under 0.65. The ceiling is set an order of magnitude above the worst of those, so ordinary
 * variance and a slower future adapter both fit, while a superlinear regression -- two to four
 * orders of magnitude out at this input size -- cannot.
 */
const MAX_REFERENCE_UNITS = 40

/** Run once to warm, then assert the second run is not superlinear relative to the reference. */
export function expectFast(run: () => unknown, label: string): void {
  run()
  const t0 = performance.now()
  run()
  const elapsed = performance.now() - t0
  const units = elapsed / reference()
  if (process.env.TG_REPORT_SCAN_UNITS === '1') {
    console.log(`SCANUNITS\t${label}\t${units.toFixed(3)}`)
  }
  expect(
    units,
    `${label}: the scan cost ${elapsed.toFixed(1)} ms against a ${reference().toFixed(1)} ms linear reference measured on this same machine, so this is the algorithm and not the runner`,
  ).toBeLessThan(MAX_REFERENCE_UNITS)
}
