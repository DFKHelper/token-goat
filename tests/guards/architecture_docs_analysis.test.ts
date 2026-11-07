/** The JSON-format and architecture-analysis rows (layer order, static cycles, side effects) of the architecture documentation engine. Split from architecture_docs.test.ts so its rows run in a parallel worker; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { START, END, DOC_HEAD, DOC_TAIL, gitOut, scratchDirs, engine, scratchRepo, curatedRepo, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

describe('sync-arch-docs --check --format=json', () => {
  // src/b.ts carries a curated role, so removing it is also a drop note.
  const GOLDEN_DRIFT =
    '{"curated_at_risk":["drop: discarded role from src/b.ts (module no longer exists)"],"layer_violations":[],"layout_drift":false,"obsolete":["src/b.ts"],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/c.ts"}],"stale":["src/a.ts"],"static_cycles":[],"status":"drift","unmapped":["src/c.ts"]}\n'
  const GOLDEN_RENAME =
    '{"curated_at_risk":["rename: src/b.ts -> src/bb.ts"],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/bb.ts"}],"stale":[],"static_cycles":[],"status":"drift","unmapped":["src/bb.ts"]}\n'
  const GOLDEN_OK =
    '{"curated_at_risk":[],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/b.ts"}],"stale":[],"static_cycles":[],"status":"ok","unmapped":[]}\n'

  it('prints one compact object with the skill keys in order, byte-identical on two runs', () => {
    const dir = curatedRepo()
    const ok = engine(dir, '--check', '--format=json')
    expect({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }).toEqual({ status: 0, stdout: GOLDEN_OK, stderr: '' })
    fs.appendFileSync(path.join(dir, 'src', 'a.ts'), 'export const omega = 3\n')
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), 'export const delta = 4\n')
    gitOut(dir, ['add', '-A'])
    gitOut(dir, ['rm', '-q', '-f', 'src/b.ts'])
    const first = engine(dir, '--check', '--format=json')
    const second = engine(dir, '--check', '--format', 'json')
    expect(first.stdout).toBe(GOLDEN_DRIFT)
    expect(second).toEqual(first)
    expect(first.status).toBe(1)
    expect(first.stderr).toBe('')
  })

  it('fills curated_at_risk with the rename note and keeps the exit code of the text format', () => {
    const dir = curatedRepo()
    gitOut(dir, ['mv', 'src/b.ts', 'src/bb.ts'])
    const json = engine(dir, '--check', '--format=json')
    expect({ status: json.status, stdout: json.stdout, stderr: json.stderr }).toEqual({ status: 1, stdout: GOLDEN_RENAME, stderr: '' })
    expect(engine(dir, '--check').status).toBe(1)
  })

  it('exits 2 for a format that is not text or json, or json outside --check', () => {
    const dir = scratchRepo()
    const yaml = engine(dir, '--check', '--format=yaml')
    expect(yaml.status).toBe(2)
    expect(yaml.stderr).toContain('error: --format must be text or json, got "yaml"')
    const jsonWrite = engine(dir, '--write', '--format=json')
    expect(jsonWrite.status).toBe(2)
    expect(jsonWrite.stderr).toContain('error: --format json applies only to --check')
    const missing = engine(dir, '--check', '--format')
    expect(missing.status).toBe(2)
    expect(missing.stderr).toContain('error: --format requires a value')
  })
})
// FIXTURE PROVENANCE (architecture analysis). Every module source below is HAND-DERIVED: written by hand so the expected finding follows from SKILL.md "Architectural Analysis Contract" (arch-doc-sync skill: "Side-Effect Taxonomy", "Inward-Only Layer Boundaries", "Static Circular Dependencies"), not read off the engine's output. The finding wording is FORMAT-DERIVED from SKILL.md "--check Output Contract" items 4 and 5, and the JSON golden from its JSON paragraph (key order, labels in taxonomy order, arrays sorted).
const LAYERED_CONFIG = JSON.stringify({
  doc: 'ARCH.md',
  roots: ['src'],
  layers: [['src/ui', 'Presentation'], ['src/core', 'Domain Core'], ['src/data', 'Data Persistence']],
})

/** A repo of the given modules under the OS temp dir with its table already written, so only the analysis can make `--check` report. */
function analysisRepo(files: Record<string, string>, config = LAYERED_CONFIG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-archdoc-'))
  scratchDirs.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text)
  }
  fs.writeFileSync(path.join(dir, '.arch-doc-sync.json'), config)
  fs.writeFileSync(path.join(dir, 'ARCH.md'), `${DOC_HEAD}${START}\n${END}\n${DOC_TAIL}`)
  gitOut(dir, ['init', '-q'])
  gitOut(dir, ['add', '.'])
  expect(engine(dir, '--write').status).toBe(0)
  return dir
}

