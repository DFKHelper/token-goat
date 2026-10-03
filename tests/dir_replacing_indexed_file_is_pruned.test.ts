/** An indexed file replaced by a directory of the same name is a deletion. `reconcile` stat'ed the path and counted only ENOENT/ENOTDIR as gone, so a directory standing there read as "still on disk" and reported clean, and the worker drain judged it by `fileIsAbsent` (ENOENT only), failed to fingerprint it, logged a transient read failure and gave up after its retries -- `symbol gammaFn` kept resolving the old file for good. Provenance: CAPTURE. Every case runs the real built bundle for indexing and reconcile and the production-default worker drain (no injected index or remove callback), against a real git repository whose file is really replaced by a directory on the real filesystem. The expected symbol names are HAND-DERIVED from the fixture text. The unreadable-file counterpart (an existing file that cannot be examined must NOT be pruned) stays pinned by tests/guards/unreadable_file_is_not_pruned.test.ts. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dirtyQueuePathFor } from '../src/dirty_queue.js'
import { indexedFileIsGone } from '../src/fingerprint.js'
import { querySymbols } from '../src/index_reader.js'
import { normalizePath } from '../src/paths.js'
import { drainOnce, pendingEmbeddings } from '../src/worker.js'
import { findGlobalDb } from './helpers/find_global_db.js'
import { indexableDir } from './helpers/temp-config.js'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

function isolatedEnv(homeDir: string): NodeJS.ProcessEnv {
  return { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir }
}

function git(projectDir: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
}

function tg(projectDir: string, homeDir: string, ...args: string[]): string {
  const r = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: projectDir, encoding: 'utf-8', env: isolatedEnv(homeDir) })
  expect(r.status, `token-goat ${args.join(' ')} exited ${r.status}: ${r.stderr}`).toBe(0)
  return r.stdout
}

/** A git project whose src/c.ts defines gammaFn, indexed through the built bundle, then c.ts replaced by a directory holding inner.ts. */
function projectWithFileReplacedByDirectory(homeDir: string): { projectDir: string; replaced: string; dbPath: string } {
  const projectDir = indexableDir()
  mkdirSync(join(projectDir, 'src'))
  writeFileSync(join(projectDir, 'src', 'c.ts'), 'export function gammaFn(): number {\n  return 3\n}\n')
  writeFileSync(join(projectDir, 'src', 'keep.ts'), 'export function keepFn(): number {\n  return 4\n}\n')
  git(projectDir, 'init', '-q')
  git(projectDir, 'add', '-A')
  tg(projectDir, homeDir, 'index', '.')
  const dbPath = findGlobalDb(homeDir) as string
  const replaced = join(projectDir, 'src', 'c.ts')
  // Calibration: the symbol is served before the replacement, so its absence afterwards can only come from the prune.
  expect(querySymbols({ name: 'gammaFn' }, dbPath)).toHaveLength(1)
  rmSync(replaced)
  mkdirSync(replaced)
  writeFileSync(join(replaced, 'inner.ts'), 'export function innerFn(): number {\n  return 5\n}\n')
  return { projectDir, replaced, dbPath }
}

describe('indexedFileIsGone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-gone-'))
  writeFileSync(join(dir, 'plain.ts'), 'export const x = 1\n')
  mkdirSync(join(dir, 'folder.ts'))

  it('is false for a regular file', () => {
    expect(indexedFileIsGone(join(dir, 'plain.ts'))).toBe(false)
  })

  it('is true for a missing path and for a path under a file (ENOENT, ENOTDIR)', () => {
    expect(indexedFileIsGone(join(dir, 'never-written.ts'))).toBe(true)
    expect(indexedFileIsGone(join(dir, 'plain.ts', 'child.ts'))).toBe(true)
  })

  it('is true for a directory standing at the path', () => {
    expect(indexedFileIsGone(join(dir, 'folder.ts'))).toBe(true)
  })
})

describe('an indexed file replaced by a directory', () => {
  it('is reported removed by reconcile and pruned by the production drain', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-dirrepl-home-'))
    const { projectDir, dbPath } = projectWithFileReplacedByDirectory(homeDir)
    git(projectDir, 'add', '-A')

    const report = JSON.parse(tg(projectDir, homeDir, 'reconcile', '--json')) as { removed: string[] }
    // The report lists paths relative to the project root.
    expect(report.removed.map((p) => normalizePath(p)), 'reconcile read a directory at an indexed path as still on disk').toEqual(['src/c.ts'])

    const dataDir = dirname(dbPath)
    // The daemon's own drain: no injected callbacks, so makeIndexer and makeRemover are the production defaults.
    drainOnce(dataDir)
    await pendingEmbeddings()
    expect(querySymbols({ name: 'gammaFn' }, dbPath), 'the directory-replaced file still serves its old symbols').toEqual([])
    expect(querySymbols({ name: 'keepFn' }, dbPath), 'the prune took an untouched file with it').toHaveLength(1)
  }, 60_000)

  it('is pruned by the drain on first sight, not logged as a transient read failure', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'tg-dirrepl-drain-'))
    const { replaced, dbPath } = projectWithFileReplacedByDirectory(homeDir)
    const dataDir = dirname(dbPath)
    const queue = dirtyQueuePathFor(dataDir)
    mkdirSync(dirname(queue), { recursive: true })
    writeFileSync(queue, `${normalizePath(replaced)}\n`)

    drainOnce(dataDir)
    await pendingEmbeddings()

    expect(querySymbols({ name: 'gammaFn' }, dbPath), 'the directory-replaced file still serves its old symbols after one drain').toEqual([])
    expect(existsSync(queue) ? readFileSync(queue, 'utf8').trim() : '', 'the path was requeued as if it were a transient failure').toBe('')
    const errorLog = join(dataDir, 'worker-errors.log')
    expect(existsSync(errorLog) ? readFileSync(errorLog, 'utf8') : '', 'the drain logged the directory as a transient read failure').not.toContain('transient read failure')
  }, 60_000)
})
