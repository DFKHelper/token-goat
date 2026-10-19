/** Built-bundle check that `refs file::symbol` stays in the project owning the file and lists a call made through an import alias: the shipped dist/token-goat.mjs, not source, indexes two sibling projects into one data dir and answers from them. Provenance: the code shapes are HAND-DERIVED (written here from the reporter's description). The `test_label_store_*` name and the sibling-project shape are CAPTURE: the 2.9.31 output the reporter saw for `refs src/snapshots.ts::store --callers` listed two rows of a Python test file in another project and missed `src/hooks_read_post.ts`, which imports `store as snapshotStore`. */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bundleTg, makeBundleProject } from './helpers/bundle.js'

let root: string
let projectA: string
let projectB: string
let env: NodeJS.ProcessEnv

function tg(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return bundleTg(cwd, env, args)
}

beforeAll(() => {
  ;({ root, project: projectA, env } = makeBundleProject('tg-refsscope-bundle-'))
  projectB = path.join(root, 'project_b')
  fs.mkdirSync(projectB, { recursive: true })
  fs.mkdirSync(path.join(projectA, '.git'))
  fs.mkdirSync(path.join(projectB, '.git'))
  fs.writeFileSync(path.join(projectA, 'snapshots.ts'), 'export function store(value: number): number {\n  return value\n}\n')
  fs.writeFileSync(path.join(projectA, 'consumer.ts'), "import { store as snapshotStore } from './snapshots.js'\n\nexport function saveAll(): number {\n  return snapshotStore(1)\n}\n")
  fs.writeFileSync(path.join(projectB, 'test_snapshots.py'), 'def test_label_store_roundtrip():\n    assert store(1) == 1\n')
  for (const dir of [projectA, projectB]) {
    const idx = tg(dir, ['index', '.', '--walk'])
    expect(idx.status, idx.stderr).toBe(0)
  }
})

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('the built bundle answers refs for a file spec from its own project', () => {
  it('--callers lists the aliased caller and nothing from the sibling project', () => {
    const r = tg(projectA, ['refs', 'snapshots.ts::store', '--callers'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('consumer.ts')
    expect(r.stdout).toContain('saveAll')
    expect(r.stdout).not.toContain('test_label_store')
    expect(r.stdout).not.toContain('project_b')
  })

  it('the plain form lists the aliased caller too', () => {
    const r = tg(projectA, ['refs', 'snapshots.ts::store'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('consumer.ts')
    expect(r.stdout).not.toContain('test_label_store')
  })

  it('a bare name is still searched machine-wide', () => {
    const r = tg(projectA, ['refs', 'store'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain('consumer.ts')
    expect(r.stdout).toContain('test_label_store')
  })
})
