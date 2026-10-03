// HAND-DERIVED: the fixture is a two-file git repo indexed here, and the slow enumeration is a clock advance injected around the real getTrackedFiles; the expected counts follow from the budget arithmetic, not from reconcile's own output.
/** `reconcile`'s budget bounds the sweep, so the time spent enumerating the project and opening the index must not be charged to it. The clock used to start before `git ls-files` and the index reads; under a loaded suite (and on a slow machine at session start) those alone took longer than the 1.5 s default, every sweep scanned zero files, and because a sweep that scanned nothing saves no resume point, the next session started from the same place and scanned zero again. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Repomap from '../src/repomap.js'

let virtualNow = 0
const SETUP_COST_MS = 5_000

vi.mock('../src/repomap.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Repomap>()
  return {
    ...actual,
    getTrackedFiles: (cwd?: string) => {
      const files = actual.getTrackedFiles(cwd)
      virtualNow += SETUP_COST_MS
      return files
    },
  }
})

const { getDb } = await import('../src/db.js')
const { indexFileSync } = await import('../src/parser.js')
const { resolveIndexPath } = await import('../src/paths.js')
const { reconcileProject, DEFAULT_RECONCILE_BUDGET_MS } = await import('../src/reconcile.js')

let projectDir: string
let dbPath: string

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-setup-'))
  dbPath = path.join(os.tmpdir(), `tg-reconcile-setup-db-${process.pid}-${Math.random().toString(36).slice(2)}.db`)
  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init', '-q')
  git('config', 'core.autocrlf', 'false')
  for (const name of ['a.ts', 'b.ts']) fs.writeFileSync(path.join(projectDir, name), `export const ${name[0]} = 1\n`)
  git('add', '-A')
  for (const name of ['a.ts', 'b.ts']) indexFileSync(resolveIndexPath(name, projectDir), dbPath)
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    getDb(dbPath).close()
  } catch {
    // Already closed or never opened.
  }
  fs.rmSync(projectDir, { recursive: true, force: true })
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${dbPath}${suffix}`, { force: true })
})

describe('reconcile budget', () => {
  it('still scans the project when enumerating it took longer than the whole budget', () => {
    virtualNow = 0
    vi.spyOn(Date, 'now').mockImplementation(() => virtualNow)
    // Calibration: the injected enumeration cost must exceed the default budget, or a clock started before it would still have time left and this case would prove nothing.
    expect(SETUP_COST_MS).toBeGreaterThan(DEFAULT_RECONCILE_BUDGET_MS)

    const r = reconcileProject({ cwd: projectDir, dbPath, dryRun: true })

    expect(r.scanned, 'the enumeration cost was charged to the scan budget').toBe(2)
    expect(r.budgetExhausted).toBe(false)
    expect(r.unscanned).toBe(0)
    expect(r.changed).toEqual([])
    expect(r.added).toEqual([])
    // Reported time is still the whole call, enumeration included, so the summary line does not understate what the session-start hook waited for.
    expect(r.elapsedMs).toBe(SETUP_COST_MS)
  })
})
