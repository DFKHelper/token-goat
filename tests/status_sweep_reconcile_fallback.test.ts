/** A formatter run, a patch application or a stash apply rewrites files without going through any edit tool, and the Bash post hook finds them by asking git for the working-tree status. When git never answers in the hook's budget (a spawn failure or the 5 s timeout under load, exit -1) the sweep used to name nothing and ask for nothing, so the index kept the pre-rewrite content with nothing in any log; it now asks the worker to reconcile the project, as the branch-switch block beside it does. The status answer is the seam (the exit codes -1 and 128 are what runGit returns for a spawn failure and for git's "not a repository", HAND-DERIVED from src/util.ts::runGit and git's exit status); the expected queue contents are HAND-DERIVED from the command. */
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
import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'

const seam = vi.hoisted(() => ({ statusExit: null as number | null }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[], opts?: Parameters<typeof actual.runGit>[1]) => (seam.statusExit !== null && args[0] === 'status' ? { stdout: '', stderr: 'no answer', exitCode: seam.statusExit } : actual.runGit(args, opts)),
  }
})

const requested = (): string[] => {
  const file = reconcileRequestPathFor(dataDir())
  return existsSync(file) ? parseReconcileRequests(readFileSync(file, 'utf8')).map((d) => foldPath(normalizePath(d))) : []
}
const dirty = (): string[] => getDirtyPaths().map((p) => foldPath(p))

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
    seam.statusExit = null
    dir = gitRepoWithCommit()
  })

  afterEach(() => {
    seam.statusExit = null
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the worker to reconcile the project when the status read never answers', async () => {
    seam.statusExit = -1

    await formatterRun(dir)

    expect(requested()).toContain(foldPath(normalizePath(dir)))
    expect(dirty()).toEqual([])
  })

  it('enqueues the rewritten file and asks for no reconcile when the status read answers', async () => {
    await formatterRun(dir)

    expect(dirty()).toContain(foldPath(resolveIndexPath('a.txt', dir)))
    expect(requested()).toEqual([])
  })

  it('asks for no reconcile when git answers that this is not a repository', async () => {
    seam.statusExit = 128

    await formatterRun(dir)

    expect(requested()).toEqual([])
    expect(dirty()).toEqual([])
  })
})
