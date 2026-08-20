/**
 * End-to-end regression for the `symbols.body` storage cap.
 *
 * Background: extractJsonSymbols used to store each top-level key's *whole source line* as its
 * body. On minified JSON — one line for the entire document — that meant every key stored a copy
 * of the whole file, so stored bytes grew as (keys × file size). One real 1.5 MB, 1142-key file
 * inflated global.db by 1.6 GB on its own, which stretched that file's reindex transaction long
 * enough to hold SQLite's writer lock past db.ts's 15s busy_timeout — reaching users as
 * "database is locked" and as long stalls during `token-goat index`.
 *
 * Two defenses were added, and this file pins the one that is easy to get subtly wrong:
 * writeParseResult bounds every stored body at MAX_SYMBOL_BODY_CHARS. The *shape* of that bound
 * is the load-bearing detail. An over-cap body is stored EMPTY, not truncated, because
 * read_commands.ts's resolveBody re-slices an empty body from the source file over the symbol's
 * line range. Storing a truncated body instead would still bound the DB but would make `read`,
 * `symbol`, and `brief` return partial source while presenting it as the complete symbol, with
 * line_end still advertising the full range — a silent correctness regression in the tool's
 * central contract, traded for disk space.
 *
 * These tests drive the real, unmocked pipeline: a real oversized source file, a real
 * indexFileSync write, the real DB, and the real runRead/runSymbol readers.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { indexFileSync, MAX_SYMBOL_BODY_CHARS, boundSymbolBody, MAX_SYMBOL_DOCSTRING_CHARS, boundSymbolDocstring } from '../src/parser.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { runRead } from '../src/read_commands.js'

/** A single JS function whose body comfortably exceeds the storage cap. */
function makeHugeFunctionSource(): string {
  const lines = ['function hugeFn() {']
  // ~40 chars per line; enough lines to clear 128 KB with margin.
  for (let i = 0; i < 6000; i++) {
    lines.push(`  const localVariableNumber${i} = ${i} + 1`)
  }
  lines.push('  return 0')
  lines.push('}')
  return lines.join('\n')
}

