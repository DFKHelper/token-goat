/**
 * Guard: `reconcile` may only report a file as removed when that file is actually gone from disk.
 *
 * Two entry points write `files` rows and they do not agree on what belongs in the index. `token-goat index` enumerates a project with `git ls-files`, so it lists tracked files and nothing else. The incremental path indexes whatever the agent touches: a `read` of a gitignored draft, an edit to a file not yet `git add`ed, a stale-index self-heal. Both are deliberate, and the rows the second one writes are perfectly good rows pointing at files that exist.
 *
 * `reconcileProject` then compares the index against the tracked list and calls the difference a deletion. Every one of those live-file rows was reported gone and queued for removal on every sweep, the next read put the row straight back, and the next sweep removed it again. Measured on this repository's own index at the time of the fix: 228 of its 1,628 rows were untracked -- 201 under `scratch/`, 12 under `.claude/`, 5 under `node_modules/`, the rest loose unstaged files -- and all 228 existed on disk, so a single sweep reported all 228 as deletions. After the fix the same sweep reports none. The function's own comment calls enqueueing a live file for removal the one mistake here that destroys working index rows, and the set it consults is named `seenOnDisk`: the intent was always disk absence, only the population was git's.
 *
 * CAPTURE: the fixture is a real git repository built on disk, indexed by spawning the built bundle, with the ignored file's row written by a real `token-goat read` -- not by calling the indexer directly. Nothing here is derived from reconcile's own source.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

const BUNDLE = join(process.cwd(), 'dist', 'token-goat.mjs')

let projectDir: string
let homeDir: string

function run(args: string[]): { out: string; err: string; code: number } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: projectDir,
    encoding: 'utf-8',
    env: { ...process.env, TOKEN_GOAT_HOME: homeDir, LOCALAPPDATA: homeDir, XDG_DATA_HOME: homeDir, TOKEN_GOAT_NO_WORKER_SPAWN: '1', TOKEN_GOAT_BASH_COMPRESS: '0' },
  })
  return { out: res.stdout ?? '', err: res.stderr ?? '', code: res.status ?? -1 }
}

function sweep(): { removed: string[]; added: string[]; changed: string[] } {
  const r = run(['reconcile', '--dry-run', '--budget-ms', '30000', '--json'])
  try {
    return JSON.parse(r.out) as { removed: string[]; added: string[]; changed: string[] }
  } catch {
    return expect.fail(`reconcile --json emitted no JSON.\nstdout: ${r.out.slice(0, 400)}\nstderr: ${r.err.slice(0, 400)}`)
  }
}

const IGNORED = join('scratch', 'draft.ts')

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'tg-recdel-home-'))
  projectDir = mkdtempSync(join(tmpdir(), 'tg-recdel-'))

  writeFileSync(join(projectDir, '.gitignore'), 'scratch/\n')
  writeFileSync(join(projectDir, 'mod.ts'), 'export function trackedAlpha(): number {\n  return 1\n}\n')
  mkdirSync(join(projectDir, 'scratch'))
  writeFileSync(join(projectDir, IGNORED), 'export function ignoredBeta(): number {\n  return 2\n}\n')

  const git = (...args: string[]): void => {
    spawnSync('git', args, { cwd: projectDir, encoding: 'utf-8' })
  }
  git('init')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 'T')
  git('add', '-A')

  const indexed = run(['index', '.'])
  expect(indexed.code, `indexing the fixture failed: ${indexed.err.slice(0, 400)}`).toBe(0)

  // The incremental path, driven the way the product drives it: reading a symbol out of a file the tracked-file walk never listed makes the index heal itself, which is what writes the row this guard is about.
  const read = run(['read', `${IGNORED.replace(/\\/g, '/')}::ignoredBeta`])
  expect(read.out, `reading the gitignored file did not return its symbol: ${read.err.slice(0, 400)}`).toContain('ignoredBeta')
})

describe('reconcile deletion detection', () => {
  it('indexes the gitignored file through the read path, so the rest of this file is not measuring an empty set', () => {
    // Calibration. If the read above stopped writing a row -- a changed heal condition, a changed path spelling -- every assertion below would pass with nothing to detect, which is the exact shape of a guard whose population emptied silently.
    const before = sweep()
    rmSync(join(projectDir, IGNORED))
    const after = sweep()
    expect(after.removed.length).toBe(before.removed.length + 1)
  })

  it('does not report a live gitignored file as removed', () => {
    expect(sweep().removed).toEqual([])
  })

  it('reports the gitignored file once it really leaves the disk', () => {
    rmSync(join(projectDir, IGNORED))
    expect(existsSync(join(projectDir, IGNORED))).toBe(false)
    expect(sweep().removed.map((p) => p.replace(/\\/g, '/')).some((p) => p.endsWith('scratch/draft.ts'))).toBe(true)
  })

  it('leaves a deleted tracked file to the change path rather than the removal path', () => {
    // A tracked file is still listed by `git ls-files` after being deleted from the worktree, so it never reaches the removal loop at all -- it is queued as changed and the worker's own read decides. Pinned because it is the boundary the fix moves against: if a later change made the removal loop authoritative for tracked files too, this is what would tell.
    rmSync(join(projectDir, 'mod.ts'))
    const after = sweep()
    expect(after.changed.map((p) => p.replace(/\\/g, '/')).some((p) => p.endsWith('mod.ts'))).toBe(true)
    expect(after.removed).toEqual([])
  })
})
