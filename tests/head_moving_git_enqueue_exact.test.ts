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

describe('a head-moving git command in any segment of a compound command gets the reflog diff', () => {
  /** A repository whose `other` branch changes o.txt, with HEAD back on the original branch: the state a head-moving command starts from. */
  function branchChangingOtxt(): { dir: string; original: string } {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    commitFile(dir, 'o.txt', 'one\n')
    git(dir, 'checkout', '-qb', 'other')
    commitFile(dir, 'o.txt', 'two\n')
    git(dir, 'checkout', '-q', original)
    return { dir, original }
  }

  it.each([
    ['echo hi && git checkout other', (dir: string): void => { git(dir, 'checkout', '-q', 'other') }],
    ['git status && git merge other', (dir: string): void => { git(dir, 'merge', '-q', 'other') }],
    ['git status; git pull . other', (dir: string): void => { git(dir, 'pull', '-q', '.', 'other') }],
    ['true && git cherry-pick other', (dir: string): void => { git(dir, 'cherry-pick', 'other') }],
    ['git status | cat; git checkout other', (dir: string): void => { git(dir, 'checkout', '-q', 'other') }],
  ])('%s enqueues the one file the command changed', async (command, move) => {
    const { dir } = branchChangingOtxt()
    move(dir)

    await postBash(command, dir)

    expectNarrowEnqueue([folded('o.txt', dir)])
  })

  it('a path-scoped checkout in a compound command runs no reflog diff', async () => {
    const { dir } = branchChangingOtxt()

    await postBash('echo hi && git checkout -- o.txt', dir)

    expect(diffBases(), 'a path-scoped checkout moves no HEAD, so no reflog base is read').toEqual([])
  })

  it('git status alone runs no reflog diff and enqueues nothing', async () => {
    const { dir } = branchChangingOtxt()

    await postBash('git status', dir)

    expect(diffBases()).toEqual([])
    expect(dirty()).toEqual([])
  })
})

/** Runs git and returns its exit status, for a step that may stop on a conflict. */
function gitStatus(cwd: string, ...args: string[]): number | null {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'maintenance.auto=false', '-c', 'core.editor=true', '-c', 'sequence.editor=true', ...args], { cwd, encoding: 'utf8' }).status
}

describe('a command that moves HEAD more than once, or replays several commits, asks for a reconcile', () => {
  it('git checkout other && git checkout - reconciles, and still queues the file the reflog diff finds', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    commitFile(dir, 'o.txt', 'one\n')
    git(dir, 'checkout', '-qb', 'other')
    commitFile(dir, 'o.txt', 'two\n')
    git(dir, 'checkout', '-q', original)
    git(dir, 'checkout', '-q', 'other')
    git(dir, 'checkout', '-q', '-')

    await postBash('git checkout other && git checkout -', dir)

    expect(dirty()).toEqual([folded('o.txt', dir)])
    expect(parseReconcileRequests(requestFile()), 'two head-moving segments: the reflog diff sees only the last move').toHaveLength(1)
  })

  it('git rebase --continue after a conflict reconciles, since HEAD@{1} covers only the replayed step', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    commitFile(dir, 'a.txt', 'base\n')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'a.txt', 'feature\n')
    commitFile(dir, 'c.txt', 'new\n')
    git(dir, 'checkout', '-q', original)
    commitFile(dir, 'a.txt', 'mainline\n')
    git(dir, 'checkout', '-q', 'feature')
    expect(gitStatus(dir, 'rebase', original), 'calibration: the rebase stops on a.txt').not.toBe(0)
    fs.writeFileSync(join(dir, 'a.txt'), 'resolved\n')
    git(dir, 'add', 'a.txt')
    expect(gitStatus(dir, 'rebase', '--continue'), 'calibration: the continue finishes the rebase').toBe(0)

    await postBash('git rebase --continue', dir)

    expect(parseReconcileRequests(requestFile()), 'the continue replays c.txt only, and a.txt was resolved by hand').toHaveLength(1)
  })

  it('git cherry-pick naming two commits reconciles, since HEAD@{1} covers only the last one', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'a.txt', 'first\n')
    commitFile(dir, 'c.txt', 'second\n')
    git(dir, 'checkout', '-q', original)
    git(dir, 'cherry-pick', 'feature~1', 'feature')

    await postBash('git cherry-pick feature~1 feature', dir)

    expect(parseReconcileRequests(requestFile()), 'two commits replayed: a.txt is not in HEAD@{1}').toHaveLength(1)
  })

  it('git merge --continue after a conflict is covered by the reflog diff, which lists every file the merge brought in', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    commitFile(dir, 'a.txt', 'base\n')
    git(dir, 'checkout', '-qb', 'other')
    commitFile(dir, 'a.txt', 'other\n')
    commitFile(dir, 'n.txt', 'new\n')
    git(dir, 'checkout', '-q', original)
    commitFile(dir, 'a.txt', 'mainline\n')
    expect(gitStatus(dir, 'merge', 'other'), 'calibration: the merge stops on a.txt').not.toBe(0)
    fs.writeFileSync(join(dir, 'a.txt'), 'resolved\n')
    git(dir, 'add', 'a.txt')
    expect(gitStatus(dir, 'merge', '--continue'), 'calibration: the continue commits the merge').toBe(0)

    await postBash('git merge --continue', dir)

    expectNarrowEnqueue([folded('a.txt', dir), folded('n.txt', dir)])
  })

  it('git cherry-pick naming one commit keeps the reflog diff and asks for no reconcile', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'a.txt', 'first\n')
    commitFile(dir, 'c.txt', 'second\n')
    git(dir, 'checkout', '-q', original)
    git(dir, 'cherry-pick', 'feature')

    await postBash('git cherry-pick feature', dir)

    expectNarrowEnqueue([folded('c.txt', dir)])
  })

  it.each([
    ['git rebase -i', (dir: string, base: string, original: string): number | null => gitStatus(dir, 'rebase', '-q', '-i', original), 'git rebase -i original'],
    ['git rebase --onto', (dir: string, base: string, original: string): number | null => gitStatus(dir, 'rebase', '-q', '--onto', original, base, 'feature'), 'git rebase --onto original base feature'],
  ])('%s replaying several commits is covered by ORIG_HEAD and enqueues only the mainline file', async (_label, replay, command) => {
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
    const base = git(dir, 'rev-parse', 'HEAD')
    commitFile(dir, 'mainline.txt', 'mainline\n')
    git(dir, 'checkout', '-q', 'feature')
    expect(replay(dir, base, original), 'calibration: the rebase finishes').toBe(0)

    await postBash(command, dir)

    expectNarrowEnqueue([folded('mainline.txt', dir)])
  })
})

