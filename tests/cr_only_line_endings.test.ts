/** A file saved with classic Mac OS line endings (a lone carriage return between lines) indexes each symbol on its own line, the same as the LF and CRLF spellings of the same source. PROVENANCE: HAND-DERIVED. Each fixture is written once with `\n` between lines and re-joined with `\r` and `\r\n`; the expected rows and spans are counted from the LF text by hand, independently of the extractors, and the three spellings must agree. */
import { describe, expect, it } from 'vitest'

import { indexedSourceText } from '../src/indexed_source.js'
import { parseSourceSymbolsTreeSitterOnly } from '../src/parser.js'
import { normalizeSourceText } from '../src/source_text.js'
import { parseFixture } from './helpers/parse-fixture.js'

const BOM = String.fromCharCode(0xfeff)

const SOURCES: ReadonlyArray<{ file: string; lines: readonly string[]; rows: readonly string[] }> = [
  {
    file: 'mac.ts',
    lines: ['export function alpha() {', '  return 1', '}', 'export function beta() {', '  return 2', '}', ''],
    rows: ['function alpha 1-3', 'function beta 4-6'],
  },
  {
    file: 'mac.py',
    lines: ['def alpha():', '    return 1', '', 'def beta():', '    return 2', ''],
    rows: ['function alpha 1-2', 'function beta 4-5'],
  },
  {
    file: 'mac.scala',
    lines: ['object Mac {', '  def one(): Int = 1', '  def two(): Int = 2', '}', ''],
    rows: ['object Mac 1-4', 'function one 2-2', 'function two 3-3'],
  },
  {
    file: 'mac.php',
    lines: ['<?php', 'class MacP {', '  public function one() { return 1; }', '}', ''],
    rows: ['class MacP 2-4', 'method one 3-3'],
  },
]

async function rowsFor(file: string, text: string): Promise<string[]> {
  const { symbols } = await parseFixture(file, text)
  return symbols.map((s) => `${s.kind} ${s.name} ${s.lineStart}-${s.lineEnd}`)
}

describe('CR-only line endings', () => {
  for (const { file, lines, rows } of SOURCES) {
    it(`${file}: lone CR, CRLF and LF index the same rows`, async () => {
      expect(await rowsFor(file, lines.join('\n'))).toEqual(rows)
      expect(await rowsFor(file, lines.join('\r\n'))).toEqual(rows)
      expect(await rowsFor(file, lines.join('\r'))).toEqual(rows)
    })
  }

  it('the tree-sitter-only skeleton path counts a lone CR as a line break', () => {
    const lines = SOURCES[0]!.lines
    const symbols = parseSourceSymbolsTreeSitterOnly(lines.join('\r'), 'mac.ts', 'typescript')
    expect(symbols?.map((s) => `${s.name} ${s.lineStart}-${s.lineEnd}`)).toEqual(['alpha 1-3', 'beta 4-6'])
  })

  it('a stored range slices the same lines out of the CR-only file the indexer counted', () => {
    const lines = SOURCES[0]!.lines
    const text = indexedSourceText('mac.ts', `${BOM}${lines.join('\r')}`).split(/\r?\n/)
    expect(text.slice(3, 6)).toEqual(['export function beta() {', '  return 2', '}'])
  })

  it('normalizes one character for one character and leaves CRLF alone', () => {
    expect(normalizeSourceText('a\rb\r\nc\r')).toBe('a\nb\r\nc\n')
    expect(normalizeSourceText(BOM + 'x\ry')).toBe('x\ny')
    expect(normalizeSourceText('plain\n')).toBe('plain\n')
  })
})
