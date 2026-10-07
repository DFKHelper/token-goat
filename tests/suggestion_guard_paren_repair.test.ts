/** When the relay's suggestion guard (stripUnsafeSuggestions in src/hint_suggestion_guard.ts) removes an unsafe command it widens the removal to the last backtick on the line, and that can take one side of a parenthesis in the prose around the command. The edit-anyway hint for `src/a`b.ts` came out as "use `token-goat (command omitted: …)`) to rewrite the whole file": the `(or `--from …`` of a parenthetical went with the command and its `)` stayed. Provenance: the stranded `)` is CAPTURE from stripUnsafeSuggestions(editAnywayHint('src/a`b.ts')) against the source at 69acedbc (2026-10-07); every other text is HAND-DERIVED from the shape of a call site named beside it, with paths chosen to break the quoting, independent of the guard's matcher. */
import { describe, expect, it } from 'vitest'

import { surgicalHintFor } from '../src/bash_extractors.js'
import { leadWithCommand, quotedArg, quotedArgs, stripUnsafeSuggestions } from '../src/hint_suggestion_guard.js'
import { editAnywayHint } from '../src/hooks_read_slice.js'

const OMITTED = 'token-goat (command omitted: the path contains shell metacharacters)'

/** Whether every `)` in `text` closes a `(` before it and every `(` is closed. */
function parensPaired(text: string): boolean {
  let depth = 0
  for (const c of text) {
    if (c === '(') depth++
    else if (c === ')' && --depth < 0) return false
  }
  return depth === 0
}

describe('a removed command whose widened removal took one side of a parenthesis', () => {
  it.each(['src/a`b.ts', 'src/a$(id).ts', `src/a"'b.ts`])('leaves no stray ) in the edit-anyway hint for %s', (p) => {
    const hint = editAnywayHint(p)
    const out = stripUnsafeSuggestions(hint)
    expect(out).toBe('To edit it anyway, use `' + OMITTED + '`' + hint.slice(hint.indexOf(') to rewrite the whole file') + 1))
    expect(parensPaired(out)).toBe(true)
  })

  it('leaves no stray ) in the JSON outline-then-query hint (src/bash_extractors.ts)', () => {
    const hint = surgicalHintFor('cfg`x.json', false, true, false, false, { name: 'KEY', real: false, slice: 'key' })
    expect(hint).toContain('(`"[\'a.b\']"` for a key holding a dot)')
    const out = stripUnsafeSuggestions(hint)
    expect(out.startsWith('Run `' + OMITTED + '`')).toBe(true)
    expect(out).not.toContain('`)')
    expect(parensPaired(out)).toBe(true)
  })

  it('leaves no stray ) when the parenthetical follows the first command (src/hooks_read.ts surgicalHint, sessionArtifactRecall)', () => {
    const p = 'out`x.json'
    const jsonHint = leadWithCommand(`token-goat json-query ${quotedArgs(p, '<key>').join(' ')}`, `(or \`token-goat json-outline ${quotedArg(p)}\`) to slice one value`)
    expect(stripUnsafeSuggestions(jsonHint)).toBe('Run `' + OMITTED + '` to slice one value.')
    const recall = 'Use `token-goat bash-output --file ' + quotedArg(p) + ' --tail 50` (or `--grep PATTERN`) to read a slice instead of the full file.'
    expect(stripUnsafeSuggestions(recall)).toBe('Use `' + OMITTED + '` to read a slice instead of the full file.')
  })

  it('puts back the ) of a parenthetical opened before the command', () => {
    expect(stripUnsafeSuggestions("Then edit it (run `token-goat write-file 'a`b.ts' --b64 '<base64>'`) or `cat` it.")).toBe('Then edit it (run `' + OMITTED + '`) it.')
    expect(stripUnsafeSuggestions("Then edit it (run token-goat write-file 'a`b.ts')")).toBe('Then edit it (run ' + OMITTED + ')')
  })

  it('adds no ) the removal did not take, for a parenthetical the line leaves open', () => {
    expect(stripUnsafeSuggestions("Options (pick one: `token-goat read 'a`b.ts'` now,\nor read it.)")).toBe('Options (pick one: `' + OMITTED + '` now,\nor read it.)')
  })

  it('keeps a ) that still closes a parenthetical opened before the command', () => {
    expect(stripUnsafeSuggestions("Hint (see `token-goat read 'a`b.ts'`) more.")).toBe('Hint (see `' + OMITTED + '`) more.')
  })

  it('reads no parenthesis in the path as prose', () => {
    expect(stripUnsafeSuggestions("Run `token-goat outline 'a(`b.md'` now.")).toBe('Run `' + OMITTED + '` now.')
    expect(stripUnsafeSuggestions("Run `token-goat outline 'a)`b.md'` now.")).toBe('Run `' + OMITTED + '` now.')
  })
})
