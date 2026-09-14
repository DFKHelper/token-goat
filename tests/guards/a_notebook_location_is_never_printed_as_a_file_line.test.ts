/**
 * A `.ipynb` is indexed from a virtual Python document that parser.ts builds by concatenating the
 * code cells' `source` arrays (see src/indexed_source.ts), so every stored `lineStart`/`lineEnd`
 * addresses that virtual document, never the JSON bytes on disk. `brief`/`outline` used to print
 * that coordinate as a bare `path:line` label -- indistinguishable from a real file:line -- which
 * sends a reader straight to the wrong offset in the JSON. formatSymbolLocation (src/indexed_source.ts)
 * closes this by appending a "(notebook cell lines)" marker whenever the path is virtual-indexed.
 * This guard proves the marker actually reaches the printed surfaces, and that a plain file's label
 * is untouched.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../../src/parser.js'
import { normalizePath } from '../../src/paths.js'
import { querySymbols } from '../../src/index_reader.js'
import { runBrief, runOutline } from '../../src/read_commands.js'
import { formatSymbolLocation } from '../../src/indexed_source.js'

/**
 * PROVENANCE: FORMAT-DERIVED -- nbformat 4 shape (`cells[].cell_type`, `cells[].source` as a line
 * array) documented at nbformat.readthedocs.io/en/latest/format_description.html. The leading
 * markdown cell pushes `def caller()` well off the JSON line the flattened virtual document would
 * put it on, which is what the calibration test below checks for.
 */
function notebookJson(): string {
  return JSON.stringify(
    {
      cells: [
        { cell_type: 'markdown', source: ['# Notes\n', '\n', 'prose that occupies file lines\n', '\n', 'and several more\n'] },
        { cell_type: 'code', source: ['def caller():\n', '    return 1\n'] },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )
}

/** `runBrief` prints via `emit()` (a raw `process.stdout.write`) and returns only an exit code, so its header text can only be observed by capturing the stream -- same local pattern `tests/read_commands.test.ts::capture` already uses for the same reason. */
function captureStdout(fn: () => void): string {
  let out = ''
  const orig = process.stdout.write.bind(process.stdout)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (chunk: string) => {
    out += chunk
    return true
  }
  try {
    fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = orig
  }
  return out
}

/** Write and index one notebook in its own root, and hand the caller everything the assertions need. Per test rather than shared state, so each gets a clean index and no test depends on another having run -- mirrors indexedNotebook() in the sibling guard tests/guards/a_notebook_surface_never_answers_with_the_json_on_disk.test.ts. */
function indexedNotebook(): { file: string; raw: string; callerLine: number; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'tg-nbloc-'))
  const file = normalizePath(join(root, 'nb.ipynb'))
  const raw = notebookJson()
  writeFileSync(file, raw, 'utf-8')
  indexFileSync(file)
  const caller = querySymbols({ filePath: file }).find((s) => s.name === 'caller')
  expect(caller, 'the notebook did not index at all, so nothing downstream is testing what it claims').toBeDefined()
  return {
    file,
    raw,
    callerLine: caller?.lineStart ?? 0,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

/** The positive control: an ordinary file whose own lines already are the source of truth, so its label must stay byte-identical to the pre-fix format -- this is what stops the helper from quietly suffixing everything. */
function indexedPython(): { file: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'tg-pyloc-'))
  const file = normalizePath(join(root, 'plain.py'))
  writeFileSync(file, 'def caller():\n    return 1\n', 'utf-8')
  indexFileSync(file)
  return {
    file,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    },
  }
}

describe('a notebook location is never printed as a file line', () => {
  it('calibration: the fixture really is misaligned, or every assertion below would pass on a file that cannot show the bug', () => {
    const nb = indexedNotebook()
    try {
      const jsonLine = nb.raw.split('\n').findIndex((l) => l.includes('def caller()')) + 1
      expect(jsonLine, 'the fixture lost its own marker line').toBeGreaterThan(0)
      expect(nb.callerLine, 'the virtual and file coordinates coincide in this fixture').not.toBe(jsonLine)
    } finally {
      nb.cleanup()
    }
  })

  it('positive control: brief on a plain .py file prints no notebook suffix and keeps the pre-fix path:line format', () => {
    const py = indexedPython()
    try {
      const text = captureStdout(() => {
        runBrief({ spec: `${py.file}::caller` })
      })
      expect(text).toContain(`${py.file}:1-2`)
      expect(text).not.toContain('(notebook cell lines)')
    } finally {
      py.cleanup()
    }
  })

  it('positive control: outline on a plain .py file prints no notebook suffix', () => {
    const py = indexedPython()
    try {
      const { text } = runOutline({ file: py.file })
      expect(text).not.toContain('(notebook cell lines)')
    } finally {
      py.cleanup()
    }
  })

  it('brief prints the notebook suffix on a symbol whose stored coordinate addresses the virtual document', () => {
    const nb = indexedNotebook()
    try {
      const text = captureStdout(() => {
        runBrief({ spec: `${nb.file}::caller` })
      })
      expect(text).toContain(`${nb.file}:${String(nb.callerLine)}`)
      expect(text).toContain('(notebook cell lines)')
    } finally {
      nb.cleanup()
    }
  })

  it('outline prints the notebook suffix on every row for a notebook file', () => {
    const nb = indexedNotebook()
    try {
      const { text } = runOutline({ file: nb.file })
      expect(text).toContain('(notebook cell lines)')
    } finally {
      nb.cleanup()
    }
  })

  describe('formatSymbolLocation', () => {
    it('single line, non-notebook path: no suffix, no range dash', () => {
      expect(formatSymbolLocation('src/a.ts', 10)).toBe('src/a.ts:10')
    })

    it('range, non-notebook path', () => {
      expect(formatSymbolLocation('src/a.ts', 10, 14)).toBe('src/a.ts:10-14')
    })

    it('single line, notebook path (lineEnd omitted)', () => {
      expect(formatSymbolLocation('nb.ipynb', 10)).toBe('nb.ipynb:10 (notebook cell lines)')
    })

    it('range, notebook path', () => {
      expect(formatSymbolLocation('nb.ipynb', 10, 14)).toBe('nb.ipynb:10-14 (notebook cell lines)')
    })

    it('lineEnd equal to lineStart still prints a range, matching the pre-existing hand-rolled format (runSymbol/brief pin a 1-1 shape for a one-line symbol)', () => {
      expect(formatSymbolLocation('src/a.ts', 10, 10)).toBe('src/a.ts:10-10')
    })

    it('a path whose extension merely contains "ipynb" but does not end in it is not treated as virtual-indexed', () => {
      expect(formatSymbolLocation('notipynb.txt', 10, 14)).toBe('notipynb.txt:10-14')
      expect(formatSymbolLocation('my.ipynb.bak', 10, 14)).toBe('my.ipynb.bak:10-14')
    })
  })
})
