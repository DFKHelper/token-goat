/** A formatter run, a patch application or a stash apply rewrites files without going through any edit tool, and the Bash post hook finds them by asking git for the working-tree status. When git runs past the hook's 5 s budget (exit -1 with timedOut, as on a loaded machine) the sweep used to name nothing and ask for nothing, so the index kept the pre-rewrite content with nothing in any log; it now asks the worker to reconcile the project and logs that, as the branch-switch block beside it does. `git restore` has the same gap one step earlier: it expands its pathspecs with `git ls-files` under the same budget, and a timed-out expansion used to name nothing just as silently, so it takes the same fallback. A git that never started (exit -1 without timedOut: missing, or a working directory that is gone) gets no request, since the worker needs git to sweep too. The status and ls-files answers are the seam: exit -1 with timedOut is what runGit returns for a spawn timeout and exit -1 without it for ENOENT (CAPTURE: Node 24.12 on Windows 11 spawnSync reports ETIMEDOUT and ENOENT), and 128 is git's "not a repository" (HAND-DERIVED from git's exit status); the expected queue contents are HAND-DERIVED from the command. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type * as UtilModule from '../src/util.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { dataDir } from '../src/constants.js'
import { parseReconcileRequests, reconcileRequestPathFor } from '../src/dirty_queue.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { postBashHandler } from '../src/hooks_bash_post.js'
import { normalizePath, resolveIndexPath } from '../src/paths.js'
import { clearModuleCaches } from '../src/reset.js'
import { foldPath } from '../src/util.js'
import { workerErrorLogPath } from '../src/worker_lifecycle.js'
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'

const seam = vi.hoisted(() => ({ status: null as { exitCode: number; timedOut?: true } | null, lsFiles: null as { exitCode: number; timedOut?: true } | null }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => {
      const answer = args[0] === 'status' ? seam.status : args[0] === 'ls-files' ? seam.lsFiles : null
      return answer !== null ? { stdout: '', stderr: 'no answer', ...answer } : actual.runGit(args, opts?.timeoutMs === undefined ? opts : { ...opts, timeoutMs: 120_000 })
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
    dir = gitRepoWithCommit()
  })

  afterEach(() => {
    seam.status = null
    seam.lsFiles = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the worker to reconcile the project, and logs it, when the status read runs past its budget', async () => {
    seam.status = { exitCode: -1, timedOut: true }

    await formatterRun(dir)

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git status did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('asks the worker to reconcile the project, and logs it, when the ls-files read that expands a git restore pathspec runs past its budget', async () => {
    seam.lsFiles = { exitCode: -1, timedOut: true }

    await bashRun(dir, 'git restore a.txt')

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
    { name: 'git could not be started at all, since the worker needs git to sweep', status: { exitCode: -1 } },
    { name: 'git answers that this is not a repository', status: { exitCode: 128 } },
  ])('asks for nothing when $name', async ({ status }) => {
    seam.status = status

    await formatterRun(dir)

    expect(requested()).toEqual([])
    expect(dirty()).toEqual([])
    expect(workerLog()).toBe('')
  })

  it('enqueues the rewritten file and asks for no reconcile when the status read answers', async () => {
    await formatterRun(dir)

    expect(dirty()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(requested()).toEqual([])
    expect(workerLog()).toBe('')
  })

  // HAND-DERIVED: each row's queue is what the command rewrote in a repository holding a.txt (and sub/a.txt, committed), read off git's own pathspec and status semantics rather than the extractor; the hook runs after the command, so the setup writes the command's effect to disk first.
  it.each([
    { command: 'git restore -- .', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'one\n'), expected: ['a.txt', 'sub/a.txt'] },
    { command: 'git stash pop', effect: (d: string) => writeFileSync(join(d, 'a.txt'), 'popped\n'), expected: ['a.txt'] },
    { command: 'git apply fix.patch', effect: (d: string) => { writeFileSync(join(d, 'a.txt'), 'patched\n'); mkdirSync(join(d, 'lib')); writeFileSync(join(d, 'lib', 'new.ts'), 'export const n = 1\n') }, expected: ['a.txt', 'lib/new.ts'] },
    { command: 'cd sub && git restore a.txt', effect: (d: string) => writeFileSync(join(d, 'sub', 'a.txt'), 'two\n'), expected: ['sub/a.txt'] },
  ])('enqueues exactly the files `$command` rewrote, and asks for no reconcile', async ({ command, effect, expected }) => {
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'a.txt'), 'two\n')
    execFileSync('git', ['add', 'sub/a.txt'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', 'sub'], { cwd: dir, stdio: 'ignore' })
    clearDirtyQueue()
    effect(dir)

    await bashRun(dir, command)

    expect([...dirty()].sort()).toEqual(expected.map((rel) => foldPath(resolveIndexPath(rel, dir))).sort())
    expect(requested()).toEqual([])
    expect(workerLog()).toBe('')
  })
})
