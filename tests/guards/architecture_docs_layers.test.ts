/** The layer-order and static-cycle rows of the architecture documentation engine. Split from architecture_docs_analysis.test.ts so its rows run in a parallel worker; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { START, analysisRepo, engine, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

describe('sync-arch-docs --check layer order', () => {
  it('reports a reverse edge with both paths and layer names and exits 1', () => {
    const dir = analysisRepo({
      'src/ui/theme.ts': 'export const theme = 1\n',
      'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: 'error: src/data/store.ts: dependency on src/ui/theme.ts violates layer order (Data Persistence -> Presentation)\n',
    })
    expect(JSON.parse(engine(dir, '--check', '--format=json').stdout)).toMatchObject({ status: 'drift', layer_violations: [{ source: 'src/data/store.ts', target: 'src/ui/theme.ts' }] })
  })

  it('does not report a forward edge or an edge within one layer', () => {
    const dir = analysisRepo({
      'src/ui/view.ts': "import { store } from '../data/store'\nimport { theme } from './theme'\nexport const view = [store, theme]\n",
      'src/ui/theme.ts': 'export const theme = 1\n',
      'src/data/store.ts': 'export const store = 2\n',
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  it('reports none when the configured layers are not the five-layer profile', () => {
    const dir = analysisRepo(
      { 'src/ui/theme.ts': 'export const theme = 1\n', 'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n" },
      JSON.stringify({ doc: 'ARCH.md', roots: ['src'], layers: [['src/ui', 'Screens'], ['src/data', 'Storage']] }),
    )
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })
})

describe('sync-arch-docs --check static cycles', () => {
  it('reports each two-module cycle and each self-import, sorted by path', () => {
    const dir = analysisRepo({
      'src/core/y.ts': "import { x } from './x'\nexport const y = x\n",
      'src/core/x.ts': "import { y } from './y'\nexport const x = y\n",
      'src/core/n.ts': "import { m } from './m'\nexport const n = m\n",
      'src/core/m.ts': "import { n } from './n'\nexport const m = n\n",
      'src/core/s.ts': "import { s } from './s'\nexport const s = 1\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({
      status: 1,
      stderr: 'error: static dependency cycle: src/core/m.ts, src/core/n.ts\nerror: static dependency cycle: src/core/s.ts\nerror: static dependency cycle: src/core/x.ts, src/core/y.ts\n',
    })
  })

  it('does not count a function-level import as a cycle edge', () => {
    const dir = analysisRepo({
      'src/core/a.ts': "import { b } from './b'\nexport const a = b\n",
      'src/core/b.ts': "export function load() {\n  const a = require('./a')\n  return a\n}\nexport async function later() {\n  return import('./a')\n}\nexport const b = 1\n",
    })
    const result = engine(dir, '--check')
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
  })

  const mangle = (dir: string): void => {
    const doc = path.join(dir, 'ARCH.md')
    fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace(`${START}\n`, `${START}\n\n`))
  }

  // The layout row is two scenarios split in two so each pays about half of the git starts.
  it('reports the table layout when no other finding is present', () => {
    const plain = analysisRepo({ 'src/core/a.ts': 'export const a = 1\n' })
    mangle(plain)
    expect(engine(plain, '--check').stderr).toBe('error: ARCH.md: table layout differs from generated output, run --write\n')
  })

  it('reports a cycle and not the table layout when both are present', () => {
    const dir = analysisRepo({ 'src/core/a.ts': "import { b } from './b'\nexport const a = b\n", 'src/core/b.ts': "import { a } from './a'\nexport const b = a\n" })
    mangle(dir)
    expect(engine(dir, '--check').stderr).toBe('error: static dependency cycle: src/core/a.ts, src/core/b.ts\n')
  })
})
