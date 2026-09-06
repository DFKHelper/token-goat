import { describe, it, expect } from 'vitest'
import { capBytes, capTokens, clampKeepingEnds, truncateMiddleSmart } from '../src/tool_filters/helpers.js'
import { filterByName } from '../src/tool_filters/index.js'

/**
 * The pre-filter input cap has to keep the end of the output, not just the beginning.
 *
 * Fixture provenance: CAPTURE for the summary block, HAND-DERIVED for the logic cases. The four
 * summary lines below are the literal tail of a real `npm test` run of this repository on
 * 2026-09-06, captured to a file and read back: 2,406,737 bytes whose last 200 hold
 * `Test Files 577 passed (577)` and `Tests 12100 passed | 17 skipped (12117)`. Under the head-only
 * cut this replaces, that run reached the model as 5.5KB containing none of them. The padding
 * around them is synthetic, because only its size matters.
 *
 * There is no ratio assertion here on purpose: a cap's ratio improves by dropping more, which is
 * the failure under test. Every case names text that must survive.
 */
describe('filter input cap keeps both ends', () => {
  const SUMMARY = [
    ' Test Files  577 passed (577)',
    '      Tests  12100 passed | 17 skipped (12117)',
    '   Start at  15:25:42',
    '   Duration  100.15s (transform 30.83s, setup 15.79s, import 164.47s, tests 893.39s, environment 58ms)',
  ]

  /** A run whose verdict sits in the final lines, with `padKb` of noise in front of it. */
  function suiteOutput(padKb: number): string {
    const noise = Array.from({ length: padKb * 8 }, (_, i) => `stdout | tests/pad_${i}.test.ts > emits a line of about 128 bytes of console noise, repeated to fill the cap`)
    return [' RUN  v4.1.11 C:/Projects/token-goat', ...noise, ...SUMMARY].join('\n')
  }

  it('keeps the trailing verdict when the input is far over the cap', () => {
    const text = suiteOutput(80)
    const cap = 16 * 1024
    expect(Buffer.byteLength(text)).toBeGreaterThan(cap * 4)
    const clamped = clampKeepingEnds(text, cap)
    expect(clamped).not.toBeNull()
    // The whole point: the summary is at the very end, so a head-only cut loses all four lines.
    for (const line of SUMMARY) expect(clamped).toContain(line)
    // The head is worth keeping too, and is what the old behaviour got right.
    expect(clamped).toContain('RUN  v4.1.11')
    expect(Buffer.byteLength(clamped as string)).toBeLessThanOrEqual(cap)
  })

  it('says how many lines it dropped rather than eliding silently', () => {
    const clamped = clampKeepingEnds(suiteOutput(80), 16 * 1024) as string
    const marker = clamped.split('\n').find((l) => l.includes('elided by token-goat'))
    expect(marker).toMatch(/^\.\.\. \[\d+ more lines elided by token-goat\]$/)
  })

  it('returns null when the text already fits, so short output is untouched', () => {
    expect(clampKeepingEnds(SUMMARY.join('\n'), 16 * 1024)).toBeNull()
  })

  it('never splits a multi-byte character, even with no line boundary to cut on', () => {
    // One line wider than the entire budget has no boundary available, so the fallback prefix is the only path that can split a UTF-8 sequence. Every character here is 3 bytes, so a naive byte cut at an odd offset lands mid-sequence.
    const oneLine = '✓'.repeat(4000)
    const clamped = clampKeepingEnds(oneLine, 1001) as string
    expect(clamped).not.toBeNull()
    expect(clamped).not.toContain('\uFFFD')
    expect(Buffer.byteLength(clamped)).toBeLessThanOrEqual(1001)
  })

  it('spends its error-context budget on both ends, not the first signals it meets', () => {
    // Measured on the same red run: the filter kept 60,720 lines holding 139 ERROR_SIGNAL_RE matches, the first ten of which fell between lines 379 and 3,813, while the failing test sat at line 60,685. Taking the first `maxErrorLines` signals therefore gave the real failure no context, and the delivered output reported that a test had failed without naming which one.
    const noise = Array.from({ length: 400 }, (_, i) => `stdout | tests/noise_${i}.test.ts > logs the word error: ${i} as ordinary content`)
    const failure = ['FAIL  tests/real_probe.test.ts > the assertion that actually broke', 'AssertionError: expected 1 to be 2']
    // The failure has to sit outside the unconditional 10-line tail window, or the tail keeps it whichever signals were chosen and the test passes against the very behaviour it exists to reject. In the measured run it sat 35 lines from the end; the 25 quiet lines below reproduce that gap.
    const afterFailure = Array.from({ length: 25 }, (_, i) => ` ✓ tests/late_${i}.test.ts (2 tests) 4ms`)
    const lines = [...noise, ...Array.from({ length: 400 }, (_, i) => `quiet line ${i}`), ...failure, ...afterFailure, ...SUMMARY]
    const out = truncateMiddleSmart(lines, 60).join('\n')
    for (const line of failure) expect(out).toContain(line)
    // The head must still be reachable, because a compiler's first error is usually the root cause.
    expect(out).toContain('noise_0.test.ts')
  })

  it('keeps both ends when capping to a token budget too, so the clamp is not undone downstream', () => {
    // `bash_runner` runs this over the delivered body of every filter once context pressure sets a budget, after the pre-filter clamp has already preserved the tail. A head-only cut here threw that tail away again: a 1,071,063-byte run capped to 2,000 tokens came back holding its first 57 lines and nothing else.
    const body = [...Array.from({ length: 9000 }, (_, i) => `commit ${String(i).padStart(40, '0')}  routine noise`), 'FINAL-ANSWER-SENTINEL'].join('\n')
    const capped = capTokens(body, 2000)
    expect(capped).toContain('FINAL-ANSWER-SENTINEL')
    expect(capped).toContain('commit 0000000000000000000000000000000000000000')
    expect(capped).toContain('[token-goat: output capped at ~2000 tokens]')
  })

  it('delivers the vitest verdict through the real filter, not just the clamp', () => {
    // The unit above tests the helper; this drives the shipping path the hook actually uses, because the cap is applied inside `apply` and a filter that dropped the summary downstream would still pass the helper's tests.
    const filter = filterByName('vitest')
    expect(filter).not.toBeNull()
    const out = filter?.apply(suiteOutput(600), '', 0, ['vitest', 'run']).text as string
    for (const line of SUMMARY) expect(out).toContain(line.trim())
  })

  it('marks a grep match count as a floor when the input was clamped, instead of stating it flat', () => {
    // The count is the answer the caller asked for, not a description of the filter's own work, so a number computed after the clamp dropped part of the input is not a fact. Measured: a 985,533-byte search of 9,000 matching lines delivered `grep: 4685 matches across 40 file(s)`, stated flat. HAND-DERIVED fixture: real grep line shape (`path:lineno:text`), synthetic content, sized to cross the 500KB clamp.
    const filter = filterByName('grep')
    expect(filter).not.toBeNull()
    const big = Array.from({ length: 9000 }, (_, i) => `src/file${i % 40}.ts:${i}:  const value = someCall(${i}) // padding to widen the line well past a hundred bytes so the whole input clears the clamp`).join('\n')
    expect(Buffer.byteLength(big)).toBeGreaterThan(500 * 1024)
    const truncated = filter?.apply(big, '', 0, ['grep', '-rn', 'value', 'src']).text as string
    expect(truncated).toContain('grep: at least ')
    expect(truncated).toContain('lower bounds')
    expect(truncated).not.toMatch(/grep: \d+ matches across/)

    // The same filter over an input that fits must keep saying the count flat, or the honest case has been made to lie too.
    const small = Array.from({ length: 200 }, (_, i) => `src/file${i % 4}.ts:${i}:  const value = someCall(${i})`).join('\n')
    const whole = filter?.apply(small, '', 0, ['grep', '-rn', 'value', 'src']).text as string
    expect(whole).toContain('grep: 200 matches across 4 file(s)')
    expect(whole).not.toContain('at least')
  })

  it('keeps the tail when the final byte cap binds, instead of undoing the line cap that just chose it', () => {
    // capBytes is step 9 of apply(), running after step 8 has already made a head-and-tail selection. A head trim here deleted the tail step 8 had just kept, so a large failing run had its summary selected and then discarded one step later. HAND-DERIVED fixture: the verdict is the final line, which is the shape every command output this runs over actually has.
    const body = [...Array.from({ length: 4000 }, (_, i) => `line ${i} of routine console noise padded out to a reasonable width`), 'VERDICT-AT-THE-END'].join('\n')
    const capped = capBytes(body, 4096)
    expect(capped).toContain('VERDICT-AT-THE-END')
    expect(capped).toContain('line 0 of routine console noise')
    expect(Buffer.byteLength(capped)).toBeLessThanOrEqual(4096)
    // The elided figure is measured against what survived, so it must exceed the naive `original - cap`, which ignores the clamp's own marker and would report less lost than really was.
    const elided = Number(/\[(\d+) bytes elided by token-goat\]/.exec(capped)?.[1])
    expect(elided).toBeGreaterThan(Buffer.byteLength(body) - 4096)
    expect(Buffer.byteLength(body) - elided).toBe(Buffer.byteLength(capped.replace(/\n\.\.\. \[\d+ bytes elided by token-goat\]$/, '')))
  })

  it('spends a tight error-context budget on both ends, not on whichever signals come first by line number', () => {
    // The both-ends signal selection is undone downstream if the context those signals need is gathered wholesale and then sliced by line index: the slice keeps the lowest indices, so the late-file signal chosen from the tail is the first thing dropped whenever context outruns the budget. Here 10 signals need 50 context lines and the budget is 10.
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ordinary output`)
    for (let i = 100; i < 105; i++) lines[i] = `error: early cascade ${i}`
    for (let i = 4000; i < 4005; i++) lines[i] = `error: late failure ${i}`
    lines[4004] = 'error: LATE-SENTINEL the assertion that actually broke'
    const out = truncateMiddleSmart(lines, 30).join('\n')
    expect(out).toContain('LATE-SENTINEL')
    // The early signals must still be reachable, because a compiler's first error is usually the cause.
    expect(out).toContain('early cascade 100')
    expect(out.split('\n').length).toBeLessThanOrEqual(30 + 12)
  })

  it('charges its own elision marker against the budget, so a small cap is not overrun', () => {
    // The marker is ~40 bytes. Against the 500KB input cap that is noise; against a caller passing 60 it is the whole budget, and capBytes passes exactly that. Unreserved, a 50-line input capped at 60 bytes came back at 83.
    const text = Array.from({ length: 50 }, (_, i) => `line-${i}`).join('\n')
    for (const cap of [40, 60, 120, 300]) {
      const out = clampKeepingEnds(text, cap)
      expect(Buffer.byteLength(out ?? text)).toBeLessThanOrEqual(cap)
    }
  })
})
