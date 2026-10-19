/** The stop line of `token-goat reconcile` names the budget the sweep was given and shows the elapsed time as such. It used to print the elapsed time where the budget belongs ("Stopped at the 1061ms budget" for a budget of 0). Provenance: HAND-DERIVED. The budget is passed as 0 on the command line, so the expected text is computed from the input and not from the formatter. */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { runTeardown } from './helpers/strict_teardown.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { out: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '0' },
  })
  return { out: res.stdout ?? '', code: res.status ?? -1 }
}

beforeAll(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-budgetmsg-home-'))
  projectDir = indexableDir()
  writeFileSync(join(projectDir, 'one.ts'), 'export const one = 1\n')
  writeFileSync(join(projectDir, 'two.ts'), 'export const two = 2\n')
  expect(spawnSync('git', ['init', '-q'], { cwd: projectDir }).status).toBe(0)
  expect(spawnSync('git', ['add', '-A'], { cwd: projectDir }).status).toBe(0)
  expect(run(['index', '.']).code, 'indexing the fixture failed').toBe(0)
}, 60_000)

afterAll(() => {
  runTeardown([() => rmSync(homeDir, { recursive: true, force: true })])
})

describe('reconcile stop message', () => {
  it('names the budget it was given, then the elapsed time as elapsed', () => {
    const { out } = run(['reconcile', '--dry-run', '--budget-ms', '0'])

    expect(out, 'the stop line did not name the 0ms budget it was given').toMatch(/^Stopped at the 0ms budget \(\d+ms elapsed\) with /m)
  }, 60_000)

  it('reports the budget in the JSON result beside the elapsed time', () => {
    const { out } = run(['reconcile', '--dry-run', '--budget-ms', '0', '--json'])
    const result = JSON.parse(out) as { budgetMs?: number; elapsedMs?: number }

    expect(result.budgetMs).toBe(0)
    expect(typeof result.elapsedMs).toBe('number')
  }, 60_000)
})
