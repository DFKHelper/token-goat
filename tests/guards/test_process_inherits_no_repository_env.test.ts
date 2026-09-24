/** The suite must never run a git command against a repository chosen by the environment it was launched from. Git exports `GIT_INDEX_FILE` to every hook, and `GIT_DIR` as an absolute path whenever the commit is made from a linked worktree. The pre-commit hook runs this guard suite and the pre-push hook runs everything, so a suite that inherits those variables sends every scratch-repository fixture to the repository being committed. Measured on one worktree commit before tests/setup/isolate-home.ts scrubbed more than `GIT_INDEX_FILE`: nine fixture commits on the worktree's branch, its index replaced by fixture files, the shared `.git/config` rewritten with the fixtures' identity and `core.bare = true`, and the main checkout refusing every work-tree command until that was undone by hand. */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { REPO_LOCAL_GIT_ENV_VARS, scrubRepoLocalGitEnv } from '../helpers/git-env.js'

const scratchDirs: string[] = []

function scratch(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=', ...args], { cwd, env, stdio: 'ignore' })
}

function configOf(repo: string): string {
  return fs.readFileSync(path.join(repo, '.git', 'config'), 'utf8')
}

/** What a scratch-repository fixture does first, run under `env`. */
function buildFixture(env: NodeJS.ProcessEnv): string {
  const dir = scratch('tg-gitenv-fixture-')
  git(dir, env, 'init')
  git(dir, env, 'config', 'user.name', 'Leaked Fixture')
  return dir
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('the test process inherits no repository-location environment', () => {
  it('scrubs every variable the installed git lists as repository-local', () => {
    const live = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .filter((name) => name !== '')
    expect(live.length, 'git printed no repository-local variables, so the comparison below is empty').toBeGreaterThan(5)
    expect(live.filter((name) => !(REPO_LOCAL_GIT_ENV_VARS as readonly string[]).includes(name)), 'git lists repository-local variables tests/helpers/git-env.ts does not scrub').toEqual([])
  })

  it('carries none of them into this process', () => {
    // Only non-vacuous when the suite is launched from a hook, which is exactly when the pre-commit tier runs this file.
    expect(REPO_LOCAL_GIT_ENV_VARS.filter((name) => process.env[name] !== undefined)).toEqual([])
  })

  it('a scratch repository built under a worktree hook environment stays in its own directory once scrubbed', () => {
    const victim = scratch('tg-gitenv-victim-')
    git(victim, { ...process.env }, 'init')
    const pristine = configOf(victim)
    const hookEnv = { ...process.env, GIT_DIR: path.join(victim, '.git') }

    // Calibration: unscrubbed, the fixture's init and config land in the victim, so a clean victim below is the scrub's doing and not a probe that cannot see the leak.
    const leaked = buildFixture(hookEnv)
    expect(fs.existsSync(path.join(leaked, '.git')), 'the unscrubbed fixture made its own repository, so this probe no longer reproduces the leak').toBe(false)
    // The leaked identity is the calibration; `core.bare = true`, which the recorded incident also showed, is written by git 2.53 but not by 2.55, so it is not asserted.
    expect(configOf(victim)).toContain('Leaked Fixture')

    fs.writeFileSync(path.join(victim, '.git', 'config'), pristine)
    const env = { ...hookEnv }
    scrubRepoLocalGitEnv(env)
    const contained = buildFixture(env)
    expect(configOf(contained)).toContain('Leaked Fixture')
    expect(configOf(victim)).toBe(pristine)
  })
})
