/** A formatter run, a patch application or a stash apply rewrites files without going through any edit tool, and the Bash post hook finds them by asking git for the working-tree status. When git runs past the hook's 5 s budget (exit -1 with timedOut, as on a loaded machine) the sweep used to name nothing and ask for nothing, so the index kept the pre-rewrite content with nothing in any log; it now asks the worker to reconcile the project and logs that, as the branch-switch block beside it does. A git that never started (exit -1 without timedOut: missing, or a working directory that is gone) gets no request, since the worker needs git to sweep too. The status answer is the seam: exit -1 with timedOut is what runGit returns for a spawn timeout and exit -1 without it for ENOENT (CAPTURE: Node 24.12 on Windows 11 spawnSync reports ETIMEDOUT and ENOENT), and 128 is git's "not a repository" (HAND-DERIVED from git's exit status); the expected queue contents are HAND-DERIVED from the command. */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const seam = vi.hoisted(() => ({ status: null as { exitCode: number; timedOut?: true } | null }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => (seam.status !== null && args[0] === 'status' ? { stdout: '', stderr: 'no answer', ...seam.status } : actual.runGit(args, opts)),
  }
})

const requested = (): string[] => {
  const file = reconcileRequestPathFor(dataDir())
  return existsSync(file) ? parseReconcileRequests(readFileSync(file, 'utf8')).map((d) => foldPath(normalizePath(d))) : []
}
const dirty = (): string[] => getDirtyPaths().map((p) => foldPath(p))
const workerLog = (): string => (existsSync(workerErrorLogPath(dataDir())) ? readFileSync(workerErrorLogPath(dataDir()), 'utf8') : '')

async function formatterRun(dir: string): Promise<void> {
  writeFileSync(join(dir, 'a.txt'), 'formatted\n')
  await postBashHandler(makeHookEvent({ eventName: 'post_tool_use', toolName: 'Bash', toolInput: { command: 'npx prettier --write .' }, sessionId: 'status-sweep', raw: { tool_name: 'Bash', tool_input: { command: 'npx prettier --write .' }, tool_response: '', cwd: dir } }))
}

describe('the working-tree status sweep when git does not answer', () => {
  let dir: string

  beforeEach(() => {
    clearModuleCaches()
    clearDirtyQueue()
    rmSync(reconcileRequestPathFor(dataDir()), { force: true })
    rmSync(workerErrorLogPath(dataDir()), { force: true })
    seam.status = null
    dir = gitRepoWithCommit()
  })

  afterEach(() => {
    seam.status = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the worker to reconcile the project, and logs it, when the status read runs past its budget', async () => {
    seam.status = { exitCode: -1, timedOut: true }

    await formatterRun(dir)

    expect(requested()).toEqual([foldPath(normalizePath(dir))])
    expect(dirty()).toEqual([])
    expect(workerLog()).toMatch(/post-bash status sweep in .*: git status did not answer in time \(no answer\); asked the worker to reconcile the project/)
  })

  it('asks for nothing when git could not be started at all, since the worker needs git to sweep', async () => {
    seam.status = { exitCode: -1 }

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

  it('asks for no reconcile when git answers that this is not a repository', async () => {
    seam.status = { exitCode: 128 }

    await formatterRun(dir)

    expect(requested()).toEqual([])
    expect(dirty()).toEqual([])
    expect(workerLog()).toBe('')
  })
})