describe('symbols.body storage cap (real pipeline)', () => {
  it('elides rather than truncates an over-cap body', () => {
    const under = 'x'.repeat(MAX_SYMBOL_BODY_CHARS)
    expect(boundSymbolBody(under)).toBe(under)

    const over = 'x'.repeat(MAX_SYMBOL_BODY_CHARS + 1)
    // Empty, not a prefix: a prefix would be served by resolveBody as if it were complete.
    expect(boundSymbolBody(over)).toBe('')
  })

  it('stores an over-cap symbol body empty but still reads it back complete from source', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-bodycap-'))
    try {
      const file = join(root, 'huge.js')
      const source = makeHugeFunctionSource()
      expect(source.length).toBeGreaterThan(MAX_SYMBOL_BODY_CHARS)
      writeFileSync(file, source)
      indexFileSync(normalizePath(file))

      const stored = querySymbols({ filePath: normalizePath(file), name: 'hugeFn' })
      expect(stored.length).toBeGreaterThan(0)
      const sym = stored[0]!
      // The DB row is bounded...
      expect(sym.body).toBe('')
      // ...while still describing the symbol's true extent, which is what lets the reader
      // reconstruct it. A row that elided the body but also lost the range would be unreadable.
      expect(sym.lineEnd - sym.lineStart).toBeGreaterThan(5000)

      // ...and the read path still returns the whole thing, including its very last line.
      // ...and the read path still serves the symbol from source. The output goes through the
      // normal overflow guard, which is the point: the reader reports honestly how much of the
      // symbol it is showing ("showing N of 6004 lines") instead of silently handing back a
      // truncated body as if it were whole, which is what storing a truncated body would cause.
      const { text, code } = runRead({ spec: `${file}::hugeFn` })
      expect(code).toBe(0)
      expect(text).toContain('localVariableNumber0 =')
      expect(text).toMatch(/of 6004 lines/)

      // --json is the documented escape hatch from that cap; the full body must be there,
      // proving nothing was lost at write time.
      const full = runRead({ spec: `${file}::hugeFn`, json: true })
      expect(full.code).toBe(0)
      expect(full.text).toContain('localVariableNumber5999 =')
      expect(full.text.length).toBeGreaterThan(MAX_SYMBOL_BODY_CHARS)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves an ordinary under-cap body stored verbatim', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-bodycap-small-'))
    try {
      const file = join(root, 'small.js')
      writeFileSync(file, 'function smallFn(a) {\n  return a + 1\n}\n')
      indexFileSync(normalizePath(file))

      const stored = querySymbols({ filePath: normalizePath(file), name: 'smallFn' })
      expect(stored.length).toBeGreaterThan(0)
      // The cap must not perturb the overwhelmingly common case.
      expect(stored[0]!.body).toContain('return a + 1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('symbols.docstring storage cap', () => {
  it('leaves an under-cap docstring untouched', () => {
    const doc = 'a'.repeat(MAX_SYMBOL_DOCSTRING_CHARS)
    expect(boundSymbolDocstring(doc)).toBe(doc)
  })

  it('never returns more than the cap it advertises', () => {
    // The marker has to be budgeted *inside* the cap. Appending it to a full-length slice would
    // make the stored value longer than MAX_SYMBOL_DOCSTRING_CHARS, which turns a constant that
    // reads as a hard storage bound into an approximate one -- exactly the kind of quiet drift
    // that let the body column reach 1.9 GB in the first place.
    const doc = 'a'.repeat(MAX_SYMBOL_DOCSTRING_CHARS * 3)
    const bounded = boundSymbolDocstring(doc)
    expect(bounded.length).toBeLessThanOrEqual(MAX_SYMBOL_DOCSTRING_CHARS)
  })

  it('truncates with a visible marker rather than eliding', () => {
    // The deliberate inverse of the body contract: no line range is recorded for a docstring, so
    // there is nothing to re-slice it from. Eliding would destroy it and flip `outline` to
    // "undocumented" for the most heavily documented symbols.
    const bounded = boundSymbolDocstring('a'.repeat(MAX_SYMBOL_DOCSTRING_CHARS * 2))
    expect(bounded).not.toBe('')
    expect(bounded).toContain('truncated')
    expect(bounded.startsWith('aaa')).toBe(true)
  })

  it('does not split a surrogate pair at the cut point', () => {
    // Build a docstring whose over-cap region lands the cut exactly between the two halves of an
    // astral character. Slicing there stores a lone surrogate -- not valid text, and liable to
    // surface downstream as a replacement character.
    const cut = MAX_SYMBOL_DOCSTRING_CHARS - '\n[... docstring truncated by token-goat ...]'.length
    const doc = 'a'.repeat(cut - 1) + '\u{1F600}'.repeat(2000)
    const bounded = boundSymbolDocstring(doc)
    const body = bounded.slice(0, bounded.length - '\n[... docstring truncated by token-goat ...]'.length)
    const last = body.charCodeAt(body.length - 1)
    expect(last >= 0xd800 && last <= 0xdbff, 'stored value ends in a lone high surrogate').toBe(false)
  })
  it('elides a destructuring declaration whose bindings would multiply it past the cap, and still reads it back complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-destructure-'))
    try {
      const file = join(root, 'many.ts')
      const names = Array.from({ length: 900 }, (_, i) => 'v' + i)
      const source = 'const [' + names.join(',') + '] = source\n'
      // Each name on its own is far under the cap. What passes it is the declarator's
      // text stored once per bound name: 900 x ~4.4 KB.
      expect(source.length).toBeLessThan(MAX_SYMBOL_BODY_CHARS)
      expect(source.length * names.length).toBeGreaterThan(MAX_SYMBOL_BODY_CHARS)
      writeFileSync(file, source)
      indexFileSync(normalizePath(file))

      const stored = querySymbols({ filePath: normalizePath(file), name: 'v0' })
      expect(stored.length).toBeGreaterThan(0)
      expect(stored[0]!.body).toBe('')

      // Elided in the row, complete on the way out.
      const { text } = runRead({ spec: file + '::v0' })
      expect(text).toContain('v899')
      expect(text).toContain('= source')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('leaves a small destructuring declaration\'s body alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-destructure-small-'))
    try {
      const file = join(root, 'few.ts')
      writeFileSync(file, 'const { alpha, beta } = source\n')
      indexFileSync(normalizePath(file))
      const stored = querySymbols({ filePath: normalizePath(file), name: 'alpha' })
      expect(stored.length).toBeGreaterThan(0)
      expect(stored[0]!.body).toBe('const { alpha, beta } = source')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})