/**
 * A `.ipynb` is indexed from a virtual Python document that parser.ts builds out of the cell
 * sources, so every line number stored for a notebook symbol addresses that document and not the
 * JSON bytes on disk. Any surface that pairs a stored line range with text it read itself is
 * therefore crossing two coordinate systems, and the failure is silent: JSON comes back under a
 * Python symbol's name, or a fold cuts a region that holds no such body, with nothing to say so.
 *
 * Four sites have now been found doing exactly that -- resolveBody, bodyFromSource,
 * buildContextWindow, and resolveFoldSpans. This guard is written against the product surfaces
 * rather than those four call sites, so a fifth one added later is caught by the same assertions:
 * index one small notebook and require that nothing which claims to show a symbol's source ever
 * answers with a line of the file's JSON.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync } from '../../src/parser.js'
import { buildContextWindow } from '../../src/util.js'
import { normalizePath } from '../../src/paths.js'
import { foldDelivery } from '../../src/fold_delivery.js'
import { indexedSourceText } from '../../src/indexed_source.js'
import { querySymbols } from '../../src/index_reader.js'
import { runRead } from '../../src/read_commands.js'

/**
 * A three-cell notebook whose markdown cell pushes the code cells well out of alignment with their
 * own JSON lines. PROVENANCE: HAND-DERIVED, in the nbformat 4 shape (`cells[].cell_type`,
 * `cells[].source` as a line array) documented at
 * nbformat.readthedocs.io/en/latest/format_description.html.
 */
