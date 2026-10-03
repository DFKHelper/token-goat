/** Regression: `refs`, `callers`, `call-chain`, `impact` and `brief` could not resolve a `file::Class.method` spec that `read` serves. `read "shapes.ts::Circle.area"` found the method through findSymbolCandidates' qualifier split, but the graph commands looked the whole string `Circle.area` up as a bare symbol name, so `refs shapes.ts::Circle.area --callers` and `callers shapes.ts::Circle.area` answered "Symbol not found". And once the method was resolved by name alone, `Circle.area` and `Square.area` in the same file shared one set of call sites. The fix resolves the qualifier through the same lookup `read` uses and hands the one resolved definition to the TypeScript checker tier, which tells the two classes apart. Provenance: HAND-DERIVED. Which caller belongs to which class follows from the parameter types in the fixture source alone, independent of the code under test. The Python case is name-keyed only (the checker tier is TypeScript-only), so it asserts resolution succeeds and the caller is found, nothing about separating classes. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { globalDbPath } from '../src/constants.js'
import { closeAllDbs } from '../src/db.js'
import { runCallChain, runCallers, runImpact } from '../src/graph_commands.js'
import { indexFileSync } from '../src/parser.js'
import { runBriefCore } from '../src/read_brief.js'
import { runRefs } from '../src/read_refs.js'

const SHAPES = [
  'export class Circle {',
  '  area(): number { return 3 }',
  '}',
  'export class Square {',
  '  area(): number { return 4 }',
  '}',
  'export function useCircle(c: Circle) { return c.area() }',
  'export function useSquare(s: Square) { return s.area() }',
  '',
].join('\n')

const STORE = ['class Store:', '    def get(self, k):', '        return k', '', 'def use(s):', '    return s.get(1)', ''].join('\n')

let dir: string
let origCwd: string

beforeEach(() => {
  origCwd = process.cwd()
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-qualified-')))
  fs.writeFileSync(path.join(dir, 'shapes.ts'), SHAPES)
  fs.writeFileSync(path.join(dir, 'store.py'), STORE)
  for (const f of ['shapes.ts', 'store.py']) indexFileSync(path.join(dir, f), globalDbPath())
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(origCwd)
  closeAllDbs()
  fs.rmSync(dir, { recursive: true, force: true })
})

function run(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const outW = process.stdout.write.bind(process.stdout)
  const errW = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((c: string | Uint8Array) => ((stdout += String(c)), true)) as typeof process.stdout.write
  process.stderr.write = ((c: string | Uint8Array) => ((stderr += String(c)), true)) as typeof process.stderr.write
  try {
    return { code: fn(), stdout, stderr }
  } finally {
    process.stdout.write = outW
    process.stderr.write = errW
  }
}

describe('file::Class.method specs in the graph commands', () => {
  it('refs --callers resolves Circle.area and excludes Square.area callers', () => {
    const r = run(() => runRefs({ spec: 'shapes.ts::Circle.area', callers: true, projectRoot: dir, json: true }))
    expect(r.stderr).not.toContain('not found')
    expect(r.code).toBe(0)
    const lines = (JSON.parse(r.stdout) as { items: Array<{ line: number }> }).items.map((i) => i.line)
    expect(lines).toEqual([7])
  })

  it('refs --callers keeps Square.area to its own caller', () => {
    const r = run(() => runRefs({ spec: 'shapes.ts::Square.area', callers: true, projectRoot: dir, json: true }))
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { items: Array<{ line: number }> }).items.map((i) => i.line)).toEqual([8])
  })

  it('refs resolves each qualified symbol of a same-file multi-symbol spec', () => {
    const r = run(() => runRefs({ spec: 'shapes.ts::Circle.area,Square.area', projectRoot: dir, json: true }))
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout) as Record<string, { items: Array<{ line: number }> }>
    expect(out['Circle.area']?.items.map((i) => i.line)).toEqual([7])
    expect(out['Square.area']?.items.map((i) => i.line)).toEqual([8])
  })

  it('callers resolves Circle.area to useCircle only', () => {
    const r = run(() => runCallers({ symbol: 'shapes.ts::Circle.area', json: true }))
    expect(r.stderr).not.toContain('not found')
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { items: Array<{ caller: string }> }).items.map((i) => i.caller)).toEqual(['useCircle'])
  })

  it('callers resolves a Python Class.method (name-keyed, so resolution is the assertion)', () => {
    const r = run(() => runCallers({ symbol: 'store.py::Store.get', json: true }))
    expect(r.stderr).not.toContain('not found')
    expect(r.code).toBe(0)
    expect((JSON.parse(r.stdout) as { items: Array<{ caller: string }> }).items.map((i) => i.caller)).toEqual(['use'])
  })

  it('call-chain and impact resolve a qualified method', () => {
    const chain = run(() => runCallChain({ symbol: 'shapes.ts::Circle.area' }))
    expect(chain.stderr).not.toContain('not found')
    expect(chain.stdout).toContain('useCircle')
    expect(chain.stdout).not.toContain('useSquare')
    const impact = run(() => runImpact({ symbol: 'shapes.ts::Circle.area' }))
    expect(impact.stderr).not.toContain('not found')
    expect(impact.stdout).toContain('useCircle')
    expect(impact.stdout).not.toContain('useSquare')
  })

  it('brief lists only the method own callers', () => {
    const r = runBriefCore({ spec: 'shapes.ts::Circle.area', projectRoot: dir })
    expect(r.code).toBe(0)
    expect(r.text).toContain('useCircle')
    expect(r.text).not.toContain('useSquare')
  })

  it('an unknown qualified method still reports not found', () => {
    const r = run(() => runCallers({ symbol: 'shapes.ts::Circle.nope' }))
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('not found')
  })
})
