/**
 * How an anchored project note is stored and shown: the `# anchor:` comment line, its life across set/unset/eviction, and the marker buildInjection adds.
 * Fixtures are HAND-DERIVED: each expected file line and marker is written out from the storage format the note set command documents, and the anchor's status comes from a stub resolver passed in so these tests say nothing about the index (tests/note_anchor.test.ts covers that, and tests/note_anchor_goes_stale_after_reindex.test.ts the real worker path).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { dataDir } from '../src/constants.js'
import {
  anchorLine,
  buildInjection,
  loadDatedEntries,
  loadEntries,
  MAX_ENTRIES,
  memoryPath,
  setEntry,
  unsetEntry,
  type AnchorStatus,
  type NoteAnchor,
} from '../src/project_memory.js'

const status = { value: 'changed' as AnchorStatus }
const statusOf = (): AnchorStatus => status.value

const SHA = 'a'.repeat(64)
const ANCHOR: NoteAnchor = { file: 'src/auth.ts', symbol: 'login', sha: SHA }
const LINE = `# anchor: src/auth.ts::login@${SHA}`

describe('anchored project notes', () => {
  const projectsDir = path.join(dataDir(), 'projects')

  beforeEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
    status.value = 'changed'
  })

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
  })

  const fileLines = (hash: string): string[] => fs.readFileSync(memoryPath(hash), 'utf8').split('\n')

  it('writes the anchor as a comment between the set time and the entry, and reads it back', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    const lines = fileLines('p')
    const at = lines.indexOf(LINE)
    expect(lines[at - 1]).toMatch(/^# set /)
    expect(lines[at + 1]).toBe('k = "v"')
    expect(loadDatedEntries('p')['k']?.anchor).toEqual(ANCHOR)
  })

  it('an older reader that knows nothing of anchors still loads the note', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    expect(loadEntries('p')).toEqual({ k: 'v' })
  })

  it('keeps the anchor when another note is set, since the update path re-reads the file', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    setEntry('p', 'other', 'w')
    expect(loadDatedEntries('p')['k']?.anchor).toEqual(ANCHOR)
    expect(loadDatedEntries('p')['other']?.anchor).toBeUndefined()
  })

  it('drops the anchor when the note is set again without one', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    setEntry('p', 'k', 'v2')
    expect(loadDatedEntries('p')['k']?.anchor).toBeUndefined()
    expect(fileLines('p')).not.toContain(LINE)
  })

  it('drops the anchor with the note on unset', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    setEntry('p', 'other', 'w')
    unsetEntry('p', 'k')
    expect(fileLines('p')).not.toContain(LINE)
  })

  it('drops the anchor with the note when it is evicted at capacity', () => {
    setEntry('p', 'k', 'v', ANCHOR)
    for (let i = 0; i < MAX_ENTRIES; i++) setEntry('p', `n${i}`, 'x')
    expect(Object.keys(loadEntries('p'))).not.toContain('k')
    expect(fileLines('p')).not.toContain(LINE)
  })

  it('refuses an anchor it could not read back', () => {
    expect(anchorLine(ANCHOR)).toBe(LINE)
    expect(anchorLine({ ...ANCHOR, symbol: 'a:b' })).toBeNull()
    expect(anchorLine({ ...ANCHOR, symbol: 'a@b' })).toBeNull()
    expect(anchorLine({ ...ANCHOR, symbol: 'a b' })).toBeNull()
    expect(anchorLine({ ...ANCHOR, file: 'src/a\nb.ts' })).toBeNull()
  })

  it('ignores a malformed anchor comment rather than refusing the file', () => {
    fs.mkdirSync(projectsDir, { recursive: true })
    fs.writeFileSync(memoryPath('p'), `# anchor: src/auth.ts::login@nothex\nk = "v"\n`)
    expect(loadDatedEntries('p')['k']).toEqual({ value: 'v' })
    setEntry('p', 'other', 'w')
    expect(loadEntries('p')).toEqual({ k: 'v', other: 'w' })
  })

  it('takes the anchor from the same line of a duplicated key that the value comes from', () => {
    fs.mkdirSync(projectsDir, { recursive: true })
    // A hand-edited file can repeat a key; the later line wins, so its missing anchor must win too, or the anchor of a value that is no longer there flags the one that is.
    fs.writeFileSync(memoryPath('p'), `${LINE}\nk = "v"\nk = "w"\n`)
    expect(loadDatedEntries('p')['k']).toEqual({ value: 'w' })
  })

  describe('buildInjection', () => {
    it('marks a note whose anchored symbol changed', () => {
      setEntry('p', 'k', 'v', ANCHOR)
      expect(buildInjection('p', '/root', statusOf)).toContain('(changed since note): v')
    })

    it('marks a note whose anchored symbol is gone', () => {
      status.value = 'gone'
      setEntry('p', 'k', 'v', ANCHOR)
      expect(buildInjection('p', '/root', statusOf)).toContain('(anchored symbol gone): v')
    })

    it('adds nothing while the symbol is current or its status unknown', () => {
      setEntry('p', 'k', 'v', ANCHOR)
      for (const s of ['current', 'unknown'] as const) {
        status.value = s
        expect(buildInjection('p', '/root', statusOf)).not.toMatch(/since note|symbol gone/)
      }
    })

    it('adds nothing without a project root or a resolver, or to a note with no anchor', () => {
      setEntry('p', 'k', 'v', ANCHOR)
      setEntry('p', 'plain', 'w')
      const out = buildInjection('p') ?? ''
      expect(out).not.toContain('since note')
      expect(buildInjection('p', '/root') ?? '').not.toContain('since note')
      expect(buildInjection('p', '/root', statusOf)).toContain('**plain** (set')
      expect(buildInjection('p', '/root', statusOf)).not.toMatch(/\*\*plain\*\*[^\n]*since note/)
    })

    // HAND-DERIVED: MAX_TOTAL_CHARS is 4000. Every value length from 1 to 300 over 40 anchored notes lands the last note shown at every distance from the cap, so a marker appended after the cap check pushes the block over it at some length, whichever of the two markers it is.
    it('stays within 4000 characters at every note length with every note marked', () => {
      fs.mkdirSync(projectsDir, { recursive: true })
      for (const s of ['changed', 'gone'] as const) {
        status.value = s
        for (let len = 1; len <= 300; len++) {
          const lines: string[] = []
          for (let i = 10; i < 50; i++) lines.push(LINE, `k${i} = "${'x'.repeat(len)}"`)
          fs.writeFileSync(memoryPath('p'), lines.join('\n') + '\n')
          const out = buildInjection('p', '/root', statusOf) ?? ''
          const at = `${s}, value length ${len}`
          expect(out, at).toContain(s === 'changed' ? '(changed since note)' : '(anchored symbol gone)')
          expect(out.length, at).toBeLessThanOrEqual(4000)
        }
      }
    })
  })
})
