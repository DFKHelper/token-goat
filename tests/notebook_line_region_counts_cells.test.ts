/** `read file:N` on a notebook must count N in the Python document the index numbered from the cells (src/indexed_source.ts), not in the JSON on disk. Fixture provenance: HAND-DERIVED, see the notebook note on the fixture below. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { indexFileSync } from '../src/parser.js'
import { runRead } from '../src/read_commands.js'

let dir: string

beforeEach(() => {
  dir = normalizePath(mkdtempSync(path.join(os.tmpdir(), 'tg-nb-region-')))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('read file:N on a notebook', () => {
  // A markdown cell and two code cells. The JSON on disk runs to dozens of lines, while the Python document the index numbers has the code cells at the top, so a line counted against the JSON lands in different text. PROVENANCE: HAND-DERIVED, nbformat 4 (cells[].cell_type, cells[].source as a line array) per nbformat.readthedocs.io/en/latest/format_description.html.
  function notebook(): string {
    return JSON.stringify(
      {
        cells: [
          { cell_type: 'markdown', source: ['# Notes\n', '\n', 'prose that occupies file lines\n'] },
          { cell_type: 'code', source: ['def helper():\n', '    return 1\n'] },
          { cell_type: 'code', source: ['def caller():\n', '    return helper()\n'] },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      },
      null,
      1,
    )
  }

  it('resolves a line number in the cells the index numbered, not in the JSON on disk', () => {
    const file = path.join(dir, 'nb.ipynb')
    writeFileSync(file, notebook(), 'utf-8')
    indexFileSync(file)
    const caller = querySymbols({ filePath: file }).find((s) => s.name === 'caller')
    expect(caller, 'the notebook did not index, so the row measures nothing').toBeDefined()
    const jsonLine = notebook().split('\n').findIndex((l) => l.includes('def caller()')) + 1
    expect(caller!.lineStart, 'the fixture lines up with its own JSON, so it cannot tell the two coordinate systems apart').not.toBe(jsonLine)
    const { text, code } = runRead({ spec: `${file}:${String(caller!.lineStart + 1)}`, projectRoot: dir })
    expect(code).toBe(0)
    expect(text).toContain('function caller')
    expect(text).toContain('return helper()')
    expect(text).not.toContain('cell_type')
  })
})
