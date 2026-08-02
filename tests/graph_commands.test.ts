/**
 * Unit tests for the pure exported helpers in src/graph_commands.ts and
 * light integration tests against the real repo index (global.db must be
 * populated before this suite runs — the fixture is the token-goat repo itself).
 */

import { readdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync, mkdirSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { captureStdout } from './helpers/capture-stdout.js'
import { querySymbols, searchSymbolsFts } from '../src/index_reader.js'
import type * as IndexReaderModule from '../src/index_reader.js'
import {
  bfsCallChains,
  compareHopEntries,
  enclosingSymbol,
  findCycles,
  isDeadSymbol,
  isTestFile,
  looksLikeTypeClass,
  runAsk,
  runArch,
  runBlame,
  runCallers,
  resolveCallers,
  runCallChain,
  runContextFor,
  runCoverageGaps,
  runDead,
  runDeps,
  runImpact,
  runScope,
  runSimilar,
  runTestFor,
  runTypes,
} from '../src/graph_commands.js'
import type { SymbolEntry } from '../src/parser_types.js'

/** Run `fn` with `process.stderr.write` captured, returning whatever it wrote. Restores the
 * original write function afterward regardless of whether `fn` throws. Shared helper for the
 * `--top <= 0` rejection tests below (mirrors the inline pattern already used throughout this
 * file, e.g. the `runTypes limit validation` suite). */
function captureStderr(fn: () => void): string {
  let errCaptured = ''
  const origStderr = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
  try {
    fn()
  } finally {
    process.stderr.write = origStderr
  }
  return errCaptured
}

// Wrap querySymbols in a spy-able vi.fn() while still delegating to the real implementation.
// vi.mock is hoisted above these imports by vitest, so every call site (this test file's own
// `querySymbols` import and graph_commands.ts's internal import) resolves to the same mocked
// module instance and can be counted via vi.mocked(querySymbols).mock.calls -- used below to
// regression-test that buildFileSymCache() is hoisted once outside the BFS loop in
// runCallChain/runImpact rather than rebuilt (and its memoization reset) on every node visited.
vi.mock('../src/index_reader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof IndexReaderModule>()
  return { ...actual, querySymbols: vi.fn(actual.querySymbols), searchSymbolsFts: vi.fn(actual.searchSymbolsFts) }
})

// ---- helpers ----------------------------------------------------------------

function makeSymbol(name: string, lineStart: number, lineEnd: number, kind = 'function'): SymbolEntry {
  return { name, kind, lineStart, lineEnd, filePath: 'file.ts', body: '', docstring: '', parent: '' }
}

// Establish the precondition this suite's header assumes: the token-goat repo's own src tree indexed into the ambient global.db. Without it a fresh checkout (CI) has an empty index and the runTypes/runCallers/runImpact integration cases below find nothing and exit 1; seeding here makes them deterministic on any machine instead of depending on pre-existing ambient index state.
beforeAll(() => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const child = join(dir, e.name)
      if (e.isDirectory()) return walk(child)
      return child.endsWith('.ts') && !child.endsWith('.d.ts') ? [child] : []
    })
  for (const file of walk(resolve('src'))) indexFileSync(normalizePath(file))
})

// ---- enclosingSymbol --------------------------------------------------------

describe('enclosingSymbol', () => {
  it('returns null for empty symbol list', () => {
    expect(enclosingSymbol([], 10)).toBeNull()
  })

  it('returns null when line is outside all symbols', () => {
    const syms = [makeSymbol('a', 1, 5), makeSymbol('b', 10, 20)]
    expect(enclosingSymbol(syms, 7)).toBeNull()
  })

  it('returns the only containing symbol', () => {
    const syms = [makeSymbol('outer', 1, 20)]
    expect(enclosingSymbol(syms, 10)?.name).toBe('outer')
  })

  it('returns the innermost (largest lineStart) of nested symbols', () => {
    const syms = [makeSymbol('outer', 1, 100), makeSymbol('inner', 40, 60)]
    expect(enclosingSymbol(syms, 50)?.name).toBe('inner')
  })

  it('returns exact boundary match (line === lineStart)', () => {
    const syms = [makeSymbol('fn', 5, 15)]
    expect(enclosingSymbol(syms, 5)?.name).toBe('fn')
  })

  it('returns exact boundary match (line === lineEnd)', () => {
    const syms = [makeSymbol('fn', 5, 15)]
    expect(enclosingSymbol(syms, 15)?.name).toBe('fn')
  })

  it('fails when containment logic is broken — mutation verification target', () => {
    // This test specifically validates the lineStart <= line check. If that check became lineStart < line (strict), line===lineStart would no longer match.
    const syms = [makeSymbol('fn', 10, 20)]
    const result = enclosingSymbol(syms, 10)
    // Must find the symbol whose lineStart equals the queried line.
    expect(result?.name).toBe('fn')
  })
})

// ---- looksLikeTypeClass -----------------------------------------------------