function notebookJson(): string {
  return JSON.stringify(
    {
      cells: [
        { cell_type: 'markdown', source: ['# Notes\n', '\n', 'prose that occupies file lines\n', '\n', 'and several more\n'] },
        { cell_type: 'code', source: ['def helper():\n', ...longBody()] },
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

/** A body comfortably past BODY_FOLD_MIN_SPAN, so "the fold declined" below means the guard held rather than that there was nothing to fold. The positive control beside it proves the same body does fold in a plain .py file. */
function longBody(): string[] {
  return Array.from({ length: 60 }, (_, i) => `    value${String(i)} = ${String(i)} * 3\n`).concat('    return value0\n')
}

/** The same Python the notebook's cells flatten to, as its own file. */
function equivalentPythonSource(): string {
  return ['def helper():', ...longBody().map((l) => l.replace(/\n$/, '')), 'def caller():', '    return helper()'].join('\n')
}

/** Lines only a reader of the raw JSON could ever produce. None of them appears in the virtual Python document. */
const JSON_ONLY_FRAGMENTS = ['"cell_type"', '"source"', '"nbformat"', '"cells"']

/** The rows a Read or a `cat` hands the fold planner, in FoldRow's own shape. A near-miss here (`line` for `no`, no `raw`) silently plans no folds at all, which is why the calibration control below exists. */
function foldRows(text: string): { no: number; text: string; raw: string }[] {
  return text.split('\n').map((line, i) => ({ no: i + 1, text: line, raw: `${String(i + 1)}\t${line}` }))
}

/** Write and index one notebook in its own root, and hand the caller everything the assertions need. Per test rather than in a beforeAll, so each gets a clean index and no test depends on another having run. */
function indexedNotebook(): { file: string; raw: string; callerLine: number; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'tg-nbcoord-'))
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

describe('a notebook surface never answers with the JSON on disk', () => {
  it('the fixture really is misaligned, or every assertion below would pass on a file that cannot show the bug', () => {
    const nb = indexedNotebook()
    try {
      // A guard whose population agrees with it by construction proves nothing. The JSON must put `def caller():` on a different line from the virtual document, or every coordinate-space bug here is invisible.
      const jsonLine = nb.raw.split('\n').findIndex((l) => l.includes('def caller()')) + 1
      expect(jsonLine, 'the fixture lost its own marker line').toBeGreaterThan(0)
      expect(nb.callerLine, 'the virtual and file coordinates coincide in this fixture').not.toBe(jsonLine)
    } finally {
      nb.cleanup()
    }
  })

  it('a notebook saved with a byte order mark still yields its cell source, so the window is not silently empty', () => {
    // The indexer decodes through decodeSource and never sees the mark, so the notebook indexes normally and every other surface reads it back correctly. The read-side helper is handed bytes its callers read themselves, and JSON.parse rejects a leading mark, so the flattened document came back as '' and buildContextWindow returned null for every symbol in the file. A control without the mark sits beside it because "returned null" and "there was nothing there" are the same observation.
    const root = mkdtempSync(join(tmpdir(), 'tg-nbbom-'))
    try {
      const body = notebookJson()
      const withMark = normalizePath(join(root, 'mark.ipynb'))
      const without = normalizePath(join(root, 'nomark.ipynb'))
      // Written as the escape rather than the literal character: a bare U+FEFF in source is both lint-flagged and invisible to a reviewer, which is exactly how one ends up in a file by accident.
      writeFileSync(withMark, `\uFEFF${body}`, 'utf-8')
      writeFileSync(without, body, 'utf-8')
      expect(indexedSourceText(without, readFileSync(without, 'utf-8')), 'the control produced no virtual document, so the assertion below measures nothing').toContain('def caller()')
      expect(indexedSourceText(withMark, readFileSync(withMark, 'utf-8')), 'a byte order mark emptied the flattened document').toContain('def caller()')
    } finally {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('buildContextWindow reads the document the line number came from', () => {
    const nb = indexedNotebook()
    try {
      const window = buildContextWindow(normalizePath(nb.file), nb.callerLine, 1)
      expect(window, 'no context window was produced at all').not.toBeNull()
      const text = (window ?? []).map((l) => l.text).join('\n')
      expect(text).toContain('def caller()')
      for (const fragment of JSON_ONLY_FRAGMENTS) expect(text, 'the context window was sliced out of the raw JSON').not.toContain(fragment)
    } finally {
      nb.cleanup()
    }
  })

  it('read returns the cell source, not notebook markup', () => {
    const nb = indexedNotebook()
    try {
      const { text } = runRead({ spec: `${nb.file}::caller` })
      expect(text).toContain('def caller()')
      for (const fragment of JSON_ONLY_FRAGMENTS) expect(text, 'the body was sliced out of the raw JSON').not.toContain(fragment)
    } finally {
      nb.cleanup()
    }
  })

  it('the same body in a plain .py file does fold, so the notebook assertion below is not measuring silence', () => {
    // Calibration. Without it, "the notebook did not fold" is satisfied by a fixture too small to fold, a disabled config, or an index that never wrote a row, and the guard would pass for the rest of its life without ever exercising the thing it names.
    const root = mkdtempSync(join(tmpdir(), 'tg-nbctl-'))
    try {
      const file = normalizePath(join(root, 'equivalent.py'))
      writeFileSync(file, equivalentPythonSource(), 'utf-8')
      indexFileSync(file)
      const folded = foldDelivery(foldRows(equivalentPythonSource()), file, file)
      expect(folded?.folds.filter((f) => f.kind === 'body') ?? [], 'the control folded no body, so the notebook case proves nothing').not.toHaveLength(0)
    } finally {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }
  })

  it('the body fold declines a notebook rather than cutting its JSON on virtual spans', () => {
    const nb = indexedNotebook()
    try {
      // The fold operates on the rows a Read or a `cat` delivered, which are the JSON. Measured before the guard existed: a notebook came back with its cell array cut in half under a notice reading "114 more lines of big_one (10-123) folded" over a region holding no such body.
      const folded = foldDelivery(foldRows(nb.raw), normalizePath(nb.file), nb.file)
      expect(folded?.folds.filter((f) => f.kind === 'body') ?? [], 'a notebook was folded on index coordinates it does not share').toHaveLength(0)
    } finally {
      nb.cleanup()
    }
  })
})
