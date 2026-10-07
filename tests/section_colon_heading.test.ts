/** Regression: `section "docs/api.md::Foo::bar()"` split the spec at the LAST `::`, so the file part became `docs/api.md::Foo` and the command failed with "File not found" although the heading `Foo::bar()` exists in `docs/api.md`. The separator now falls back to the other `::` positions, first to last, when the last-split file does not exist. Provenance: every expected string below is HAND-DERIVED from the document literal in this file, computed by reading its lines, not from the implementation. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { findSectionSeparator, runSection } from '../src/read_section.js'

let tmpDir: string
let mdFile: string

// HAND-DERIVED line numbers (1-based): '## Foo::bar()' is line 3, its body line 5; '## Foo' is line 7.
const DOC = ['# Title', '', '## Foo::bar()', '', 'scoped body', '', '## Foo', '', 'plain foo body', ''].join('\n')

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tg-colonheading-'))
  mdFile = join(tmpDir, 'api.md')
  writeFileSync(mdFile, DOC)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('section with `::` inside the heading text', () => {
  it('reads the heading whose own text holds `::` instead of failing on a phantom file', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Foo::bar()`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text, 'the spec was cut at the last `::`, naming a file that does not exist').toBe(`# Foo::bar() — ${mdFile}:3-5\n## Foo::bar()\n\nscoped body`)
  })

  it('resolves a relative file against the project root the same way', () => {
    const { text, code } = runSection({ spec: 'api.md::Foo::bar()', projectRoot: tmpDir, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text).toContain('scoped body')
  })

  it('keeps a plain file::Heading spec on the same path as before', () => {
    const { text, code } = runSection({ spec: `${mdFile}::Foo`, suppressStat: true })
    expect(code, text).toBe(0)
    expect(text).toBe(`# Foo — ${mdFile}:7-9\n## Foo\n\nplain foo body`)
  })

  it('still reports a missing file against the last-split file part when no split names a file', () => {
    const { text, code } = runSection({ spec: `${join(tmpDir, 'nope.md')}::Foo::bar()`, suppressStat: true })
    expect(code).toBe(1)
    expect(text).toContain(`File not found: "${join(tmpDir, 'nope.md')}::Foo"`)
  })
})

describe('findSectionSeparator', () => {
  it('returns -1 for a spec with no separator and the last `::` for a single one', () => {
    expect(findSectionSeparator('plain.md', undefined)).toBe(-1)
    expect(findSectionSeparator(`${mdFile}::Foo`, undefined)).toBe(mdFile.length)
  })

  // A file name holding `::` is legal on POSIX only; Windows cannot create one.
  it.skipIf(process.platform === 'win32')('prefers the last `::` when the file it leaves exists', () => {
    const dir = join(tmpDir, 'a::b')
    mkdirSync(dir)
    writeFileSync(join(dir, 'c.md'), DOC)
    const spec = `${dir}/c.md::Foo`
    expect(findSectionSeparator(spec, undefined)).toBe(spec.lastIndexOf('::'))
  })

  it('does not read a Windows drive letter as a separator', () => {
    expect(findSectionSeparator('C:/docs/api.md::Foo::bar()', undefined)).toBe('C:/docs/api.md::Foo'.length)
  })

  it('falls back to the first `::` whose file exists', () => {
    const spec = `${mdFile}::Foo::bar()`
    expect(findSectionSeparator(spec, undefined)).toBe(mdFile.length)
  })

  it('refuses a directory as the file part', () => {
    const spec = `${tmpDir}::Foo::bar()`
    expect(findSectionSeparator(spec, undefined)).toBe(spec.lastIndexOf('::'))
  })
})
