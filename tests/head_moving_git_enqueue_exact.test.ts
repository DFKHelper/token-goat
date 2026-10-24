/** The narrow path of a head-moving git command in the post hook: when git answers, exactly the files the command changed reach the dirty queue and no reconcile request is left. tests/hooks_bash.test.ts accepts a reconcile request in place of the queue because its git reads share the loaded suite's 5 s budget; this file pins the other half, so a hook whose diff or top-level read always failed could not pass through that fallback. Every real git call here runs with a long budget (the product's 5 s is what the fallback tests inject), and the base the diff was taken against is asserted, which is what separates `ORIG_HEAD` from `HEAD@{1}`. PROVENANCE: the repositories are real git repositories built here; the expected files are HAND-DERIVED from what each command rewrote (git's own semantics: a checkout, reset or rebase changes the files that differ between the old and the new tip); the subdirectory case is HAND-DERIVED from git's output, which names changed files relative to the repository top-level and not to the working directory. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { basename, join } from 'node:path'

import type * as GitAsyncModule from '../src/git_async.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { dataDir } from '../src/constants.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { indexableDir } from './helpers/temp-config.js'

const seam = vi.hoisted(() => ({ calls: [] as string[][] }))

vi.mock('../src/git_async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitAsyncModule>()
  return {
    ...actual,
    runGitAsync: (args: string[], opts?: Parameters<typeof actual.runGitAsync>[1]) => {
      seam.calls.push(args)
      return actual.runGitAsync(args, opts?.timeoutMs === undefined ? opts : { ...opts, timeoutMs: 120_000 })
    },
  }
})

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' })
  expect(r.status, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0)
  return r.stdout.trim()
}

function commitFile(dir: string, name: string, body: string): void {
  fs.writeFileSync(join(dir, name), body)
  git(dir, 'add', name)
  git(dir, 'commit', '-qm', `write ${name}`)
}

const dirty = (): string[] => getDirtyPaths().map(foldPath)
const folded = (rel: string, root: string): string => foldPath(resolveIndexPath(rel, root))
const requestFile = (): string => (fs.existsSync(reconcileRequestPathFor(dataDir())) ? fs.readFileSync(reconcileRequestPathFor(dataDir()), 'utf8') : '')
const workerLog = (): string => (fs.existsSync(workerErrorLogPath(dataDir())) ? fs.readFileSync(workerErrorLogPath(dataDir()), 'utf8') : '')
const diffBases = (): string[] => seam.calls.filter((c) => c[0] === 'diff').map((c) => c[2] as string)

async function postBash(command: string, cwd: string): Promise<void> {
  await postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'enqueue-exact', raw: { tool_name: 'Bash', tool_input: { command }, tool_response: '', cwd } }))
}

/** What a hook that read git successfully leaves: the queue holds `expected` and nothing else, no reconcile was requested, and nothing was logged as a failure. */
function expectNarrowEnqueue(expected: string[]): void {
  expect(dirty().sort()).toEqual([...expected].sort())
  expect(parseReconcileRequests(requestFile()), 'a diff that answered must not hand the whole project to the worker').toEqual([])
  expect(workerLog()).toBe('')
}

/** What a hard reset leaves: the queue holds `expected`, and the project is asked for a reconcile too, since `--hard` discards working-tree changes that no commit diff lists. Nothing is logged as a failure. */
function expectExactEnqueueAndReconcile(expected: string[]): void {
  expect(dirty().sort()).toEqual([...expected].sort())
  expect(parseReconcileRequests(requestFile()), 'a hard reset discards working-tree changes the commit diff cannot list, so the project is reconciled').toHaveLength(1)
  expect(workerLog()).toBe('')
}

beforeEach(() => {
  clearModuleCaches()
  clearDirtyQueue()
  seam.calls.length = 0
  fs.rmSync(reconcileRequestPathFor(dataDir()), { force: true })
  fs.rmSync(workerErrorLogPath(dataDir()), { force: true })
})

