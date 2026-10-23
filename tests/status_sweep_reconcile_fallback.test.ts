/** A formatter run, a patch application or a stash apply rewrites files without going through any edit tool, and the Bash post hook finds them by asking git for the working-tree status. When git runs past the hook's 5 s budget (exit -1 with timedOut, as on a loaded machine) the sweep used to name nothing and ask for nothing, so the index kept the pre-rewrite content with nothing in any log; it now asks the worker to reconcile the project and logs that, as the branch-switch block beside it does. `git restore` has the same gap one step earlier: it expands its pathspecs with `git ls-files` under the same budget, and a timed-out expansion used to name nothing just as silently, so it takes the same fallback. A git that never started (exit -1 without timedOut: missing, or a working directory that is gone) gets no request, since the worker needs git to sweep too. The status and ls-files answers are the seam: exit -1 with timedOut is what runGit returns for a spawn timeout and exit -1 without it for ENOENT (CAPTURE: Node 24.12 on Windows 11 spawnSync reports ETIMEDOUT and ENOENT), and 128 is git's "not a repository" (HAND-DERIVED from git's exit status); the expected queue contents are HAND-DERIVED from the command. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type * as DirtyQueueModule from '../src/dirty_queue.js'
import type * as GitAsyncModule from '../src/git_async.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dataDir } from '../src/constants.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { gitRepoWithCommit, gitRepoWithSubCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'

type SeamAnswer = { exitCode: number; unfinished: boolean; timedOut?: true; signal?: string; stdout?: string; stderr?: string } | null
const seam = vi.hoisted(() => ({ status: null as SeamAnswer, lsFiles: null as SeamAnswer, revParse: null as SeamAnswer, reconcileUnrecorded: false }))

vi.mock('../src/dirty_queue.js', async (importOriginal) => {
  const actual = await importOriginal<typeof DirtyQueueModule>()
  return { ...actual, appendReconcileRequest: (dir: string, projectDir: string) => (seam.reconcileUnrecorded ? false : actual.appendReconcileRequest(dir, projectDir)) }
})

vi.mock('../src/git_async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof GitAsyncModule>()
  return {
    ...actual,
    runGitAsync: async (args: string[], opts?: Parameters<typeof actual.runGitAsync>[1]) => {
      const answer = args[0] === 'status' ? seam.status : args[0] === 'ls-files' ? seam.lsFiles : args[0] === 'rev-parse' ? seam.revParse : null
      return answer !== null ? { stdout: '', stderr: 'no answer', ...answer } : actual.runGitAsync(args, opts?.timeoutMs === undefined ? opts : { ...opts, timeoutMs: 120_000 })
    },
  }
})

const requested = (): string[] => {
  const file = reconcileRequestPathFor(dataDir())
  return existsSync(file) ? parseReconcileRequests(readFileSync(file, 'utf8')).map((d) => foldPath(normalizePath(d))) : []
}
const dirty = (): string[] => getDirtyPaths().map((p) => foldPath(p))
const workerLog = (): string => (existsSync(workerErrorLogPath(dataDir())) ? readFileSync(workerErrorLogPath(dataDir()), 'utf8') : '')

async function bashRun(dir: string, command: string): Promise<void> {
  await postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command }, sessionId: 'status-sweep', raw: { tool_name: 'Bash', tool_input: { command }, tool_response: '', cwd: dir } }))
}

async function formatterRun(dir: string): Promise<void> {
  writeFileSync(join(dir, 'a.txt'), 'formatted\n')
  await bashRun(dir, 'npx prettier --write .')
}

describe('the working-tree status sweep when git does not answer', () => {
  let dir: string

  beforeEach(() => {
    clearModuleCaches()
    clearDirtyQueue()
    rmSync(reconcileRequestPathFor(dataDir()), { force: true })
    rmSync(workerErrorLogPath(dataDir()), { force: true })
    seam.status = null
    seam.lsFiles = null
    seam.revParse = null
    seam.reconcileUnrecorded = false
    dir = gitRepoWithCommit()
  })

  afterEach(() => {
    seam.status = null
    seam.lsFiles = null
    seam.revParse = null
    seam.reconcileUnrecorded = false
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the worker to reconcile the project, and logs it, when the status read runs past its budget', async () => {
    seam.status = { exitCode: -1, unfinished: true, timedOut: true }

    await formatterRun(dir)

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git status did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('asks the worker to reconcile the project, and logs it, when the status read is killed by a signal, not reported as clean', async () => {
    seam.status = { exitCode: -1, unfinished: true, signal: 'SIGKILL' }

    await formatterRun(dir)

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git status did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('asks the worker to reconcile the project, and logs it, when the ls-files read that expands a git restore pathspec runs past its budget', async () => {
    seam.lsFiles = { exitCode: -1, unfinished: true, timedOut: true }

    // A glob, since a literal name is enqueued as written whatever ls-files says.
    await bashRun(dir, "git restore '*.txt'")

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash git restore in .*: git ls-files did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('asks the worker to reconcile the project when the ls-files read that expands a git restore pathspec is killed by a signal', async () => {
    seam.lsFiles = { exitCode: -1, unfinished: true, signal: 'SIGKILL' }

    // A glob, as in the timed-out row above: a literal name is enqueued without asking ls-files.
    await bashRun(dir, "git restore '*.txt'")

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash git restore in .*: git ls-files did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('enqueues the restored file and asks for no reconcile when the ls-files read answers', async () => {
    await bashRun(dir, 'git restore a.txt')

    expect(dirty()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(requested()).toEqual([])
    expect(workerLog()).toBe('')
  })

  it.each([
    { name: 'git could not be started at all, since the worker needs git to sweep', status: { exitCode: -1, unfinished: false } },
    { name: 'git answers that this is not a repository', status: { exitCode: 128, unfinished: false } },
  ])('asks for nothing when $name', async ({ status }) => {
    seam.status = status

    await formatterRun(dir)

    expect(requested()).toEqual([])
    expect(dirty()).toEqual([])
    expect(workerLog()).toBe('')
  })

  // FORMAT-DERIVED: the overflow result src/git_async.ts::runGitAsync settles with (exit -1, unfinished, no timedOut, this stderr text); tests/git_did_not_finish.test.ts drives the real runner to it. The sweep reads it as a git that did not finish.
  it('asks the worker to reconcile the project, and logs it, when git status lists more than the output buffer holds', async () => {
    seam.status = { unfinished: true, exitCode: -1, stderr: 'spawn git ENOBUFS: output exceeded the 200 MiB buffer' }

    await formatterRun(dir)

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git status did not answer in time \(spawn git ENOBUFS.*asked the worker to reconcile the project/)
  })

  it('logs that a file the sweep could not see may stay stale when the reconcile request cannot be recorded', async () => {
    seam.reconcileUnrecorded = true

    await formatterRun(dir)

    expect(dirty()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(requested()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: could not record a reconcile request, so a file this sweep could not see may stay stale until the next index run/)
  })

  it('enqueues the rewritten file and asks the worker to reconcile, without logging, when the status read answers', async () => {
    await formatterRun(dir)

    expect(dirty()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(workerLog()).toBe('')
  })

  const git = (d: string, ...args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: d, stdio: 'ignore' })
  }

  // HAND-DERIVED: each row's queue is what the command rewrote in a repository holding a.txt, sub/a.txt and café.ts (committed), read off git's own pathspec and status semantics rather than the extractor; the hook runs after the command, so the setup writes the command's effect to disk first. A status sweep asks for a reconcile whatever it lists, since a file put back to its committed content is on no listing; a `git restore` names its files and needs none.
  const rewriteRows: Array<{ command: string; effect: (d: string) => void; expected: string[]; reconcile: boolean; reconcileIn?: string }> = [
    { command: 'git restore -- .', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'one\n'), expected: ['a.txt', 'sub/a.txt', 'café.ts'], reconcile: false },
    { command: 'git restore café.ts', effect: (d: string) => writeFileSync(join(d, 'café.ts'), 'export const c = 1\n'), expected: ['café.ts'], reconcile: false },
    { command: 'cd sub && git restore a.txt', effect: (d: string) => writeFileSync(join(d, 'sub', 'a.txt'), 'two\n'), expected: ['sub/a.txt'], reconcile: false },
    { command: 'git stash pop', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'popped\n'), expected: ['a.txt'], reconcile: true },
    { command: 'git apply fix.patch', effect: (d: string) => { writeFileSync(join(d, 'a.txt'), 'patched\n'); mkdirSync(join(d, 'lib')); writeFileSync(join(d, 'lib', 'new.ts'), 'export const n = 1\n') }, expected: ['a.txt', 'lib/new.ts'], reconcile: true },
    { command: 'git apply fix.patch', effect: (d: string) => { mkdirSync(join(d, 'bücher')); writeFileSync(join(d, 'bücher', 'ünï.ts'), 'export const u = 1\n') }, expected: ['bücher/ünï.ts'], reconcile: true },
    { command: 'git stash pop', effect: (d: string) => rmSync(join(d, 'a.txt')), expected: ['a.txt'], reconcile: true },
    { command: 'git stash apply', effect: (d: string) => git(d, 'mv', 'a.txt', 'renamed.txt'), expected: ['a.txt', 'renamed.txt'], reconcile: true },
    { command: 'git stash', effect: () => {}, expected: [], reconcile: true },
    { command: 'git stash -u && echo done', effect: () => {}, expected: [], reconcile: true },
    { command: 'git stash list', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'edited earlier\n'), expected: [], reconcile: false },
    { command: 'echo ready && git stash', effect: () => {}, expected: [], reconcile: true },
    { command: 'git stash list && git stash pop', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'popped\n'), expected: ['a.txt'], reconcile: true },
    { command: 'GIT_TRACE=0 git stash pop', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'popped\n'), expected: ['a.txt'], reconcile: true },
    { command: 'git status && GIT_TRACE=0 git stash pop', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'popped\n'), expected: ['a.txt'], reconcile: true },
    { command: 'git -c core.quotepath=off stash', effect: () => {}, expected: [], reconcile: true },
    { command: 'git -C sub stash pop', effect: (d: string) => writeFileSync(join(d, 'sub', 'a.txt'), 'popped\n'), expected: ['sub/a.txt'], reconcile: true, reconcileIn: 'sub' },
    { command: 'git stash -h', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'edited earlier\n'), expected: [], reconcile: false },
    { command: 'git stash pop --help', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'edited earlier\n'), expected: [], reconcile: false },
    // The real commands run in the effect: `git stash branch` checks out a new branch at the commit the stash was made on and applies the stash there, so café.ts goes back to that commit's content (a HEAD move, which the status listing does not show) and a.txt takes the stashed change (which only the status listing shows).
    { command: 'git stash branch side', effect: (d: string) => { writeFileSync(join(d, 'a.txt'), 'stashed\n'); git(d, 'stash'); writeFileSync(join(d, 'café.ts'), 'export const c = 2\n'); git(d, 'commit', '-q', '-am', 'c2'); git(d, 'stash', 'branch', 'side') }, expected: ['a.txt', 'café.ts'], reconcile: true },
    // The real commands run in the effect: a file the last commit deleted is brought back from the commit before, so it is on disk while the index, which `git ls-files` reads, lacks it.
    { command: 'git restore --source=HEAD~1 a.txt', effect: (d: string) => { git(d, 'rm', '-q', 'a.txt'); git(d, 'commit', '-m', 'drop a'); git(d, 'restore', '--source=HEAD~1', 'a.txt') }, expected: ['a.txt'], reconcile: false },
  ]
  it.each(rewriteRows)('enqueues exactly the files `$command` rewrote ($expected)', async ({ command, effect, expected, reconcile, reconcileIn }) => {
    dir = gitRepoWithSubCommit()
    clearDirtyQueue()
    effect(dir)

    await bashRun(dir, command)

    expect([...dirty()].sort()).toEqual(expected.map((rel) => foldPath(resolveIndexPath(rel, dir))).sort())
    expect(requested()).toEqual(reconcile ? [foldPath(normalizePath(reconcileIn === undefined ? dir : join(dir, reconcileIn)))] : [])
    expect(workerLog()).toBe('')
  })

  // HAND-DERIVED: porcelain v1 `-z` names a path as written, so a name holding ` -> ` is one path; Windows cannot create such a file, so the status answer is supplied directly and the path, absent from disk, is enqueued for the drain to drop.
  it('takes a status entry whose name holds ` -> ` as one path', async () => {
    seam.status = { unfinished: false, exitCode: 0, stdout: '?? old -> new.ts\0' }

    await formatterRun(dir)

    expect(dirty()).toEqual([foldPath(resolveIndexPath('old -> new.ts', dir))])
  })

  it('enqueues at most 2000 swept paths, and logs that the reconcile covers the rest', async () => {
    seam.status = { unfinished: false, exitCode: 0, stdout: Array.from({ length: 2001 }, (_, i) => `?? gone${i}.ts\0`).join('') }

    await formatterRun(dir)

    expect(dirty()).toHaveLength(2000)
    expect(dirty()).not.toContain(foldPath(resolveIndexPath('gone2000.ts', dir)))
    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git listed 2001 paths, so only the first 2000 were queued, untracked ones first; 1 untracked file was left out, which no reconcile finds, and asked the worker to reconcile the project for the rest of the tracked files/)
  })

  // HAND-DERIVED: the reconcile finds a changed tracked file from the index, but nothing lists a new untracked one except this sweep, so over the cap the untracked entries are the ones kept, wherever git put them in its listing.
  it('keeps every untracked path when the listing is over the cap, and names no untracked file as left out', async () => {
    const tracked = Array.from({ length: 1990 }, (_, i) => ` M tracked${i}.ts\0`).join('')
    const untracked = Array.from({ length: 20 }, (_, i) => `?? new${i}.ts\0`).join('')
    seam.status = { unfinished: false, exitCode: 0, stdout: tracked + untracked }

    await formatterRun(dir)

    expect(dirty()).toHaveLength(2000)
    for (let i = 0; i < 20; i++) expect(dirty()).toContain(foldPath(resolveIndexPath(`new${i}.ts`, dir)))
    expect(workerLog()).toMatch(/git listed 2010 paths, so only the first 2000 were queued, untracked ones first; asked the worker to reconcile the project for the rest of the tracked files/)
  })

  it.each([
    { name: 'a status sweep', run: (d: string) => formatterRun(d), answer: 'status' as const, stdout: ' M a.txt\0' },
    { name: 'a git restore', run: (d: string) => bashRun(d, "git restore '*.txt'"), answer: 'lsFiles' as const, stdout: 'a.txt\0' },
  ])('enqueues nothing and asks for a reconcile when $name lists files but git cannot name the repository root', async ({ run, answer, stdout }) => {
    seam[answer] = { unfinished: false, exitCode: 0, stdout }
    seam.revParse = { exitCode: -1, unfinished: true, timedOut: true }

    await run(dir)

    expect(dirty()).toEqual([])
    expect(requested()).toEqual([foldPath(normalizePath(dir))])
  })
})
