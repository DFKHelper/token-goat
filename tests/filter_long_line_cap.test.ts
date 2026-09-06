/**
 * Per-line cap in the shared filter pipeline (`ToolFilter.apply` step 7.5).
 *
 * `apply` counted lines at step 8 and measured the whole body at step 9, so one enormous line
 * cleared both and shipped at full length. The grep filter grew its own centred clip for that
 * reason; every other filter had nothing, which is why a 5,008-char line went through the generic
 * filter untouched (measured against the built bundle: 5,538 bytes in, 5,539 out).
 *
 * Fixture provenance:
 *   - The long lines are HAND-DERIVED: a repeated token of known length, so the expected elided
 *     count is arithmetic on the input and not a value read back off `capLongLines`.
 *   - The elision marker's exact text is FORMAT-DERIVED from `src/tool_filters/helpers.ts::capLongLines`,
 *     which is the producer. That proves agreement with the producer, not that a shipped build emits
 *     it, so the bundle case in `tests/command_matrix_e2e.test.ts` territory is what would catch a
 *     build-time divergence; these cases pin the logic.
 *   - `LONG_LINE_MAX_CHARS` is imported rather than restated, so a change to the threshold moves the
 *     tests with it instead of leaving them asserting a number the code no longer uses.
 */
import { describe, expect, it } from 'vitest'

import { capLongLines, LONG_LINE_MAX_CHARS } from '../src/tool_filters/helpers.js'
import { GenericFilter } from '../src/tool_filters/generic.js'

/** A single line of exactly `n` characters, distinguishable from padding. */
function wide(n: number): string {
  return 'z'.repeat(n)
}

describe('capLongLines', () => {
  it('leaves a line at the threshold alone and clips the one past it', () => {
    const [atCap, overCap] = capLongLines([wide(LONG_LINE_MAX_CHARS), wide(LONG_LINE_MAX_CHARS + 1)], LONG_LINE_MAX_CHARS)
    expect(atCap).toBe(wide(LONG_LINE_MAX_CHARS))
    expect(overCap).toContain('… [1 chars elided]')
  })

  it('reports the elided count against the original line, not the clipped one', () => {
    // Arithmetic on the input: 4,000 characters in, 1,000 kept, so 3,000 are gone. A count computed
    // from anything else (the marker text, the clipped length) lands on a different number.
    const [clipped] = capLongLines([wide(4000)], LONG_LINE_MAX_CHARS)
    expect(clipped).toContain(`… [${4000 - LONG_LINE_MAX_CHARS} chars elided]`)
  })

  it('does not clip a line a previous pass already clipped', () => {
    // The grep filter clips centred on the match and leaves a line that is still over a smaller cap.
    // Clipping again would append a second marker whose count is measured against the first marker's
    // text rather than the original line, so the result would carry two notices and the later one
    // would be wrong.
    const once = capLongLines([wide(4000)], LONG_LINE_MAX_CHARS)
    const twice = capLongLines(once, LONG_LINE_MAX_CHARS)
    expect(twice).toEqual(once)
    expect(twice[0]?.match(/chars elided/g)).toHaveLength(1)
  })

  it('never splits a surrogate pair', () => {
    // A cut landing between a high and low surrogate leaves a lone surrogate that serializes as
    // U+FFFD. The pair is placed to straddle the cut exactly.
    const line = 'a'.repeat(LONG_LINE_MAX_CHARS - 1) + '\u{1F600}' + 'b'.repeat(200)
    const [clipped] = capLongLines([line], LONG_LINE_MAX_CHARS)
    expect(clipped).not.toContain('�')
    expect(Buffer.from(clipped ?? '', 'utf-8').toString('utf-8')).toBe(clipped)
  })
})

describe('ToolFilter.apply: a single enormous line no longer ships whole', () => {
  it('clips a long line that the line cap and the byte cap both pass', () => {
    // Deliberately small enough overall that step 8 (line count) and step 9 (whole-body bytes) are
    // both satisfied: without a per-line rule this body is delivered verbatim, which is exactly what
    // the built bundle did before this change.
    const body = [`PAYLOAD ${wide(5000)}`, ...Array.from({ length: 30 }, (_, i) => `ordinary line ${i}`)].join('\n')
    const out = new GenericFilter().apply(body, '', 0, ['cat', 'wide.txt'])

    expect(out.text).toContain('chars elided')
    expect(out.text).not.toContain(wide(2000))
    // The short lines are content, not noise, and must survive: a rule that shrank this body by
    // dropping them would satisfy a ratio floor while destroying the answer.
    expect(out.text).toContain('ordinary line 0')
    expect(out.text).toContain('ordinary line 29')
    expect(Buffer.byteLength(out.text, 'utf-8')).toBeLessThan(Buffer.byteLength(body, 'utf-8'))
  })

  it('leaves a body of ordinary-width lines completely alone', () => {
    // Calibration for the case above: without it, that test only proves something was shortened, not
    // that line width is what drives it.
    const body = Array.from({ length: 30 }, (_, i) => `ordinary line ${i}`).join('\n')
    const out = new GenericFilter().apply(body, '', 0, ['cat', 'narrow.txt'])
    expect(out.text).not.toContain('chars elided')
  })
})
