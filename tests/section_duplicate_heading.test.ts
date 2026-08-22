/**
 * Regression: `section "file::Heading"` silently answered with one of several identically-named
 * headings.
 *
 * A changelog carries one `### Fixed` per release, so `token-goat section "CHANGELOG.md::Fixed"`
 * matched five headings and returned the first with nothing in the output saying the other four
 * existed. The caller could not tell a lucky hit from a wrong one. `section --list` printed the
 * five names indistinguishably, and an out-of-range ordinal reported the heading as *not found*
 * and then suggested it five times over.
 *
 * The ordinal syntax that fixes all of this (`Heading#2`) already worked -- nothing surfaced it.
 *
 * Why didn't a test catch this: every section fixture in the suite used headings that are unique
 * within their file, so the whole duplicate-name branch was unreached. `read` had refused an
 * ambiguous symbol for a long time; `section` is the same shape of question about the same shape
 * of document and answered it by guessing.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { didYouMean, runListSections, runSection } from '../src/read_commands.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let tmpDir: string
let mdFile: string

const DOC = [
  '# Changelog',
  '',
  '## [2.0.0]',
  '',
  '### Fixed',
  '- two point oh',
  '',
  '### Added',
  '- a new thing',
  '',
  '## [1.0.0]',
  '',
  '### Fixed',
  '- one point oh',
  '',
  '## [0.9.0]',
  '',
  '### Fixed',
  '- nought point nine',
  '',
].join('\n')

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tg-dupheading-'))
  mdFile = join(tmpDir, 'CHANGELOG.md')
  writeFileSync(mdFile, DOC)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('section with a heading that occurs more than once', () => {
  it('refuses and names every qualified retry instead of guessing one', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Fixed`, suppressStat: true })
    expect(code, text).toBe(1)
    expect(text, 'the ambiguity was resolved silently to the first match').toContain(
      "Ambiguous heading 'Fixed'",
    )
    expect(text).toContain('3 headings match')
    // Every occurrence gets a runnable retry, so the caller never has to know the `#N` grammar.
    expect(text).toContain('::Fixed#1"')
    expect(text).toContain('::Fixed#2"')
    expect(text).toContain('::Fixed#3"')
  })

  it('still answers a spec that carries an ordinal, without any ambiguity noise', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Fixed#2`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text).toContain('one point oh')
    expect(text).not.toContain('Ambiguous')
  })

  it('answers a unique heading exactly as before', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Added`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text).toContain('a new thing')
  })

  it('reports how many occurrences exist when the ordinal is out of range', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Fixed#9`, suppressStat: true })
    expect(code, text).toBe(1)
    expect(text, 'a present heading was reported as missing').not.toContain('not found')
    expect(text).toContain('has 3 occurrences')
    expect(text).toContain('#1 to #3')
  })
})

describe('section --list with repeated names', () => {
  let stdout: string[]
  let stdoutSpy: WriteSpy

  beforeEach(() => {
    stdout = []
    stdoutSpy = spyOnWrite(process.stdout, stdout)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
  })

  it('numbers a repeated name and leaves a unique one bare', () => {
    expect(runListSections({ file: mdFile })).toBe(0)
    // The exact line set, not a containment check: an implementation that emitted the numbered
    // names AND kept the bare duplicates would satisfy `toContain` while still being unusable.
    expect(
      stdout.join('').split('\n').filter((l) => l.length > 0),
      'repeated names were listed indistinguishably',
    ).toEqual(['Changelog', '[2.0.0]', 'Fixed#1', 'Added', '[1.0.0]', 'Fixed#2', '[0.9.0]', 'Fixed#3'])
  })

  it('numbers them in --json too, which is the form an agent parses', () => {
    expect(runListSections({ file: mdFile, json: true })).toBe(0)
    const parsed = JSON.parse(stdout.join('')) as { items: string[] }
    expect(parsed.items.filter((i) => i.startsWith('Fixed'))).toEqual(['Fixed#1', 'Fixed#2', 'Fixed#3'])
    expect(parsed.items).toContain('Added')
  })

  it('keeps the ordinals a --grep-narrowed list prints usable as retries', () => {
    // Numbering after the filter would renumber the survivors, so `Fixed#1` in a narrowed list
    // would fetch a different section than `Fixed#1` in the full one.
    expect(runListSections({ file: mdFile, grep: 'Fixed' })).toBe(0)
    expect(stdout.join('').split('\n').filter((l) => l.length > 0)).toEqual([
      'Fixed#1',
      'Fixed#2',
      'Fixed#3',
    ])
  })
})

describe('section ambiguity through the multi-heading and json forms', () => {
  it('reports the ambiguous heading inline without failing the whole multi-heading call', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Added,Fixed`, suppressStat: true })
    // `Added` resolved, so the call succeeds -- but `Fixed` must still say why it did not.
    expect(code, text).toBe(0)
    expect(text).toContain('a new thing')
    expect(text).toContain("Ambiguous heading 'Fixed'")
  })

  it('refuses an ambiguous heading under --json rather than emitting one arbitrary section', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Fixed`, json: true, suppressStat: true })
    expect(code, text).toBe(1)
    expect(text).toContain("Ambiguous heading 'Fixed'")
    expect(text, 'a json caller was handed a section it never disambiguated').not.toContain(
      'two point oh',
    )
  })

  it('still emits json for an ordinal-qualified heading', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Fixed#3`, json: true, suppressStat: true })
    expect(code, text).toBe(0)
    const parsed = JSON.parse(text) as { heading: string; content: string }
    expect(parsed.heading).toBe('Fixed')
    expect(parsed.content).toContain('nought point nine')
  })
})

describe('didYouMean', () => {
  it('collapses a repeated candidate instead of spending the whole budget on it', () => {
    const out = didYouMean(['Fixed', 'Fixed', 'Fixed', 'Fixed', 'Fixed'])
    expect(out.split('\n').filter((l) => l.includes('Fixed')), out).toHaveLength(1)
  })

  it('keeps distinct candidates and their order', () => {
    expect(didYouMean(['Beta', 'Alpha', 'Beta'])).toBe('Did you mean:\n  - Beta\n  - Alpha')
  })
})
