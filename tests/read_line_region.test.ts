/** `token-goat read "file:142"` / `"file:142-160"` -- resolving a bare line number to the region enclosing it. Before this existed, a `:N` spec fell through every branch of runRead and died in formatBareNameSpecError with `Invalid spec - expected "file::symbol"`, so an agent holding a line number from a grep hit, a stack frame, or a diff hunk had nothing to hand token-goat and went back to `sed -n 'N,Mp'`. These drive the REAL pipeline -- a real on-disk file, the real on-demand indexer via healStaleIndex, the real global.db (test-isolated) -- the way read_commands_ondemand_index_e2e.test.ts does, rather than mocking querySymbols and asserting against a hand-built symbol list. Provenance for the parser cases below: HAND-DERIVED, the expected file/line split computed from the spec string by the rule stated in the task (split on the LAST colon; the suffix must be entirely digits or digits-dash-digits), independently of parseColonLineSpec's own regex. */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { runRead } from '../src/read_commands.js'
import { parseColonLineSpec, resolveLineRegions } from '../src/read_spec.js'
import type { SymbolEntry } from '../src/parser_types.js'

// A 15-line file exercising all three region kinds: a preamble (1-3) above the first symbol, three top-level symbols, an inter-symbol gap, and a trailing gap running to EOF. CAPTURE: the symbol spans this file produces -- `variable TOP_CONST_9K` 4-4, `function alphaRegionFn9k` 6-8, `function betaRegionFn9k` 11-13, three symbols total -- are what the real indexer emitted for these exact bytes, read off a `runOutline` run over them rather than predicted from the parser's source. That distinction had already bitten this fixture once: an earlier draft assumed a top-level `const` was preamble text, when the indexer emits it as a `variable` symbol and so there was no preamble above it at all.
const SAMPLE = [
  '// header comment for the sample module', // 1
  "import { join } from 'node:path'", // 2
  '', // 3
  'const TOP_CONST_9K = 3', // 4
  '', // 5
  'function alphaRegionFn9k(a) {', // 6
  '  return a + TOP_CONST_9K', // 7
  '}', // 8
  '', // 9
  '', // 10
  'function betaRegionFn9k(b) {', // 11
  '  return b * 2', // 12
  '}', // 13
  '', // 14
  '// trailing note, after every symbol', // 15
].join('\n') + '\n'

