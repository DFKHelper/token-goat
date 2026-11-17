/** The JSON-format rows of the architecture documentation engine. The layer, cycle and side-effect rows are in architecture_docs_layers.test.ts and architecture_docs_effects.test.ts, so each file's rows run in their own parallel worker and carry a share of the git starts a loaded Windows host makes slow; the fixtures are in tests/helpers/arch_docs_fixture.ts. */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { gitOut, engine, scratchRepo, curatedRepo, renamedCuratedRepo, useArchDocFixtures } from '../helpers/arch_docs_fixture.js'

useArchDocFixtures()

describe('sync-arch-docs --check --format=json', () => {
  // src/b.ts carries a curated role, so removing it is also a drop note.
  const GOLDEN_DRIFT =
    '{"curated_at_risk":["drop: discarded role from src/b.ts (module no longer exists)"],"layer_violations":[],"layout_drift":false,"obsolete":["src/b.ts"],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/c.ts"}],"stale":["src/a.ts"],"static_cycles":[],"status":"drift","unmapped":["src/c.ts"]}\n'
  const GOLDEN_RENAME =
    '{"curated_at_risk":["rename: src/b.ts -> src/bb.ts"],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/bb.ts"}],"stale":[],"static_cycles":[],"status":"drift","unmapped":["src/bb.ts"]}\n'
  const GOLDEN_OK =
    '{"curated_at_risk":[],"layer_violations":[],"layout_drift":false,"obsolete":[],"side_effects":[{"labels":["[Pure Domain]"],"module":"src/a.ts"},{"labels":["[Pure Domain]"],"module":"src/b.ts"}],"stale":[],"static_cycles":[],"status":"ok","unmapped":[]}\n'

  it('prints one compact object in the skill key order for an in-sync repo', () => {
    const ok = engine(curatedRepo(), '--check', '--format=json')
    expect({ status: ok.status, stdout: ok.stdout, stderr: ok.stderr }).toEqual({ status: 0, stdout: GOLDEN_OK, stderr: '' })
  })

  it('prints the drift object in the skill key order, byte-identical on two runs', () => {
    const dir = curatedRepo()
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
    const dir = renamedCuratedRepo()
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
