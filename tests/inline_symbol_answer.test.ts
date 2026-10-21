import { describe, expect, it } from 'vitest'

import { INLINE_SYMBOL_MAX_BYTES, decideInline, declaredNameOf, isPlainGrep, type InlineBody, type InlineInput, type Staleness } from '../src/inline_symbol_answer.js'

// HAND-DERIVED: every row is computed from the decision's stated rules (one candidate by name inside the scope, fresh index, agreeing body, under the cap), independently of the implementation's branches.

const BODY: InlineBody = { text: 'def load():\n    return 1', agreesWithIndex: true }

function input(over: Partial<InlineInput> = {}, staleness: Record<string, Staleness> = { 'src/a.py': 'fresh' }): InlineInput {
  return {
    enabled: true,
    symbol: 'load',
    candidates: [{ name: 'load', file: 'src/a.py' }],
    staleness,
    readBody: () => BODY,
    ...over,
  }
}

describe('decideInline', () => {
  it('inlines the body of the one symbol that resolves', async () => {
    expect(await decideInline(input())).toEqual({ inline: BODY.text, file: 'src/a.py', symbol: 'load' })
  })

  it('names ambiguous when two files hold the name and no scope narrows it', async () => {
    const two = [{ name: 'load', file: 'src/a.py' }, { name: 'load', file: 'src/b.py' }]
    expect(await decideInline(input({ candidates: two }, { 'src/a.py': 'fresh', 'src/b.py': 'fresh' }))).toEqual({ name: 'ambiguous' })
  })

  it('inlines when the Grep path narrows an ambiguous name to one file', async () => {
    const two = [{ name: 'load', file: 'src/a.py' }, { name: 'load', file: 'lib/b.py' }]
    expect(await decideInline(input({ candidates: two, scope: 'src' }, { 'src/a.py': 'fresh', 'lib/b.py': 'fresh' }))).toEqual({ inline: BODY.text, file: 'src/a.py', symbol: 'load' })
  })

  it('names none when no candidate carries the name, or the scope drops it', async () => {
    expect(await decideInline(input({ candidates: [{ name: 'other', file: 'src/a.py' }] }))).toEqual({ name: 'none' })
    expect(await decideInline(input({ scope: 'lib' }))).toEqual({ name: 'none' })
  })

  it('names stale when the index copy is stale', async () => {
    expect(await decideInline(input({}, { 'src/a.py': 'stale' }))).toEqual({ name: 'stale' })
  })

  it('names staleness_unknown when there is no evidence for the file, and when it says unknown', async () => {
    expect(await decideInline(input({}, {}))).toEqual({ name: 'staleness_unknown' })
    expect(await decideInline(input({}, { 'src/a.py': 'unknown' }))).toEqual({ name: 'staleness_unknown' })
  })

  it('names over_cap when the body is past the cap, and a caller cap cannot raise the ceiling', async () => {
    const big = { text: 'x'.repeat(INLINE_SYMBOL_MAX_BYTES + 1), agreesWithIndex: true }
    expect(await decideInline(input({ readBody: () => big }))).toEqual({ name: 'over_cap' })
    expect(await decideInline(input({ readBody: () => big, capBytes: INLINE_SYMBOL_MAX_BYTES * 10 }))).toEqual({ name: 'over_cap' })
    expect(await decideInline(input({ capBytes: 5 }))).toEqual({ name: 'over_cap' })
    const exact = { text: 'x'.repeat(INLINE_SYMBOL_MAX_BYTES), agreesWithIndex: true }
    expect(await decideInline(input({ readBody: () => exact }))).toMatchObject({ inline: exact.text })
  })

  it('counts the cap in bytes, not characters', async () => {
    const wide = { text: 'é'.repeat(INLINE_SYMBOL_MAX_BYTES / 2 + 1), agreesWithIndex: true }
    expect(wide.text.length).toBeLessThan(INLINE_SYMBOL_MAX_BYTES)
    expect(await decideInline(input({ readBody: () => wide }))).toEqual({ name: 'over_cap' })
  })

  it('names body_mismatch when the disk lines disagree with the index range, and unreadable_body when there is none', async () => {
    expect(await decideInline(input({ readBody: () => ({ text: BODY.text, agreesWithIndex: false }) }))).toEqual({ name: 'body_mismatch' })
    expect(await decideInline(input({ readBody: () => null }))).toEqual({ name: 'unreadable_body' })
  })

  // The null-index-key reason is `untouchable_path` (the Grep path is one the hook may not touch before approval), set in inlineSymbolAnswer and covered in the e2e file.

  it('names disabled, without reading anything, when the config is off', async () => {
    let reads = 0
    const out = await decideInline(input({ enabled: false, readBody: () => { reads++; return BODY } }))
    expect(out).toEqual({ name: 'disabled' })
    expect(reads).toBe(0)
  })

  it('does not read the body for a candidate it has already refused', async () => {
    let reads = 0
    const readBody = (): InlineBody => { reads++; return BODY }
    await decideInline(input({ readBody }, { 'src/a.py': 'stale' }))
    await decideInline(input({ readBody }, {}))
    expect(reads).toBe(0)
  })
})

