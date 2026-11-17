/** The side-effect label and JSON analysis rows of the architecture documentation engine. Split from architecture_docs_analysis.test.ts so its rows run in a parallel worker; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import { describe, expect, it } from 'vitest'

import { analysisRepo, engine, sideEffectsOf, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

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