function withSample(fn: (file: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'tg-lineregion-'))
  try {
    const file = join(root, 'regions.js')
    writeFileSync(file, SAMPLE)
    fn(file)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function sym(name: string, lineStart: number, lineEnd: number, kind = 'function'): SymbolEntry {
  return { filePath: '/x/f.ts', name, kind, lineStart, lineEnd, body: '', docstring: '', parent: '' }
}

describe('parseColonLineSpec', () => {
  it('splits a relative path on the last colon', () => {
    expect(parseColonLineSpec('src/answer_router.ts:200')).toEqual({ file: 'src/answer_router.ts', start: 200, end: 200 })
  })

  it('accepts a range', () => {
    expect(parseColonLineSpec('src/answer_router.ts:200-240')).toEqual({ file: 'src/answer_router.ts', start: 200, end: 240 })
  })

  it('keeps the drive letter on a Windows absolute path', () => {
    expect(parseColonLineSpec('C:/Projects/token-goat/src/answer_router.ts:142')).toEqual({
      file: 'C:/Projects/token-goat/src/answer_router.ts',
      start: 142,
      end: 142,
    })
    expect(parseColonLineSpec('C:\\Projects\\token-goat\\src\\answer_router.ts:142-160')).toEqual({
      file: 'C:\\Projects\\token-goat\\src\\answer_router.ts',
      start: 142,
      end: 160,
    })
  })

  it('declines a path whose last colon is not followed by digits', () => {
    expect(parseColonLineSpec('C:/Projects/token-goat/src/answer_router.ts')).toBeNull()
    expect(parseColonLineSpec('src/answer_router.ts')).toBeNull()
    expect(parseColonLineSpec('src/answer_router.ts:200x')).toBeNull()
  })

  it('declines the `file::symbol` and `file::N` forms, which the existing `::` path owns', () => {
    expect(parseColonLineSpec('src/answer_router.ts::resolveSubject')).toBeNull()
    expect(parseColonLineSpec('src/answer_router.ts::200')).toBeNull()
    expect(parseColonLineSpec('src/answer_router.ts::200-240')).toBeNull()
  })

  // A stray colon anywhere in the file part means the spec is not a line spec. Splitting on the last colon regardless captured `src/answer_router.ts:1` and `C` as file names, and the read that followed failed with `Could not read:` naming a path nobody typed. `C:142` is a legal drive-relative path (drive C, file `142`), which is why a bare drive letter declines rather than being read as a line number.
  it('declines a file part carrying a colon of its own', () => {
    expect(parseColonLineSpec('src/answer_router.ts:1:2')).toBeNull()
    expect(parseColonLineSpec('C:142')).toBeNull()
    expect(parseColonLineSpec('C::142')).toBeNull()
  })

  it('names what the caller typed when the spec carries a stray colon', () => {
    const { text, code } = runRead({ spec: 'src/answer_router.ts:1:2' })
    expect(code).toBe(1)
    expect(text).toContain('src/answer_router.ts:1:2')
  })

  // `file::N:M` is an existing accepted range spelling (read_commands.test.ts, "accepts the colon separator form file::N:M"): its LAST colon is the range separator, so a split on it alone would capture the spec here with file = `src/answer_router.ts::200`.
  it('declines the `file::N:M` range spelling, whose last colon is a range separator', () => {
    expect(parseColonLineSpec('src/answer_router.ts::200:240')).toBeNull()
  })
})

describe('resolveLineRegions', () => {
  const symbols = [sym('alpha', 6, 8), sym('beta', 11, 13)]

  it('picks the smallest enclosing symbol when symbols nest', () => {
    const nested = [sym('Outer', 10, 100, 'class'), sym('inner', 40, 50, 'method')]
    expect(resolveLineRegions(nested, 200, 45, 45)).toEqual([
      { kind: 'symbol', label: 'method inner', start: 40, end: 50 },
    ])
  })

  it('coalesces a nested region into its container when the span covers both', () => {
    const nested = [sym('Outer', 10, 100, 'class'), sym('inner', 40, 50, 'method')]
    expect(resolveLineRegions(nested, 200, 45, 90)).toEqual([
      { kind: 'symbol', label: 'class Outer', start: 10, end: 100 },
    ])
  })

  it('returns the preamble for a line above the first symbol', () => {
    expect(resolveLineRegions(symbols, 15, 3, 3)).toEqual([
      { kind: 'preamble', label: 'file preamble', start: 1, end: 5 },
    ])
  })

  it('returns the inter-symbol gap for a line between two symbols', () => {
    expect(resolveLineRegions(symbols, 15, 9, 9)).toEqual([
      { kind: 'gap', label: 'gap between alpha and beta', start: 9, end: 10 },
    ])
  })

  it('runs the trailing gap to end of file', () => {
    expect(resolveLineRegions(symbols, 15, 15, 15)).toEqual([
      { kind: 'gap', label: 'gap after beta', start: 14, end: 15 },
    ])
  })

  it('returns every overlapped region in file order for a range', () => {
    expect(resolveLineRegions(symbols, 15, 3, 12)).toEqual([
      { kind: 'preamble', label: 'file preamble', start: 1, end: 5 },
      { kind: 'symbol', label: 'function alpha', start: 6, end: 8 },
      { kind: 'gap', label: 'gap between alpha and beta', start: 9, end: 10 },
      { kind: 'symbol', label: 'function beta', start: 11, end: 13 },
    ])
  })

  it('returns nothing when the file has no symbols, rather than an adjacent slice', () => {
    expect(resolveLineRegions([], 15, 3, 3)).toEqual([])
  })
})

describe('runRead with a `file:N` line spec (real pipeline)', () => {
  it('resolves a line inside a function to that function, disclosing kind and true span', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:12` })
      expect(code).toBe(0)
      expect(text).toContain('function betaRegionFn9k  lines 11-13 of 15')
      expect(text).toContain('return b * 2')
      expect(text).not.toContain('alphaRegionFn9k')
    })
  })

  it('resolves a line in the preamble to the preamble', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:2` })
      expect(code).toBe(0)
      expect(text).toContain('file preamble  lines 1-3 of 15')
      expect(text).toContain('// header comment for the sample module')
      expect(text).not.toContain('return a + TOP_CONST_9K')
    })
  })

  it('resolves a line below every symbol to the trailing gap, running to end of file', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:15` })
      expect(code).toBe(0)
      expect(text).toContain('gap after betaRegionFn9k  lines 14-15 of 15')
      expect(text).toContain('// trailing note, after every symbol')
    })
  })

  it('resolves a line between two symbols to the gap, naming both neighbours', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:9` })
      expect(code).toBe(0)
      expect(text).toContain('gap between alphaRegionFn9k and betaRegionFn9k  lines 9-10 of 15')
    })
  })

  it('returns every overlapped region for a range, numbered and in file order', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:2-12` })
      expect(code).toBe(0)
      expect(text).toContain('-> 6 regions')
      expect(text).toContain('[1/6] file preamble  lines 1-3 of 15')
      expect(text).toContain('[2/6] variable TOP_CONST_9K  lines 4-4 of 15')
      expect(text).toContain('[3/6] gap between TOP_CONST_9K and alphaRegionFn9k  lines 5-5 of 15')
      expect(text).toContain('[4/6] function alphaRegionFn9k  lines 6-8 of 15')
      expect(text).toContain('[5/6] gap between alphaRegionFn9k and betaRegionFn9k  lines 9-10 of 15')
      expect(text).toContain('[6/6] function betaRegionFn9k  lines 11-13 of 15')
      expect(text.indexOf('[1/6]')).toBeLessThan(text.indexOf('[6/6]'))
    })
  })

  it('refuses a line past end of file instead of serving the nearest region', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}:900` })
      expect(code).toBe(1)
      expect(text).toContain('Line 900 is past end of file (15 lines)')
    })
  })

  it('says so plainly when the file has no indexed symbols', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-lineregion-nosym-'))
    try {
      const file = join(root, 'plain.txt')
      writeFileSync(file, 'one\ntwo\nthree\n')
      const { text, code } = runRead({ spec: `${file}:2` })
      expect(code).toBe(1)
      expect(text).toContain('No indexed symbols')
      expect(text).toContain('@2')
      expect(text).not.toContain('two')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves `file::symbol` untouched', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}::alphaRegionFn9k` })
      expect(code).toBe(0)
      expect(text).toContain('return a + TOP_CONST_9K')
      expect(text).not.toContain('file preamble')
    })
  })

  it('leaves the raw `file@N-M` line range untouched', () => {
    withSample((file) => {
      const { text, code } = runRead({ spec: `${file}@12-12` })
      expect(code).toBe(0)
      expect(text).toContain('# lines 12-12 of 15')
      expect(text).toContain('return b * 2')
    })
  })
})