describe('declaredNameOf', () => {
  // HAND-DERIVED: patterns an agent writes for one declaration, and the ones that ask for more than one thing.
  it.each([
    [String.raw`def load\b`, 'load'],
    ['^def load$', 'load'],
    ['def load(', 'load'],
    [String.raw`def foo\(`, 'foo'],
    [String.raw`class Foo\b`, 'Foo'],
    ['class Foo<', 'Foo'],
    [String.raw`def load\(`, 'load'],
    [String.raw`^def\s+load\b`, 'load'],
    ['class Config:', 'Config'],
    [String.raw`export function loadConfig\(`, 'loadConfig'],
    [String.raw`export default class Foo\b`, 'Foo'],
    [String.raw`async\s+def run\b`, 'run'],
  ])('%j names %s', (pattern, name) => {
    expect(declaredNameOf(pattern)).toBe(name)
  })

  it.each([['load'], ['def'], ['def load|def save'], ['def load.*'], ['def .*'], ['function a.b'], ['def lo[ad]'], ['class'], [''], ['def load extra words']])('%j names no single symbol', (pattern) => {
    expect(declaredNameOf(pattern)).toBeNull()
  })

  // HAND-DERIVED: a regex is a substring match, so a pattern with no terminator after the name also matches every longer identifier (`class Foo` matches `class FooBar`).
  it.each([['class Foo'], ['def load'], ['^def load'], ['export function loadConfig'], ['Foo.*'], ['class Foo.*'], [String.raw`def foo\s`]])('%j can match a longer identifier, so it names no symbol', (pattern) => {
    expect(declaredNameOf(pattern)).toBeNull()
  })
})

describe('isPlainGrep', () => {
  // FORMAT-DERIVED: key names from Claude Code's GrepInput, @anthropic-ai/claude-code 2.1.306 sdk-tools.d.ts (pattern, path, glob, output_mode, -B, -A, -C, context, -n, -i, -o, type, head_limit, offset, multiline).
  const base = { pattern: String.raw`def a\b`, path: 'a.py' }

  it.each([[{}], [{ output_mode: 'content' }], [{ output_mode: 'content', '-n': true, '-i': false, multiline: false }]])('%j is a plain content search', (extra) => {
    expect(isPlainGrep({ ...base, ...extra })).toBe(true)
  })

  it.each([
    [{ '-i': true }],
    [{ output_mode: 'count' }],
    [{ output_mode: 'files_with_matches' }],
    [{ multiline: true }],
    [{ '-A': 2 }],
    [{ '-B': 2 }],
    [{ '-C': 2 }],
    [{ context: 2 }],
    [{ head_limit: 5 }],
    [{ glob: '*.py' }],
    [{ type: 'py' }],
    [{ '-o': true }],
    [{ offset: 3 }],
    [{ 'some-future-flag': 'x' }],
  ])('%j is not plain', (extra) => {
    expect(isPlainGrep({ ...base, ...extra })).toBe(false)
  })
})
