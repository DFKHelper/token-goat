/**
 * Regression: a top-level destructuring declaration indexed the identifiers in its *default
 * values* and *computed keys* as if they were new bindings.
 *
 * `collectPatternBindings` walked every named child of the pattern and pushed anything typed
 * `identifier`. In `const { alpha = fallbackValue } = o` the default `fallbackValue` is an
 * `identifier` sitting inside the pattern, so it was recorded as a variable declared on that
 * line. Same for `const { [keyName]: computed } = o` (the computed key reads `keyName`) and for
 * `const [gamma = mk()] = a` (the call's callee `mk`).
 *
 * The damage lands on the read path, which is the whole point of the index: a name that is
 * declared exactly once ends up with two rows, so `symbol NAME` reports two definitions and
 * `read "file::NAME"` refuses a name that was never ambiguous -- and the extra row cites a line
 * that merely mentions the name rather than declaring it.
 *
 * Why didn't a test catch this: every destructuring fixture in the suite used plain bindings and
 * renames. The docblock on `collectPatternBindings` shows renames (`{ a: b }`) were considered --
 * they are safe by accident, because a plain key is a `property_identifier` and the walker only
 * pushes `identifier`. Defaults and computed keys put a real `identifier` inside the pattern, and
 * nothing exercised either. Asserting only `toContain('alpha')` also cannot see an extra name:
 * the assertion that catches this has to be over the whole set.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { parseFile } from '../src/parser.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-destr-'))
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(name: string, content: string): string {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, content)
  return p
}

const SOURCE = [
  'const fallbackValue = 1',
  'const someDefault = 2',
  'const keyName = "k"',
  'function mk() { return {} }',
  'export const { alpha = fallbackValue } = mk()',
  'export const { beta: renamed = someDefault } = mk()',
  'export const { [keyName]: computed } = mk()',
  'export const [gamma = mk()] = []',
  'export const { nested: { deep = fallbackValue } = {} } = mk()',
  'export const { ...rest } = mk()',
  '',
].join('\n')

describe('destructuring defaults and computed keys', () => {
  it('binds only the pattern names, never the identifiers a default or key reads', async () => {
    const result = await parseFile(write('a.ts', SOURCE))
    const names = result.symbols.map((s) => s.name).sort()
    // The exact set, not `toContain`: a phantom binding is an *extra* entry, so any containment
    // assertion stays green while the index carries names nothing on that line declares.
    expect(names, 'a default value or computed key was indexed as a declaration').toEqual([
      'alpha',
      // no `beta`: in `{ beta: renamed }` the key is a property_identifier, not a binding.
      'computed',
      'deep',
      'fallbackValue',
      'gamma',
      'keyName',
      'mk',
      'renamed',
      'rest',
      'someDefault',
    ])
  })

  it('leaves each name declared exactly once, so the read path stays unambiguous', async () => {
    const result = await parseFile(write('b.ts', SOURCE))
    const counts = new Map<string, number>()
    for (const s of result.symbols) counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
    const duplicated = [...counts.entries()].filter(([, n]) => n > 1).map(([n]) => n)
    expect(
      duplicated,
      'a uniquely-declared name got a second row, which makes `read "file::name"` refuse it',
    ).toEqual([])
  })

  it('keeps the real declaration of a name used as a default value', async () => {
    const result = await parseFile(write('c.ts', SOURCE))
    // `fallbackValue` must survive -- the fix must drop the phantom row, not the genuine one.
    const rows = result.symbols.filter((s) => s.name === 'fallbackValue')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.lineStart, 'the surviving row is not the actual declaration').toBe(1)
  })

  it('applies the same rule to plain JavaScript, whose grammar shares these node names', async () => {
    const js = [
      'const fb = 1',
      'const key = "k"',
      'export const { a = fb } = o',
      'export const { [key]: c } = o',
      '',
    ].join('\n')
    const result = await parseFile(write('d.js', js))
    expect(result.symbols.map((s) => s.name).sort()).toEqual(['a', 'c', 'fb', 'key'])
  })
})
