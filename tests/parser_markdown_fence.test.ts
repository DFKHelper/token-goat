import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseFile } from '../src/parser.js'

describe('markdown symbol extraction ignores fenced code blocks', () => {
  // Regression: extractMarkdownSymbols ran the ATX-heading regex on every line with no fenced-code-block state, so a `#` comment inside a ``` or ~~~ fence was indexed as a phantom heading. The section reader already skips fences; this asserts the symbol surface agrees.
  it('does not index a #-comment inside a ``` fence as a heading', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-fence-'))
    const file = path.join(dir, 'doc.md')
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
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      expect(result.language).toBe('markdown')
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('Title')
      expect(headings).toContain('Install')
      expect(headings).toContain('Done')
      // The fenced shell comment must not become a phantom heading symbol.
      expect(headings).not.toContain('install dependencies')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not index a #-comment inside a ~~~ fence as a heading', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-fence-'))
    const file = path.join(dir, 'doc.md')
    const md = ['# Real', '', '~~~', '# not a heading', '~~~', '', '## Tail'].join('\n')
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('Real')
      expect(headings).toContain('Tail')
      expect(headings).not.toContain('not a heading')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not let a nested ``` example close an outer ```` fence early', async () => {
    // Regression: fence-close was checked by matching only the first backtick
    // character, not the run length, so a 3-backtick line nested inside an
    // outer 4-backtick fence wrongly closed it early (CommonMark requires a
    // closing run >= the opening run's length).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-fence-'))
    const file = path.join(dir, 'doc.md')
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
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('Real')
      expect(headings).toContain('Tail')
      expect(headings).not.toContain('not a heading')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
