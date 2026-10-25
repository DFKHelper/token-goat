/** scripts/prepush-graph.mjs replaces `vitest related` for the pre-push selection: it must find the tests that import a changed module, with the right distance, from the specifier spellings this repo uses. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as graph from '../scripts/prepush-graph.mjs'
import { importerGraph, readSources, relativeSpecifiers, resolveSpecifier, testDistances } from '../scripts/prepush-graph.mjs'

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

describe('prepush graph: fixtures a test spawns', () => {
  // Fixture provenance: HAND-DERIVED. A fixture is a program a test spawns; the test names it by the basename it joins, and the fixture imports src, so the test is two hops from that src module.
  const sources = new Map([
    ['src/hook_server.ts', 'export {}\n'],
    ['tests/fixtures/held_cli_server.ts', "import '../../src/hook_server.js'\n"],
    ['tests/hook_client.test.ts', "const script = join(here, 'fixtures', 'held_cli_server.ts')\n"],
    ['tests/unrelated.test.ts', "const script = join(here, 'fixtures', 'other_server.ts')\n"],
  ])

  it('reaches the test that names the fixture, at one hop past the fixture', () => {
    expect(Object.fromEntries(testDistances(importerGraph(sources), ['src/hook_server.ts']))).toEqual({ 'tests/hook_client.test.ts': 2 })
  })
})

describe('prepush graph: fixtures named only by a helper or a setup file', () => {
  // Fixture provenance: HAND-DERIVED. The fixture is named only by a support file under tests (a helper or a setup file), which the test imports; the test reaches src through that file and the fixture, three hops from the src module.
  it.each(['helpers', 'setup'])('reaches the test that imports a tests/%s file naming the fixture, three hops from the src module', (dir) => {
    const sources = new Map([
      ['src/hook_server.ts', 'export {}\n'],
      ['tests/fixtures/held_cli_server.ts', "import '../../src/hook_server.js'\n"],
      [`tests/${dir}/spawn.ts`, "export const script = join(here, 'fixtures', 'held_cli_server.ts')\n"],
      ['tests/hook_client.test.ts', `import { script } from './${dir}/spawn.js'\n`],
    ])
    expect(Object.fromEntries(testDistances(importerGraph(sources), ['src/hook_server.ts']))).toEqual({ 'tests/hook_client.test.ts': 3 })
  })
})

describe('prepush graph: sources are the tracked files', () => {
  let dir = ''
  afterEach(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' })

  it('lists the tracked code files and not an untracked one', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-graph-'))
    for (const rel of ['src/a.ts', 'tests/a.test.ts']) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), 'export {}\n')
    }
    git('init', '-q')
    git('add', '-A')
    writeFileSync(path.join(dir, 'tests/untracked.test.ts'), 'u')
    expect([...readSources(dir).keys()].sort()).toEqual(['src/a.ts', 'tests/a.test.ts'])
  })

  it('throws when the root is not a git repository, so the selector falls back to the full leg', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-graph-'))
    for (const rel of ['src/a.ts', 'tests/a.test.ts', 'scripts/a.mjs']) {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
      writeFileSync(path.join(dir, rel), 'export {}\n')
    }
    expect(() => readSources(dir)).toThrow()
  })
})

describe('prepush graph: a setup file reached through imports', () => {
  // Fixture provenance: HAND-DERIVED. The graph is hand-built: a setup file imports a src module, and no test imports the setup file.
  it('lists the setup file reached from the changed module, and no test', () => {
    const importers = new Map([['src/hint_stats.ts', new Set(['tests/setup/reset-hint-stats.ts'])]])
    expect(graph.setupsReached(importers, ['src/hint_stats.ts'])).toEqual(['tests/setup/reset-hint-stats.ts'])
    expect(testDistances(importers, ['src/hint_stats.ts']).size).toBe(0)
  })
})
