import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

describe('markdown symbol extraction handles ATX closing hashes CommonMark-correctly', () => {
  // Regression: the heading regex used `(?:\s*#+\s*)?$`, which strips a trailing `#` even with
  // no whitespace before it, violating CommonMark (a closing ATX sequence requires whitespace
  // before it). `## C#` indexed as `C` instead of `C#`, diverging from section_reader, which
  // already used the CommonMark-correct `\s+#+` rule.
  it('preserves a trailing # in a heading with no space before it (C#)', async () => {
    const md = ['# Lang notes', '## C#', 'dotnet content'].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('C#')
    expect(headings).not.toContain('C')
  })

  it('preserves a trailing # in a heading with multiple slashes (C++/C#)', async () => {
    const md = ['# Lang notes', '## C++/C#', 'polyglot content'].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('C++/C#')
    expect(headings).not.toContain('C++/C')
  })

  it('still strips a true closing ATX sequence with whitespace before it', async () => {
    const md = ['## Setup ##'].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('Setup')
    expect(headings).not.toContain('Setup ##')
  })
})