/** Leaves `git am` stopped on a.txt, with the patch's new file n.txt still to write: the patch and its resolution are both real git. */
function amStoppedOnConflict(dir: string): void {
  const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
  commitFile(dir, 'a.txt', 'base\n')
  git(dir, 'checkout', '-qb', 'feature')
  fs.writeFileSync(join(dir, 'a.txt'), 'feature\n')
  fs.writeFileSync(join(dir, 'n.txt'), 'new\n')
  git(dir, 'add', 'a.txt', 'n.txt')
  git(dir, 'commit', '-qm', 'feature changes a.txt and adds n.txt')
  const mbox = join(dir, '.git', 'feature.mbox')
  fs.writeFileSync(mbox, `${git(dir, 'format-patch', '-1', '--stdout', 'HEAD')}\n`)
  git(dir, 'checkout', '-q', original)
  commitFile(dir, 'a.txt', 'mainline\n')
  expect(gitStatus(dir, 'am', mbox), 'calibration: the am stops on a.txt').not.toBe(0)
}

describe('git am asks for a reconcile in every form, since no reflog diff covers the patch it applies or its --continue', () => {
  it('a clean git am <mbox> reconciles, although the patch adds a file and changes another', async () => {
    const dir = gitRepoWithCommit()
    const original = git(dir, 'symbolic-ref', '--short', 'HEAD')
    commitFile(dir, 'a.txt', 'base\n')
    git(dir, 'checkout', '-qb', 'feature')
    commitFile(dir, 'a.txt', 'feature\n')
    fs.writeFileSync(join(dir, 'n.txt'), 'new\n')
    git(dir, 'add', 'n.txt')
    git(dir, 'commit', '-qm', 'feature adds n.txt')
    const mbox = join(dir, '.git', 'clean.mbox')
    fs.writeFileSync(mbox, `${git(dir, 'format-patch', '-2', '--stdout', 'HEAD')}\n`)
    git(dir, 'checkout', '-q', original)
    expect(gitStatus(dir, 'am', mbox), 'calibration: the am applies both patches').toBe(0)

    await postBash(`git am ${mbox}`, dir)

    expect(parseReconcileRequests(requestFile()), 'am is never head-moving, so only the reconcile covers the files it wrote').toHaveLength(1)
  })

  it.each([['--continue'], ['--cont'], ['--resolved'], ['-r']])('git am %s after a real conflict reconciles, since the new file is written by hand', async (flag) => {
    const dir = gitRepoWithCommit()
    amStoppedOnConflict(dir)
    fs.writeFileSync(join(dir, 'a.txt'), 'resolved\n')
    fs.writeFileSync(join(dir, 'n.txt'), 'new\n')
    git(dir, 'add', 'a.txt', 'n.txt')
    expect(gitStatus(dir, 'am', flag), 'calibration: the continue commits the patch').toBe(0)

    await postBash(`git am ${flag}`, dir)

    expect(parseReconcileRequests(requestFile()), `reconcile requests after git am ${flag}`).toHaveLength(1)
  })
})

describe('git revert asks for a reconcile in every form, with real git, since its files are in no reflog diff the hook takes', () => {
  it.each([['git revert --no-edit HEAD', ['--no-edit']], ['git revert --no-commit HEAD', ['--no-commit']]])('%s changes a.txt and n.txt and reconciles', async (command, options) => {
    const dir = gitRepoWithCommit()
    commitFile(dir, 'a.txt', 'base\n')
    fs.writeFileSync(join(dir, 'a.txt'), 'changed\n')
    fs.writeFileSync(join(dir, 'n.txt'), 'new\n')
    git(dir, 'add', 'a.txt', 'n.txt')
    git(dir, 'commit', '-qm', 'change a.txt and add n.txt')
    const head = git(dir, 'rev-parse', 'HEAD')

    expect(gitStatus(dir, 'revert', ...options, 'HEAD'), 'calibration: the revert runs').toBe(0)
    expect(git(dir, 'rev-parse', 'HEAD') === head, 'calibration: a revert moves HEAD only without --no-commit').toBe(options[0] === '--no-commit')

    await postBash(command, dir)

    expect(parseReconcileRequests(requestFile()), `reconcile requests after ${command}`).toHaveLength(1)
  })
})
