// Throwaway git repositories for tests, built by copying a template rather than by shelling out
// to git every time.
//
// `git init` plus an `add` and a `commit` is three process spawns; the template is built once per
// process on first use, so a file wanting eleven identical repos pays for one init instead of
// eleven. A repo made this way is byte-identical to one made by running the same commands
// directly -- nothing git writes during `init`/`add`/`commit` records the repository's own
// absolute path, so a copy is not distinguishable from the original, and
// tests/git_repo_helper.test.ts pins exactly that.
//
// Deliberately covers only the three-spawn shape. The obvious sibling -- a template for a bare
// `git init` with no commit, which the suite also does in about eighteen places -- was built,
// used, measured, and thrown away: replacing a single spawn with a recursive copy of a `.git`
// directory is a wash at best on Windows, where the copy is dozens of small files and each one is
// scanned. Measured on graph_commands.test.ts, eight such swaps cost 0.23s rather than saving
// anything, while the eleven three-spawn swaps here saved 0.92s (11.17s -> 10.25s). So the win is
// specifically in amortising the `add` and `commit`, not in avoiding `git init`, and a helper for
// the single-spawn case would be a slower way to write the same test.
//
// Cleanup is not the caller's problem: these live under the per-process root temp-config.ts
// already removes on exit (and sweeps if a worker is killed first), so a repo survives a failing
// assertion for debugging without leaking.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { tempDir } from './temp-config.js'

/**
 * Fixed author and committer date for the fixture commit.
 *
 * Without it the commit SHA depends on the wall-clock second the commit landed in, which makes
 * the repository non-reproducible: the loose object git writes for the commit lives at
 * `.git/objects/<first 2 hex>/<remaining 38>`, so two runs a second apart produce different paths
 * on disk for the same logical repo. `git_repo_helper.test.ts` compares this fixture's full file
 * listing against a control repo built the long way, and that comparison flaked exactly when the
 * two commits straddled a second boundary -- same file count, different object path.
 */
export const FIXTURE_COMMIT_DATE = '2020-01-02T03:04:05+00:00'

/** Run git in `cwd`, silently. `core.hooksPath` is neutralised so a developer's own global hooks cannot fail or slow a fixture commit. */
function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE, GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE },
  })
}

let committedTemplate: string | null = null

/** A fresh repository with a single commit containing `a.txt`, whose contents are `one\n`. */
export function gitRepoWithCommit(): string {
  if (committedTemplate === null) {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    git(dir, ['init'])
    git(dir, ['add', '.'])
    git(dir, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init'])
    committedTemplate = dir
  }
  const dir = tempDir()
  fs.cpSync(committedTemplate, dir, { recursive: true })
  return dir
}
