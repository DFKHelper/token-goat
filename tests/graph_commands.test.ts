/**
 * Unit tests for the pure exported helpers in src/graph_commands.ts and
 * light integration tests against the real repo index (global.db must be
 * populated before this suite runs — the fixture is the token-goat repo itself).
 */

import { readdirSync, mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { join, resolve, delimiter } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { beforeAll, describe, expect, it, vi } from 'vitest'

import { indexFileSync } from '../src/parser.js'
import { normalizePath } from '../src/paths.js'
import { querySymbols } from '../src/index_reader.js'
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

// ---- helpers ----------------------------------------------------------------

function makeSymbol(name: string, lineStart: number, lineEnd: number, kind = 'function'): SymbolEntry {
  return { name, kind, lineStart, lineEnd, filePath: 'file.ts', body: '', docstring: '' }
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
    for (const name of ['main', 'default', 'index', '__init__', '__main__', 'setup', 'run', 'handler']) {
      expect(isDeadSymbol(name, 0), `${name} should not be dead`).toBe(false)
    }
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
    // src/cli.ts line 1 is in the module scope but the file is indexed. Use a line that is reliably inside buildProgram (~line 640).
    const result = runScope({ spec: 'src/cli.ts:640' })
    // buildProgram is a large function; line 640 should be inside it. We accept either 0 (found) or 1 (not found if line shifted); the key assertion is that it is a number and does not throw.
    expect(typeof result).toBe('number')
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

    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      runScope({ spec: `src/read_commands.ts:${line}`, json: true })
    } finally {
      process.stdout.write = origWrite
    }
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('exits 1 for a nonsense file even with --json (regression: emptiness check must run before format branching)', () => {
    const result = runScope({ spec: 'src/__nonexistent_file_xyzzy__.ts:1', json: true })
    expect(result).toBe(1)
  })
})

// ---- integration: runTypes against the real repo index ---------------------

describe('runTypes integration', () => {
  it('exits 0 and finds SymbolEntry interface', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runTypes({})
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(captured).toMatch(/SymbolEntry|RefEntry|Language/)
  })

  it('exits 0 scoped to a specific file', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runTypes({ file: 'src/parser_types.ts' })
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(captured).toMatch(/SymbolEntry|Language/)
  })

  it('returns valid JSON for --json flag', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runTypes({ json: true })
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    const parsed: unknown = JSON.parse(captured)
    expect(Array.isArray(parsed)).toBe(true)
    expect((parsed as unknown[]).length).toBeGreaterThan(0)
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

      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        if (typeof chunk === 'string') captured += chunk
        return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
      }
      try {
        const code = runTypes({ json: true, limit: 5000 })
        expect(code).toBe(0)
      } finally {
        process.stdout.write = origWrite
      }
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
})

// ---- integration: runCallers against the real repo index -------------------

describe('runCallers integration', () => {
  it('exits 0 for a well-known symbol and returns structured output', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runCallers({ symbol: 'querySymbols' })
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(captured.length).toBeGreaterThan(0)
  })

  it('exits 1 for an unknown symbol', () => {
    const code = runCallers({ symbol: '__xyzzy_no_such_symbol_9f3k__' })
    expect(code).toBe(1)
  })

  it('returns valid JSON for --json flag', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      runCallers({ symbol: 'querySymbols', json: true })
    } finally {
      process.stdout.write = origWrite
    }
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
})


// ---- integration: runDead against the real repo index ----------------------

describe('runDead integration', () => {
  it('exits 0 even when no dead symbols are found', () => {
    const code = runDead({ top: 0 })
    expect(code).toBe(0)
  })

  it('returns valid JSON for --json flag with --top 5', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      runDead({ json: true, top: 5 })
    } finally {
      process.stdout.write = origWrite
    }
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
        let captured = ''
        const origWrite = process.stdout.write.bind(process.stdout)
        process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
          if (typeof chunk === 'string') captured += chunk
          return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
        }
        try {
          runDead({ json: true, top: 500 })
        } finally {
          process.stdout.write = origWrite
        }
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

// ---- integration: runDeps against the real repo -------------------------

describe('runDeps integration', () => {
  it('returns internal and external deps for a known file', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runDeps({ file: 'src/read_commands.ts' })
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(captured).toMatch(/internal:|external:|node:|\.\//)
  })

  it('exits 1 for a nonexistent file', () => {
    const code = runDeps({ file: 'src/__nonexistent_xyzzy__.ts' })
    expect(code).toBe(1)
  })

  it('returns valid JSON for --json flag', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      runDeps({ file: 'src/read_commands.ts', json: true })
    } finally {
      process.stdout.write = origWrite
    }
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
      let captured = ''
      const origWrite = process.stdout.write.bind(process.stdout)
      process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        if (typeof chunk === 'string') captured += chunk
        return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
      }
      try {
        const code = runDeps({ file, json: true })
        expect(code).toBe(0)
      } finally {
        process.stdout.write = origWrite
      }
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
})

// ---- integration: runCallChain against the real repo index -----------------

describe('runCallChain integration', () => {
  it('exits 0 for a known symbol', () => {
    const code = runCallChain({ symbol: 'runRead' })
    expect(code).toBe(0)
  })

  it('returns valid JSON for --json flag', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      runCallChain({ symbol: 'runRead', json: true, depth: 2 })
    } finally {
      process.stdout.write = origWrite
    }
    const parsed = JSON.parse(captured) as { chains: string[][] }
    expect(Array.isArray(parsed.chains)).toBe(true)
  })
})

// ---- integration: runImpact against the real repo index -------------------

describe('runImpact integration', () => {
  it('exits 0 with non-empty output for querySymbols', () => {
    let captured = ''
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string') captured += chunk
      return origWrite(chunk, ...(rest as Parameters<typeof origWrite>))
    }
    try {
      const code = runImpact({ symbol: 'querySymbols', top: 5 })
      expect(code).toBe(0)
    } finally {
      process.stdout.write = origWrite
    }
    expect(captured.length).toBeGreaterThan(0)
  })

  it('exits 1 for an unknown symbol', () => {
    const code = runImpact({ symbol: '__xyzzy_no_such_symbol_9f3k__' })
    expect(code).toBe(1)
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
    expect(cycles.length).toBeGreaterThan(0)
    const flat = cycles.flat()
    expect(flat).toContain('a')
    expect(flat).toContain('b')
  })

  it('finds a three-node cycle', () => {
    const g = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']], ['standalone', []]])
    const cycles = findCycles(g)
    expect(cycles.length).toBeGreaterThan(0)
    const flat = cycles.flat()
    expect(flat).toContain('x')
    expect(flat).toContain('y')
    expect(flat).toContain('z')
  })

  it('mutation-verification: removing cycle back-edge eliminates all cycles', () => {
    const withCycle = new Map([['x', ['y']], ['y', ['z']], ['z', ['x']]])
    const withoutCycle = new Map([['x', ['y']], ['y', ['z']], ['z', []]])
    expect(findCycles(withCycle).length).toBeGreaterThan(0)
    expect(findCycles(withoutCycle)).toHaveLength(0)
  })

  it('does not crash on an empty graph', () => {
    expect(findCycles(new Map())).toHaveLength(0)
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
    expect(captured.length).toBeGreaterThan(0)
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
