/**
 * The security doc's list of project-locked config sections must match the code's.
 *
 * This existed as a real drift, not a hypothetical one: `screenshot` was in
 * `PROJECT_LOCKED_SECTIONS` while docs/security.md said "Five whole sections" and named five. A
 * reader auditing what a cloned repository can reconfigure got a shorter list than the truth. That
 * direction is the harmless one; the same sentence going stale the other way -- naming a section
 * that is no longer locked -- tells a reader a protection exists that does not.
 *
 * The count word is checked as well as the names, because the sentence leads with it and a
 * mismatched number is what a reader actually notices.
 *
 * PROVENANCE
 *
 * HAND-DERIVED. The expectation is computed from `PROJECT_LOCKED_SECTIONS` at run time, so it
 * cannot fall behind the code; the number words are an independent lookup table rather than
 * anything the doc or the config module produces.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { PROJECT_LOCKED_SECTIONS } from '../../src/config.js'

const DOC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'security.md')

const NUMBER_WORDS: Record<number, string> = {
  3: 'Three',
  4: 'Four',
  5: 'Five',
  6: 'Six',
  7: 'Seven',
  8: 'Eight',
  9: 'Nine',
  10: 'Ten',
}

describe('the project-locked section list in docs/security.md', () => {
  const text = fs.readFileSync(DOC, 'utf8')

  it('names every locked section, so the doc cannot under-report what a repository may not touch', () => {
    expect(PROJECT_LOCKED_SECTIONS.length, 'the locked-section list is empty, so this guard checks nothing').toBeGreaterThan(0)

    const sentence = text.split('\n').find((l) => l.includes('whole sections are therefore off limits'))
    expect(sentence, 'the sentence this guard pins is gone from docs/security.md; repoint it').toBeDefined()

    const missing = PROJECT_LOCKED_SECTIONS.filter((s) => !sentence!.includes(`\`${s}\``))
    expect(missing, `these sections are locked in code but not named in docs/security.md: ${missing.join(', ')}`).toEqual([])
  })

  it('states the right number of them', () => {
    const expected = NUMBER_WORDS[PROJECT_LOCKED_SECTIONS.length]
    expect(expected, `add ${PROJECT_LOCKED_SECTIONS.length} to NUMBER_WORDS`).toBeDefined()
    expect(
      text,
      `docs/security.md should say "${expected} whole sections", since PROJECT_LOCKED_SECTIONS has ${PROJECT_LOCKED_SECTIONS.length}`,
    ).toContain(`${expected} whole sections`)
  })
})
