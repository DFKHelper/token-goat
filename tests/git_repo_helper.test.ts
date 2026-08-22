// The whole premise of tests/helpers/git-repo.ts is that copying an already-built repository is
// indistinguishable from running init/add/commit again. If that were ever false -- a future git
// version recording an absolute path during init, say -- every fixture built on it would drift
// silently, and the tests using those fixtures would not notice, because they assert on hook and
// indexer behaviour rather than on repository state. So the equivalence itself is pinned here,
// against a control repo built the long way in this same test.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, it, expect } from 'vitest'

import { FIXTURE_COMMIT_DATE, gitRepoWithCommit } from './helpers/git-repo.js'
import { tempDir } from './helpers/temp-config.js'

// Same pinned date the helper uses, so the control commit hashes to the same SHA and the two
// repositories are comparable file for file. Left to the ambient clock, the control's commit
// object lands at a different `.git/objects/xx/yyy` path whenever it falls in a different second
// than the template's, which is a race the file-listing assertion below lost under suite load.
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_COMMIT_DATE, GIT_COMMITTER_DATE: FIXTURE_COMMIT_DATE },
  })
}

/** Every path under `dir`, relative and slash-normalised, sorted. Directories included, so a missing subdirectory shows up as a difference rather than as nothing. */
function listTree(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((p) => p.split(path.sep).join('/'))
    .sort()
}

describe('git-repo fixtures are equivalent to building the repo directly', () => {
  it('gitRepoWithCommit matches a repo built by running init/add/commit', () => {
    const control = tempDir()
    fs.writeFileSync(path.join(control, 'a.txt'), 'one\n')
    git(control, ['init'])
    git(control, ['add', '.'])
    git(control, ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'init'])

    const copied = gitRepoWithCommit()

    // The tree hash is the content of the commit, independent of when or where it was made.
    expect(git(copied, ['log', '--format=%T', '-1'])).toBe(git(control, ['log', '--format=%T', '-1']))
    const copiedStatus = git(copied, ['status', '--porcelain'])
    expect(copiedStatus).toBe(git(control, ['status', '--porcelain']))
    expect(copiedStatus).toBe('')
    expect(git(copied, ['symbolic-ref', '--short', 'HEAD'])).toBe(git(control, ['symbolic-ref', '--short', 'HEAD']))
    expect(git(copied, ['ls-files'])).toBe('a.txt\n')
    expect(fs.readFileSync(path.join(copied, 'a.txt'), 'utf8')).toBe('one\n')

    // The fixture is fully determined -- pinned date, author, message and content -- so its commit
    // hashes to one fixed value. Pinned as a literal rather than just compared against the control,
    // because the two agreeing proves nothing on its own: before the date was pinned they agreed
    // whenever both commits happened to land in the same wall-clock second, which is most of the
    // time and none of the time under load. Drop the pin and this fails on every run instead.
    const copiedHead = git(copied, ['rev-parse', 'HEAD']).trim()
    expect(copiedHead).toBe('32ba05faacf1c3dc7aed01ce1e67d38e6e89f51d')
    expect(git(control, ['rev-parse', 'HEAD']).trim()).toBe(copiedHead)

    // Same set of files on disk, .git included: a copy that silently dropped part of .git could
    // still answer every command above correctly from the parts it did copy.
    expect(listTree(copied)).toEqual(listTree(control))
    // 180s, not the 60s global bound. This case runs 15 `git` subprocesses -- three to build the
    // control, three to build the template, nine to interrogate the two repositories -- in a suite
    // whose scarcest resource is process creation. Standalone it takes 1.26s; under a full run it
    // was measured at 63.8s and timed out, a 50x contention factor that no plausible global bound
    // absorbs without weakening hang detection for the other ~10,000 tests. The bound is sized
    // above the observed worst rather than tuned to it, and a genuine hang still fails here, just
    // later. Duplicate spawns were removed alongside this, which is why the count is 15 and not 17.
  }, 180000)

  it('hands out independent repos, so writing to one never reaches another', () => {
    const first = gitRepoWithCommit()
    const second = gitRepoWithCommit()

    expect(first).not.toBe(second)
    fs.writeFileSync(path.join(first, 'a.txt'), 'two\n')

    expect(fs.readFileSync(path.join(second, 'a.txt'), 'utf8')).toBe('one\n')
    expect(git(second, ['status', '--porcelain'])).toBe('')
    // The template itself must survive being copied from: a third repo is still pristine.
    expect(git(gitRepoWithCommit(), ['status', '--porcelain'])).toBe('')
  })
})
