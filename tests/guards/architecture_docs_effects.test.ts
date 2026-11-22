/** The side-effect label, JSON analysis and repository-root rows of the architecture documentation engine. Split from architecture_docs_analysis.test.ts so its rows run in a parallel worker; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { repoRoot } from '../../scripts/arch-docs/source.mjs'
import { analysisRepo, engine, gitOut, initializedRepo, scratchDir, scratchDirs, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

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
    const result = engine(dir, '--check', '--format=json')
    expect(result.status).toBe(0)
    expect((JSON.parse(result.stdout) as { side_effects: unknown[] }).side_effects).toEqual([
      { module: 'src/core/both.ts', labels: ['[File / System I/O]', '[CLI / Runtime]'] },
      { module: 'src/core/cli.ts', labels: ['[CLI / Runtime]'] },
      { module: 'src/core/mutating.ts', labels: ['[Oracle Mutating]'] },
      { module: 'src/core/pure.ts', labels: ['[Pure Domain]'] },
      { module: 'src/core/readonly.ts', labels: ['[Oracle Read-Only]'] },
      { module: 'src/core/system.ts', labels: ['[File / System I/O]'] },
      { module: 'src/ui/view.ts', labels: ['[UI / View]'] },
    ])
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

// HAND-DERIVED: each expected root is what `git rev-parse --show-toplevel` prints for the same repository, asked of the real git rather than computed from the engine's walk.
describe('repository root without a git start', () => {
  const gitRoot = (cwd: string): string => path.resolve(gitOut(cwd, ['rev-parse', '--show-toplevel']).trim())

  it('finds the root of a plain repository from a nested directory, as git does', () => {
    const dir = initializedRepo()
    const nested = path.join(dir, 'src', 'core')
    fs.mkdirSync(nested, { recursive: true })
    expect(repoRoot(nested)).toBe(gitRoot(nested))
  })

  it('defers to git when core.worktree moves the work tree away from the .git directory', () => {
    const dir = initializedRepo()
    const elsewhere = scratchDir()
    scratchDirs.push(elsewhere)
    gitOut(dir, ['config', 'core.worktree', elsewhere])
    expect(repoRoot(dir)).toBe(gitRoot(dir))
    expect(repoRoot(dir)).not.toBe(path.resolve(dir))
  })

  it('defers to git when GIT_WORK_TREE names another work tree', () => {
    const dir = initializedRepo()
    const elsewhere = scratchDir()
    scratchDirs.push(elsewhere)
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
    process.env.GIT_DIR = path.join(dir, '.git')
    process.env.GIT_WORK_TREE = elsewhere
    try {
      // HAND-DERIVED: git resolves the work tree through the OS (macOS /private/var, a Windows 8.3 RUNNER~1 name), so both sides are compared as the OS spells them.
      expect(fs.realpathSync.native(repoRoot(dir))).toBe(fs.realpathSync.native(elsewhere))
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  })
})
