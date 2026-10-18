/** A reconcile resume row whose project left without a known_roots row to retry on was never collected: the per-root purge runs from that row. Fixture provenance: CAPTURE for the scan row (written by a real reconcileProject run on a scratch git repo at a 0 ms budget, read back from the table), HAND-DERIVED for the deletion-pass row (the key shape, root + NUL + deletions, is read off the producer in src/reconcile.ts, a source file and not a shipped build). */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { closeAllDbs, getDb } from '../src/db.js'
import { sweepKnownRoots } from '../src/index_prune.js'
import { reconcileProject } from '../src/reconcile.js'
import { indexableDir } from './helpers/temp-config.js'

const NUL = String.fromCharCode(0)

let projectDir: string
let dataDir: string
let dbPath: string

function git(...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

/** Every cursor key, whole (hex, because the driver cuts a TEXT value at its first NUL). */
function cursorKeys(): string[] {
  return (getDb(dbPath).prepare('SELECT hex(root) AS h FROM reconcile_cursor').all() as Array<{ h: string }>).map((r) => Buffer.from(r.h, 'hex').toString('utf8')).sort()
}

/** The scan row a real truncated sweep leaves: two tracked files and a 0 ms budget, so the sweep stops after the first and saves where it was. */
function produceScanCursor(): string {
  fs.writeFileSync(path.join(projectDir, 'a.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(projectDir, 'b.ts'), 'export const b = 1\n')
  git('add', '-A')
  reconcileProject({ cwd: projectDir, dbPath, budgetMs: 0, queueDir: dataDir })
  const keys = cursorKeys()
  expect(keys.length, 'calibration: the producer should leave exactly one scan row').toBe(1)
  return keys[0]!
}

function removeProject(): void {
  fs.rmSync(projectDir, { recursive: true, force: true })
}

beforeEach(() => {
  projectDir = indexableDir()
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-orphan-cursor-'))
  dbPath = path.join(dataDir, 'global.db')
  git('init', '-q')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
})

afterEach(() => {
  closeAllDbs()
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.rmSync(projectDir, { recursive: true, force: true })
})

describe('reconcile cursors with no known_roots row', () => {
  it('a sweep collects the rows of a project whose directory is gone, scan row and deletion-pass row alike', () => {
    const scanKey = produceScanCursor()
    getDb(dbPath).prepare('INSERT INTO reconcile_cursor (root, last_scanned_path, updated_at) VALUES (?, ?, 0)').run(`${scanKey}${NUL}deletions`, `${scanKey}/b.ts`)
    removeProject()

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })

    expect(cursorKeys(), 'a cursor row of a project that is gone survived the sweep').toEqual([])
  })

  it('keeps the rows of a project whose directory still stands, so its scan keeps resuming', () => {
    const scanKey = produceScanCursor()

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })

    expect(cursorKeys(), 'a live project lost its resume point').toEqual([scanKey])
  })

  it('leaves a gone project that still has a known_roots row to that row\'s grace, whose purge is the per-root branch', () => {
    const scanKey = produceScanCursor()
    getDb(dbPath).prepare('INSERT INTO known_roots (root, last_seen_ms, first_missing_ms) VALUES (?, 0, NULL)').run(scanKey)
    removeProject()

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000 })

    expect(cursorKeys(), 'the orphan pass took a registered root\'s rows before its grace ran out').toEqual([scanKey])
  })

  it('a dry run keeps them', () => {
    const scanKey = produceScanCursor()
    removeProject()

    sweepKnownRoots(dbPath, { now: 2000, missingGraceMs: 1000, dryRun: true })

    expect(cursorKeys()).toEqual([scanKey])
  })
})
