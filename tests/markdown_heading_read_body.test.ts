/** Regression: `read`/`brief` on a markdown heading printed a "7 lines" header over the one heading line, because the heading symbol spans its whole section but stores only the heading line. The read path now re-slices the section from disk. Provenance: HAND-DERIVED. Line numbers are counted by hand from the documents each test writes (1-based; a section runs to the line before the next heading of the same or a shallower level). The real pipeline is driven: indexFileSync into the isolated DB, then runRead/runBriefCore. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { runBriefCore } from '../src/read_brief.js'
import { resolveBody, runRead } from '../src/read_commands.js'

// 1 # Demo / 2 / 3 Intro text. / 4 / 5 ## Usage / 6 / 7 Run the alpha function. / 8 / 9 ### alpha / 10 / 11 The alpha function calls beta. / 12 / 13 ## Widget / 14 / 15 The Widget class renders.
const ATX = ['# Demo', '', 'Intro text.', '', '## Usage', '', 'Run the alpha function.', '', '### alpha', '', 'The alpha function calls beta.', '', '## Widget', '', 'The Widget class renders.', ''].join('\n')
const USAGE = ['## Usage', '', 'Run the alpha function.', '', '### alpha', '', 'The alpha function calls beta.'].join('\n')

function withDoc(name: string, doc: string, fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tg-mdbody-'))
  try {
    const file = join(root, name)
    writeFileSync(file, doc)
    indexFileSync(normalizePath(file))
    fn(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe('read/brief on a markdown heading print the section the header announces', () => {
  it('read prints all 7 lines of an ATX section', () => {
    withDoc('README.md', ATX, (file) => {
      const r = runRead({ spec: `${file}::Usage` })
      expect(r.code).toBe(0)
      expect(r.text).toContain('# 7 lines')
      expect(r.text).toContain(USAGE)
    })
  })

  it('read of a nested heading prints its own 3 lines', () => {
    withDoc('README.md', ATX, (file) => {
      const r = runRead({ spec: `${file}::alpha` })
      expect(r.text).toContain('# 3 lines')
      expect(r.text).toContain(['### alpha', '', 'The alpha function calls beta.'].join('\n'))
    })
  })

  it('read --json carries the whole section as body', () => {
    withDoc('README.md', ATX, (file) => {
      const body = (JSON.parse(runRead({ spec: `${file}::Usage`, json: true }).text) as { body: string }).body
      expect(body).toBe(USAGE)
    })
  })

  it('brief prints the whole section, text and json', () => {
    withDoc('README.md', ATX, (file) => {
      expect(runBriefCore({ spec: `${file}::Usage` }).text).toContain(USAGE)
      const sym = (JSON.parse(runBriefCore({ spec: `${file}::Usage`, json: true }).text) as { symbol: { body: string } }).symbol
      expect(sym.body).toBe(USAGE)
    })
  })

  it('reads a setext section whole', () => {
    // 1 Title / 2 ===== / 3 / 4 Setext body. / 5 / 6 Sub / 7 --- / 8 Sub body.
    const doc = ['Title', '=====', '', 'Setext body.', '', 'Sub', '---', 'Sub body.', ''].join('\n')
    withDoc('setext.md', doc, (file) => {
      const r = runRead({ spec: `${file}::Title` })
      expect(r.text).toContain('# 8 lines')
      expect(r.text).toContain(['Title', '=====', '', 'Setext body.', '', 'Sub', '---', 'Sub body.'].join('\n'))
    })
  })

  it('keeps the stored heading line when the file no longer has it at the stored line', () => {
    // runRead reindexes a stale file first, so the stale row is handed to resolveBody directly.
    withDoc('README.md', ATX, (file) => {
      writeFileSync(file, ['intro rewritten', 'with', 'new', 'lines', 'only', 'here', 'now', 'ok'].join('\n'))
      const row = { body: '## Usage', filePath: file, lineStart: 5, lineEnd: 11, kind: 'heading' }
      expect(resolveBody(row)).toBe('## Usage')
    })
  })

  it('leaves a one-line heading and non-heading symbols alone', () => {
    withDoc('README.md', ATX, (file) => {
      expect(resolveBody({ body: '## Widget', filePath: file, lineStart: 13, lineEnd: 13, kind: 'heading' })).toBe('## Widget')
      expect(resolveBody({ body: 'x', filePath: file, lineStart: 1, lineEnd: 9, kind: 'function' })).toBe('x')
    })
  })
})
