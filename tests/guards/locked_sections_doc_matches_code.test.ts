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

import { lockedEnvOverridableKeys } from '../../src/cli_doctor.js'
import { PROJECT_LOCKED_KEYS, PROJECT_LOCKED_SECTIONS } from '../../src/config.js'

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

// Lower case and reaching further, because the two claims below sit mid-sentence rather than opening one, and both counts are already past ten.
const COUNT_WORDS: Record<number, string> = {
  8: 'eight',
  9: 'nine',
  10: 'ten',
  11: 'eleven',
  12: 'twelve',
  13: 'thirteen',
  14: 'fourteen',
  15: 'fifteen',
  16: 'sixteen',
  17: 'seventeen',
  18: 'eighteen',
  19: 'nineteen',
  20: 'twenty',
  21: 'twenty-one',
  22: 'twenty-two',
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

  // The section half of this sentence was guarded from the start and the key half was not, so the
  // key half is the half that went stale: it still said "plus one individual key" after seven more
  // had been added, four of them in the same release that added this test.
  it('names every locked key literally, so a reader is not told a shorter list than the code enforces', () => {
    expect(PROJECT_LOCKED_KEYS.length, 'the locked-key list is empty, so this guard checks nothing').toBeGreaterThan(0)

    const missing = PROJECT_LOCKED_KEYS.filter((k) => !text.includes(`\`${k}\``))
    expect(missing, `these keys are locked in code but not named in docs/security.md: ${missing.join(', ')}`).toEqual([])
  })

  it('states the right number of locked keys', () => {
    const expected = COUNT_WORDS[PROJECT_LOCKED_KEYS.length]
    expect(expected, `add ${PROJECT_LOCKED_KEYS.length} to COUNT_WORDS`).toBeDefined()
    // Lower-cased, because this count happens to open its sentence and the doc capitalises a word the table stores lower case.
    expect(
      text.toLowerCase(),
      `docs/security.md should say "${expected} individual keys", since PROJECT_LOCKED_KEYS has ${PROJECT_LOCKED_KEYS.length}`,
    ).toContain(`${expected} individual keys`)
  })

  // A different set again: the keys the *environment* can still decide, which is neither the section
  // list nor the key list but derived from both. `doctor` prints this count at run time, so the doc
  // and the command disagreeing is something a reader can see for themselves.
  it('states the right number of environment-overridable locked keys', () => {
    const n = lockedEnvOverridableKeys().length
    expect(n, 'the env-overridable set is empty, so this guard checks nothing').toBeGreaterThan(0)
    const expected = COUNT_WORDS[n]
    expect(expected, `add ${n} to COUNT_WORDS`).toBeDefined()
    expect(
      text,
      `docs/security.md should say "all ${expected} locked keys", since lockedEnvOverridableKeys() returns ${n}`,
    ).toContain(`all ${expected} locked keys`)
  })
})
