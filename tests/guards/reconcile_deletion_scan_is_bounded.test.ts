/**
 * Guard: the deletion scan reads the budget clock on every row, not only on rows that turn out to be deletions.
 *
 * The scan that decides which indexed rows are gone costs a disk stat per row, so it sits under the same budget the change scan does. The trap is where the check goes. A row still on disk takes an early exit, so a clock read placed after that exit is reached only on rows that are deletions -- and an index full of live rows would sail past the bound without ever consulting it. That is the shape this repository keeps shipping: a bound is not a bound when the data decides whether the check is reached.
 *
 * HAND-DERIVED: the clock is a monotonic counter, so "the sweep overran" is arithmetic here rather than a measurement of a real machine under load. Wall-clock timing would make this test a coin flip on a busy runner, which is the one thing a bound's guard must not be.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../../src/db.js'
import { resolveIndexPath } from '../../src/paths.js'
import { indexFileSync } from '../../src/parser.js'
import { reconcileProject } from '../../src/reconcile.js'

/** Untracked, indexed, and still on disk -- the rows that take the early exit and so never reach a clock read placed below it. */
const LIVE_UNTRACKED = 24

let projectDir: string
let dbPath: string

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'tg-recbudget-'))
  dbPath = join(projectDir, 'probe.db')

  writeFileSync(join(projectDir, '.gitignore'), 'scratch/\n')
  writeFileSync(join(projectDir, 'mod.ts'), 'export function trackedAlpha(): number {\n  return 1\n}\n')
  mkdirSync(join(projectDir, 'scratch'))
  for (let i = 0; i < LIVE_UNTRACKED; i++) {
    writeFileSync(join(projectDir, 'scratch', `draft${i}.ts`), `export function draftSymbol${i}(): number {\n  return ${i}\n}\n`)
  }

  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  indexFileSync(resolveIndexPath(join(projectDir, 'mod.ts')), dbPath)
  for (let i = 0; i < LIVE_UNTRACKED; i++) {
    indexFileSync(resolveIndexPath(join(projectDir, 'scratch', `draft${i}.ts`)), dbPath)
  }
  const rows = getDb(dbPath).prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }
  // Calibration: the whole point is that the deletion loop has many live untracked rows to walk. If indexing wrote fewer, an overrun could never be reached and the bound assertion below would pass on an empty walk.
  expect(rows.n).toBe(LIVE_UNTRACKED + 1)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the deletion scan', () => {
  it('completes within a real budget and reports no deletions, since every row is on disk', () => {
    const r = reconcileProject({ cwd: projectDir, dbPath, dryRun: true, budgetMs: 30_000 })
    expect(r.budgetExhausted).toBe(false)
    expect(r.removed).toEqual([])
  })

  it('reads the clock on rows that are still on disk, so a walk of live rows can exhaust the budget', () => {
    // A counter, not a clock: each read advances by a fixed step, so the change scan (one tracked file, a handful of reads) stays inside the budget and the deletion scan's 24 rows cannot.
    let ticks = 0
    vi.spyOn(Date, 'now').mockImplementation(() => ticks++ * 10)

    const r = reconcileProject({ cwd: projectDir, dbPath, dryRun: true, budgetMs: 100 })

    expect(r.budgetExhausted).toBe(true)
    // Not a partial list. An incomplete sweep reports no deletions rather than the prefix it happened to reach, which is the contract the change scan already held.
    expect(r.removed).toEqual([])
  })
})
