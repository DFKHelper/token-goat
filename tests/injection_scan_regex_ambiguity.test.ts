import { describe, expect, it } from 'vitest'

import {
  fenceMarkerPattern,
  neutralizeSpokenMarkers,
  SPOKEN_MARKER,
  UNTRUSTED_FILE_TAG,
  UNTRUSTED_GITHUB_TAG,
  UNTRUSTED_HTML_TAG,
  UNTRUSTED_OCR_TAG,
  UNTRUSTED_TOOL_TAG,
  UNTRUSTED_WEB_TAG,
} from '../src/injection_scan.js'
import { ambiguousParts } from './helpers/regex_ambiguity.js'

// HAND-DERIVED: no fixture bytes. The checker walks every code point 0..0x10FFFF through the parts of a pattern, so the verdict is a property of the pattern alone and no input length, clock or machine speed enters it. U+FEFF is both whitespace (\s) and a format character (\p{Cf}), which is the overlap that made `(?:\s|[\p{Cf}...])*` backtrack exponentially on `[` + FEFF x n + `x`.
const FEFF = String.fromCodePoint(0xfeff)

describe('the regex ambiguity checker', () => {
  it('reports the alternation whose branches share U+FEFF', () => {
    expect(ambiguousParts(/\[(?:\s|[\p{Cf}])*x/u).join('\n')).toContain('repeated alternatives \\s and [\\p{Cf}] both match U+feff')
  })

  it('reports two whitespace runs split only by an optional slash', () => {
    expect(ambiguousParts(/<\s*\/?\s*x/).join('\n')).toContain('adjacent \\s and \\s both match U+9')
  })

  it('accepts disjoint neighbours and a mandatory literal between two runs', () => {
    expect(ambiguousParts(/a*b*/)).toEqual([])
    expect(ambiguousParts(/\s*x\s*/)).toEqual([])
  })

  it('refuses a repeated group of more than one atom instead of passing it', () => {
    expect(() => ambiguousParts(/(?:ab|c)*/)).toThrow('unsupported repeated group shape')
  })
})

describe('the patterns that read untrusted bytes cannot backtrack catastrophically', () => {
  it('has no overlapping neighbours in the spoken marker', () => {
    expect(ambiguousParts(SPOKEN_MARKER)).toEqual([])
  })

  for (const tag of [UNTRUSTED_WEB_TAG, UNTRUSTED_FILE_TAG, UNTRUSTED_OCR_TAG, UNTRUSTED_TOOL_TAG, UNTRUSTED_GITHUB_TAG, UNTRUSTED_HTML_TAG]) {
    it('has none in the ' + tag + ' tag match', () => {
      expect(ambiguousParts(fenceMarkerPattern(tag))).toEqual([])
      expect(ambiguousParts(fenceMarkerPattern(tag, true))).toEqual([])
    })
  }

  it('still escapes a marker behind a long run of U+FEFF', () => {
    const out = neutralizeSpokenMarkers('[' + FEFF.repeat(50000) + 'token-goat: x]')
    expect(out.startsWith('&#91;')).toBe(true)
  })
})
