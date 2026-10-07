// Regression: insert-section on a mixed-line-ending file rewrote every line's EOL to the dominant style, turning a one-section insert into a whole-file diff. Untouched lines must keep their original bytes.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { cmdInsertSection } from '../src/cli_file_ops.js'
import { spyOnWrite, type WriteSpy } from './setup/spy-stdio.js'

let dir: string
let spy: WriteSpy

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ins-eol-'))
  spy = spyOnWrite(process.stdout, [])
})

afterEach(() => {
  spy.mockRestore()
  fs.rmSync(dir, { recursive: true, force: true })
})

function insert(file: string, after: string, text: string): void {
  cmdInsertSection(file, { after, contentB64: Buffer.from(text, 'utf8').toString('base64') })
}

// Provenance: HAND-DERIVED the fixture is built byte by byte; the first section is CRLF, the second LF, the third CRLF, so LF-or-CRLF dominance is ambiguous and a whole-file rewrite changes bytes.
const MIXED = '# Doc\r\n\r\n## One\r\nalpha\r\n\r\n## Two\nbeta\ngamma\n\n## Three\r\ndelta\r\n'

describe('insert-section keeps untouched line endings', () => {
  it('inserting after a CRLF section leaves the LF section byte-identical and uses CRLF at the splice', () => {
    const file = path.join(dir, 'mixed.md')
    fs.writeFileSync(file, MIXED)
    insert(file, 'One', 'inserted\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('# Doc\r\n\r\n## One\r\nalpha\r\ninserted\r\n\r\n## Two\nbeta\ngamma\n\n## Three\r\ndelta\r\n')
  })

  it('inserting after an LF section uses LF at the splice and leaves the CRLF sections untouched', () => {
    const file = path.join(dir, 'mixed2.md')
    fs.writeFileSync(file, MIXED)
    insert(file, 'Two', 'inserted\r\nmore\r\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('# Doc\r\n\r\n## One\r\nalpha\r\n\r\n## Two\nbeta\ngamma\ninserted\nmore\n\n## Three\r\ndelta\r\n')
  })

  it('appending after the last section of a file with no trailing newline keeps the old no-trailing-newline shape', () => {
    const file = path.join(dir, 'tail.md')
    fs.writeFileSync(file, '# Doc\r\n## Last\r\nend')
    insert(file, 'Last', 'tail\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('# Doc\r\n## Last\r\nend\r\ntail')
  })
})

// Provenance: HAND-DERIVED, each expected file written out by hand from the input: an inserted heading sits apart from the text above it by one blank line in that line's own ending, as the file's other headings do (`second\n## New` was the dogfood output before the fix).
describe('insert-section separates an inserted heading from the section above it', () => {
  it('puts one blank line in the splice line ending between the section text and an inserted heading', () => {
    const file = path.join(dir, 'heading.md')
    fs.writeFileSync(file, MIXED)
    insert(file, 'One', '## New\nx\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('# Doc\r\n\r\n## One\r\nalpha\r\n\r\n## New\r\nx\r\n\r\n## Two\nbeta\ngamma\n\n## Three\r\ndelta\r\n')
  })

  it('separates a heading appended after a last line with no trailing newline, and keeps that shape', () => {
    const file = path.join(dir, 'tail-heading.md')
    fs.writeFileSync(file, '# Doc\r\n## Last\r\nend')
    insert(file, 'Last', '## New\nx\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('# Doc\r\n## Last\r\nend\r\n\r\n## New\r\nx')
  })

  it('separates it from a heading with no body as well, whose own line is the one above', () => {
    const file = path.join(dir, 'empty-section.md')
    fs.writeFileSync(file, '# Doc\n\n## Empty\n\n## Next\nz\n')
    insert(file, 'Empty', '## New\nx\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('# Doc\n\n## Empty\n\n## New\nx\n\n## Next\nz\n')
  })

  it('adds no second blank line where the section already ends on a line holding only spaces', () => {
    const file = path.join(dir, 'blank-above.md')
    fs.writeFileSync(file, '# Doc\n\n## A\nx\n   \n## B\ny\n')
    insert(file, 'A', '## New\nz\n')
    expect(fs.readFileSync(file, 'utf8')).toContain('\nx\n   \n## New\nz\n')
  })
})
