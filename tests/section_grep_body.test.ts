import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

import { runSection } from '../src/read_section.js'

// Provenance: HAND-DERIVED. The document is written out line by line below and the expected survivors are read off it by hand, independently of the filter's code.
const DOC = [
  '# Doc',
  '',
  '## A',
  'intro text',
  '### Fixed',
  'fixed the lock race',
  'unrelated middle line',
  '### Added',
  'added a lock file',
  'trailing text',
  '',
  '## B',
  'lock in another section',
].join('\n')

describe('section --grep filters the section body', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-section-grep-'))
    file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, DOC)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('keeps matching lines with the section and nearest sub-headings, and drops the rest', () => {
    const res = runSection({ spec: `${file}::A`, grep: 'lock' })
    expect(res.code).toBe(0)
    for (const kept of ['## A', '### Fixed', 'fixed the lock race', '### Added', 'added a lock file']) expect(res.text).toContain(kept)
    for (const dropped of ['unrelated middle line', 'intro text', 'trailing text', 'lock in another section']) expect(res.text).not.toContain(dropped)
    expect(res.text).toContain('2 of 8 lines matched')
  })

  it('prints the empty-filter notice and exits 0 when nothing matches', () => {
    const res = runSection({ spec: `${file}::A`, grep: 'frontmatter' })
    expect(res.code).toBe(0)
    expect(res.text).toContain('filtered out by --grep frontmatter')
    expect(res.text).not.toContain('unrelated middle line')
  })

  it('matches an invalid regex literally', () => {
    fs.writeFileSync(file, '# Doc\n\n## A\nfoo(bar\nplain\n')
    const res = runSection({ spec: `${file}::A`, grep: '(' })
    expect(res.code).toBe(0)
    expect(res.text).toContain('foo(bar')
    expect(res.text).not.toContain('plain')
  })

  it('carries only the matched lines in --json', () => {
    const res = runSection({ spec: `${file}::A`, grep: 'lock', json: true })
    const parsed = JSON.parse(res.text) as { content: string; matchedLines: number }
    expect(parsed.content).toContain('added a lock file')
    expect(parsed.content).not.toContain('unrelated middle line')
    expect(parsed.matchedLines).toBe(2)
  })

  it('filters each spec of a comma multi-heading read', () => {
    const res = runSection({ spec: `${file}::A,B`, grep: 'lock' })
    expect(res.text).toContain('fixed the lock race')
    expect(res.text).toContain('lock in another section')
    expect(res.text).not.toContain('unrelated middle line')
  })

  it('filters each spec of a cross-file read', () => {
    const other = path.join(dir, 'other.md')
    fs.writeFileSync(other, '# O\n\n## C\nlock here\nnot this\n')
    const res = runSection({ spec: `${file}::A,${other}::C`, grep: 'lock' })
    expect(res.text).toContain('fixed the lock race')
    expect(res.text).toContain('lock here')
    expect(res.text).not.toContain('not this')
    expect(res.text).not.toContain('unrelated middle line')
  })
})