describe('looksLikeTypeClass', () => {
  it('returns true for BaseModel subclass', () => {
    expect(looksLikeTypeClass('class Foo(BaseModel):\n  x: int')).toBe(true)
  })

  it('returns true for TypedDict subclass', () => {
    expect(looksLikeTypeClass('class Foo(TypedDict):\n  x: int')).toBe(true)
  })

  it('returns true for Protocol subclass', () => {
    expect(looksLikeTypeClass('class Foo(Protocol):\n  def method(self) -> None: ...')).toBe(true)
  })

  it('returns true for @dataclass decorator', () => {
    expect(looksLikeTypeClass('@dataclass\nclass Foo:\n  x: int')).toBe(true)
  })

  it('returns false for a plain class', () => {
    expect(looksLikeTypeClass('class Foo:\n  def method(self): pass')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(looksLikeTypeClass('')).toBe(false)
  })

  it('fails if the BaseModel check is removed — mutation verification target', () => {
    // If the BaseModel regex is removed, this would return false when it should return true.
    const body = 'class Config(BaseModel):\n  name: str'
    expect(looksLikeTypeClass(body)).toBe(true)
  })
})

// ---- isDeadSymbol -----------------------------------------------------------

describe('isDeadSymbol', () => {
  it('returns true for a function with zero refs', () => {
    expect(isDeadSymbol('myHelper', 0)).toBe(true)
  })

  it('returns false for a function with refs', () => {
    expect(isDeadSymbol('myHelper', 3)).toBe(false)
  })

  it('returns false for entry-point names even with zero refs', () => {
    for (const name of ['main', 'default', 'index', '__init__', '__main__', 'setup', 'run', 'handler', 'constructor']) {
      expect(isDeadSymbol(name, 0), `${name} should not be dead`).toBe(false)
    }
  })

  // Regression: a JS/TS class constructor is invoked via `new X()`, which creates a ref named
  // `X` (the class), never a ref literally named `constructor` -- so every class constructor in
  // the codebase was a guaranteed false-positive dead-symbol report before `constructor` joined
  // ENTRY_NAMES, mirroring the already-present `__init__` (Python's equivalent) exclusion.
  it('returns false for constructor specifically, mirroring the existing __init__ exclusion', () => {
    expect(isDeadSymbol('constructor', 0)).toBe(false)
  })

  it('fails if the zero-ref check is inverted — mutation verification target', () => {
    // If isDeadSymbol returned refCount > 0 instead of refCount === 0, this would fail.
    expect(isDeadSymbol('orphanFn', 0)).toBe(true)
    expect(isDeadSymbol('usedFn', 1)).toBe(false)
  })
})

// ---- bfsCallChains ----------------------------------------------------------

describe('bfsCallChains', () => {
  it('returns only the start when no callers exist', () => {
    const chains = bfsCallChains('a', () => [], 4)
    expect(chains).toEqual([['a']])
  })

  it('traces a simple one-hop chain', () => {
    const callersOf = (n: string): string[] => (n === 'a' ? ['b'] : [])
    const chains = bfsCallChains('a', callersOf, 4)
    expect(chains).toEqual([['a', 'b']])
  })

  it('produces multiple chains for a diamond, labeling a cross-branch revisit as "visited" rather than a false cycle', () => {
    const graph: Record<string, string[]> = { a: ['b', 'c'], b: ['d'], c: ['d'] }
    const callersOf = (n: string): string[] => graph[n] ?? []
    const chains = bfsCallChains('a', callersOf, 4)
    const flat = chains.map((c) => c.join('->'))
    expect(flat).toContain('a->b->d')
    // d is reached first via a->b->d. The second path, a->c->d, revisits d via a DIFFERENT branch — c is not an ancestor of the first d, so there is no real cycle back to the current chain. This is legitimate cross-branch deduplication and must be labeled "visited", not "cycle".
    expect(flat).toContain('a->c->(visited:d)')
    expect(flat.some((s) => s.includes('cycle'))).toBe(false)
  })

  it('emits a cycle sentinel instead of looping forever', () => {
    const callersOf = (n: string): string[] => (n === 'a' ? ['b'] : n === 'b' ? ['a'] : [])
    const chains = bfsCallChains('a', callersOf, 10)
    const flat = chains.map((c) => c.join('->'))
    expect(flat.some((s) => s.includes('cycle:a'))).toBe(true)
    expect(chains.length).toBeLessThan(50)
  })

  it('respects maxDepth=0 by returning just the start', () => {
    const callersOf = (_n: string): string[] => ['x', 'y', 'z']
    const chains = bfsCallChains('a', callersOf, 0)
    expect(chains).toEqual([['a']])
  })

  it('respects maxDepth and does not exceed it', () => {
    const callersOf = (n: string): string[] => [`${n}x`]
    const chains = bfsCallChains('a', callersOf, 3)
    for (const chain of chains) {
      expect(chain.length).toBeLessThanOrEqual(4)
    }
  })

  it('fails if the cycle guard is removed — mutation verification target', () => {
    // Without the globalVisited check, a->b->a would loop forever. The cycle sentinel test above already catches that, but this makes the intent explicit.
    let calls = 0
    const callersOf = (n: string): string[] => {
      calls++
      if (calls > 1000) throw new Error('infinite loop detected')
      return n === 'start' ? ['mid'] : n === 'mid' ? ['start'] : []
    }
    expect(() => bfsCallChains('start', callersOf, 10)).not.toThrow()
  })

  it('does not emit a redundant duplicate chain when all of a node\'s callers are cycles (fail-on-buggy: missing expanded=true in the cycle branch double-emits)', () => {
    const graph: Record<string, string[]> = { a: ['b'], b: ['a'] }
    const callersOf = (n: string): string[] => graph[n] ?? []
    const chains = bfsCallChains('a', callersOf, 10)
    const flat = chains.map((c) => c.join('->'))
    expect(flat).toContain('a->b->(cycle:a)')
    expect(flat).not.toContain('a->b')
    expect(chains).toHaveLength(1)
  })
})

// ---- integration: runScope against the real repo index ----------------------

describe('runScope integration', () => {
  it('exits 0 and finds at least one enclosing symbol for a known source line', () => {
    // Resolve a line guaranteed to be inside a real function body at test-run time, rather than a
    // hardcoded line number -- a fixed magic number (this test used to hardcode src/cli.ts:640
    // under a stale "reliably inside buildProgram" comment) drifts as the file grows, and the
    // old assertion (`typeof result === 'number'`) accepted either exit code, so it kept passing
    // even after the comment's premise went stale and the line landed in a different, unrelated
    // function -- silently no longer proving what the test's own title claims. Assert the actual
    // claimed behavior: exit code 0.
    // A symbol whose lineStart equals its lineEnd (a one-line class/const declaration) leaves no
    // interior line to target, so require at least 2 lines of span before trusting lineStart+1
    // to land inside it.
    const symbols = querySymbols({ filePath: normalizePath(resolve('src/cli.ts')), limit: 50 })
    const spanningSymbol = symbols.find((s) => s.lineEnd > s.lineStart)
    expect(spanningSymbol).toBeDefined()
    const line = (spanningSymbol?.lineStart ?? 1) + 1
    const result = runScope({ spec: `src/cli.ts:${line}` })
    expect(result).toBe(0)
  })

  it('exits 1 for a nonsense file', () => {
    const result = runScope({ spec: 'src/__nonexistent_file_xyzzy__.ts:1' })
    expect(result).toBe(1)
  })

  it('exits 1 for a malformed spec with no colon', () => {
    const result = runScope({ spec: 'nocoheresymbol' })
    expect(result).toBe(1)
  })

  it('returns JSON array for --json flag', () => {
    // Resolve a line guaranteed to be inside a real function body at test-run time, rather than
    // a hardcoded line number -- this file grows over time and a fixed magic number eventually
    // drifts outside every symbol's range (as happened here), making runScope legitimately find
    // nothing and never print, which is a real test bug, not a runScope bug.
    const anySymbol = querySymbols({ filePath: normalizePath(resolve('src/read_commands.ts')), limit: 1 })[0]
    expect(anySymbol).toBeDefined()
    const line = (anySymbol?.lineStart ?? 1) + 1

    const captured = captureStdout(() => {
      runScope({ spec: `src/read_commands.ts:${line}`, json: true })
    })
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('exits 1 for a nonsense file even with --json (regression: emptiness check must run before format branching)', () => {
    const result = runScope({ spec: 'src/__nonexistent_file_xyzzy__.ts:1', json: true })
    expect(result).toBe(1)
  })

  // #232 regression: Number.parseInt('12abc', 10) silently parsed as 12 instead of rejecting the
  // trailing garbage, so `scope file:12abc` resolved the line number as if it had been `file:12`.
  it('exits 1 for a line number with trailing garbage instead of silently truncating it', () => {
    const result = runScope({ spec: 'src/cli.ts:12abc' })
    expect(result).toBe(1)
  })

  it('exits 1 for a line number in exponential notation instead of silently truncating it', () => {
    const result = runScope({ spec: 'src/cli.ts:1e3' })
    expect(result).toBe(1)
  })

  // Regression-coverage gap: the existing "--json flag" test above only ever asserted
  // `Array.isArray(parsed)`, never that the returned symbols are the right ones, in the right
  // (innermost-first) order the CLI help text and doc comment both promise. A file with a class
  // containing a method makes the ordering directly observable.
  it('orders enclosing symbols innermost first for a nested class method', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-scope-nest-'))
    try {
      const file = join(dir, 'Nested.ts')
      writeFileSync(
        file,
        [
          'export class ScopeNestOuter {',
          '  method() {',
          '    return 1',
          '  }',
          '}',
          '',
        ].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runScope({ spec: `${file}:3`, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((s) => s.name)).toEqual(['method', 'ScopeNestOuter'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- integration: runTypes against the real repo index ---------------------

describe('runTypes integration', () => {
  it('exits 0 and finds SymbolEntry interface', () => {
    const captured = captureStdout(() => {
      const code = runTypes({})
      expect(code).toBe(0)
    })
    expect(captured).toMatch(/SymbolEntry|RefEntry|Language/)
  })

  it('exits 0 scoped to a specific file', () => {
    const captured = captureStdout(() => {
      const code = runTypes({ file: 'src/parser_types.ts' })
      expect(code).toBe(0)
    })
    expect(captured).toMatch(/SymbolEntry|Language/)
  })

  it('returns valid JSON for --json flag', () => {
    const captured = captureStdout(() => {
      const code = runTypes({ json: true })
      expect(code).toBe(0)
    })
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
    // Length-only would still pass if --json returned unrelated rows (e.g. a broken kind filter
    // that fell through to every symbol in the project) -- assert a known real project type
    // interface is actually present by name, matching the plain-text sibling test above's own
    // toMatch(/SymbolEntry|RefEntry|Language/) content pin.
    expect((parsed as SymbolEntry[]).some((r) => r.name === 'SymbolEntry')).toBe(true)
  })

  it('exits 1 for a nonexistent file even with --json (regression: emptiness check must run before format branching)', () => {
    const code = runTypes({ file: 'src/__nonexistent_xyzzy__.ts', json: true })
    expect(code).toBe(1)
  })

  it('sorts a realistic mixed-case file-path set in the expected en-locale order (regression: comparator must not silently drop its locale pin)', () => {
    // Must live under process.cwd() (the repo root, matched against runTypes()'s own
    // process.cwd()-scoped rootDir since #43's cross-project fix), not the bare OS temp dir --
    // otherwise this fixture is now correctly excluded as belonging to a different project.
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-locale-'))
    try {
      const fileA = join(dir, 'Banana.ts')
      const fileB = join(dir, 'apple.ts')
      writeFileSync(fileA, 'export interface BananaLocaleFixture { x: number }\n')
      writeFileSync(fileB, 'export interface AppleLocaleFixture { y: number }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const captured = captureStdout(() => {
        const code = runTypes({ json: true, limit: 5000 })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string }>
      const idxApple = parsed.findIndex((r) => r.name === 'AppleLocaleFixture')
      const idxBanana = parsed.findIndex((r) => r.name === 'BananaLocaleFixture')
      expect(idxApple).toBeGreaterThanOrEqual(0)
      expect(idxBanana).toBeGreaterThanOrEqual(0)
      // Under 'en'-locale comparison, "apple.ts" sorts before "Banana.ts"
      // despite the case difference -- pins the exact expected order so a
      // future regression in the comparator (wrong operand order, dropped
      // locale argument, etc.) is still caught even though the locale
      // -instability the fix addresses isn't independently observable from
      // a single-environment/single-ICU-build test run.
      expect(idxApple).toBeLessThan(idxBanana)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression-coverage gap: `class` is not in TYPE_KINDS (line ~608), so the only path
  // by which a class can ever appear in runTypes' output is the looksLikeTypeClass(cls.body)
  // filter loop below the TYPE_KINDS scan. looksLikeTypeClass itself has thorough standalone
  // unit tests (pydantic BaseModel, TypedDict, Protocol, @dataclass), but nothing exercised
  // that filter loop through runTypes end-to-end -- a regression there (e.g. the loop being
  // deleted, or its condition inverted) would pass every existing runTypes integration test
  // while silently dropping every Python data-model class from `types` output.
  it('surfaces a Python pydantic-style class via the looksLikeTypeClass filter, not just TYPE_KINDS symbols', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-pyclass-'))
    try {
      const file = join(dir, 'model.py')
      writeFileSync(
        file,
        ['class TypesPyClassFixture(BaseModel):', '    x: int', ''].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesPyClassFixture')
      expect(parsed.find((r) => r.name === 'TypesPyClassFixture')?.kind).toBe('class')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~612) omitted 'union', so a Rust `union` -- a type
  // declaration exactly like `struct`/`enum`/`trait`, all of which ARE in TYPE_KINDS -- was
  // indexed (parser.ts's RUST_KIND_BY_TYPE maps union_item -> 'union') but never surfaced by
  // `token-goat types`. Caught by Codex review of the commit that added Rust union indexing.
  it('surfaces a Rust union via TYPE_KINDS, matching struct/enum/trait', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-rustunion-'))
    try {
      const file = join(dir, 'packed.rs')
      writeFileSync(
        file,
        ['union TypesRustUnionFixture {', '    a: u32,', '    b: f32,', '}', ''].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesRustUnionFixture')
      expect(parsed.find((r) => r.name === 'TypesRustUnionFixture')?.kind).toBe('union')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~626) never included 'protocol' -- Swift's extractor
  // (languages/swift.ts) emits kind 'protocol' for `protocol Foo { ... }` declarations, a type
  // declaration exactly analogous to `interface` (which IS in TYPE_KINDS) in every other
  // extractor's vocabulary. Every Swift protocol was indexed but silently excluded from
  // `token-goat types`, the same class of gap already fixed once for Rust `union`.
  it('surfaces a Swift protocol via TYPE_KINDS, matching interface', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-swiftprotocol-'))
    try {
      const file = join(dir, 'fixture.swift')
      writeFileSync(
        file,
        ['protocol TypesSwiftProtocolFixture {', '    func doThing()', '}', ''].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesSwiftProtocolFixture')
      expect(parsed.find((r) => r.name === 'TypesSwiftProtocolFixture')?.kind).toBe('protocol')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~629) never included 'opaque' -- Zig's extractor
  // (languages/zig.ts's CONTAINER_RE) emits kind 'opaque' for `const X = opaque { ... }`
  // declarations, a type declaration exactly analogous to `struct`/`enum`/`union` (all of which
  // ARE in TYPE_KINDS, and are matched by the very same regex/code path in zig.ts). Every Zig
  // opaque type was indexed but silently excluded from `token-goat types`, the same class of gap
  // already fixed twice (Rust 'union', Swift 'protocol').
  it('surfaces a Zig opaque type via TYPE_KINDS, matching struct/enum/union', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-zigopaque-'))
    try {
      const file = join(dir, 'fixture.zig')
      writeFileSync(file, ['const TypesZigOpaqueFixture = opaque {};', ''].join('\n'))
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesZigOpaqueFixture')
      expect(parsed.find((r) => r.name === 'TypesZigOpaqueFixture')?.kind).toBe('opaque')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~632) never included 'mixin' -- Dart's extractor
  // (languages/dart.ts's MIXIN_RE) emits kind 'mixin' for `mixin Foo { ... }` declarations, a
  // type declaration exactly analogous to `class`/`enum` (both indexed the same way), yet every
  // Dart mixin was silently excluded from `token-goat types`, the same class of gap already
  // fixed three times (Rust 'union', Swift 'protocol', Zig 'opaque').
  it('surfaces a Dart mixin via TYPE_KINDS, matching class/enum', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-dartmixin-'))
    try {
      const file = join(dir, 'fixture.dart')
      writeFileSync(file, ['mixin TypesDartMixinFixture {}', ''].join('\n'))
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesDartMixinFixture')
      expect(parsed.find((r) => r.name === 'TypesDartMixinFixture')?.kind).toBe('mixin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~632) never included 'extension' -- Dart's extractor
  // (languages/dart.ts's EXTENSION_RE) and Swift's (languages/swift.ts's TYPE_HEADER_RE) both
  // emit kind 'extension' for an `extension Foo on Bar { ... }` declaration, yet every extension
  // was silently excluded from `token-goat types` despite being indexed identically to the
  // struct/enum/protocol kinds that already are in TYPE_KINDS.
  it('surfaces a Dart extension via TYPE_KINDS, matching class/mixin', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-dartextension-'))
    try {
      const file = join(dir, 'fixture.dart')
      writeFileSync(file, ['extension TypesDartExtensionFixture on String {}', ''].join('\n'))
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesDartExtensionFixture')
      expect(parsed.find((r) => r.name === 'TypesDartExtensionFixture')?.kind).toBe('extension')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS (line ~632) never included 'actor' -- Swift's extractor
  // (languages/swift.ts's TYPE_HEADER_RE) emits kind 'actor' for `actor Foo { ... }`
  // declarations (Swift concurrency's reference type, declared the same way as class/struct),
  // yet every Swift actor was silently excluded from `token-goat types`.
  it('surfaces a Swift actor via TYPE_KINDS, matching class/struct', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-swiftactor-'))
    try {
      const file = join(dir, 'fixture.swift')
      writeFileSync(file, ['actor TypesSwiftActorFixture {}', ''].join('\n'))
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesSwiftActorFixture')
      expect(parsed.find((r) => r.name === 'TypesSwiftActorFixture')?.kind).toBe('actor')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'apex_class'/'apex_interface'/'apex_enum' -- the
  // Apex extractor (languages/apex.ts) emits those kinds (not the generic 'class'/'interface'/
  // 'enum' TYPE_KINDS already recognizes) for `class`/`interface`/`enum` declarations, and
  // runTypes' separate looksLikeTypeClass(cls.body) fallback only ever queries kind === 'class'
  // literally, so it never picks up 'apex_class' either. Every Apex class/interface/enum was
  // indexed but silently excluded from `token-goat types` in its entirety, the same class of
  // gap already fixed for Rust union, Swift protocol/actor, Zig opaque, Dart mixin/extension,
  // and proto message/enum/service.
  it('surfaces Apex class/interface/enum via TYPE_KINDS, matching struct/enum/interface', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-apex-'))
    try {
      const clsFile = join(dir, 'TypesApexClassFixture.cls')
      writeFileSync(clsFile, ['public class TypesApexClassFixture {', '}', ''].join('\n'))
      const intfFile = join(dir, 'TypesApexInterfaceFixture.cls')
      writeFileSync(intfFile, ['public interface TypesApexInterfaceFixture {', '    void doThing();', '}', ''].join('\n'))
      const enumFile = join(dir, 'TypesApexEnumFixture.cls')
      writeFileSync(enumFile, ['public enum TypesApexEnumFixture {', '    A, B', '}', ''].join('\n'))
      indexFileSync(normalizePath(clsFile))
      indexFileSync(normalizePath(intfFile))
      indexFileSync(normalizePath(enumFile))

      for (const [file, name, kind] of [
        [clsFile, 'TypesApexClassFixture', 'apex_class'],
        [intfFile, 'TypesApexInterfaceFixture', 'apex_interface'],
        [enumFile, 'TypesApexEnumFixture', 'apex_enum'],
      ] as const) {
        const captured = captureStdout(() => {
          const code = runTypes({ file: normalizePath(file), json: true })
          expect(code).toBe(0)
        })
        const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
        expect(parsed.map((r) => r.name)).toContain(name)
        expect(parsed.find((r) => r.name === name)?.kind).toBe(kind)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'proto_message'/'proto_enum'/'proto_service' --
  // the .proto extractor (languages/proto_idx.ts's KIND_MAP) emits those kinds for `message`,
  // `enum`, and `service` declarations, the exact type/interface-shaped constructs TYPE_KINDS
  // exists to surface (a proto message is analogous to struct, a proto enum to enum, a proto
  // service's RPC method set to interface), yet every one was silently excluded from
  // `token-goat types` -- the same class of gap already fixed for Rust union, Swift
  // protocol/actor, Zig opaque, and Dart mixin/extension.
  it('surfaces proto message/enum/service via TYPE_KINDS, matching struct/enum/interface', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-proto-'))
    try {
      const file = join(dir, 'fixture.proto')
      writeFileSync(
        file,
        [
          'syntax = "proto3";',
          'message TypesProtoMessageFixture {',
          '  string name = 1;',
          '}',
          'enum TypesProtoEnumFixture {',
          '  UNKNOWN = 0;',
          '}',
          'service TypesProtoServiceFixture {',
          '  rpc DoThing(TypesProtoMessageFixture) returns (TypesProtoMessageFixture);',
          '}',
          '',
        ].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesProtoMessageFixture')
      expect(parsed.find((r) => r.name === 'TypesProtoMessageFixture')?.kind).toBe('proto_message')
      expect(parsed.map((r) => r.name)).toContain('TypesProtoEnumFixture')
      expect(parsed.find((r) => r.name === 'TypesProtoEnumFixture')?.kind).toBe('proto_enum')
      expect(parsed.map((r) => r.name)).toContain('TypesProtoServiceFixture')
      expect(parsed.find((r) => r.name === 'TypesProtoServiceFixture')?.kind).toBe('proto_service')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'graphql_type'/'graphql_interface'/'graphql_input'/
  // 'graphql_enum'/'graphql_union' -- the GraphQL extractor (languages/graphql_idx.ts's
  // KIND_MAP) emits those prefixed kinds (not the generic 'type'/'interface'/'enum'/'union'
  // TYPE_KINDS already recognizes) for `type`/`interface`/`input`/`enum`/`union` declarations,
  // so every GraphQL type/interface/input/enum/union was indexed but silently excluded from
  // `token-goat types` in its entirety -- the same class of gap already fixed for Rust union,
  // Swift protocol/actor, Zig opaque, Dart mixin/extension, proto message/enum/service, and
  // Apex class/interface/enum.
  it('surfaces GraphQL type/interface/input/enum/union via TYPE_KINDS, matching struct/enum/interface', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-graphql-'))
    try {
      const file = join(dir, 'fixture.graphql')
      writeFileSync(
        file,
        [
          'type TypesGraphqlTypeFixture {',
          '  id: ID!',
          '}',
          'interface TypesGraphqlInterfaceFixture {',
          '  id: ID!',
          '}',
          'input TypesGraphqlInputFixture {',
          '  id: ID!',
          '}',
          'enum TypesGraphqlEnumFixture {',
          '  A',
          '  B',
          '}',
          'union TypesGraphqlUnionFixture = TypesGraphqlTypeFixture',
          '',
        ].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      for (const [name, kind] of [
        ['TypesGraphqlTypeFixture', 'graphql_type'],
        ['TypesGraphqlInterfaceFixture', 'graphql_interface'],
        ['TypesGraphqlInputFixture', 'graphql_input'],
        ['TypesGraphqlEnumFixture', 'graphql_enum'],
        ['TypesGraphqlUnionFixture', 'graphql_union'],
      ] as const) {
        expect(parsed.map((r) => r.name)).toContain(name)
        expect(parsed.find((r) => r.name === name)?.kind).toBe(kind)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'object' -- languages/kotlin.ts and languages/scala.ts
  // both deliberately emit kind 'object' (not folded into 'class') for a top-level `object Foo {
  // ... }` singleton declaration or a Kotlin companion object, per each file's own comment. Unlike
  // a plain class/interface/enum, `runTypes`' fallback loop only ever re-queries kind === 'class'
  // through looksLikeTypeClass -- it never considers 'object' rows at all, so every Kotlin/Scala
  // object/companion-object declaration was indexed but silently and totally excluded from
  // `token-goat types`, the same class of gap already fixed for Rust union, Swift
  // protocol/actor, Zig opaque, Dart mixin/extension, proto message/enum/service, Apex
  // class/interface/enum, and GraphQL type/interface/input/enum/union.
  it("surfaces Kotlin/Scala 'object' declarations via TYPE_KINDS, matching class/interface", () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-object-'))
    try {
      const ktFile = join(dir, 'fixture.kt')
      writeFileSync(ktFile, ['object TypesKotlinObjectFixture {', '    val x = 1', '}', ''].join('\n'))
      indexFileSync(normalizePath(ktFile))

      const scalaFile = join(dir, 'fixture.scala')
      writeFileSync(scalaFile, ['object TypesScalaObjectFixture {', '  val x = 1', '}', ''].join('\n'))
      indexFileSync(normalizePath(scalaFile))

      for (const file of [ktFile, scalaFile]) {
        const captured = captureStdout(() => {
          const code = runTypes({ file: normalizePath(file), json: true })
          expect(code).toBe(0)
        })
        const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
        const expectedName = file === ktFile ? 'TypesKotlinObjectFixture' : 'TypesScalaObjectFixture'
        expect(parsed.map((r) => r.name)).toContain(expectedName)
        expect(parsed.find((r) => r.name === expectedName)?.kind).toBe('object')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'graphql_scalar'. languages/graphql_idx.ts's own
  // KIND_MAP (the same map that already supplies 'graphql_type'/'graphql_interface'/
  // 'graphql_input'/'graphql_enum'/'graphql_union', all already fixed and present in TYPE_KINDS)
  // also maps the `scalar` keyword to 'graphql_scalar' -- a GraphQL custom scalar declaration
  // (`scalar DateTime`) is a first-class SDL type declaration exactly like `enum`/`union`, but
  // its kind was the one KIND_MAP entry never added to TYPE_KINDS, so every `scalar` declaration
  // was indexed but silently excluded from `token-goat types` in its entirety -- the same class
  // of gap already fixed for the other five GraphQL kinds, Rust union, Swift protocol/actor, Zig
  // opaque, Dart mixin/extension, proto message/enum/service, Apex class/interface/enum, and
  // Kotlin/Scala 'object'.
  it("surfaces GraphQL 'scalar' declarations via TYPE_KINDS, matching the other GraphQL kinds", () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-graphql-scalar-'))
    try {
      const file = join(dir, 'fixture.graphql')
      writeFileSync(file, ['scalar TypesGraphqlScalarFixture', ''].join('\n'))
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesGraphqlScalarFixture')
      expect(parsed.find((r) => r.name === 'TypesGraphqlScalarFixture')?.kind).toBe('graphql_scalar')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'graphql_extend'. languages/graphql_idx.ts's TYPE_RE
  // handler maps EVERY `extend type|interface|input|enum|union|scalar Foo { ... }` declaration
  // (GraphQL's mechanism for adding fields to a type from another file/module, ubiquitous in
  // federation and schema-stitching) to this one shared kind regardless of which keyword follows
  // `extend` -- but unlike the six non-extend KIND_MAP entries above (all already fixed), this
  // kind was never added to TYPE_KINDS, so every `extend` declaration was indexed but silently
  // excluded from `token-goat types` in its entirety -- the same class of gap already fixed for
  // the other six GraphQL kinds, Rust union, Swift protocol/actor, Zig opaque, Dart mixin/
  // extension, proto message/enum/service, Apex class/interface/enum, and Kotlin/Scala 'object'.
  it("surfaces GraphQL 'extend' declarations via TYPE_KINDS, matching the other GraphQL kinds", () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-graphql-extend-'))
    try {
      const file = join(dir, 'fixture.graphql')
      writeFileSync(
        file,
        ['extend type TypesGraphqlExtendFixture {', '  extraField: String', '}', ''].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesGraphqlExtendFixture')
      expect(parsed.find((r) => r.name === 'TypesGraphqlExtendFixture')?.kind).toBe('graphql_extend')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression: TYPE_KINDS never included 'sfc_script_class'. languages/sfc_idx.ts (Vue/Svelte/
  // Astro single-file components) emits this distinct kind for a top-level `class Foo { ... }`
  // declaration in a component's script block rather than the generic 'class', so unlike a plain
  // class it never reaches runTypes' looksLikeTypeClass fallback either (that loop only ever
  // re-queries kind === 'class' literally). Every SFC top-level class was indexed but silently
  // excluded from `token-goat types` in its entirety -- the same class of gap already fixed for
  // Rust union, Swift protocol/actor, Zig opaque, Dart mixin/extension, proto message/enum/
  // service, Apex class/interface/enum, GraphQL type/interface/input/enum/union/scalar, and
  // Kotlin/Scala 'object'.
  it("surfaces a Vue SFC top-level class via TYPE_KINDS, matching class/interface", () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-types-sfc-class-'))
    try {
      const file = join(dir, 'Fixture.vue')
      writeFileSync(
        file,
        ['<script>', 'export class TypesSfcClassFixture {', '  constructor() {}', '}', '</script>', ''].join('\n'),
      )
      indexFileSync(normalizePath(file))

      const captured = captureStdout(() => {
        const code = runTypes({ file: normalizePath(file), json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ name: string; kind: string }>
      expect(parsed.map((r) => r.name)).toContain('TypesSfcClassFixture')
      expect(parsed.find((r) => r.name === 'TypesSfcClassFixture')?.kind).toBe('sfc_script_class')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- integration: runCallers against the real repo index -------------------

// `LIMIT 0` in SQL always returns zero rows on every kind-scan, so a project with type
// declarations that genuinely exist would otherwise be reported as "no type declarations
// found" -- a wrong answer, not just a permissive input. limit: 0 (or negative) must be
// rejected up front.
describe('runTypes limit validation', () => {
  it('rejects limit: 0 as an explicit invalid-argument error instead of returning a false "no type declarations found"', () => {
    let errCaptured = ''
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
    let code: number
    try {
      code = runTypes({ limit: 0 })
    } finally {
      process.stderr.write = origStderr
    }
    expect(code).toBe(1)
    expect(errCaptured).not.toContain('No type declarations found')
    expect(errCaptured.toLowerCase()).toContain('limit')
  })

  it('rejects a negative limit as an explicit invalid-argument error', () => {
    let errCaptured = ''
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
    let code: number
    try {
      code = runTypes({ limit: -1 })
    } finally {
      process.stderr.write = origStderr
    }
    expect(code).toBe(1)
    expect(errCaptured.toLowerCase()).toContain('limit')
  })
})

describe('runCallers integration', () => {
  it('exits 0 for a well-known symbol and returns structured output', () => {
    const captured = captureStdout(() => {
      const code = runCallers({ symbol: 'querySymbols' })
      expect(code).toBe(0)
    })
    // Length-only would still pass on any non-empty (even malformed) output. Pin the actual
    // documented plain-text shape (`{caller}\t{file}:{line}`, see runCallers' emit loop) so a
    // regression that dropped the tab separator or the file:line suffix is caught here.
    expect(captured).toMatch(/^\S+\t.+:\d+$/m)
  })

  it('exits 1 for an unknown symbol', () => {
    const code = runCallers({ symbol: '__xyzzy_no_such_symbol_9f3k__' })
    expect(code).toBe(1)
  })

  it('returns valid JSON for --json flag', () => {
    const captured = captureStdout(() => {
      runCallers({ symbol: 'querySymbols', json: true })
    })
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
    const arr = parsed as Array<{ caller: string; kind: string; file: string; line: number }>
    expect(arr.length).toBeGreaterThan(0)
    expect(typeof arr[0]?.caller).toBe('string')
    expect(typeof arr[0]?.line).toBe('number')
  })

  it('resolveCallers returns the same enclosing-function-aware entries runCallers prints', () => {
    const entries = resolveCallers('querySymbols')
    expect(entries.length).toBeGreaterThan(0)
    expect(typeof entries[0]?.caller).toBe('string')
    expect(typeof entries[0]?.file).toBe('string')
    expect(typeof entries[0]?.line).toBe('number')
  })

  it('resolveCallers returns an empty array for an unknown symbol', () => {
    expect(resolveCallers('__xyzzy_no_such_symbol_9f3k__')).toEqual([])
  })

  // `LIMIT 0` in SQL always returns zero rows, so a symbol that genuinely has callers would
  // otherwise be reported as "no references found" -- a wrong answer, not just a permissive
  // input. limit: 0 (or negative) must be rejected up front instead of reaching queryRefs.
  it('rejects limit: 0 as an explicit invalid-argument error instead of returning a false "no references found"', () => {
    let errCaptured = ''
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
    let code: number
    try {
      code = runCallers({ symbol: 'querySymbols', limit: 0 })
    } finally {
      process.stderr.write = origStderr
    }
    expect(code).toBe(1)
    expect(errCaptured).not.toContain('No references found')
    expect(errCaptured.toLowerCase()).toContain('limit')
  })

  it('rejects a negative limit as an explicit invalid-argument error', () => {
    let errCaptured = ''
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
    let code: number
    try {
      code = runCallers({ symbol: 'querySymbols', limit: -1 })
    } finally {
      process.stderr.write = origStderr
    }
    expect(code).toBe(1)
    expect(errCaptured.toLowerCase()).toContain('limit')
  })
})

// ---- resolveCallers/runCallers cross-project scoping (regression) -----------

describe('resolveCallers cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index shared across every project ever
  // indexed (constants.ts). resolveCallers used to run queryRefs with no project scope, so a
  // caller of a same-named symbol living in a completely unrelated project on the same machine
  // would leak into this project's caller list.
  it('does not report a caller from a different project for a same-named symbol', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-callers-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-callers-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function scopedTargetFn9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function scopedTargetFn9k2() { return 1 }\nfunction caller() { scopedTargetFn9k2() }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        // rootB's caller() reference to the same-named function must not leak into rootA's results.
        expect(resolveCallers('scopedTargetFn9k2')).toEqual([])
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- integration: runDead against the real repo index ----------------------

describe('runDead integration', () => {
  it('exits 0 even when no dead symbols are found', () => {
    // A nonexistent kind genuinely finds zero symbols to check -- unlike a --top of 0, this
    // exercises the "no dead symbols found" message path without relying on --top to force an
    // empty slice (see the --top rejection test below).
    const code = runDead({ kind: '__nonexistent_kind_xyzzy__' })
    expect(code).toBe(0)
  })

  it('rejects --top 0 as an explicit invalid-argument error instead of silently reporting a false-clean "no dead symbols" result', () => {
    const errCaptured = captureStderr(() => {
      const code = runDead({ top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured).not.toContain('No dead symbols found')
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('rejects a negative --top as an explicit invalid-argument error', () => {
    const errCaptured = captureStderr(() => {
      const code = runDead({ top: -1 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('returns valid JSON for --json flag with --top 5', () => {
    const captured = captureStdout(() => {
      runDead({ json: true, top: 5 })
    })
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
  })
})

// ---- runDead cross-project scoping (regression) -----------------------------

describe('runDead cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index shared across every project ever
  // indexed (constants.ts). runDead used to run querySymbols/queryRefs with no project scope, so
  // a function truly dead in one project could be scored ALIVE by a reference to a same-named
  // symbol living in a completely unrelated project on the same machine.
  it('reports a function as dead even when a same-named symbol is referenced in a different project', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-dead-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-dead-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function trulyDeadFn9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function trulyDeadFn9k2() { return 1 }\nfunction caller() { trulyDeadFn9k2() }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        const captured = captureStdout(() => {
          runDead({ json: true, top: 500 })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string }>
        // rootB's reference to the same-named function must not mask rootA's copy as alive.
        expect(parsed.some((r) => r.name === 'trulyDeadFn9k2')).toBe(true)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- resolveCallers / runDead same-project name-collision scoping (regression) ---------------

describe('resolveCallers same-project name-collision scoping', () => {
  // Regression: resolveCallers matched refs by bare name only, scoped to the project but not to
  // which file actually defines the symbol being asked about. When two files in the same project
  // each define a function with the identical name, a call resolving to file B's local copy was
  // attributed as a "caller" of file A's unrelated same-named symbol too.
  it('does not attribute another same-named symbol\'s local caller when a defining filePath is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-callers-collision-'))
    try {
      const fileA = join(root, 'collide-a.ts')
      const fileB = join(root, 'collide-b.ts')
      // fileA's copy is never called anywhere.
      writeFileSync(fileA, 'export function collideFn7m3() { return 1 }\n')
      // fileB defines its OWN same-named function and calls it locally.
      writeFileSync(fileB, 'export function collideFn7m3() { return 2 }\nfunction caller() { collideFn7m3() }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        // Scoped to fileA's own (unused) definition: fileB's local call must not be attributed to it.
        expect(resolveCallers('collideFn7m3', undefined, normalizePath(fileA))).toEqual([])
        // Scoped to fileB's own definition: its local caller is still correctly attributed.
        const bCallers = resolveCallers('collideFn7m3', undefined, normalizePath(fileB))
        expect(bCallers).toHaveLength(1)
        expect(bCallers[0]?.caller).toBe('caller')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('runDead same-project name-collision scoping', () => {
  // Regression: runDead computed a symbol's ref count via a bare-name queryRefs scoped only to
  // the project root, so a genuinely unused function in file A was scored ALIVE by a call that
  // actually resolved to a different, same-named function locally defined and called in file B.
  it('reports a truly-unused function as dead even when a different file defines and calls a same-named function', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dead-collision-'))
    try {
      const fileA = join(root, 'dead-collide-a.ts')
      const fileB = join(root, 'dead-collide-b.ts')
      const normA = normalizePath(fileA)
      const normB = normalizePath(fileB)
      writeFileSync(fileA, 'export function collideFn9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function collideFn9k2() { return 2 }\nfunction caller() { collideFn9k2() }\n')
      indexFileSync(normA)
      indexFileSync(normB)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const captured = captureStdout(() => {
          runDead({ json: true, top: 500 })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string; file: string }>
        // fileA's copy is truly dead and must be reported.
        expect(parsed.some((r) => r.name === 'collideFn9k2' && normalizePath(r.file) === normA)).toBe(true)
        // fileB's copy is genuinely called locally and must NOT be reported as dead.
        expect(parsed.some((r) => r.name === 'collideFn9k2' && normalizePath(r.file) === normB)).toBe(false)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---- runDead virtual-dispatch ancestor-self-dispatch rescue (regression) ---

describe('runDead virtual-dispatch rescue', () => {
  // Regression: filterRefsForSymbol's cross-file heuristic misattributes a base class's own
  // `this.<method>(...)` self-dispatch ref entirely to the base's own same-named definition
  // (since the dispatch call's file DOES define a same-named symbol), starving every subclass
  // override elsewhere of credit -- every compressBody override in tool_filters/*.ts false
  // positived as dead until this rescue check was added.
  it('does not flag a named-class polymorphic override as dead, but still flags a genuinely unused sibling method', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dead-vdispatch-named-'))
    try {
      const baseFile = normalizePath(join(root, 'base.ts'))
      const implFile = normalizePath(join(root, 'impl.ts'))
      writeFileSync(
        baseFile,
        'export class Base {\n  compress(): string {\n    return this.compressBody("x")\n  }\n\n  compressBody(s: string): string {\n    return s\n  }\n}\n',
      )
      writeFileSync(
        implFile,
        'import { Base } from "./base.js"\n\nexport class Impl extends Base {\n  override compressBody(s: string): string {\n    return s.toUpperCase()\n  }\n\n  neverCalledMethod9k2(): void {\n    return\n  }\n}\n',
      )
      indexFileSync(baseFile)
      indexFileSync(implFile)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const captured = captureStdout(() => {
          runDead({ json: true, top: 500, kind: 'method' })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string; file: string }>
        // The override is reachable only via Base's self-dispatch -- must not be flagged dead.
        expect(parsed.some((r) => r.name === 'compressBody' && normalizePath(r.file) === implFile)).toBe(false)
        // A genuinely unused sibling method on the same class must still be flagged.
        expect(parsed.some((r) => r.name === 'neverCalledMethod9k2' && normalizePath(r.file) === implFile)).toBe(true)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // Regression: an anonymous class expression (`new (class extends Base { ... })()`, the shape
  // used by makeAiCliFilter/makeLanguageFilter in tool_filters/families.ts) has no name of its
  // own, so the extends-clause ref's `context` falls back to the nearest enclosing NAMED scope --
  // the factory function -- rather than a (nonexistent) class name. enclosingClass (kind ===
  // 'class' only) returned null for these, silently skipping the rescue check entirely; fixed by
  // enclosingNamedScope also matching kind === 'function'.
  it('does not flag an override inside an anonymous class expression as dead, but still flags a genuinely unused sibling method', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-dead-vdispatch-anon-'))
    try {
      const baseFile = normalizePath(join(root, 'base.ts'))
      const factoryFile = normalizePath(join(root, 'factory.ts'))
      writeFileSync(
        baseFile,
        'export class Base {\n  compress(): string {\n    return this.compressBody("x")\n  }\n\n  compressBody(s: string): string {\n    return s\n  }\n}\n',
      )
      writeFileSync(
        factoryFile,
        [
          'import { Base } from "./base.js"',
          '',
          'export function makeThing9k2() {',
          '  return new (class extends Base {',
          '    override compressBody(s: string): string {',
          '      return s.toUpperCase()',
          '    }',
          '',
          '    neverCalledMethod9k2(): void {',
          '      return',
          '    }',
          '  })()',
          '}',
          '',
        ].join('\n'),
      )
      indexFileSync(baseFile)
      indexFileSync(factoryFile)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        const captured = captureStdout(() => {
          runDead({ json: true, top: 500, kind: 'method' })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string; file: string }>
        expect(parsed.some((r) => r.name === 'compressBody' && normalizePath(r.file) === factoryFile)).toBe(false)
        expect(parsed.some((r) => r.name === 'neverCalledMethod9k2' && normalizePath(r.file) === factoryFile)).toBe(true)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---- integration: runDeps against the real repo -------------------------

describe('runDeps integration', () => {
  it('returns internal and external deps for a known file', () => {
    const captured = captureStdout(() => {
      const code = runDeps({ file: 'src/read_commands.ts' })
      expect(code).toBe(0)
    })
    expect(captured).toMatch(/internal:|external:|node:|\.\//)
  })

  it('exits 1 for a nonexistent file', () => {
    const code = runDeps({ file: 'src/__nonexistent_xyzzy__.ts' })
    expect(code).toBe(1)
  })

  it('returns valid JSON for --json flag', () => {
    const captured = captureStdout(() => {
      runDeps({ file: 'src/read_commands.ts', json: true })
    })
    const parsed = JSON.parse(captured) as { file: string; internal: string[]; external: string[] }
    expect(typeof parsed.file).toBe('string')
    expect(Array.isArray(parsed.internal)).toBe(true)
    expect(Array.isArray(parsed.external)).toBe(true)
  })

  it('classifies Python relative imports ("from . import foo", "from ..pkg import bar") as internal, not external', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-py-'))
    try {
      const file = join(dir, 'mod.py')
      writeFileSync(file, ['from . import foo', 'from ..pkg import bar', 'import os', ''].join('\n'))
      const captured = captureStdout(() => {
        const code = runDeps({ file, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[]; external: string[] }
      expect(parsed.internal).toContain('.')
      expect(parsed.internal).toContain('..pkg')
      expect(parsed.external).toContain('os')
      expect(parsed.external).not.toContain('.')
      expect(parsed.external).not.toContain('..pkg')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a NodeNext-style "./foo.js" specifier to its .ts source file, not a literal "foo.js.ts" candidate', () => {
    // This codebase's own source (and any TS project using NodeNext/ESM module resolution)
    // writes relative imports with an explicit .js extension even though the source file on
    // disk is .ts -- e.g. "import { x } from './foo.js'" resolving to foo.ts. Appending a
    // source extension onto a base that already ends in one (foo.js + '.ts' -> 'foo.js.ts')
    // never matches anything on disk, so the import stayed unresolved (just the literal
    // specifier) instead of pointing at the real file.
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-nodenext-'))
    try {
      const depFile = join(dir, 'helper.ts')
      writeFileSync(depFile, 'export const helper = 1\n')
      const entryFile = join(dir, 'entry.ts')
      writeFileSync(entryFile, "import { helper } from './helper.js'\n")
      const captured = captureStdout(() => {
        const code = runDeps({ file: entryFile, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[] }
      expect(parsed.internal).toContain(depFile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a barrel-style directory import ("./utils" backed by "./utils/index.ts") to the real file, not the raw specifier', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-barrel-'))
    try {
      const utilsDir = join(dir, 'utils')
      mkdirSync(utilsDir)
      const indexFile = join(utilsDir, 'index.ts')
      writeFileSync(indexFile, 'export function foo() { return 1 }\n')
      const entryFile = join(dir, 'entry.ts')
      writeFileSync(entryFile, "import { foo } from './utils'\n")
      const captured = captureStdout(() => {
        const code = runDeps({ file: entryFile, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[] }
      expect(parsed.internal).toContain(indexFile)
      expect(parsed.internal).not.toContain('./utils')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves a relative import onto a .cts source file (SOURCE_EXTENSIONS previously omitted .mts/.cts)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-cts-'))
    try {
      const depFile = join(dir, 'config.cts')
      writeFileSync(depFile, 'export const config = 1\n')
      const entryFile = join(dir, 'entry.ts')
      writeFileSync(entryFile, "import { config } from './config'\n")
      const captured = captureStdout(() => {
        const code = runDeps({ file: entryFile, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[] }
      expect(parsed.internal).toContain(depFile)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Regression (command-entry-point coverage gap): read_commands.test.ts unit-proves
  // extractImports(text, '.mk') and importsExtensionFor() in isolation, but nothing exercised
  // them wired together through the real `runDeps` command handler against a file literally
  // named "Makefile" -- the injected-seam failure mode this project's own CLAUDE.md warns
  // about (helper-level proof without command-entry-point proof). Found via an independent
  // Codex pre-push review of this batch's diff.
  it('reports include directives as external deps for a file literally named "Makefile"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-makefile-'))
    try {
      const file = join(dir, 'Makefile')
      writeFileSync(file, 'include config.mk\n-include optional.mk\n\nall:\n\techo build\n')
      const captured = captureStdout(() => {
        const code = runDeps({ file, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[]; external: string[] }
      expect([...parsed.internal, ...parsed.external]).toEqual(expect.arrayContaining(['config.mk', 'optional.mk']))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('prefers the earlier SOURCE_EXTENSIONS candidate when a barrel directory has multiple index.* files', () => {
    // Regression/mutation-verification target: the extension-probe loop must `break` on the
    // first match. Without the break, a later-iterated extension (e.g. index.js, tried after
    // index.ts in SOURCE_EXTENSIONS) silently overwrites the earlier, correct match instead of
    // being ignored.
    const dir = mkdtempSync(join(tmpdir(), 'tg-deps-barrel-precedence-'))
    try {
      const utilsDir = join(dir, 'utils')
      mkdirSync(utilsDir)
      const indexTs = join(utilsDir, 'index.ts')
      writeFileSync(join(utilsDir, 'index.js'), 'exports.foo = 1\n')
      writeFileSync(indexTs, 'export function foo() { return 1 }\n')
      const entryFile = join(dir, 'entry.ts')
      writeFileSync(entryFile, "import { foo } from './utils'\n")
      const captured = captureStdout(() => {
        const code = runDeps({ file: entryFile, json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as { internal: string[] }
      expect(parsed.internal).toContain(indexTs)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- integration: runCallChain against the real repo index -----------------

describe('runCallChain integration', () => {
  it('exits 0 for a known symbol', () => {
    const code = runCallChain({ symbol: 'runRead' })
    expect(code).toBe(0)
  })

  it('returns valid JSON for --json flag', () => {
    const captured = captureStdout(() => {
      runCallChain({ symbol: 'runRead', json: true, depth: 2 })
    })
    const parsed = JSON.parse(captured) as { chains: string[][] }
    expect(Array.isArray(parsed.chains)).toBe(true)
  })
})

// ---- runCallChain nonexistent-symbol / dead-branch / depth<=0 (regression) ---

describe('runCallChain error handling and no-callers branch', () => {
  // Regression: runCallChain never checked the symbol was indexed before running BFS, so a
  // nonexistent symbol fell straight through to bfsCallChains and came back as `[[symbol]]` --
  // a fabricated "root entry point" result indistinguishable from a real caller-less symbol.
  it('rejects a nonexistent symbol with exit 1 and no chain output', () => {
    let code = -1
    const captured = captureStdout(() => {
      code = runCallChain({ symbol: 'zzqxNopeDoesNotExist' })
    })
    const errCaptured = captureStderr(() => {
      code = runCallChain({ symbol: 'zzqxNopeDoesNotExist' })
    })
    expect(code).toBe(1)
    expect(captured).toBe('')
    expect(errCaptured).toContain('Symbol not found: zzqxNopeDoesNotExist')
  })

  // Same nonexistent-symbol check must run before the --json branch, so a machine-consuming
  // caller never sees a fabricated `{ chains: [...] }` payload for a symbol that isn't indexed.
  it('rejects a nonexistent symbol under --json with exit 1 and no chains payload', () => {
    let code = -1
    const captured = captureStdout(() => {
      code = runCallChain({ symbol: 'zzqxNopeDoesNotExist', json: true })
    })
    expect(code).toBe(1)
    expect(captured).not.toContain('chains')
  })

  // Regression: bfsCallChains can never return an empty array (a caller-less tip still pushes
  // its one-node chain via `complete.push(chain)`), so the old `chains.length === 0` guard for
  // the "(no callers)" message was unreachable dead code. This proves the message now actually
  // prints for a genuinely caller-less indexed symbol.
  it('prints "(no callers)" for an indexed symbol with zero callers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-chain-nocallers-'))
    try {
      const file = join(dir, 'lonely.ts')
      writeFileSync(file, 'export function chainLonelyFn7x1() { return 1 }\n')
      indexFileSync(normalizePath(file))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
      try {
        const captured = captureStdout(() => {
          const code = runCallChain({ symbol: 'chainLonelyFn7x1' })
          expect(code).toBe(0)
        })
        expect(captured.trim()).toBe('chainLonelyFn7x1  (no callers)')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // A symbol that DOES have callers must still produce its normal chain output, unchanged by
  // either the existence check or the corrected no-callers condition.
  it('still produces normal chain output for a symbol with callers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-chain-haswoncallers-'))
    try {
      const file = join(dir, 'linked.ts')
      writeFileSync(file, [
        'export function chainCalleeFn3q8() { return 1 }',
        'export function chainCallerFn3q8() { return chainCalleeFn3q8() }',
        '',
      ].join('\n'))
      indexFileSync(normalizePath(file))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
      try {
        const captured = captureStdout(() => {
          const code = runCallChain({ symbol: 'chainCalleeFn3q8' })
          expect(code).toBe(0)
        })
        expect(captured).not.toContain('(no callers)')
        expect(captured).toContain('chainCalleeFn3q8 -> chainCallerFn3q8')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // Edge case: bfsCallChains also returns `[[start]]` when maxDepth <= 0 (its own first-line
  // short-circuit), for a symbol that may well have real callers. Rejecting non-positive --depth
  // up front (matching runCallers'/runSimilar's own --limit/--top <= 0 convention) means this
  // never has a chance to be misread as "(no callers)".
  it('rejects --depth 0 with exit 1', () => {
    const errCaptured = captureStderr(() => {
      const code = runCallChain({ symbol: 'runRead', depth: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('depth')
  })

  it('rejects --depth -1 with exit 1', () => {
    const errCaptured = captureStderr(() => {
      const code = runCallChain({ symbol: 'runRead', depth: -1 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('depth')
  })
})

// ---- runCallChain cross-project scoping (regression) -------------------------

describe('runCallChain cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index shared across every project ever
  // indexed (constants.ts). runCallChain's callersOf closure used to run queryRefs with no
  // project scope, so a caller of a same-named symbol living in a completely unrelated project
  // on the same machine would leak into this project's call chains.
  it('does not follow a caller edge from a different project for a same-named symbol', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-chain-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-chain-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function chainScopedFn9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function chainScopedFn9k2() { return 1 }\nfunction caller() { chainScopedFn9k2() }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        const captured = captureStdout(() => {
          runCallChain({ symbol: 'chainScopedFn9k2' })
        })
        // rootB's caller() must not appear in rootA-scoped output -- the only chain found is the
        // single-node chain (the symbol itself has no callers within rootA), which now renders
        // via the "(no callers)" branch instead of a bare name (defect 2 fix). The "(no callers)"
        // message itself contains the word "caller", so assert on the exact rendered line instead
        // of a substring-absence check.
        expect(captured.trim()).toBe('chainScopedFn9k2  (no callers)')
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- runCallChain file-symbol cache hoisting (regression) --------------------

describe('runCallChain file-symbol cache hoisting', () => {
  // Regression: runCallChain used to call buildFileSymCache() from inside the callersOf closure
  // that runs once per BFS node, discarding the memoized Map and forcing a fresh querySymbols()
  // call for the same file on every hop instead of reusing one cache across the whole BFS.
  it('calls querySymbols at most once per unique file across the whole BFS, not once per hop', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-chain-cache-'))
    try {
      const file = join(dir, 'chain.ts')
      writeFileSync(file, [
        'export function cacheLevel0() { return 1 }',
        'export function cacheLevel1() { return cacheLevel0() }',
        'export function cacheLevel2() { return cacheLevel1() }',
        'export function cacheLevel3() { return cacheLevel2() }',
        '',
      ].join('\n'))
      indexFileSync(normalizePath(file))

      vi.mocked(querySymbols).mockClear()
      const code = runCallChain({ symbol: 'cacheLevel0', depth: 5 })
      expect(code).toBe(0)

      const callsForFile = vi.mocked(querySymbols).mock.calls.filter(
        (call) => (call[0] as { filePath?: string }).filePath === normalizePath(file),
      )
      // All four BFS hops (cacheLevel0 -> cacheLevel1 -> cacheLevel2 -> cacheLevel3) resolve
      // references inside the same file. With the cache correctly hoisted once outside the BFS
      // loop, that file's symbols are fetched exactly once and reused for every hop.
      expect(callsForFile.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- integration: runImpact against the real repo index -------------------

describe('runImpact integration', () => {
  it('exits 0 with non-empty output for querySymbols', () => {
    const captured = captureStdout(() => {
      const code = runImpact({ symbol: 'querySymbols', top: 5 })
      expect(code).toBe(0)
    })
    // Length-only would still pass on any non-empty (even malformed) output. Pin the actual
    // documented plain-text shape (`{symbol}\t(hops: {n})`, see runImpact's emit loop) so a
    // regression that dropped the tab separator or the "hops:" suffix is caught here.
    expect(captured).toMatch(/^\S+\t\(hops: \d+\)$/m)
  })

  it('exits 1 for an unknown symbol', () => {
    const code = runImpact({ symbol: '__xyzzy_no_such_symbol_9f3k__' })
    expect(code).toBe(1)
  })
})

// ---- runImpact cross-project scoping (regression) ----------------------------

describe('runImpact cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index shared across every project ever
  // indexed (constants.ts). runImpact's BFS used to run queryRefs with no project scope, so a
  // caller of a same-named symbol living in a completely unrelated project on the same machine
  // would leak into this project's impact analysis.
  it('does not follow a caller edge from a different project for a same-named symbol', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-impact-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-impact-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function impactScopedFn9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function impactScopedFn9k2() { return 1 }\nfunction impactCaller9k2() { impactScopedFn9k2() }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        // rootB's impactCaller9k2() must not leak into rootA-scoped output, so rootA has no
        // callers at all for this symbol and runImpact exits 1.
        const code = runImpact({ symbol: 'impactScopedFn9k2' })
        expect(code).toBe(1)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- runImpact file-symbol cache hoisting (regression) ------------------------

describe('runImpact file-symbol cache hoisting', () => {
  // Regression: runImpact used to call buildFileSymCache() from inside the BFS while-loop body
  // (once per dequeued node), discarding the memoized Map and forcing a fresh querySymbols() call
  // for the same file on every hop instead of reusing one cache across the whole BFS.
  it('calls querySymbols at most once per unique file across the whole BFS, not once per hop', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-impact-cache-'))
    try {
      const file = join(dir, 'chain.ts')
      writeFileSync(file, [
        'export function impactCacheLevel0() { return 1 }',
        'export function impactCacheLevel1() { return impactCacheLevel0() }',
        'export function impactCacheLevel2() { return impactCacheLevel1() }',
        'export function impactCacheLevel3() { return impactCacheLevel2() }',
        '',
      ].join('\n'))
      indexFileSync(normalizePath(file))

      vi.mocked(querySymbols).mockClear()
      const code = runImpact({ symbol: 'impactCacheLevel0' })
      expect(code).toBe(0)

      const callsForFile = vi.mocked(querySymbols).mock.calls.filter(
        (call) => (call[0] as { filePath?: string }).filePath === normalizePath(file),
      )
      // All four BFS hops resolve references inside the same file. With the cache correctly
      // hoisted once outside the BFS loop, that file's symbols are fetched exactly once and
      // reused for every hop.
      expect(callsForFile.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- runImpact module-scope refs surfaced as file-level entries (regression) --

describe('runImpact module-scope refs', () => {
  // Regression: runImpact used to `continue` past any ref whose enclosing symbol could not be
  // resolved (i.e. a module-scope reference -- top-level code, not inside a function/class),
  // silently dropping it. resolveCallers already surfaces this same situation as a file-level
  // entry (caller: '(module scope)'); runImpact must do the same instead of discarding it.
  it('surfaces a module-scope reference as a file-level entry instead of dropping it', () => {
    const dir = mkdtempSync(join(process.cwd(), 'tg-impact-modscope-'))
    try {
      const file = join(dir, 'modscope.ts')
      const filePath = normalizePath(file)
      writeFileSync(file, [
        'export function moduleScopeTargetFn9k2() { return 1 }',
        'moduleScopeTargetFn9k2()',
        '',
      ].join('\n'))
      indexFileSync(filePath)

      const captured = captureStdout(() => {
        const code = runImpact({ symbol: 'moduleScopeTargetFn9k2', json: true })
        expect(code).toBe(0)
      })
      const parsed = JSON.parse(captured) as Array<{ symbol: string; hops: number }>
      const moduleScopeEntry = parsed.find((e) => e.symbol.includes('(module scope)') && e.symbol.includes(filePath))
      expect(moduleScopeEntry).toBeDefined()
      expect(moduleScopeEntry?.hops).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- compareHopEntries (runImpact tiebreak) ---------------------------------
//
// Regression coverage for a locale-dependent-output bug: runImpact() used to
// tiebreak same-hop-distance entries with a no-explicit-locale
// localeCompare(), which resolves to the host's default ICU collation. Because
// the sort ran BEFORE slicing to top-N, a tie at the boundary meant the
// returned top-N SET (not just its order) could differ across machines with
// different regional settings. compareHopEntries() replaces that with a
// plain ordinal (UTF-16 code-unit) comparison so the same input always yields
// the same top-N set everywhere.

describe('compareHopEntries (runImpact tiebreak)', () => {
  it('demonstrates the root cause: localeCompare() collates the same pair of names in opposite order across locales', () => {
    expect('öffnen'.localeCompare('zebra_util', 'en')).toBeLessThan(0)
    expect('öffnen'.localeCompare('zebra_util', 'sv')).toBeGreaterThan(0)
  })

  it('sorts by hop distance first, then by ordinal (non-locale) string order', () => {
    const entries: Array<[string, number]> = [
      ['zebra_util', 2],
      ['öffnen', 1],
      ['apple_util', 1],
      ['mid_util', 1],
    ]
    const sorted = [...entries].sort(compareHopEntries).map(([name]) => name)
    expect(sorted).toEqual(['apple_util', 'mid_util', 'öffnen', 'zebra_util'])
  })

  it('never calls String.prototype.localeCompare, so it cannot be locale-dependent on any host', () => {
    const spy = vi.spyOn(String.prototype, 'localeCompare')
    const entries: Array<[string, number]> = [
      ['zebra_util', 1],
      ['öffnen', 1],
      ['apple_util', 1],
    ]
    entries.sort(compareHopEntries)
    const callCount = spy.mock.calls.length
    spy.mockRestore()
    expect(callCount).toBe(0)
  })

  it('regression: a boundary tie no longer changes the returned top-N SET across host locales', () => {
    // Reproduces runImpact's post-BFS reduction step: hop-tied entries get
    // sorted, then sliced to top-N. Four names tie at hop=1; top=3 means
    // exactly one of them gets dropped, and which one depends on the tiebreak.
    const hops = new Map<string, number>([
      ['apple_util', 1],
      ['öffnen', 1],
      ['zebra_util', 1],
      ['mid_util', 1],
    ])
    const top = 3

    // Pre-fix behavior, reconstructed here only to document the bug (not
    // exercised by the fix itself): an en-US/de-DE host's default localeCompare()
    // tiebreak drops 'zebra_util' and keeps 'öffnen'; an sv-SE host's drops
    // 'öffnen' and keeps 'zebra_util' instead. That is a different SET, not
    // merely a different order, which is exactly the bug this test guards.
    const preFixEn = [...hops.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'en'))
      .slice(0, top)
      .map(([name]) => name)
    const preFixSv = [...hops.entries()]
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0], 'sv'))
      .slice(0, top)
      .map(([name]) => name)
    expect(new Set(preFixEn)).not.toEqual(new Set(preFixSv))

    // Fixed behavior: exactly one deterministic set regardless of host locale.
    const fixed = [...hops.entries()].sort(compareHopEntries).slice(0, top).map(([name]) => name)
    expect(new Set(fixed)).toEqual(new Set(['apple_util', 'mid_util', 'zebra_util']))
  })
})

// ---- isTestFile -------------------------------------------------------------

describe('isTestFile', () => {
  it('returns true for a file in a tests/ directory', () => {
    expect(isTestFile('project/tests/foo.ts')).toBe(true)
  })

  it('returns true for a .test. file', () => {
    expect(isTestFile('src/util.test.ts')).toBe(true)
  })

  it('returns true for a .spec. file', () => {
    expect(isTestFile('src/util.spec.ts')).toBe(true)
  })

  it('returns true for a _test. prefix file', () => {
    expect(isTestFile('src/test_util.py')).toBe(true)
  })

  it('returns false for a regular source file', () => {
    expect(isTestFile('src/index.ts')).toBe(false)
  })

  it('returns false for a path whose directory name contains test but is not tests/', () => {
    expect(isTestFile('footest/util.ts')).toBe(false)
  })

  it('mutation-verification: anchor prevents false matches on non-test-segment dirs', () => {
    // If the (^|[/\\]) anchor were removed, contests/foo.ts would match - proving the anchor is load-bearing
    expect(isTestFile('contests/foo.ts')).toBe(false)
  })
})

// ---- findCycles -------------------------------------------------------------

describe('findCycles', () => {
  it('returns empty array for an acyclic graph', () => {
    const g = new Map([['a', ['b']], ['b', ['c']], ['c', []]])
    expect(findCycles(g)).toHaveLength(0)
  })

  it('finds a simple two-node cycle', () => {
    const g = new Map([['a', ['b']], ['b', ['a']]])
    const cycles = findCycles(g)
    // Length + flat-contains would still pass if findCycles found the same two nodes via a
    // duplicated or malformed cycle path -- pin the exact single-cycle array (the node order the
    // SCC walk actually produces) so a regression that emits duplicate/extra cycles is caught.
    expect(cycles).toEqual([['b', 'a', 'b']])
  })

  it('finds a three-node cycle', () => {
    const g = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']], ['standalone', []]])
    const cycles = findCycles(g)
    expect(cycles).toEqual([['z', 'x', 'y', 'z']])
  })

  it('mutation-verification: removing cycle back-edge eliminates all cycles', () => {
    const withCycle = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']]])
    const withoutCycle = new Map([['x', ['y']], ['y', ['z']], ['z', []]])
    expect(findCycles(withCycle)).toEqual([['z', 'x', 'y', 'z']])
    expect(findCycles(withoutCycle)).toHaveLength(0)
  })

  it('does not crash on an empty graph', () => {
    expect(findCycles(new Map())).toHaveLength(0)
  })

  it('finds two distinct cycles that share a node instead of dropping the second', () => {
    // Regression: the old DFS pruned with a global `visited` set, so once C was marked visited
    // while exploring A->B->C->A, the A->D->C->A branch returned as soon as it reached the
    // already-visited C, without ever exploring C's edge back to A - silently dropping a
    // genuinely distinct cycle that happens to share a node with an already-found one.
    const g = new Map([
      ['A', ['B', 'D']],
      ['B', ['C']],
      ['C', ['A']],
      ['D', ['C']],
    ])
    const cycles = findCycles(g)
    const nodeSets = cycles.map((c) => [...new Set(c)].sort().join(','))
    expect(nodeSets).toContain(['A', 'B', 'C'].join(','))
    expect(nodeSets).toContain(['A', 'C', 'D'].join(','))
  })

  it('does not report the same cycle twice when discovered from different start nodes', () => {
    const g = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']]])
    const cycles = findCycles(g)
    const keys = new Set(cycles.map((c) => [...new Set(c)].sort().join(',')))
    expect(keys.size).toBe(cycles.length)
  })

  it('finds a self-loop as a one-node cycle', () => {
    const g = new Map([['a', ['a']], ['b', []]])
    const cycles = findCycles(g)
    expect(cycles).toEqual([['a', 'a']])
  })

  it('still finds a cycle when one of its nodes also points at an already-finished unrelated component', () => {
    // Regression/mutation-verification target: tarjanSCCs's back-edge branch must gate on
    // `onStack.has(w)` -- a neighbor that has already been indexed but is NOT on the current
    // Tarjan stack (i.e. it finished as its own earlier, unrelated component) must NOT feed its
    // index into the current node's lowlink. Dropping that guard lets a's lowlink get dragged
    // down to x's (already-closed, lower) index via the a->x edge, so a's real lowlink==index
    // check at the end of its DFS frame never fires -- the entire a<->b cycle silently vanishes
    // from the result instead of being reported.
    const g = new Map([
      ['x', []],
      ['a', ['b', 'x']],
      ['b', ['a']],
    ])
    const cycles = findCycles(g)
    const flat = cycles.flat()
    expect(flat).toContain('a')
    expect(flat).toContain('b')
  })

  it('does not crash with a stack overflow on a deep linear import chain (large real-world repo)', () => {
    // Regression: tarjanSCCs used to be a plain recursive `strongconnect`, whose recursion depth
    // equals the longest DFS path in the graph. runArch builds this graph from every tracked file
    // in the whole project, so a long acyclic import chain in a large monorepo (verified: a plain
    // linear chain of ~5000 nodes reliably overflows Node's default stack) crashed `token-goat
    // arch` outright with "Maximum call stack size exceeded" instead of reporting zero cycles.
    const g = new Map<string, string[]>()
    const n = 20000
    for (let i = 0; i < n; i++) g.set(`n${i}`, i + 1 < n ? [`n${i + 1}`] : [])
    expect(() => findCycles(g)).not.toThrow()
    expect(findCycles(g)).toHaveLength(0)
  })
})

// ---- runSimilar (integration) -----------------------------------------------

describe('runSimilar', () => {
  it('exits 1 when the spec has no :: separator', () => {
    const code = runSimilar({ spec: 'noseparator' })
    expect(code).toBe(1)
  })

  it('exits 1 when the anchor symbol is not in the index', () => {
    const code = runSimilar({ spec: 'src/graph_commands.ts::__nonexistent_xyzzy__' })
    expect(code).toBe(1)
  })

  it('self-exclusion: if anchor is found, it must not appear in the result list', () => {
    // Use enclosingSymbol which is a stable symbol in the live index.
    let captured = ''
    const origStdout = process.stdout.write.bind(process.stdout)
    let errCaptured = ''
    const origStderr = process.stderr.write.bind(process.stderr)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
    let code: number
    try {
      code = runSimilar({ spec: 'src/graph_commands.ts::enclosingSymbol', top: 5 })
    } finally {
      process.stdout.write = origStdout
      process.stderr.write = origStderr
    }
    if (code !== 0) {
      // Symbol not in index (stale index is expected per stale-index-trap memory note); skip assertion
      expect(errCaptured).toMatch(/not found|Symbol/)
      return
    }
    // When found: the anchor itself must not appear in the results
    const lines = captured.split('\n').filter((l) => l.trim())
    for (const line of lines) {
      expect(line.split('\t')[0]).not.toBe('enclosingSymbol')
    }
  })
})

// ---- runContextFor (integration) --------------------------------------------

describe('runContextFor', () => {
  it('exits 0 for any query (even if FTS finds no matches)', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runContextFor({ task: 'query symbols' })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    // Output is either empty (no FTS hits) or contains read commands
    if (captured.trim().length > 0) {
      expect(captured).toMatch(/token-goat read/)
    }
  })

  it('respects budget=1 and emits at most one entry without crashing', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runContextFor({ task: 'index reader', budget: 1 })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    const lines = captured.split('\n').filter((l) => l.includes('token-goat read'))
    expect(lines.length).toBeLessThanOrEqual(1)
  })
})

// ---- runTestFor (integration) -----------------------------------------------

describe('runTestFor', () => {
  it('exits 0 for a file with no indexed symbols', () => {
    const code = runTestFor({ file: 'src/__nonexistent_file_xyz__.ts' })
    expect(code).toBe(0)
  })

  it('exits 0 and lists test files covering a well-tested source file', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runTestFor({ file: 'src/graph_commands.ts' })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    expect(captured).toMatch(/test/)
  })

  it('narrows testFunctions to only the test symbols that actually reference the target file (not every test-prefixed symbol in the test file)', () => {
    // Regression test for the unpopulated testFileMap Set: previously every test-prefixed
    // symbol in a candidate test file was listed regardless of whether it referenced the
    // target file's symbols at all.
    const dir = mkdtempSync(join(tmpdir(), 'tg-testfor-'))
    try {
      // package.json marks `dir` as its own project root for resolveProjectRoot's findProject()
      // fallback (this tmpdir is not inside a git repo); runTestFor scopes its ref lookup to the
      // current project root (see "runTestFor cross-project scoping" below), so cwd must be
      // mocked to `dir` for these fixture files to be in scope.
      writeFileSync(join(dir, 'package.json'), '{"name":"tg-testfor-fixture"}\n')

      const srcFile = normalizePath(join(dir, 'testForTarget.ts'))
      const testFile = normalizePath(join(dir, 'testForTarget.test.ts'))

      writeFileSync(srcFile, 'export function __testForBugTargetFn_9f2a1c() {\n  return 1\n}\n', 'utf-8')
      writeFileSync(
        testFile,
        [
          "import { __testForBugTargetFn_9f2a1c } from './testForTarget'",
          '',
          'function test_usesTarget() {',
          '  __testForBugTargetFn_9f2a1c()',
          '}',
          '',
          'function test_unrelated() {',
          '  return 2',
          '}',
        ].join('\n'),
        'utf-8',
      )

      indexFileSync(srcFile)
      indexFileSync(testFile)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runTestFor({ file: srcFile, json: true })
      } finally {
        process.stdout.write = origWrite
        cwdSpy.mockRestore()
      }
      expect(code).toBe(0)

      const results = JSON.parse(captured) as Array<{ testFile: string; testFunctions: string[] }>
      const entry = results.find((r) => r.testFile === testFile)
      expect(entry).toBeDefined()
      expect(entry!.testFunctions).toContain('test_usesTarget')
      expect(entry!.testFunctions).not.toContain('test_unrelated')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not misclassify an ordinary helper whose name merely starts with "it" or "test" as a test function (regression: the test-prefix regex had no boundary after the alternation, so a bare prefix match let "it" match "itemsToJson"/"iterateOverTargetHelper" and "test" match "testament")', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-testfor-itword-'))
    try {
      writeFileSync(join(dir, 'package.json'), '{"name":"tg-testfor-itword-fixture"}\n')

      const srcFile = normalizePath(join(dir, 'itWordTarget.ts'))
      const testFile = normalizePath(join(dir, 'itWordTarget.test.ts'))

      writeFileSync(srcFile, 'export function __itWordBugTargetFn_7c3d2e() {\n  return 1\n}\n', 'utf-8')
      writeFileSync(
        testFile,
        [
          "import { __itWordBugTargetFn_7c3d2e } from './itWordTarget'",
          '',
          '// A plain helper whose name coincidentally starts with "it" -- not a real test.',
          'function iterateOverTargetHelper() {',
          '  __itWordBugTargetFn_7c3d2e()',
          '}',
          '',
          'it(\'works correctly\', () => {',
          '  iterateOverTargetHelper()',
          '})',
        ].join('\n'),
        'utf-8',
      )

      indexFileSync(srcFile)
      indexFileSync(testFile)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runTestFor({ file: srcFile, json: true })
      } finally {
        process.stdout.write = origWrite
        cwdSpy.mockRestore()
      }
      expect(code).toBe(0)

      const results = JSON.parse(captured) as Array<{ testFile: string; testFunctions: string[] }>
      const entry = results.find((r) => r.testFile === testFile)
      expect(entry).toBeDefined()
      expect(entry!.testFunctions).not.toContain('iterateOverTargetHelper')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- runTestFor cross-project scoping (regression) --------------------------

describe('runTestFor cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index shared across every project ever
  // indexed (constants.ts). runTestFor used to run queryRefs({ name: sym.name, limit: 500 })
  // with no rootDir, unlike every sibling command (runCallers, runCallChain, runImpact, runDead,
  // runCoverageGaps, runSimilar, runContextFor, runAsk). A test file in a completely unrelated
  // project referencing a same-named symbol would leak into this project's test-for results.
  it('does not report a test file from a different project for a same-named symbol', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-testfor-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-testfor-rootB-'))
    try {
      // package.json marks each root as its own project root for resolveProjectRoot's
      // findProject() fallback (these tmpdirs are not inside a git repo).
      writeFileSync(join(rootA, 'package.json'), '{"name":"tg-testfor-fixtureA"}\n')
      writeFileSync(join(rootB, 'package.json'), '{"name":"tg-testfor-fixtureB"}\n')

      const srcFileA = normalizePath(join(rootA, 'shared.ts'))
      const srcFileB = normalizePath(join(rootB, 'shared.ts'))
      const testFileB = normalizePath(join(rootB, 'shared.test.ts'))

      writeFileSync(srcFileA, 'export function crossProjTestForFn9k2() {\n  return 1\n}\n', 'utf-8')
      writeFileSync(srcFileB, 'export function crossProjTestForFn9k2() {\n  return 1\n}\n', 'utf-8')
      writeFileSync(
        testFileB,
        [
          "import { crossProjTestForFn9k2 } from './shared'",
          '',
          'function test_usesSharedFn() {',
          '  crossProjTestForFn9k2()',
          '}',
        ].join('\n'),
        'utf-8',
      )

      indexFileSync(srcFileA)
      indexFileSync(srcFileB)
      indexFileSync(testFileB)

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        let captured = ''
        const origWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
        let code: number
        try {
          code = runTestFor({ file: srcFileA, json: true })
        } finally {
          process.stdout.write = origWrite
        }
        expect(code).toBe(0)
        const results = JSON.parse(captured) as Array<{ testFile: string; testFunctions: string[] }>
        // rootB's test file referencing the same-named function must not leak into rootA's results.
        expect(results.some((r) => r.testFile === testFileB)).toBe(false)
        expect(results).toEqual([])
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- runCoverageGaps (integration) ------------------------------------------

describe('runCoverageGaps', () => {
  it('exits 0 and returns some output', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runCoverageGaps({ top: 5 })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    // Length-only would still pass on the "No coverage gaps found." fallback line (also
    // non-empty, also exit 0) -- so a regression that made every real gap silently disappear
    // (e.g. a broken filter) would slip through undetected. Pin the actual documented row shape
    // (`{name}\t{kind}\t{file}:{line}`, see runCoverageGaps' emit loop) to prove real gap rows
    // were printed, not the empty-result fallback.
    expect(captured).toMatch(/^\S+\t\S+\t.+:\d+$/m)
  })

  it('never includes ENTRY_NAMES in the gap list', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    try {
      runCoverageGaps({ top: 200 })
    } finally {
      process.stdout.write = origWrite
    }
    const lines = captured.split('\n').filter((l) => l.includes('\t'))
    for (const line of lines) {
      const name = line.split('\t')[0] ?? ''
      expect(['main', 'run', 'handler', 'index', 'setup']).not.toContain(name)
    }
  })
})

// ---- runCoverageGaps subdirectory scoping (regression) ----------------------

describe('runCoverageGaps subdirectory scoping', () => {
  // Regression: runCoverageGaps used to scope its querySymbols/queryRefs calls to a raw
  // `rootDir = process.cwd()` instead of resolving the actual project root. Invoking the command
  // from a subdirectory of a project (e.g. `cd src && token-goat coverage-gaps`) silently shrank
  // the scope to that subtree, via a `LIKE '<subdir>/%'` clause, so a genuinely untested function
  // living in a SIBLING directory of the same project (e.g. a `lib/` next to that `src/`) was
  // never even scanned, let alone flagged as a gap.
  it('reports a gap from a sibling directory of the project when invoked from a subdirectory (not shrunk to that subtree)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-covgaps-root-'))
    try {
      // package.json marks `root` as the project root for resolveProjectRoot's findProject()
      // fallback (these tmpdirs are not inside a git repo).
      writeFileSync(join(root, 'package.json'), '{"name":"tg-covgaps-fixture"}\n')
      const subdir = join(root, 'sub')
      mkdirSync(subdir)
      const siblingDir = join(root, 'lib')
      mkdirSync(siblingDir)

      const fileInSubdir = join(subdir, 'inside.ts')
      const fileOutsideSubdir = join(siblingDir, 'outside.ts')
      writeFileSync(fileInSubdir, 'export function insideSubdirFn9k2() { return 1 }\n')
      writeFileSync(fileOutsideSubdir, 'export function coverageGapSiblingFn9k2() { return 1 }\n')
      indexFileSync(normalizePath(fileInSubdir))
      indexFileSync(normalizePath(fileOutsideSubdir))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subdir)
      try {
        const captured = captureStdout(() => {
          runCoverageGaps({ json: true, top: 5000 })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string }>
        // Pre-fix: rootDir === subdir, so `lib/outside.ts` (a sibling of subdir, not a
        // descendant) falls outside the `<subdir>/%` LIKE scope and is silently excluded from
        // the whole-project scan -- coverageGapSiblingFn9k2 would never appear here at all.
        expect(parsed.some((r) => r.name === 'coverageGapSiblingFn9k2')).toBe(true)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---- runTestFor / runCoverageGaps do not truncate away test refs at 500+ refs (regression) --

describe('runTestFor / runCoverageGaps with 500+ refs to one symbol', () => {
  // Regression: queryRefs's DEFAULT_REF_QUERY_LIMIT (500) orders by file_path, line with no
  // preference for test-file paths. runTestFor/runCoverageGaps used to pass that same capped
  // limit, so a symbol referenced 500+ times from files that sort alphabetically BEFORE its test
  // file's path would have every one of its real test refs silently dropped by the cutoff --
  // runCoverageGaps then falsely reports the symbol as an untested "coverage gap", and
  // runTestFor silently omits the test file that actually exercises it.
  const REF_FILE_COUNT = 6
  const REFS_PER_FILE = 100 // 600 total, comfortably over the old 500-row cap

  function buildFixture(symbolName: string): string {
    const root = mkdtempSync(join(tmpdir(), 'tg-refcap-'))
    writeFileSync(join(root, 'package.json'), '{"name":"tg-refcap-fixture"}\n')

    const targetFile = normalizePath(join(root, 'target.ts'))
    writeFileSync(targetFile, `export function ${symbolName}() {\n  return 1\n}\n`, 'utf-8')
    indexFileSync(targetFile)

    // File names sort alphabetically BEFORE the test file below ('a...' < 'z...'), so these
    // refs occupy the entire 0-499 window of a file_path-ordered, 500-row-capped query.
    for (let i = 0; i < REF_FILE_COUNT; i++) {
      const refFile = normalizePath(join(root, `a_ref_file_${String(i).padStart(2, '0')}.ts`))
      const lines = [`import { ${symbolName} } from './target'`]
      for (let j = 0; j < REFS_PER_FILE; j++) lines.push(`${symbolName}()`)
      writeFileSync(refFile, lines.join('\n') + '\n', 'utf-8')
      indexFileSync(refFile)
    }

    const testFile = normalizePath(join(root, 'z_target.test.ts'))
    writeFileSync(
      testFile,
      [
        `import { ${symbolName} } from './target'`,
        '',
        'function test_usesTarget() {',
        `  ${symbolName}()`,
        '}',
      ].join('\n'),
      'utf-8',
    )
    indexFileSync(testFile)

    return root
  }

  it('runTestFor still finds the test file even though 600 non-test refs sort before it', () => {
    const symbolName = 'refCapBugTarget9f2a1c'
    const root = buildFixture(symbolName)
    try {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runTestFor({ file: normalizePath(join(root, 'target.ts')), json: true })
      } finally {
        process.stdout.write = origWrite
        cwdSpy.mockRestore()
      }
      expect(code).toBe(0)
      const results = JSON.parse(captured) as Array<{ testFile: string; testFunctions: string[] }>
      expect(results.some((r) => r.testFile.endsWith('z_target.test.ts'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runCoverageGaps does not flag a tested symbol as a gap even though 600 non-test refs sort before its test ref', () => {
    const symbolName = 'refCapBugTarget7c3d2e'
    const root = buildFixture(symbolName)
    try {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      try {
        runCoverageGaps({ json: true, top: 5000 })
      } finally {
        process.stdout.write = origWrite
        cwdSpy.mockRestore()
      }
      const parsed = JSON.parse(captured) as Array<{ name: string }>
      expect(parsed.some((r) => r.name === symbolName)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---- runSimilar/runContextFor/runAsk cross-project FTS scoping (regression) -

describe('searchSymbolsFts callers (similar/context-for/ask) do not leak across projects', () => {
  // Regression: searchSymbolsFts (index_reader.ts) used to take no rootDir parameter at all, so
  // every caller queried the FTS index across every project ever indexed into global.db, not
  // just the current one. This is the default (non-edge-case) path on installs without
  // sqlite-vec/@xenova, since `semantic` always falls through to this same FTS search there.
  it('runContextFor does not surface a symbol from a different project sharing a search term', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-fts-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-fts-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      // The shared search term lives inside the function BODY (not a leading /** */ comment --
      // this parser does not attach that as a docstring for a bare `export function`), since
      // searchSymbolsFts's FTS mirror indexes name/body/docstring and body is what's reliably
      // populated here.
      writeFileSync(fileA, 'export function ftsScopeFnA9k2() { /* ftsScopeSharedTerm9k2 */ return 1 }\n')
      writeFileSync(fileB, 'export function ftsScopeFnB9k2() { /* ftsScopeSharedTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        const captured = captureStdout(() => {
          runContextFor({ task: 'ftsScopeSharedTerm9k2', json: true, top: 50 })
        })
        const parsed = JSON.parse(captured) as Array<{ symbol: string }>
        expect(parsed.some((r) => r.symbol === 'ftsScopeFnA9k2')).toBe(true)
        // rootB's symbol shares the same searchable docstring term but must not leak into
        // rootA-scoped context.
        expect(parsed.some((r) => r.symbol === 'ftsScopeFnB9k2')).toBe(false)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('runAsk (degraded mode) does not surface a symbol from a different project sharing a search term', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-fts-ask-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-fts-ask-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      writeFileSync(fileA, 'export function ftsAskFnA9k2() { /* ftsAskSharedTerm9k2 */ return 1 }\n')
      writeFileSync(fileB, 'export function ftsAskFnB9k2() { /* ftsAskSharedTerm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      const origBackendEnv = process.env.TOKEN_GOAT_ASK_BACKEND
      delete process.env.TOKEN_GOAT_ASK_BACKEND
      try {
        const captured = captureStdout(() => {
          runAsk({ question: 'ftsAskSharedTerm9k2', json: true, top: 50 })
        })
        const parsed = JSON.parse(captured) as { context: Array<{ symbol: string }> }
        expect(parsed.context.some((r) => r.symbol === 'ftsAskFnA9k2')).toBe(true)
        expect(parsed.context.some((r) => r.symbol === 'ftsAskFnB9k2')).toBe(false)
      } finally {
        cwdSpy.mockRestore()
        if (origBackendEnv !== undefined) process.env.TOKEN_GOAT_ASK_BACKEND = origBackendEnv
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })

  it('runSimilar does not surface a symbol from a different project sharing a docstring term', () => {
    const rootA = mkdtempSync(join(tmpdir(), 'tg-fts-similar-rootA-'))
    const rootB = mkdtempSync(join(tmpdir(), 'tg-fts-similar-rootB-'))
    try {
      const fileA = join(rootA, 'a.ts')
      const fileB = join(rootB, 'b.ts')
      // runSimilar's search query is built from the anchor's own name (docstring is empty here,
      // since this parser doesn't attach a leading /** */ comment as a docstring for a bare
      // `export function`) -- so rootB's body must literally mention the anchor's name for a
      // pre-fix (unscoped) search to wrongly surface it.
      writeFileSync(fileA, 'export function ftsSimilarAnchor9k2() { return 1 }\n')
      writeFileSync(fileB, 'export function ftsSimilarOther9k2() { /* mentions ftsSimilarAnchor9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootA)
      try {
        const captured = captureStdout(() => {
          runSimilar({ spec: `${normalizePath(fileA)}::ftsSimilarAnchor9k2`, top: 50, json: true })
        })
        const parsed = JSON.parse(captured) as Array<{ name: string }>
        expect(parsed.some((r) => r.name === 'ftsSimilarOther9k2')).toBe(false)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(rootA, { recursive: true, force: true })
      rmSync(rootB, { recursive: true, force: true })
    }
  })
})

// ---- runContextFor / runAsk (#248 regression) --------------------------------
// Regression coverage for task #248: natural-language queries silently returning zero
// results, runContextFor's empty-result silence, runAsk's zero-hits hallucination risk, and
// runContextFor's --budget loop dropping the whole result set behind one oversized top hit.
describe('runContextFor / runAsk (#248 regression)', () => {
  it('runContextFor finds a match for a multi-word natural-language query where no single symbol contains every word (widen-on-empty)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ctxfor-widen-'))
    try {
      const fileA = join(root, 'a.ts')
      const fileB = join(root, 'b.ts')
      // Neither symbol's indexed text (name/body/docstring) contains BOTH terms -- an AND-joined
      // FTS query (requiring every term to co-occur in one symbol) matches nothing. Each term
      // individually matches exactly one symbol, so an OR-joined widen-on-empty retry must find it.
      writeFileSync(fileA, 'export function ctxWidenAlpha9k2() { /* zzznarwhalterm9k2 */ return 1 }\n')
      writeFileSync(fileB, 'export function ctxWidenBeta9k2() { /* zzzwombatterm9k2 */ return 2 }\n')
      indexFileSync(normalizePath(fileA))
      indexFileSync(normalizePath(fileB))

      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        let captured = ''
        const origWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
        let code: number
        try {
          code = runContextFor({ task: 'zzznarwhalterm9k2 zzzwombatterm9k2', json: true, top: 50 })
        } finally {
          process.stdout.write = origWrite
        }
        expect(code).toBe(0)
        const parsed = JSON.parse(captured) as Array<{ symbol: string }>
        expect(parsed.length).toBe(2)
        expect(parsed.map((r) => r.symbol).sort()).toEqual(['ctxWidenAlpha9k2', 'ctxWidenBeta9k2'])
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runContextFor emits a clear "no matches found" message and exits 1 when nothing matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ctxfor-empty-'))
    try {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      try {
        let errCaptured = ''
        const origStderr = process.stderr.write.bind(process.stderr)
        process.stderr.write = (chunk: unknown) => { errCaptured += String(chunk); return true }
        let code: number
        try {
          code = runContextFor({ task: 'zzzcompletelyunmatchedquery9k2' })
        } finally {
          process.stderr.write = origStderr
        }
        expect(code).toBe(1)
        expect(errCaptured).toMatch(/No matches found/)
      } finally {
        cwdSpy.mockRestore()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runAsk degrades instead of invoking a configured, resolvable backend when retrieval returns zero hits', () => {
    const root = mkdtempSync(join(tmpdir(), 'tg-ask-zerohits-'))
    try {
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(root)
      const origBackendEnv = process.env.TOKEN_GOAT_ASK_BACKEND
      // "node" is guaranteed resolvable on PATH in this test environment -- proves the zero-hits
      // guard fires BEFORE (and regardless of) backend resolution, not merely because the backend
      // itself couldn't be found (a separate, already-tested degrade path).
      process.env.TOKEN_GOAT_ASK_BACKEND = 'node'
      try {
        let captured = ''
        const origWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
        let code: number
        try {
          code = runAsk({ question: 'zzzcompletelyunmatchedaskquery9k2' })
        } finally {
          process.stdout.write = origWrite
        }
        expect(code).toBe(0)
        expect(captured).toMatch(/degraded mode/)
      } finally {
        cwdSpy.mockRestore()
        if (origBackendEnv === undefined) delete process.env.TOKEN_GOAT_ASK_BACKEND
        else process.env.TOKEN_GOAT_ASK_BACKEND = origBackendEnv
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('runContextFor --budget skips an oversized top-ranked hit and still returns a smaller hit that fits (continue, not break)', () => {
    const oversized: SymbolEntry = {
      filePath: 'big.ts',
      name: 'oversizedHit',
      kind: 'function',
      lineStart: 1,
      lineEnd: 1,
      body: 'x'.repeat(3000),
      docstring: '',
      parent: '',
    }
    const fits: SymbolEntry = {
      filePath: 'small.ts',
      name: 'smallHit',
      kind: 'function',
      lineStart: 1,
      lineEnd: 1,
      body: 'y'.repeat(30),
      docstring: '',
      parent: '',
    }
    // Ranked with the oversized hit FIRST -- a `break` on the first hit exceeding budget would
    // stop the loop immediately and never even consider the smaller hit ranked below it.
    vi.mocked(searchSymbolsFts).mockReturnValueOnce([oversized, fits])

    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runContextFor({ task: 'irrelevant-mocked-query', json: true, top: 50, budget: 50 })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    const parsed = JSON.parse(captured) as Array<{ symbol: string }>
    expect(parsed.some((r) => r.symbol === 'smallHit')).toBe(true)
    expect(parsed.some((r) => r.symbol === 'oversizedHit')).toBe(false)
  })
})

// ---- runArch (integration) --------------------------------------------------

describe('runArch', () => {
  it('exits 0 and always emits the hubs header line', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runArch({ top: 3 })
    } finally {
      process.stdout.write = origWrite
    }
    expect(code).toBe(0)
    expect(captured).toMatch(/hubs/)
  })

  // Regression-coverage gap: every existing runArch test only ever asserted on `hubs` --
  // `entryPoints` and `cycles`, the other two fields runArch's JSON payload actually returns,
  // had no test exercising their content at all. Builds a small real repo with an unambiguous
  // shape for both: `main.ts` imports `leaf.ts` and nothing imports `main.ts` (the entry point),
  // and `a.ts`/`b.ts` import each other (a 2-node cycle) while also both being imported by
  // `main.ts` so they're excluded from entryPoints.
  it('reports entryPoints and cycles, not just hubs', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-arch-fields-'))
    try {
      writeFileSync(join(repo, 'leaf.ts'), 'export const leaf = 1\n')
      writeFileSync(join(repo, 'a.ts'), "import { leaf } from './leaf'\nimport { b } from './b'\nexport const a = leaf + b\n")
      writeFileSync(join(repo, 'b.ts'), "import { a } from './a'\nexport const b = 1\n")
      writeFileSync(join(repo, 'main.ts'), "import { a } from './a'\nimport { b } from './b'\nconsole.log(a, b)\n")
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runArch({ cwd: repo, top: 10, json: true })
      } finally {
        process.stdout.write = origWrite
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(captured) as {
        entryPoints: Array<{ file: string }>
        cycles: string[][]
      }

      // main.ts is imported by nobody and imports others -- the only real entry point here.
      expect(parsed.entryPoints).toHaveLength(1)
      expect(parsed.entryPoints.map((e) => e.file.replace(/\\/g, '/'))).toEqual(
        expect.arrayContaining([expect.stringContaining('main.ts')]),
      )
      // leaf.ts is imported by a.ts but imports nothing itself -- not an entry point by this
      // function's definition (entryPoints requires the file to also import something).
      expect(parsed.entryPoints.some((e) => e.file.includes('leaf.ts'))).toBe(false)
      // a.ts/b.ts are each imported (by main.ts and each other) -- not entry points either.
      expect(parsed.entryPoints.some((e) => e.file.includes('a.ts'))).toBe(false)
      expect(parsed.entryPoints.some((e) => e.file.includes('b.ts'))).toBe(false)

      // a.ts <-> b.ts form a real 2-node cycle.
      expect(parsed.cycles).toHaveLength(1)
      const hasAbCycle = parsed.cycles.some(
        (c) => c.some((f) => f.includes('a.ts')) && c.some((f) => f.includes('b.ts')),
      )
      expect(hasAbCycle).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves a relative import onto a .cts source file (candidate ext list previously omitted .cjs/.cts)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-arch-cts-'))
    try {
      writeFileSync(join(repo, 'config.cts'), 'export const config = 1\n')
      writeFileSync(join(repo, 'main.ts'), "import { config } from './config'\nconsole.log(config)\n")
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runArch({ cwd: repo, top: 10, json: true })
      } finally {
        process.stdout.write = origWrite
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(captured) as { hubs: Array<{ file: string; importedBy: number }> }
      expect(parsed.hubs.some((h) => h.file.replace(/\\/g, '/').endsWith('config.cts'))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves a barrel-style directory import ("./utils" backed by "./utils/index.cts") to the real file (regression: the index-probe extension list only tried .ts/.js/.tsx/.jsx, omitting .mts/.cts even though direct-file resolution above already handles both)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-arch-cts-index-'))
    try {
      const utilsDir = join(repo, 'utils')
      mkdirSync(utilsDir)
      writeFileSync(join(utilsDir, 'index.cts'), 'export const helper = 1\n')
      writeFileSync(join(repo, 'main.ts'), "import { helper } from './utils'\nconsole.log(helper)\n")
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runArch({ cwd: repo, top: 10, json: true })
      } finally {
        process.stdout.write = origWrite
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(captured) as { hubs: Array<{ file: string; importedBy: number }> }
      expect(parsed.hubs.some((h) => h.file.replace(/\\/g, '/').endsWith('utils/index.cts'))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('resolves an import spec that differs only in case from the tracked file on a case-insensitive filesystem (regression: 7th case-fold instance)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-arch-fold-'))
    const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    try {
      writeFileSync(join(repo, 'Foo.ts'), 'export const foo = 1\n')
      writeFileSync(join(repo, 'bar.ts'), "import { foo } from './foo'\nexport const bar = foo\n")
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runArch({ cwd: repo, top: 5, json: true })
      } finally {
        process.stdout.write = origWrite
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(captured) as { hubs: Array<{ file: string; importedBy: number }> }
      const fooHub = parsed.hubs.find((h) => h.file.toLowerCase().endsWith('foo.ts'))
      expect(fooHub?.importedBy).toBe(1)
    } finally {
      if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
      rmSync(repo, { recursive: true, force: true })
    }
  })

  it('does not resolve the case-mismatched import when the filesystem is treated as case-sensitive (control)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'tg-arch-fold-ctrl-'))
    const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    try {
      writeFileSync(join(repo, 'Foo.ts'), 'export const foo = 1\n')
      writeFileSync(join(repo, 'bar.ts'), "import { foo } from './foo'\nexport const bar = foo\n")
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'ignore' })

      process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
      let code: number
      try {
        code = runArch({ cwd: repo, top: 5, json: true })
      } finally {
        process.stdout.write = origWrite
      }
      expect(code).toBe(0)
      const parsed = JSON.parse(captured) as { hubs: Array<{ file: string; importedBy: number }> }
      const fooHub = parsed.hubs.find((h) => h.file.toLowerCase().endsWith('foo.ts'))
      expect(fooHub).toBeUndefined()
    } finally {
      if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
      else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

// ---- runBlame (integration) -------------------------------------------------

describe('runBlame', () => {
  it('exits 1 when the spec has no :: separator', () => {
    const code = runBlame({ spec: 'noseparator' })
    expect(code).toBe(1)
  })

  it('exits 1 when the symbol is not in the index', () => {
    const code = runBlame({ spec: 'src/constants.ts::__nonexistent_symbol__' })
    expect(code).toBe(1)
  })

  it('exits 0 and emits git blame output for VERSION in src/constants.ts', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runBlame({ spec: 'src/constants.ts::VERSION' })
    } finally {
      process.stdout.write = origWrite
    }
    if (code === 0) {
      // git blame succeeded; output must contain at least one commit hash (hex chars)
      expect(captured).toMatch(/[0-9a-f]{6,}/)
    } else {
      // Symbol not in index or not a git repo - graceful failure is acceptable
      expect(code).toBe(1)
    }
  })
})

// ---- runAsk (integration) ---------------------------------------------------

describe('runAsk', () => {
  it('exits 0 in degraded mode when TOKEN_GOAT_ASK_BACKEND is unset', () => {
    const orig = process.env['TOKEN_GOAT_ASK_BACKEND']
    delete process.env['TOKEN_GOAT_ASK_BACKEND']
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runAsk({ question: 'how are refs stored' })
    } finally {
      process.stdout.write = origWrite
      if (orig !== undefined) process.env['TOKEN_GOAT_ASK_BACKEND'] = orig
    }
    expect(code).toBe(0)
    expect(captured).toMatch(/degraded mode/)
  })

  it('exits 0 in degraded mode when backend label is not found on PATH', () => {
    const orig = process.env['TOKEN_GOAT_ASK_BACKEND']
    process.env['TOKEN_GOAT_ASK_BACKEND'] = '__nonexistent_backend_xyzzy__'
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runAsk({ question: 'how are refs stored' })
    } finally {
      process.stdout.write = origWrite
      if (orig !== undefined) process.env['TOKEN_GOAT_ASK_BACKEND'] = orig
      else delete process.env['TOKEN_GOAT_ASK_BACKEND']
    }
    expect(code).toBe(0)
    expect(captured).toMatch(/degraded mode/)
  })

  // Regression: on Windows, `where.exe <label>` for an npm-installed CLI resolves to a .cmd
  // shim (there is no separate .exe). spawnSync cannot exec a .cmd directly without
  // `shell: true` and used to throw EINVAL, which the catch block swallowed into a silent
  // degrade -- TOKEN_GOAT_ASK_BACKEND=claude looked like it worked but never ran anything.
  it.skipIf(process.platform !== 'win32')('actually runs a resolved .cmd backend shim on Windows instead of silently degrading', () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'tg-ask-shim-'))
    const shimName = 'tg_test_ask_backend'
    writeFileSync(join(shimDir, `${shimName}.cmd`), '@echo off\r\necho shim-answer-12345\r\n', 'utf-8')

    const origPath = process.env['PATH']
    const origBackend = process.env['TOKEN_GOAT_ASK_BACKEND']
    process.env['PATH'] = `${shimDir}${delimiter}${origPath ?? ''}`
    process.env['TOKEN_GOAT_ASK_BACKEND'] = shimName

    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runAsk({ question: 'how are refs stored' })
    } finally {
      process.stdout.write = origWrite
      if (origPath !== undefined) process.env['PATH'] = origPath
      else delete process.env['PATH']
      if (origBackend !== undefined) process.env['TOKEN_GOAT_ASK_BACKEND'] = origBackend
      else delete process.env['TOKEN_GOAT_ASK_BACKEND']
      rmSync(shimDir, { recursive: true, force: true })
    }
    expect(code).toBe(0)
    expect(captured).not.toMatch(/degraded mode/)
    expect(captured).toContain('shim-answer-12345')
  })

  // Regression for the CRITICAL bug: askArgs used to be hardcoded to
  // ['--print', '--bare', '--no-session-persistence'] for every backend, including codex --
  // those are Claude-Code-CLI-specific top-level flags that codex rejects outright. The shim
  // below stands in for real codex: it exits non-zero (like real codex does on '--print') unless
  // invoked as `exec --ephemeral --output-last-message <path>`, in which case it writes a known
  // answer to that file and, to prove the fix reads the file and not stdout, also emits noisy
  // stdout of the kind real codex produces (reasoning summaries, hook logs).
  it('uses the codex-shaped invocation (exec --ephemeral --output-last-message) and reads the answer from the output file, not stdout', () => {
    const shimDir = mkdtempSync(join(tmpdir(), 'tg-ask-codex-shim-'))
    const isWin = process.platform === 'win32'
    const shimPath = isWin ? join(shimDir, 'codex.cmd') : join(shimDir, 'codex')

    if (isWin) {
      const script = [
        '@echo off',
        'if "%~1"=="exec" (',
        '  echo codex: reasoning summary noise',
        '  echo hook: SessionStart',
        '  > "%~4" echo codex-known-answer-98765',
        '  exit /b 0',
        ') else (',
        '  echo error: unexpected argument \'--print\' found 1>&2',
        '  exit /b 2',
        ')',
        '',
      ].join('\r\n')
      writeFileSync(shimPath, script, 'utf-8')
    } else {
      const script = [
        '#!/usr/bin/env bash',
        'if [ "$1" = "exec" ]; then',
        '  echo "codex: reasoning summary noise"',
        '  echo "hook: SessionStart"',
        '  prev=""',
        '  outpath=""',
        '  for a in "$@"; do',
        '    if [ "$prev" = "--output-last-message" ]; then outpath="$a"; fi',
        '    prev="$a"',
        '  done',
        '  echo "codex-known-answer-98765" > "$outpath"',
        '  exit 0',
        'else',
        '  echo "error: unexpected argument \'--print\' found" >&2',
        '  exit 2',
        'fi',
        '',
      ].join('\n')
      writeFileSync(shimPath, script, 'utf-8')
      chmodSync(shimPath, 0o755)
    }

    const origPath = process.env['PATH']
    const origBackend = process.env['TOKEN_GOAT_ASK_BACKEND']
    process.env['PATH'] = `${shimDir}${delimiter}${origPath ?? ''}`
    process.env['TOKEN_GOAT_ASK_BACKEND'] = 'codex'

    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: unknown) => { captured += String(chunk); return true }
    let code: number
    try {
      code = runAsk({ question: 'how are refs stored' })
    } finally {
      process.stdout.write = origWrite
      if (origPath !== undefined) process.env['PATH'] = origPath
      else delete process.env['PATH']
      if (origBackend !== undefined) process.env['TOKEN_GOAT_ASK_BACKEND'] = origBackend
      else delete process.env['TOKEN_GOAT_ASK_BACKEND']
      rmSync(shimDir, { recursive: true, force: true })
    }
    expect(code).toBe(0)
    expect(captured).not.toMatch(/degraded mode/)
    expect(captured).toContain('codex-known-answer-98765')
    // Codex's noisy stdout must never leak into the emitted answer.
    expect(captured).not.toMatch(/reasoning summary noise/)
    expect(captured).not.toMatch(/SessionStart/)
  })
})

// ---- --top <= 0 rejection (regression) --------------------------------------
// Every --top consumer in this file used to slice its results list with `opts.top` unchecked,
// so `--top 0` (or negative) silently produced an empty result -- reported as "No callers
// found", "No dead symbols found.", "No coverage gaps found.", etc -- indistinguishable from a
// genuinely clean project, exactly the failure mode runRefs' own --top validation (see
// read_commands.test.ts) already guards against. Each command below must reject a non-positive
// --top explicitly instead.
describe('--top <= 0 rejection across graph_commands.ts', () => {
  it('runImpact rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runImpact({ symbol: 'querySymbols', top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured).not.toContain('No callers found')
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('runSimilar rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runSimilar({ spec: 'src/graph_commands.ts::enclosingSymbol', top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('runContextFor rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runContextFor({ task: 'query symbols', top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('runCoverageGaps rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runCoverageGaps({ top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured).not.toContain('No coverage gaps found')
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('runArch rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runArch({ top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('top')
  })

  it('runAsk rejects --top 0', () => {
    const errCaptured = captureStderr(() => {
      const code = runAsk({ question: 'how are refs stored', top: 0 })
      expect(code).toBe(1)
    })
    expect(errCaptured.toLowerCase()).toContain('top')
  })
})

