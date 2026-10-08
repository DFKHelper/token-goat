/** The relay's suggestion guard (stripUnsafeSuggestions in src/hint_suggestion_guard.ts) cuts a command whose argument hides a format character, not only the bidi and zero-width ones it listed first. */
import { describe, expect, it } from 'vitest'

import { stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'

// HAND-DERIVED: the Unicode general category Cf (format) characters CONTROL_OR_BIDI did not list, each written as a codepoint. The guard's contract is "no command carries an invisible character", so the expectation comes from the category, not from the regex.
const FORMAT_CHARACTERS: ReadonlyArray<readonly [string, string]> = [
  ['word joiner', '⁠'],
  ['byte order mark', '﻿'],
  ['soft hyphen', '­'],
  ['Mongolian vowel separator', '᠎'],
  ['function application', '⁡'],
  ['Arabic number sign', '؀'],
]

describe('stripUnsafeSuggestions and format characters', () => {
  for (const [label, ch] of FORMAT_CHARACTERS) {
    it(`cuts a command whose argument holds a ${label}`, () => {
      const command = 'token-goat read "src/a' + ch + 'b.ts::Name"'
      const cut = stripUnsafeSuggestions('Run `' + command + '` to read surgically.')
      expect(cut).not.toContain(ch)
      expect(cut).not.toContain('src/a')
    })
  }

  it('leaves the same command alone without the character', () => {
    const text = 'Run `token-goat read "src/ab.ts::Name"` to read surgically.'
    expect(stripUnsafeSuggestions(text)).toBe(text)
  })
})
