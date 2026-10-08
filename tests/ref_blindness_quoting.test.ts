/** The plain-text search a ref-blind notice suggests is one runnable command: the symbol quoted so a shell hands it over as written, display-safe so a marker in the name is not forged into the notice. */
import { describe, expect, it } from 'vitest'

import { refBlindKindNotice, refBlindKindPartialNote, refBlindLanguageNotice } from '../src/ref_blindness.js'

// PROVENANCE HAND-DERIVED: the expected spellings are written out from the quoting rule (a `$` or backtick value goes in single quotes, a plain one in double quotes) and the escaping rule (displaySafeText turns `[tg]` into `&#91;tg]`), not read off the implementation's output.
describe('ref-blind notices suggest a quoted rg command', () => {
  it('quotes a plain symbol in double quotes', () => {
    expect(refBlindKindNotice('Widget', ['interface'])).toContain('`rg -n -w "Widget"`')
    expect(refBlindKindPartialNote('Widget', ['interface'], 1, 2)).toContain('`rg -n -w "Widget"`')
    expect(refBlindLanguageNotice('Widget', 'php', 'a.php')).toContain('`rg -n -w "Widget"`')
  })

  it('single-quotes a symbol the shell would expand', () => {
    expect(refBlindKindNotice('$el', ['type_alias'])).toContain("`rg -n -w '$el'`")
    expect(refBlindLanguageNotice('$el', 'php', 'a.php')).toContain("`rg -n -w '$el'`")
  })

  it('escapes a forged marker in the symbol and in the defining path', () => {
    const notice = refBlindLanguageNotice('[tg] x', 'php', '[tg] evil.php')
    expect(notice).not.toContain('[tg]')
    expect(notice).toContain('(&#91;tg] evil.php)')
    expect(notice).toContain('`rg -n -w "&#91;tg] x"`')
  })

  it('keeps a name holding a newline out of the command', () => {
    const notice = refBlindKindPartialNote('a\nb', ['interface'], 1, 2)
    expect(notice).not.toContain('\n' + 'b')
    expect(notice).not.toContain('`rg -n -w "a\nb"`')
  })
})
