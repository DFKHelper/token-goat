/**
 * The shared guard parser must see every shape a top-level function is written in.
 *
 * Eleven structural guards resolve their populations through
 * `tests/guards/reachability.ts::parseTopLevelFunctions`. It matched only `function name(` and so
 * was blind to module-scope arrow consts: an audit injected both shapes into
 * `src/vscode_duplicate.ts` and got `function probeFn` back but not
 * `const probeArrow = (q) => fs.existsSync(q)`. Nothing turned red, because the population simply
 * did not contain the function -- the same silent-shrink failure `pinnedPopulation` exists to
 * catch, one level lower down where a floor cannot see it. An ungated pre-approval `fs` touch
 * written as an arrow const would have shipped green.
 *
 * The parser is a pure function of source TEXT, so the injection here is done in memory against
 * the real file's bytes rather than by writing to `src/`. That is the same evidence as an on-disk
 * mutation for a pure function, and it cannot leave a poisoned tree behind if the run is killed.
 *
 * PROVENANCE: CAPTURE for the real-file half (the subject is `src/vscode_duplicate.ts` as it
 * actually is on disk, read at run time, not a transcription of it). HAND-DERIVED for the shape
 * table: each case is a declaration written to exercise one syntactic form, with the expected
 * body computed by reading the form, never by running the parser and pinning what it said.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { functionMap, parseTopLevelFunctions } from './reachability.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC_DIR = path.join(HERE, '..', '..', 'src')

/** Split so that a guard which scans this repo's own sources cannot match its own probe text. */
const PROBE = `NOSUCH${'X'}TOKEN`

describe('parseTopLevelFunctions sees every top-level function shape', () => {
  const cases: ReadonlyArray<[string, string, string]> = [
    ['function declaration', 'function a(q) { return q }', 'return q'],
    ['exported async declaration', 'export async function a(q: string): Promise<void> { await q }', 'await q'],
    ['inline object return type', 'function a(q: string): { x: number } | null { return null }', 'return null'],
    ['arrow const, block body', 'const a = (q) => { return q }', 'return q'],
    ['exported arrow const, expression body', 'export const a = (q: string) => q.trim()', 'q.trim()'],
    ['async arrow const', 'const a = async (q: string): Promise<string> => { return q }', 'return q'],
    ['unparenthesized single parameter', 'const a = q => q.trim()', 'q.trim()'],
    ['arrow const behind a function-typed annotation', 'const a: (q: string) => string = (q) => q.trim()', 'q.trim()'],
    ['let-bound arrow', 'let a = (q) => { return q }', 'return q'],
    ['arrow const with an inline object return type', 'const a = (q: string): { x: number } | null => q.trim()', 'q.trim()'],
    ['function expression const', 'const a = function (q) { return q }', 'return q'],
    ['named async function expression', 'const a = async function inner(q: string) { return q }', 'return q'],
  ]

  for (const [label, source, expected] of cases) {
    it(`reports the ${label}`, () => {
      const fns = parseTopLevelFunctions(`${source}\n`)
      expect(fns.map((f) => f.name)).toEqual(['a'])
      expect(fns[0]?.body).toContain(expected)
    })
  }

  it('reports nothing for a const that is not a function', () => {
    // The other direction: widening the parser must not turn every module constant into a
    // "function", which would pad every population built on it with members no guard can act on.
    const src = 'const a = new Map<string, string>()\nconst b = 1\nconst c: string[] = []\nconst d = { e: (q) => q }\n'
    expect(parseTopLevelFunctions(src).map((f) => f.name)).toEqual([])
  })

  // The negative case above is the variant that passes for free: with no later arrow in the file,
  // an unbounded `indexOf('=>')` finds nothing and the phantom never appears. The real shape has a
  // later arrow to scavenge, and that one was reported for three rounds.
  it('does not attach a later arrow to a parenthesized initializer that is not a function', () => {
    const src = 'const total = (aaa + bbb) * 2\nconst later = (q) => { unsafeCall(q) }\n'

    const fns = parseTopLevelFunctions(src)

    expect(fns.map((f) => f.name)).toEqual(['later'])
    expect(fns[0]?.body).toContain('unsafeCall(q)')
  })

  it('does not let a phantom overwrite a real function of the same name', () => {
    // Why the phantom matters at all: `functionMap` keys by name and the last write wins, so a
    // phantom sharing a name with a real function replaces that function's body in a guard's view
    // -- the guard then reports green about code it can no longer see. `var` because it is the one
    // binding form that may legally redeclare a function declaration in the same scope.
    const src = 'function check(q) { return realGate(q) }\nvar check = (aaa + bbb) * 2\nconst later = (q) => { unsafeCall(q) }\n'

    const byName = functionMap(parseTopLevelFunctions(src))

    expect(byName.get('check')).toContain('realGate(q)')
    expect(byName.get('check')).not.toContain('unsafeCall')
  })

  it('reports no function for a non-function const in a real source file that has arrows after it', () => {
    // CAPTURE: `src/webfetch.ts` as it is on disk. ALLOW_UNRESOLVED is a boolean; the unbounded
    // scan reported it as a function whose body (`void,`) was scavenged from a later annotation.
    const real = fs.readFileSync(path.join(SRC_DIR, 'webfetch.ts'), 'utf8')
    expect(real).toContain('ALLOW_UNRESOLVED') // calibration: a rename must fail loudly, not pass silently

    expect(parseTopLevelFunctions(real).map((f) => f.name)).not.toContain('ALLOW_UNRESOLVED')
  })

  it('keeps a function body brace-matched rather than stopping at the first close', () => {
    const fns = parseTopLevelFunctions('const a = (q) => {\n  if (q) { return 1 }\n  return 2\n}\n')
    expect(fns[0]?.body).toContain('return 2')
  })

  it('stops an expression body at the end of its statement', () => {
    const fns = parseTopLevelFunctions('const a = (q) => q.trim()\nconst b = (q) => q.length\n')
    expect(fns.map((f) => f.name)).toEqual(['a', 'b'])
    expect(fns[0]?.body).toBe('q.trim()')
  })

  it('reports BOTH shapes when they are injected into a real source file', () => {
    // The audit's exact reproduction: `function probeFn` came back, `const probeArrow` did not.
    const real = fs.readFileSync(path.join(SRC_DIR, 'vscode_duplicate.ts'), 'utf8')
    const before = parseTopLevelFunctions(real).map((f) => f.name)
    expect(before.length).toBeGreaterThan(0) // the subject file must really parse, or this proves nothing
    expect(before).not.toContain(`probeFn${PROBE}`)

    const injected = `${real}\nexport function probeFn${PROBE}(q: string): boolean { return fs.existsSync(q) }\nexport const probeArrow${PROBE} = (q: string) => fs.existsSync(q)\n`
    const after = parseTopLevelFunctions(injected)

    expect(after.map((f) => f.name)).toEqual([...before, `probeFn${PROBE}`, `probeArrow${PROBE}`])
    // Bodies too, not just names: a member whose body came back empty is invisible to every
    // predicate the guards run, which is the same hole wearing a different hat.
    expect(after.find((f) => f.name === `probeArrow${PROBE}`)?.body).toContain('fs.existsSync(q)')
  })
})
