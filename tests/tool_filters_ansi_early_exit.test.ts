// Regression: colour-heavy output used to clear the 40% normalisation bar on escape bytes alone, skip the per-tool filter, and leave a free-standing "(×2)" line where a run of blank lines had been collapsed, under a footer crediting a filter that never ran.
import { describe, expect, it } from 'vitest'

import { filterByName } from '../src/tool_filters/dispatch.js'
import { GenericFilter } from '../src/tool_filters/generic.js'
import { dedupeConsecutive } from '../src/tool_filters/helpers.js'

// Provenance: CAPTURE `node node_modules/typescript/bin/tsc --noEmit --pretty -p .` (TypeScript 6.0.3, Node 24.12.0, stdout piped to a file, colour still emitted) in a scratch project whose src/c.ts holds twelve lines `q1;` .. `q12;`, so tsc reports twelve TS2304 errors. Lines split on the CRLF tsc printed.
const TSC_PRETTY_12_ERRORS = [
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m1\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q1'.",
  "",
  "\u001b[7m1\u001b[0m q1;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m2\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q2'.",
  "",
  "\u001b[7m2\u001b[0m q2;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m3\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q3'.",
  "",
  "\u001b[7m3\u001b[0m q3;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m4\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q4'.",
  "",
  "\u001b[7m4\u001b[0m q4;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m5\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q5'.",
  "",
  "\u001b[7m5\u001b[0m q5;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m6\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q6'.",
  "",
  "\u001b[7m6\u001b[0m q6;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m7\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q7'.",
  "",
  "\u001b[7m7\u001b[0m q7;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m8\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q8'.",
  "",
  "\u001b[7m8\u001b[0m q8;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m9\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q9'.",
  "",
  "\u001b[7m9\u001b[0m q9;",
  "\u001b[7m \u001b[0m \u001b[91m~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m10\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q10'.",
  "",
  "\u001b[7m10\u001b[0m q10;",
  "\u001b[7m  \u001b[0m \u001b[91m~~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m11\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q11'.",
  "",
  "\u001b[7m11\u001b[0m q11;",
  "\u001b[7m  \u001b[0m \u001b[91m~~~\u001b[0m",
  "",
  "\u001b[96msrc/c.ts\u001b[0m:\u001b[93m12\u001b[0m:\u001b[93m1\u001b[0m - \u001b[91merror\u001b[0m\u001b[90m TS2304: \u001b[0mCannot find name 'q12'.",
  "",
  "\u001b[7m12\u001b[0m q12;",
  "\u001b[7m  \u001b[0m \u001b[91m~~~\u001b[0m",
  "",
  "",
  "Found 12 errors in the same file, starting at: src/c.ts\u001b[90m:1\u001b[0m",
  "",
  "",].join('\r\n')

const ESC = String.fromCharCode(27)

describe('colour-heavy tsc --pretty output still reaches the tsc filter', () => {
  const argv = ['tsc', '--noEmit', '--pretty']
  const result = filterByName('tsc')!.apply(TSC_PRETTY_12_ERRORS, '', 2, argv)

  it('runs the structural filter on the stripped text (drops errors past the per-code cap)', () => {
    expect(result.text).toContain('dropped 9 more TS2304 errors')
    expect(result.filterName).toBe('tsc')
  })

  // Must-not-drop: real lines of the capture that carry the diagnosis.
  it('keeps the first errors and the summary line, with no escape bytes', () => {
    expect(result.text).toContain("src/c.ts:1:1 - error TS2304: Cannot find name 'q1'.")
    expect(result.text).toContain('Found 12 errors in the same file, starting at: src/c.ts:1')
    expect(result.text).not.toContain(ESC)
  })

  it('never renders a bare counter line', () => {
    expect(result.text.split('\n').some((l) => /^\s*\(×\d+\)\s*$/.test(l))).toBe(false)
  })
})

describe('the early-exit path (normalisation alone)', () => {
  // Provenance: HAND-DERIVED a `\r` progress run collapses to its last segment, which is the reduction the early exit credits; coloured lines separated by blank pairs are the shape the finder's script printed.
  const progress = Array.from({ length: 400 }, (_, i) => `${i}%`).join('\r')
  const colouredWithBlankPairs = Array.from({ length: 6 }, (_, i) => `${ESC}[32mok ${i}${ESC}[0m\n\n`).join('\n') + progress

  it('squeezes a blank run to one blank line instead of a "(×N)" counter', () => {
    const r = new GenericFilter().apply(colouredWithBlankPairs, '', 0, [])
    expect(r.text.split('\n').some((l) => /^\s*\(×\d+\)\s*$/.test(l))).toBe(false)
    expect(r.text).toContain('ok 0')
    expect(r.text).toContain('ok 5')
  })

  it('names the generic pass, not the per-tool filter that was skipped', () => {
    const r = filterByName('tsc')!.apply(progress, '', 0, ['tsc'])
    expect(r.notes.join(' ')).toContain('early-exit')
    expect(r.filterName).toBe('generic')
  })
})

describe('dedupeConsecutive on blank lines', () => {
  it('squeezes a run of blank or whitespace-only lines to one empty line', () => {
    expect(dedupeConsecutive(['a', '', '', '  ', 'b'])).toEqual(['a', '', 'b'])
  })

  it('leaves a single blank line and a run of real lines alone', () => {
    expect(dedupeConsecutive(['a', '', 'b', 'b'])).toEqual(['a', '', 'b  (×2)'])
  })
})
