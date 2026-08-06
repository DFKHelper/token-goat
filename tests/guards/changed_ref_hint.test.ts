/**
 * Guard against two regressions in `token-goat changed`:
 *
 * (a) `.command('changed')` was registered with no positional argument spec, so Commander
 * silently dropped a `changed <ref>` invocation (the exact form README documents) — the run
 * always fell through to the `HEAD~5` default with no error and no signal the argument was
 * ignored.
 *
 * (b) the `HEAD~5` default fails on any repo with fewer than 6 commits (a fresh checkout, a
 * shallow CI clone, a new project) with raw git stderr that names no working alternative, even
 * though `--since` exists and would fix it.
 *
 * These run the real built bundle against real git fixtures so a severed positional-argument
 * wire, or a hardcoded/non-resolving hint, cannot pass by accident (a mocked `runGit` call
 * sequence could satisfy either without exercising the actual CLI argument plumbing).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { BUNDLE } from '../helpers/bundle.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function commit(cwd: string, file: string, content: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), content)
  git(cwd, ['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(cwd, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message])
}

/** Builds a fresh git repo with the given number of commits, each touching one file. */
function makeRepo(commitCount: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-changed-hint-'))
  tempDirs.push(dir)
  git(dir, ['init'])
  for (let i = 1; i <= commitCount; i++) {
    commit(dir, `f${i}.ts`, `export function f${i}(): number {\n  return ${i}\n}\n`, `commit ${i}`)
  }
  return dir
}

/** Spawns the built bundle with cwd set to a scratch repo (runCli always uses the test runner's cwd). */
function spawnInRepo(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd, encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

describe('changed [ref] positional wiring (exact-count)', () => {
  // This repo is shared across every test in this describe block, so it must not be swept
  // by the module-level afterEach (which clears tempDirs after each individual test) — it
  // gets its own tracking array cleaned up once, after the whole block finishes.
  const repo3Dirs: string[] = []
  let repo3: string

  beforeAll(() => {
    repo3 = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-changed-hint-shared-'))
    repo3Dirs.push(repo3)
    git(repo3, ['init'])
    for (let i = 1; i <= 3; i++) {
      commit(repo3, `f${i}.ts`, `export function f${i}(): number {\n  return ${i}\n}\n`, `commit ${i}`)
    }
  })

  afterAll(() => {
    for (const dir of repo3Dirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    }
  })

  it('changed HEAD~1 resolves the positional ref, not the ignored-argument default path', () => {
    const r = spawnInRepo(repo3, ['changed', 'HEAD~1'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('git diff failed')
    const lines = r.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(lines).toEqual(['f3.ts'])
  })

  it('--since takes precedence over the positional ref in both directions', () => {
    // HEAD~1 vs --since HEAD~2 -> --since wins -> 2 files changed (f2.ts, f3.ts)
    const a = spawnInRepo(repo3, ['changed', 'HEAD~1', '--since', 'HEAD~2'])
    expect(a.status, a.stderr).toBe(0)
    const aFiles = a.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(aFiles.sort()).toEqual(['f2.ts', 'f3.ts'])

    // HEAD~2 vs --since HEAD~1 -> --since wins -> 1 file changed (f3.ts)
    const b = spawnInRepo(repo3, ['changed', 'HEAD~2', '--since', 'HEAD~1'])
    expect(b.status, b.stderr).toBe(0)
    const bFiles = b.stdout.trim().split(/\r?\n/).filter(Boolean)
    expect(bFiles).toEqual(['f3.ts'])

    expect(aFiles.length).not.toBe(bFiles.length)
  })
})

describe('changed default-ref hint on shallow repos (not a constant)', () => {
  it('a 3-commit repo names "3 commits" in the hint', () => {
    const dir = makeRepo(3)
    const r = spawnInRepo(dir, ['changed'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('3 commits')
  })

  it('a 1-commit repo names "1 commit" (singular) in the hint, not "1 commits"', () => {
    const dir = makeRepo(1)
    const r = spawnInRepo(dir, ['changed'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('git diff failed: fatal: ambiguous argument')
    expect(r.stderr).toContain('1 commit')
    expect(r.stderr).not.toContain('1 commits')
  })

  it('the suggested --since ref in the hint actually resolves and runs cleanly (executable-suggestion guard)', () => {
    for (const count of [1, 3]) {
      const dir = makeRepo(count)
      const r = spawnInRepo(dir, ['changed'])
      expect(r.status).toBe(1)
      const match = /token-goat changed --since (\S+)/.exec(r.stderr)
      expect(match, `no suggested-ref line found in stderr:\n${r.stderr}`).not.toBeNull()
      const suggestedRef = match?.[1] as string
      const follow = spawnInRepo(dir, ['changed', '--since', suggestedRef])
      expect(follow.status, follow.stderr).toBe(0)
    }
  })
})

describe('changed bare default in a deep repo stays untouched (byte-identical sanity)', () => {
  it('a 6-commit repo resolves HEAD~5 without a hint appended', () => {
    const dir = makeRepo(6)
    const r = spawnInRepo(dir, ['changed'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stderr).not.toContain('Hint:')
  })
})

