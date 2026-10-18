/** A reconcile sweep with no time left (a 0 ms budget stands in for a machine that spent it all before the deletion pass, with no clock read) still examines one indexed row that git no longer lists, and resumes after it on the next sweep, so every deleted file is pruned within as many sweeps as there are candidate rows. Provenance: HAND-DERIVED. The row counts come from the fixture below, and the budget is passed as 0. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { closeAllDbs } from '../src/db.js'
import { querySymbols } from '../src/index_reader.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { runTeardown } from './helpers/strict_teardown.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

const homes: string[] = []

afterEach(() => {
  const doomed = homes.splice(0)
  runTeardown([closeAllDbs, ...doomed.map((home) => () => rmSync(home, { recursive: true, force: true }))])
})

function git(projectDir: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

function body(name: string): string {
  return `export function ${name}(): number {\n  return 1\n}\n`
}

interface Fixture {
  projectDir: string
  dbPath: string
  dataDir: string
}

/** Two tracked files plus `deleted` files that were indexed and then removed from git and disk, indexed through the built bundle. */
function fixture(deleted: string[]): Fixture {
  const homeDir = mkdtempSync(join(tmpdir(), 'tg-delprogress-home-'))
  homes.push(homeDir)
  const projectDir = indexableDir()
  writeFileSync(join(projectDir, 'keep1.ts'), body('keepOne'))
  writeFileSync(join(projectDir, 'keep2.ts'), body('keepTwo'))
  for (const name of deleted) writeFileSync(join(projectDir, `${name}.ts`), body(`${name}Fn`))
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  const env = { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_NO_WORKER_SPAWN: '1' }
  const r = spawnSync(process.execPath, [BUNDLE, 'index', '.'], { cwd: projectDir, encoding: 'utf-8', env })
  expect(r.status, `index exited ${r.status}: ${r.stderr}`).toBe(0)
  const dbPath = findGlobalDb(homeDir) as string
  for (const name of deleted) {
    expect(querySymbols({ name: `${name}Fn` }, dbPath), `calibration: ${name}Fn was not indexed`).toHaveLength(1)
    git(projectDir, 'rm', '-qf', `${name}.ts`)
  }
  return { projectDir, dbPath, dataDir: dirname(dbPath) }
}

/** One zero-budget sweep, then the production drain that prunes what it queued. */
async function sweepAndDrain(fx: Fixture): Promise<ReturnType<typeof reconcileProject>> {
  const result = reconcileProject({ cwd: fx.projectDir, dbPath: fx.dbPath, queueDir: fx.dataDir, budgetMs: 0 })
  drainOnce(fx.dataDir)
  await pendingEmbeddings()
  return result
}

function stillIndexed(fx: Fixture, names: string[]): string[] {
  return names.filter((name) => querySymbols({ name: `${name}Fn` }, fx.dbPath).length > 0)
}

describe('reconcileProject deletion pass under a spent budget', () => {
  it('prunes the one deleted file after one sweep', async () => {
    const fx = fixture(['gone1'])

    const result = await sweepAndDrain(fx)

    expect(result.removed.map((p) => p.replace(/^.*[\\/]/, '')), 'the deletion pass never stat-ed the deleted row').toEqual(['gone1.ts'])
    expect(stillIndexed(fx, ['gone1']), 'the deleted file still serves its symbols after one sweep').toEqual([])
    expect(querySymbols({ name: 'keepOne' }, fx.dbPath), 'the prune took a live file with it').toHaveLength(1)
  }, 90_000)

  it('prunes every one of N deleted files within N sweeps', async () => {
    const names = ['gone1', 'gone2', 'gone3']
    const fx = fixture(names)

    for (let sweep = 1; sweep <= names.length; sweep++) {
      const before = stillIndexed(fx, names).length
      await sweepAndDrain(fx)
      expect(stillIndexed(fx, names).length, `sweep ${sweep} pruned nothing`).toBeLessThan(before)
    }

    expect(stillIndexed(fx, names), 'a deleted file survived N sweeps').toEqual([])
  }, 90_000)

  it('moves past a live untracked row that sorts first instead of re-checking it forever', async () => {
    const fx = fixture(['gone1'])
    // Ignored by git so `git ls-files` never lists it, and in a directory that sorts before gone1.ts so the pass meets it first.
    writeFileSync(join(fx.projectDir, '.gitignore'), 'aaa_ignored/\n')
    mkdirSync(join(fx.projectDir, 'aaa_ignored'))
    writeFileSync(join(fx.projectDir, 'aaa_ignored', 'live.ts'), body('aLive'))
    indexFileSync(resolveIndexPath('aaa_ignored/live.ts', fx.projectDir), fx.dbPath)
    expect(querySymbols({ name: 'aLive' }, fx.dbPath), 'calibration: the live untracked row was not indexed').toHaveLength(1)

    await sweepAndDrain(fx)
    await sweepAndDrain(fx)

    expect(stillIndexed(fx, ['gone1']), 'the sweep re-examined the live row first every time and never reached the deleted one').toEqual([])
    expect(querySymbols({ name: 'aLive' }, fx.dbPath), 'the prune took the live untracked row with it').toHaveLength(1)
  }, 90_000)
})
