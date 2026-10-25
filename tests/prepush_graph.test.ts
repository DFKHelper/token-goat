/** scripts/prepush-graph.mjs replaces `vitest related` for the pre-push selection: it must find the tests that import a changed module, with the right distance, from the specifier spellings this repo uses. */
import { describe, expect, it } from 'vitest'
import { importerGraph, relativeSpecifiers, resolveSpecifier, testDistances } from '../scripts/prepush-graph.mjs'

// Fixture provenance: the specifier spellings are CAPTURE from this repo (grep of tests/ and src/ for `from '`, `import(` and `vi.mock(` shows the `.js` suffix on TypeScript sources, dynamic imports and vi.mock calls); the graphs are HAND-DERIVED.
const files = (...names: string[]): Set<string> => new Set(names)

describe('prepush graph: specifiers', () => {
  it.each([
    ["import { a } from './a.js'", ['./a.js']],
    ["import './side.js'", ['./side.js']],
    ["export * from '../src/b.js'", ['../src/b.js']],
    ["const m = await import('./dyn.js')", ['./dyn.js']],
    ["vi.mock('../src/c.js', () => ({}))", ['../src/c.js']],
    ["await vi.importActual('./d.js')", ['./d.js']],
    ["const x = require('./e.cjs')", ['./e.cjs']],
    ["import type { T } from './t.js'", ['./t.js']],
    ["import x from 'node:fs'", []],
    ["import x from 'vitest'", []],
    ["const p = path.join(root, 'src/a.ts')", []],
  ])('%s', (text, want) => {
    expect(relativeSpecifiers(text)).toEqual(want)
  })
})

describe('prepush graph: resolution', () => {
  it.each([
    ['tests/a.test.ts', '../src/b.js', 'src/b.ts'],
    ['tests/a.test.ts', '../scripts/x.mjs', 'scripts/x.mjs'],
    ['src/a.ts', './dir', 'src/dir/index.ts'],
    ['src/a.ts', './b', 'src/b.ts'],
    ['src/a.ts', './helpers/h.js', 'src/helpers/h.ts'],
  ])('%s imports %s as %s', (from, spec, want) => {
    expect(resolveSpecifier(from, spec, files('src/b.ts', 'scripts/x.mjs', 'src/dir/index.ts', 'src/helpers/h.ts'))).toBe(want)
  })

  it('names nothing for a file that is not scanned', () => {
    expect(resolveSpecifier('src/a.ts', './missing.js', files('src/b.ts'))).toBeNull()
  })
})

describe('prepush graph: distances', () => {
  const sources = new Map([
    ['src/leaf.ts', 'export {}\n'],
    ['src/mid.ts', "import './leaf.js'\n"],
    ['src/top.ts', "import './mid.js'\n"],
    ['tests/direct.test.ts', "import '../src/leaf.js'\n"],
    ['tests/two.test.ts', "import '../src/mid.js'\n"],
    ['tests/three.test.ts', "import '../src/top.js'\n"],
    ['tests/both.test.ts', "import '../src/top.js'\nimport '../src/leaf.js'\n"],
    ['tests/mocked.test.ts', "vi.mock('../src/leaf.js')\n"],
    ['tests/unrelated.test.ts', "import '../src/other.js'\n"],
    ['src/other.ts', 'export {}\n'],
  ])

  it('gives each test the fewest import hops to the changed module', () => {
    const d = testDistances(importerGraph(sources), ['src/leaf.ts'])
    expect(Object.fromEntries(d)).toEqual({ 'tests/direct.test.ts': 1, 'tests/mocked.test.ts': 1, 'tests/both.test.ts': 1, 'tests/two.test.ts': 2, 'tests/three.test.ts': 3 })
  })

  it('does not list a test that reaches nothing changed', () => {
    expect(testDistances(importerGraph(sources), ['src/leaf.ts']).has('tests/unrelated.test.ts')).toBe(false)
  })

  it('follows a helper under tests that other tests import', () => {
    const s = new Map([
      ['tests/helpers/h.ts', 'export {}\n'],
      ['tests/a.test.ts', "import './helpers/h.js'\n"],
    ])
    expect(Object.fromEntries(testDistances(importerGraph(s), ['tests/helpers/h.ts']))).toEqual({ 'tests/a.test.ts': 1 })
  })

  it('ends on an import cycle', () => {
    const s = new Map([
      ['src/a.ts', "import './b.js'\n"],
      ['src/b.ts', "import './a.js'\n"],
      ['tests/t.test.ts', "import '../src/a.js'\n"],
    ])
    expect(Object.fromEntries(testDistances(importerGraph(s), ['src/b.ts']))).toEqual({ 'tests/t.test.ts': 2 })
  })
})
