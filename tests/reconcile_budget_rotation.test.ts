/**
 * `reconcileProject` bounds its sweep by a wall-clock budget and, on a project too large to
 * finish inside it, breaks out partway through a deterministic (`git ls-files`) file order. Before
 * this fix there was no resume point: every truncated sweep restarted at index 0, so the same
 * prefix was rescanned and the same tail was skipped forever, across every session, with no way to
 * ever reach it. This file proves the tail becomes reachable across repeated sweeps once a sweep
 * persists where it stopped and the next one resumes from there, and that doing so never turns an
 * unvisited (not-yet-rotated-to) file into a false "removed" report.
 *
 * Determinism: real wall-clock budgets are a flake risk (CPU load, disk cache state, and process
 * startup cost all vary run to run), so this test never depends on real elapsed time. `budgetMs`
 * is real (it is `reconcileProject`'s actual, unmocked option), but the clock it is measured
 * against is a `Date.now` mock driven by a plain incrementing counter: one virtual millisecond
 * per call, so the exact number of files scanned before the budget check trips is deterministic
 * and reproducible byte-for-byte on any machine.
 */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getDb } from '../src/db.js'
import { indexFileSync } from '../src/parser.js'
import { resolveIndexPath } from '../src/paths.js'
import { reconcileProject } from '../src/reconcile.js'

const FILE_NAMES = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts']
const TARGET = 'h.ts'

let projectDir: string
let dbPath: string

function git(...args: string[]): void {
  spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-reconcile-rotation-'))
  dbPath = path.join(os.tmpdir(), `tg-reconcile-rotation-db-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  for (const name of FILE_NAMES) {
    fs.writeFileSync(path.join(projectDir, name), `export const ${name.replace('.ts', '')} = 1\n`)
  }
  git('add', '-A')
  git('commit', '-m', 'init')
  for (const name of FILE_NAMES) {
    // Resolved the same way every real indexing caller (worker.ts, cli.ts, read_commands.ts)
    // resolves a path before handing it to indexFileSync: normalized to forward slashes so it
    // matches the range bound projectScopeClause builds from the normalized project root, rather
    // than a raw OS-style path indexFileSync itself does not normalize.
    indexFileSync(resolveIndexPath(name, projectDir), dbPath)
  }
})

afterEach(() => {
  vi.restoreAllMocks()
  try {
    getDb(dbPath).close()
  } catch {
    // Already closed or never opened.
  }
  fs.rmSync(projectDir, { recursive: true, force: true })
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true })
  }
})

/**
 * Runs one sweep with a `Date.now` mock that advances by exactly one virtual millisecond per
 * call, so a `budgetMs` of `filesPerCall` scans exactly that many files before the budget check
 * trips (or fewer, if the rotated scan order runs out first -- see the file-header comment).
 */
function sweepOnce(filesPerCall: number): ReturnType<typeof reconcileProject> {
  let tick = -1
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => {
    tick++
    return tick
  })
  try {
    return reconcileProject({ cwd: projectDir, dbPath, budgetMs: filesPerCall })
  } finally {
    spy.mockRestore()
  }
}

describe('reconcileProject budget rotation', () => {
  it('reaches a file in the tail across repeated truncated sweeps instead of rescanning the same prefix forever', () => {
    // Drift the last file in git's (alphabetical) tracked-file order after indexing, so it is
    // exactly the file a non-resuming sweep -- which always restarts at index 0 -- would never
    // reach with a budget of 2 files per call over an 8-file project.
    fs.writeFileSync(path.join(projectDir, TARGET), 'export const drifted = 999\n')

    const results = [sweepOnce(2), sweepOnce(2), sweepOnce(2), sweepOnce(2)]

    const changedName = (r: ReturnType<typeof reconcileProject>): string[] => r.changed.map((p) => path.basename(p))

    // Calibration: the mock clock must actually be bounding the sweep to 2 files, or every
    // assertion below proves nothing.
    expect(results[0]?.scanned, 'the mocked clock did not truncate the sweep to 2 files; this case proves nothing').toBe(2)
    expect(results[0]?.budgetExhausted).toBe(true)

    // The first three sweeps (6 files' worth of progress at 2/call over an 8-file project) must
    // not have reached the drifted tail file yet.
    for (let i = 0; i < 3; i++) {
      expect(changedName(results[i] as ReturnType<typeof reconcileProject>), `sweep ${i + 1} already reported the tail file; the calibration above is wrong`).not.toContain(TARGET)
    }

    // The fourth sweep, resuming from where the third left off, must reach and report it.
    expect(changedName(results[3] as ReturnType<typeof reconcileProject>), 'four repeated sweeps never reached the tail file -- no resume point advanced the scan').toContain(TARGET)
  })

  it('never rescans the same prefix forever: the cursor advances every truncated call', () => {
    const results = [sweepOnce(2), sweepOnce(2), sweepOnce(2)]
    // Each sweep's `unscanned` count is scoped to that one call (an honest "this sweep left N
    // unchecked"), not a lifetime total -- rotation does not change what this number means, only
    // how much of the project it is measured against gets a turn. That is the claim the note text
    // still needs to hold: it must still just be tracked.length - scanned for the call, always.
    for (const r of results) {
      expect(r.unscanned).toBe(FILE_NAMES.length - r.scanned)
    }
  })

  it('a completed lap after a mid-list resume still visits every tracked file, so it never reports a live file as removed', () => {
    // First sweep truncates after 2 files (cursor lands mid-list, not at the start or the end).
    const first = sweepOnce(2)
    expect(first.budgetExhausted).toBe(true)
    expect(first.scanned).toBe(2)

    // Second sweep gets a budget generous enough to finish the whole rotated order in one call.
    const second = sweepOnce(100)
    expect(second.budgetExhausted, 'the second sweep did not complete a full lap; this case proves nothing about the completed-lap path').toBe(false)
    // Every one of the 8 tracked files is still on disk and still tracked: a full lap that visited
    // fewer than all 8 (an off-by-one in the rotation slice, say) would silently drop one from
    // seenOnDisk and report it as removed below.
    expect(second.scanned, 'a completed lap did not visit every tracked file after resuming mid-list').toBe(FILE_NAMES.length)
    expect(second.removed, 'a completed lap after a mid-list resume reported a live file as deleted').toEqual([])
  })
})