const sideEffectsOf = (dir: string): { module: string; labels: string[] }[] =>
  (JSON.parse(engine(dir, '--check', '--format=json').stdout) as { side_effects: { module: string; labels: string[] }[] }).side_effects

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

  it('reports the table layout only when no other finding is present', () => {
    const cyclic = { 'src/core/a.ts': "import { b } from './b'\nexport const a = b\n", 'src/core/b.ts': "import { a } from './a'\nexport const b = a\n" }
    const mangle = (dir: string): void => {
      const doc = path.join(dir, 'ARCH.md')
      fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace(`${START}\n`, `${START}\n\n`))
    }
    const plain = analysisRepo({ 'src/core/a.ts': 'export const a = 1\n' })
    mangle(plain)
    expect(engine(plain, '--check').stderr).toBe('error: ARCH.md: table layout differs from generated output, run --write\n')
    const dir = analysisRepo(cyclic)
    mangle(dir)
    expect(engine(dir, '--check').stderr).toBe('error: static dependency cycle: src/core/a.ts, src/core/b.ts\n')
  })
})

describe('sync-arch-docs --check side effects', () => {
  const FILES: Record<string, string> = {
    'src/core/mutating.ts': "export const sql = 'INSERT INTO t VALUES (1)'\n",
    'src/core/readonly.ts': "// uses oracledb\nexport const sql = 'SELECT id FROM users'\n",
    'src/core/system.ts': "import fs from 'node:fs'\nexport const text = fs.readFileSync('x', 'utf8')\n",
    'src/ui/view.ts': 'export const view = () => render()\n',
    'src/core/cli.ts': 'export const args = process.argv.slice(2)\n',
    'src/core/pure.ts': 'export const add = (a: number, b: number) => a + b\n',
    'src/core/both.ts': "import fs from 'node:fs'\nexport const both = [fs.readFileSync('x', 'utf8'), process.argv]\n",
  }

  it('labels each one-file module, in taxonomy order, and gives [Pure Domain] only to a module with no other label', () => {
    const dir = analysisRepo(FILES)
    expect(sideEffectsOf(dir)).toEqual([
      { module: 'src/core/both.ts', labels: ['[File / System I/O]', '[CLI / Runtime]'] },
      { module: 'src/core/cli.ts', labels: ['[CLI / Runtime]'] },
      { module: 'src/core/mutating.ts', labels: ['[Oracle Mutating]'] },
      { module: 'src/core/pure.ts', labels: ['[Pure Domain]'] },
      { module: 'src/core/readonly.ts', labels: ['[Oracle Read-Only]'] },
      { module: 'src/core/system.ts', labels: ['[File / System I/O]'] },
      { module: 'src/ui/view.ts', labels: ['[UI / View]'] },
    ])
    expect(engine(dir, '--check').status).toBe(0)
  })
})

describe('sync-arch-docs --check --format=json analysis', () => {
  const pure = (module: string): string => `{"labels":["[Pure Domain]"],"module":"${module}"}`
  const GOLDEN =
    '{"curated_at_risk":[],"layer_violations":[{"source":"src/data/store.ts","source_layer":"Data Persistence","target":"src/ui/theme.ts","target_layer":"Presentation"}],"layout_drift":false,"obsolete":[],"side_effects":[' +
    [pure('src/core/a.ts'), pure('src/core/b.ts'), pure('src/data/store.ts'), pure('src/ui/theme.ts')].join(',') +
    '],"stale":[],"static_cycles":[["src/core/a.ts","src/core/b.ts"]],"status":"drift","unmapped":[]}\n'

  it('carries the layer violation, the cycle and the labels byte for byte, identically on two runs', () => {
    const dir = analysisRepo({
      'src/core/a.ts': "import { b } from './b'\nexport const a = b\n",
      'src/core/b.ts': "import { a } from './a'\nexport const b = a\n",
      'src/data/store.ts': "import { theme } from '../ui/theme'\nexport const store = theme\n",
      'src/ui/theme.ts': 'export const theme = 1\n',
    })
    const first = engine(dir, '--check', '--format=json')
    const second = engine(dir, '--check', '--format=json')
    expect({ status: first.status, stdout: first.stdout, stderr: first.stderr }).toEqual({ status: 1, stdout: GOLDEN, stderr: '' })
    expect(second).toEqual(first)
  })
})
