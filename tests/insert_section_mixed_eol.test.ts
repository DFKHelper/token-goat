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

// Provenance: HAND-DERIVED, each expected file written out by hand from the input: inserted text ending on a text line sits apart from the heading below it by one blank line, as the file's other headings do (`new\n## Lesson 2` was the dogfood output before the fix, for a section with no blank line before the next heading and for one ending on a line of spaces).
describe('insert-section separates the inserted text from the heading below it', () => {
  it('puts one blank line between the inserted text and a next heading the section ran straight into', () => {
    const file = path.join(dir, 'tight.md')
    fs.writeFileSync(file, '## Lesson 1\nfirst\n## Lesson 2\nsecond\n')
    insert(file, 'Lesson 1', '## Lesson 1.5\nnew\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('## Lesson 1\nfirst\n\n## Lesson 1.5\nnew\n\n## Lesson 2\nsecond\n')
  })

  it('puts one blank line before the next heading when the section ends on a line holding only spaces', () => {
    const file = path.join(dir, 'spaces.md')
    fs.writeFileSync(file, '## Lesson 1\nfirst\n  \n## Lesson 2\nsecond\n')
    insert(file, 'Lesson 1', '## Lesson 1.5\nnew\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('## Lesson 1\nfirst\n  \n## Lesson 1.5\nnew\n\n## Lesson 2\nsecond\n')
  })

  it('keeps a setext heading below from swallowing inserted paragraph text, in the splice line ending', () => {
    const file = path.join(dir, 'setext.md')
    fs.writeFileSync(file, 'One\r\n===\r\nalpha\r\n \r\nTwo\r\n===\r\nbeta\r\n')
    insert(file, 'One', 'more text\n')
    expect(fs.readFileSync(file, 'latin1')).toBe('One\r\n===\r\nalpha\r\n \r\nmore text\r\n\r\nTwo\r\n===\r\nbeta\r\n')
  })

  it('adds nothing where a blank line already follows, the insert ends on a blank line, or nothing follows', () => {
    const spaced = path.join(dir, 'spaced.md')
    fs.writeFileSync(spaced, '## A\nx\n\n## B\ny\n')
    insert(spaced, 'A', 'z\n')
    expect(fs.readFileSync(spaced, 'utf8')).toBe('## A\nx\nz\n\n## B\ny\n')
    const trailingBlank = path.join(dir, 'trailing-blank.md')
    fs.writeFileSync(trailingBlank, '## A\nx\n## B\ny\n')
    insert(trailingBlank, 'A', 'z\n\n')
    expect(fs.readFileSync(trailingBlank, 'utf8')).toBe('## A\nx\nz\n\n## B\ny\n')
    const last = path.join(dir, 'last.md')
    fs.writeFileSync(last, '## A\nx\n')
    insert(last, 'A', 'z\n')
    expect(fs.readFileSync(last, 'utf8')).toBe('## A\nx\nz\n')
  })

  it('writes the same bytes for the same content whether it arrives by --content-from or --content-b64', () => {
    const content = '## Lesson 1.5\r\nnew\r\n'
    const fromFile = path.join(dir, 'from.md')
    const b64File = path.join(dir, 'b64.md')
    const source = path.join(dir, 'content.md')
    fs.writeFileSync(source, content)
    for (const f of [fromFile, b64File]) fs.writeFileSync(f, '## Lesson 1\nfirst\n## Lesson 2\nsecond\n')
    cmdInsertSection(fromFile, { after: 'Lesson 1', contentFrom: source })
    cmdInsertSection(b64File, { after: 'Lesson 1', contentB64: Buffer.from(content, 'utf8').toString('base64') })
    expect(fs.readFileSync(fromFile, 'utf8')).toBe('## Lesson 1\nfirst\n\n## Lesson 1.5\nnew\n\n## Lesson 2\nsecond\n')
    expect(fs.readFileSync(b64File, 'utf8')).toBe(fs.readFileSync(fromFile, 'utf8'))
  })
})
