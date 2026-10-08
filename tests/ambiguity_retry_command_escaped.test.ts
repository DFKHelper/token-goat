// formatAmbiguity builds the retry command for each candidate from a file name the repository chose, so a format character in a directory name must be escaped in the command it prints, not only in the label beside it.

// HAND-DERIVED: the directory name holds U+202E (a bidi override, a format character); the expected spelling is displaySafeText's `\u202e` escape worked out from that rule. The built bundle's output guard escapes the same character after the fact, so this runs the function in-process, where nothing else does.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/index_reader.js', async (importOriginal) => {
  const real = await importOriginal<typeof IndexReader>()
  return { ...real, querySymbols: () => [] }
})

import type * as IndexReader from '../src/index_reader.js'
import type { SymbolEntry } from '../src/parser_types.js'
import { formatAmbiguity } from '../src/read_spec.js'

function candidate(filePath: string): SymbolEntry {
  return { filePath, name: 'dup', kind: 'function', lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' } as SymbolEntry
}

describe('formatAmbiguity', () => {
  it('escapes a format character in the file name of each retry command', () => {
    const root = '/proj'
    const text = formatAmbiguity('dup', 'same.ts', [candidate('/proj/d1/same.ts'), candidate('/proj/d\u202e2/same.ts')], root)
    expect(text).toContain('token-goat read "d\\u202e2/same.ts::dup"')
    expect(text).not.toMatch(/\p{Cf}/u)
  })
})
