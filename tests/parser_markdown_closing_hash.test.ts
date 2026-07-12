import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { parseFile } from '../src/parser.js'

describe('markdown symbol extraction handles ATX closing hashes CommonMark-correctly', () => {
  // Regression: the heading regex used `(?:\s*#+\s*)?$`, which strips a trailing `#` even with
  // no whitespace before it, violating CommonMark (a closing ATX sequence requires whitespace
  // before it). `## C#` indexed as `C` instead of `C#`, diverging from section_reader, which
  // already used the CommonMark-correct `\s+#+` rule.
  it('preserves a trailing # in a heading with no space before it (C#)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-closing-hash-'))
    const file = path.join(dir, 'doc.md')
    const md = ['# Lang notes', '## C#', 'dotnet content'].join('\n')
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('C#')
      expect(headings).not.toContain('C')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('preserves a trailing # in a heading with multiple slashes (C++/C#)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-closing-hash-'))
    const file = path.join(dir, 'doc.md')
    const md = ['# Lang notes', '## C++/C#', 'polyglot content'].join('\n')
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('C++/C#')
      expect(headings).not.toContain('C++/C')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still strips a true closing ATX sequence with whitespace before it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-md-closing-hash-'))
    const file = path.join(dir, 'doc.md')
    const md = ['## Setup ##'].join('\n')
    fs.writeFileSync(file, md)
    try {
      const result = await parseFile(file)
      const headings = result.symbols.filter((s) => s.kind === 'heading').map((s) => s.name)
      expect(headings).toContain('Setup')
      expect(headings).not.toContain('Setup ##')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
