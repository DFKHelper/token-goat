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
 * The budget is therefore deliberately loose. It was 100 ms, which held on a developer box and
 * failed on every CI runner the first time one saw this suite: Groovy's dollar-slashy scan is
 * ~30 ms locally by design (each opener scans to a 1 KB bound, so 25,000 openers cost 25 M
 * character reads -- linear, and intended), and a shared runner under three-way sharding took
 * 316-563 ms for the same work. That was measuring runner load, not the algorithm. 2 s is still
 * two to four orders of magnitude under any superlinear regression at this input size, and no
 * correct adapter comes near it.
 */
import { expect } from 'vitest'

/** Every pathological fixture is one 50,000-character line. */
export const LINE_50K = 50_000

/** Wall-clock budget for a single pathological scan. See the file header for why it is this loose. */
const BUDGET_MS = 2000

/** Run once to warm, then assert the second run finishes inside the budget. */
export function expectFast(run: () => unknown, label: string): void {
  run()
  const t0 = performance.now()
  run()
  expect(performance.now() - t0, label).toBeLessThan(BUDGET_MS)
}
