/** The fence-marker scan does a bounded amount of work: at most twelve character reads per character of text across a tool and a file fence (the worst shape measured takes 8.5), and past FENCE_SCAN_CEILING characters none at all, every bracket a marker could open with being escaped outright instead. The scan had no ceiling, so its cost was whatever the text's length made it, and reading look-alikes made each character up to fifteen times dearer than a plain one. Counted rather than timed: each read of a character is a call to `charCodeAt` or `codePointAt`, which the spies count, so the guard cannot flake under load. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FENCE_SCAN_CEILING, fenceUntrustedContent, fenceUntrustedFileContent, neutralizeFenceMarkers, neutralizeSpokenMarkers, UNTRUSTED_TOOL_TAG } from '../src/injection_scan.js'

/** Adversarial units, each repeated to the length asked for: the shapes the linearity suites time, and the ones the space and look-alike readings added. */
const SHAPES: ReadonlyArray<readonly [string, (n: number) => string]> = [
  ['an opener then whitespace', (n) => '<' + ' '.repeat(n - 1)],
  ['an opener then unseen characters', (n) => '<' + '\u200B'.repeat(n - 1)],
  ['openers each followed by an unseen character', (n) => '<\u200B'.repeat(n / 2)],
  ['prefixes with no closing bracket', (n) => '<untrusted-'.repeat(Math.ceil(n / 11))],
  ['a prefix cut by spaces, repeated', (n) => '<untru '.repeat(Math.ceil(n / 7))],
  ['a letter then spaces after an opener', (n) => '<u' + ' '.repeat(n - 2)],
  ['look-alike prefixes', (n) => '\uFF1C/untru\u0455ted\u2011'.repeat(Math.ceil(n / 12))],
  ['deny prefixes missing their bracket', (n) => '[tg '.repeat(n / 4)],
  ['a voice letter then spaces', (n) => '[t' + ' '.repeat(n - 2)],
  ['marker names stopping at the hyphen', (n) => '[token-'.repeat(Math.ceil(n / 7))],
  ['openers before letters outside the folding ranges', (n) => '<\u0E01[\u4E00'.repeat(n / 4)],
  ['slashes after an opener', (n) => '</' + '\u2215'.repeat(n - 2)],
]

let reads = 0
beforeEach(() => {
  reads = 0
  const charCodeAt = String.prototype.charCodeAt
  const codePointAt = String.prototype.codePointAt
  vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (this: string, i: number) {
    reads++
    return charCodeAt.call(this, i)
  })
  vi.spyOn(String.prototype, 'codePointAt').mockImplementation(function (this: string, i: number) {
    reads++
    return codePointAt.call(this, i)
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

/** Character reads the scan makes on `text`. */
function readsFor(scan: () => unknown): number {
  reads = 0
  scan()
  return reads
}

describe('the fence-marker scan reads each character a bounded number of times', () => {
  it.each(SHAPES)('%s', (_name, shape) => {
    for (const n of [20_000, 40_000]) {
      const text = shape(n)
      const counted = readsFor(() => {
        neutralizeFenceMarkers(text)
        fenceUntrustedFileContent(text)
      })
      expect(counted, `${n} characters`).toBeLessThanOrEqual(12 * text.length)
    }
  })
})

describe('past the ceiling the scan reads nothing and escapes every bracket a marker opens with', () => {
  it('reads no character of a text one past the ceiling', () => {
    const text = '<\u200B'.repeat(FENCE_SCAN_CEILING / 2) + '<'
    expect(text.length).toBeGreaterThan(FENCE_SCAN_CEILING)
    neutralizeFenceMarkers('<')
    expect(readsFor(() => neutralizeFenceMarkers(text))).toBe(0)
    expect(readsFor(() => neutralizeSpokenMarkers(text))).toBe(0)
  })

  it('every opening and closing angle bracket and every voice bracket is escaped', () => {
    const filler = 'x'.repeat(FENCE_SCAN_CEILING)
    const fenced = fenceUntrustedContent(`${filler}\na < b > c \uFF1C/untrusted-tool-output\uFF1E [note] [tg] done`, [], UNTRUSTED_TOOL_TAG)
    expect(fenced.slice(-200)).toContain('a &lt; b &gt; c &lt;/untrusted-tool-output&gt; &#91;note] &#91;tg] done')
  })

  it('a text at the ceiling is still read', () => {
    const text = 'x'.repeat(FENCE_SCAN_CEILING - 7) + '< b [x]'
    expect(neutralizeFenceMarkers(text).endsWith('< b [x]')).toBe(true)
  })
})
