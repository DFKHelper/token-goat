/**
 * The per-line width bound that keeps the tool filters' line-oriented regexes from running on a
 * single enormous line.
 *
 * `clampKeepingEnds` bounds a *stream*: nothing bounded a *line*. Every per-tool filter regex is
 * written on the premise that a line is short -- 205 of them carry a
 * `no-super-linear-backtracking` suppression -- and a minified bundle, a base64 blob, or a JSON
 * one-liner emitted by a build tool violates that premise without exceeding the stream cap at all.
 *
 * Fixture provenance: HAND-DERIVED for the shape assertions (the clip's arithmetic is computed here
 * from the input length, independently of the implementation), CAPTURE for the timing anchor: the
 * 480 KB single-line input below is the shape that took 47.51 s inside a blocking hook when run
 * through the shipped `dist/token-goat.mjs` during the 2026-09-08 review. The bound asserted here is
 * deliberately far looser than that measurement, because the point is to catch the return of an
 * unbounded line, not to pin a machine's speed.
 */

import { describe, expect, it } from 'vitest'

import { clipWideLines, INPUT_MAX_LINE_CHARS } from '../src/tool_filters/helpers.js'
import { GenericFilter } from '../src/tool_filters/generic.js'

describe('clipWideLines', () => {
  it('leaves text whose every line is within the bound completely untouched', () => {
    const text = ['a'.repeat(INPUT_MAX_LINE_CHARS), 'short', ''].join('\n')
    expect(clipWideLines(text)).toBe(text)
  })

  it('keeps both ends of an over-wide line and says how much it dropped', () => {
    const width = INPUT_MAX_LINE_CHARS * 3
    const line = 'H'.repeat(20) + 'x'.repeat(width - 40) + 'T'.repeat(20)
    const out = clipWideLines(line)
    // Head and tail survive: a head-only trim would discard the end of the line, which on a
    // one-line JSON or stack-trace payload is where the answer usually is.
    expect(out.startsWith('H'.repeat(20))).toBe(true)
    expect(out.endsWith('T'.repeat(20))).toBe(true)
    expect(out).toContain(`[${width - INPUT_MAX_LINE_CHARS} chars clipped]`)
    expect(out.length).toBeLessThan(line.length)
  })

  it('clips only the wide lines and leaves their neighbours byte-identical', () => {
    const narrow = 'error: something went wrong'
    const text = [narrow, 'z'.repeat(INPUT_MAX_LINE_CHARS * 2), narrow].join('\n')
    const lines = clipWideLines(text).split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe(narrow)
    expect(lines[2]).toBe(narrow)
    expect(lines[1]!.length).toBeLessThan(INPUT_MAX_LINE_CHARS * 2)
  })

  it('bounds a filter run over one 480KB line, the shape that hung a blocking hook', () => {
    // Not a synthetic worst case: a minified bundle or a single-line JSON payload printed by a
    // build tool looks exactly like this, and reaches the filter as ordinary command output.
    const oneLine = 'a'.repeat(240_000) + ':' + 'b'.repeat(240_000)
    const started = process.hrtime.bigint()
    const out = new GenericFilter().apply(oneLine, '', 0, ['somecmd'])
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
    expect(elapsedMs).toBeLessThan(5000)
    expect(out.notes.join('; ')).toContain('clipped line(s) wider than')
  })
})