describe('a head-moving git command whose git reads answer', () => {
  it('git checkout enqueues exactly the file that differs between the branches', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'a.txt', 'two\n')
    git(dir, 'checkout', '-q', original)

    await postBash('git checkout feature', dir)

    expectNarrowEnqueue([folded('a.txt', dir)])
    expect(diffBases(), 'checkout never sets ORIG_HEAD, so the reflog base is used').toEqual(['HEAD@{1}'])
  })

  it('git reset --hard enqueues exactly the file the reset reverted', async () => {
    const dir = gitRepoWithCommit()
    const first = git(dir, 'rev-parse', 'HEAD')
    commitFile(dir, 'a.txt', 'two\n')
    git(dir, 'reset', '-q', '--hard', first)

    await postBash(`git reset --hard ${first}`, dir)

    expectExactEnqueueAndReconcile([folded('a.txt', dir)])
    expect(diffBases()).toEqual(['HEAD@{1}'])
  })

  it('a multi-commit rebase enqueues the one file whose content changed, taken against ORIG_HEAD', async () => {
    const dir = indexableDir()
    fs.writeFileSync(join(dir, 'base.txt'), 'base\n')
    git(dir, 'init', '-q')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'first.txt', 'first\n')
    commitFile(dir, 'second.txt', 'second\n')
    git(dir, 'checkout', '-q', original)
    commitFile(dir, 'mainline.txt', 'mainline\n')
    git(dir, 'checkout', '-q', 'feature')
    git(dir, 'rebase', '-q', original)

    await postBash(`git rebase ${original}`, dir)

    // HEAD@{1} is the rebase's own finishing step here, so a diff against it would come back empty and enqueue nothing.
    expectNarrowEnqueue([folded('mainline.txt', dir)])
    expect(diffBases()).toEqual(['ORIG_HEAD'])
  })

  it('a reset right after a rebase enqueues what the reset reverted, not what the rebase moved', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'first.txt', 'first\n')
    commitFile(dir, 'second.txt', 'second\n')
    git(dir, 'checkout', '-q', original)
    commitFile(dir, 'mainline.txt', 'mainline\n')
    git(dir, 'checkout', '-q', 'feature')
    git(dir, 'rebase', '-q', original)
    const rebaseOrigHead = git(dir, 'rev-parse', 'ORIG_HEAD')
    commitFile(dir, 'third.txt', 'third\n')
    git(dir, 'reset', '-q', '--hard', 'HEAD~1')
    expect(git(dir, 'rev-parse', 'ORIG_HEAD'), 'calibration: the reset replaced the rebase\'s ORIG_HEAD').not.toBe(rebaseOrigHead)

    await postBash('git reset --hard HEAD~1', dir)

    expectExactEnqueueAndReconcile([folded('third.txt', dir)])
    expect(diffBases(), 'reset is outside the ORIG_HEAD set, so it diffs against the reflog base').toEqual(['HEAD@{1}'])
  })

  it('a cd prefix enqueues the file of the repository it moved into, not of the one the call started in', async () => {
    const start = gitRepoWithCommit()
    const other = gitRepoWithCommit()
    const original = git(other, 'symbolic-ref', '--short', 'HEAD')
    git(other, 'checkout', '-qb', 'feature')
    commitFile(other, 'a.txt', 'two\n')
    git(other, 'checkout', '-q', original)

    await postBash(`cd ../${basename(other)} && git checkout ${original}`, start)

    expectNarrowEnqueue([folded('a.txt', other)])
  })

  it('a call whose cwd is a repository subdirectory enqueues the path under the repository top-level, not under the subdirectory', async () => {
    const dir = indexableDir()
    fs.mkdirSync(join(dir, 'sub'))
    fs.writeFileSync(join(dir, 'sub', 'nested.txt'), 'one\n')
    git(dir, 'init', '-q')
    git(dir, 'add', '.')
    git(dir, 'commit', '-qm', 'init')
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    fs.writeFileSync(join(dir, 'sub', 'nested.txt'), 'two\n')
    git(dir, 'commit', '-qam', 'change nested.txt')
    git(dir, 'checkout', '-q', original)

    await postBash('git checkout feature', join(dir, 'sub'))

    // git reports sub/nested.txt relative to the top-level; resolving it against the subdirectory would name sub/sub/nested.txt, which expectNarrowEnqueue's exact equality rejects.
    expectNarrowEnqueue([folded('sub/nested.txt', dir)])
  })
})
