/** A device control string (DCS), and the SOS, PM and APC strings shaped like it, is removed whole up to its string terminator even when its payload holds an ESC. The strip's control-string alternative stopped at the first ESC so that a line of `ESC P` with no terminator could not make it quadratic, and that let the payload of any string holding an ESC through as text: tmux's passthrough, `ESC Ptmux;` then the wrapped sequence with its ESC doubled then ESC and a backslash, reached a tool-output fence as `tmux;` and the clipboard payload after it. The strip now looks for a terminator only before the last one in the text, which keeps it linear. */
import { describe, expect, it } from 'vitest'

import { withoutEscapes } from '../src/injection_scan.js'
import { stripAnsiEscapes } from '../src/render/ansi.js'
import { expectFast, LINE_50K } from './helpers/pathological_scan.js'

const ESC = '\x1b'
const ST = `${ESC}\\`

describe('a control string whose payload holds an ESC is removed whole', () => {
  it.each([
    // PROVENANCE: tmux's passthrough wrapping of an OSC 52 clipboard write, the audit's example.
    ['tmux passthrough', `before ${ESC}Ptmux;${ESC}${ESC}]52;c;aGVsbG8=\x07${ST} after`],
    ['an APC with a colour code inside', `before ${ESC}_payload ${ESC}[31mred${ST} after`],
    ['a PM with a lone ESC inside', `before ${ESC}^note ${ESC} more${ST} after`],
    ['an SOS with two strings behind it', `before ${ESC}Xa${ESC}b${ST} after${ESC}Pq${ESC}r${ST}`],
  ])('%s', (_name, text) => {
    expect(stripAnsiEscapes(text)).toBe('before  after')
    expect(withoutEscapes(text)).toBe('before  after')
  })

  it('a string with no terminator after it still keeps the text that follows', () => {
    expect(stripAnsiEscapes(`a${ESC}Ppayload rest`)).toBe('apayload rest')
    expect(stripAnsiEscapes(`a${ESC}Pone${ST}b${ESC}Ptwo rest`)).toBe('abtwo rest')
  })

  it('colour codes and OSC titles are stripped as before', () => {
    expect(stripAnsiEscapes(`${ESC}[1;31mred${ESC}[0m ${ESC}]0;title\x07x ${ESC}]8;;u${ST}link${ESC}]8;;${ST}`)).toBe('red x link')
  })
})

describe('the control-string strip stays linear', () => {
  const k = LINE_50K / 2
  it.each([
    ['openers with no terminator', `${ESC}P`.repeat(k)],
    ['openers then one terminator at the very end', `${ESC}P`.repeat(k) + ST],
    ['a terminator first, then openers', ST + `${ESC}P`.repeat(k)],
    ['openers each followed by a lone ESC', `${ESC}P${ESC}`.repeat(LINE_50K / 3)],
    ['strings each closed, back to back', `${ESC}Px${ST}`.repeat(LINE_50K / 5)],
  ])('%s', (name, text) => {
    expectFast(() => stripAnsiEscapes(text), name)
    expectFast(() => withoutEscapes(text), `withoutEscapes: ${name}`)
  })
})
