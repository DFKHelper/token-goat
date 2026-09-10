import { describe, it, expect } from 'vitest'
import { planProseFolds, foldDetail } from '../src/code_fold.js'
import { proseFoldNotice } from '../src/fold_delivery.js'

/**
 * Folding a long prose paragraph down to its opening sentence.
 *
 * Fixture provenance: HAND-DERIVED for the logic cases, CAPTURE for the shape. The paragraphs below
 * are written for this test and every expected cut is computed from the input by reading it, not by
 * running the planner and recording what it said. The document *shape* they imitate -- one heading
 * line, then list items whose whole body is a single physical line of several hundred characters --
 * is this repository's own changelog, which is what real reads of it deliver.
 *
 * There is no ratio assertion here on purpose. A fold ratio improves when more is removed, so a
 * floor on it is satisfied by exactly the failure this planner has to avoid. Every test below names
 * text that must survive instead.
 */
describe('prose fold', () => {
  /** Builds rows the way both hook surfaces do: 1-based line numbers, one entry per physical line. */
  function rows(...lines: readonly string[]): Array<{ no: number; text: string }> {
    return lines.map((text, i) => ({ no: i + 1, text }))
  }

  const LONG_TAIL = ' It then continues for a good while longer, restating the point in more detail than a reader scanning the document has any use for, which is exactly the text this fold exists to remove from the delivered output.'
  const paragraph = `A shell read of a file now withholds only the lines already shown.${LONG_TAIL}${LONG_TAIL}`

  it('keeps the opening sentence and folds the rest of the paragraph', () => {
    const folds = planProseFolds(rows(paragraph), new Set())
    expect(folds).toHaveLength(1)
    expect(folds[0]?.kind).toBe('prose')
    expect(folds[0]?.keep).toBe('A shell read of a file now withholds only the lines already shown.')
    // One row in, one row out: the paragraph is replaced in place rather than removed, which is what keeps its opening visible.
    expect(folds[0]?.len).toBe(1)
    expect(folds[0]?.startIdx).toBe(0)
  })

  it('never touches a structural line, however long it runs', () => {
    // These carry the document's shape. A heading is the one line a reader navigates by; a table row and a fence are syntax whose meaning depends on the whole line surviving; a blockquote is someone else's words, and trimming a quotation misrepresents its source rather than merely shortening it.
    const structural = [`## ${paragraph}`, `| ${paragraph} |`, `> ${paragraph}`, '```']
    expect(planProseFolds(rows(...structural), new Set())).toHaveLength(0)
  })

  it('folds a list item, keeping its marker and lead sentence in place', () => {
    // This is the shape the fold was measured against, not an edge case: a changelog entry is a bullet whose whole body is one physical line. The marker sits inside the kept text, so the list still reads as a list.
    for (const marker of ['- ', '1. ', '* ']) {
      const folds = planProseFolds(rows(`${marker}**A shell read now withholds only what was already shown.**${LONG_TAIL}${LONG_TAIL}`), new Set())
      expect(folds[0]?.keep).toBe(`${marker}**A shell read now withholds only what was already shown.**`)
    }
  })

  it('leaves a short paragraph alone, where the marker would cost more than the fold saves', () => {
    // 287 characters with its opening sentence at 26% of them, so it clears the keep ratio comfortably and the length floor is the only rule left to decline it. Two earlier fixtures here passed with the floor removed: a single sentence fails the ratio test instead, and so does a two-sentence line whose opening runs to two thirds of it.
    expect(planProseFolds(rows(`A shell read of a file now withholds only the lines the session already saw.${LONG_TAIL}`), new Set())).toHaveLength(0)
  })

  it('declines a paragraph whose opening sentence is most of it', () => {
    // Nothing meaningful is removed here, so the reader would pay a recall pointer for a paragraph they had essentially received in full.
    const oneSentence = `${'A single unbroken clause about the delivery path that simply keeps going and going, '.repeat(6)}and then ends. Short tail.`
    expect(planProseFolds(rows(oneSentence), new Set())).toHaveLength(0)
  })

  it('does not treat an abbreviation or an initial as the end of the opening sentence', () => {
    // Each false terminator below sits past the 40-character sentence floor, so that floor cannot be what declines it and the abbreviation rule is genuinely under test. A shorter fixture passes either way: measured by removing the rule, one placed at character 30 still produced the right answer.
    const cases: ReadonlyArray<readonly [string, string]> = [
      [`Applies the harness delivery cap before any fold runs, e.g. when a shell read overruns it.${LONG_TAIL}${LONG_TAIL}`, 'Applies the harness delivery cap before any fold runs, e.g. when a shell read overruns it.'],
      [`The rule dates back to a memo written by R. Fielding, whose thesis is its source.${LONG_TAIL}${LONG_TAIL}`, 'The rule dates back to a memo written by R. Fielding, whose thesis is its source.'],
    ]
    for (const [text, expected] of cases) {
      expect(planProseFolds(rows(text), new Set())[0]?.keep).toBe(expected)
    }
  })

  it('does not split a decimal point, which the whitespace rule already covers', () => {
    // No abbreviation rule is involved: `0.75` is not a sentence end because a digit follows the point, not a space. Asserted because the behaviour is load-bearing even though nothing in the planner tests for it by name.
    const text = `Rejects any sampling ratio below 0.75, past which the population stops being representative.${LONG_TAIL}${LONG_TAIL}`
    expect(planProseFolds(rows(text), new Set())[0]?.keep).toBe('Rejects any sampling ratio below 0.75, past which the population stops being representative.')
  })

  it('skips an opening fragment too short to summarise anything', () => {
    const text = `Superseded. Use the delivery-cap helper, which clamps to what the harness will actually send.${LONG_TAIL}${LONG_TAIL}`
    expect(planProseFolds(rows(text), new Set())[0]?.keep).toBe('Superseded. Use the delivery-cap helper, which clamps to what the harness will actually send.')
  })

  it('never folds a line inside a code fence, and resumes after it closes', () => {
    // Found by censusing the planner over 2,032 real document reads: 70 fenced lines were folded, because declining the delimiter line says nothing about the lines between delimiters. A long line in a fenced block is a payload, a log record or a command, and cutting it at its first full stop corrupts precisely the content a writer fenced to protect.
    const json = `{"cap": 20000, "note": "${'a very long delivered value that runs on. '.repeat(12)}"}`
    expect(json.length).toBeGreaterThan(400)
    const folds = planProseFolds(rows('```json', json, '```', paragraph), new Set())
    expect(folds).toHaveLength(1)
    expect(folds[0]?.firstLine).toBe(4)
  })

  it('does not fold a row another planner already claimed', () => {
    // Two planners folding the same row would each book its bytes, and the second notice would describe lines the first had already removed.
    expect(planProseFolds(rows(paragraph), new Set([0]))).toHaveLength(0)
  })

  it('falls back to a ranged Read when no enclosing section can be resolved, and carries no stray marker', () => {
    // Both assertions come from running the built binary against this repository's own changelog, where the first draft of this notice failed them. It named `token-goat section "CHANGELOG.md::<heading>"`, a placeholder the reader is left to resolve on their own, and it opened with a `[token-goat]` marker that the untrusted-output fence escaped to `&#91;token-goat]` in the text actually delivered. A nonexistent normalizedPath here means findContainingSection cannot resolve a heading, exercising that fallback branch specifically; tests/fold_pointer_round_trip.test.ts drives the real, resolvable case end to end through the hook pair and proves the section pointer it prints actually round-trips.
    const notice = proseFoldNotice('A shell read now withholds only what was already shown.', 42, 'CHANGELOG.md', 'c:/nonexistent/CHANGELOG.md')
    expect(notice).toBe('A shell read now withholds only what was already shown. ... rest of paragraph folded (line 42) -- Read "CHANGELOG.md" with offset=42, limit=1')
    expect(notice).not.toContain('<')
    expect(notice).not.toContain('[')
  })

  it('keeps the paragraph out of the ledger, recording only its line', () => {
    // `name` on a prose fold is a placeholder, but `keep` holds document text and the detail column must never carry it: a stats row is not a place to store what someone was reading.
    const folds = planProseFolds(rows('', paragraph), new Set())
    const detail = foldDetail('docs/a.md', folds)
    expect(detail).toBe('docs/a.md::#2-2')
    expect(detail).not.toContain('withholds')
  })
})
