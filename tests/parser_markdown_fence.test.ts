import { describe, expect, it } from 'vitest'

import { parseFixture } from './helpers/parse-fixture.js'

describe('markdown symbol extraction ignores fenced code blocks', () => {
  // Regression: extractMarkdownSymbols ran the ATX-heading regex on every line with no fenced-code-block state, so a `#` comment inside a ``` or ~~~ fence was indexed as a phantom heading. The section reader already skips fences; this asserts the symbol surface agrees.
  it('does not index a #-comment inside a ``` fence as a heading', async () => {
    const md = [
      '# Title',
      '',
      '## Install',
      '',
      '```bash',
      '# install dependencies',
      'npm install -g token-goat',
      '```',
      '',
      '## Done',
    ].join('\n')
    const result = await parseFixture('doc.md', md)
    expect(result.language).toBe('markdown')
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('Title')
    expect(headings).toContain('Install')
    expect(headings).toContain('Done')
    // The fenced shell comment must not become a phantom heading symbol.
    expect(headings).not.toContain('install dependencies')
  })

  it('does not index a #-comment inside a ~~~ fence as a heading', async () => {
    const md = ['# Real', '', '~~~', '# not a heading', '~~~', '', '## Tail'].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('Real')
    expect(headings).toContain('Tail')
    expect(headings).not.toContain('not a heading')
  })

  it('does not let a nested ``` example close an outer ```` fence early', async () => {
    // Regression: fence-close was checked by matching only the first backtick
    // character, not the run length, so a 3-backtick line nested inside an
    // outer 4-backtick fence wrongly closed it early (CommonMark requires a
    // closing run >= the opening run's length).
    const md = [
      '# Real',
      '',
      '````markdown',
      "Here's an example:",
      '```',
      '# not a heading',
      '```',
      'More content after.',
      '````',
      '',
      '## Tail',
    ].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('Real')
    expect(headings).toContain('Tail')
    expect(headings).not.toContain('not a heading')
  })

  it('does not let a same-char fence-looking line with a trailing info string close an open fence', async () => {
    // Regression coverage for the third CommonMark condition (the other two are covered by the
    // two tests above): a closing run must have no trailing info string. A ```json line inside
    // an already-open ``` fence must stay fenced content, not be read as the real closer.
    const md = ['# Real', '', '```', '```json', '# not a heading', '```', '', '## Tail'].join('\n')
    const result = await parseFixture('doc.md', md)
    const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
    expect(headings).toContain('Real')
    expect(headings).toContain('Tail')
    expect(headings).not.toContain('not a heading')
  })
})
