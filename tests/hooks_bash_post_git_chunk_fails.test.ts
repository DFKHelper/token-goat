// A hook that runs git loads src/git_async.ts on demand, and that load can fail (a file replaced under a long-lived hook server). Provenance: HAND-DERIVED for the rule (a git that never ran gives runGit's shape, exit -1 with the reason in stderr, and the rest of the post hook still happens). The failed load is forced by a module factory that throws, which is how a failed dynamic import() reaches the caller: as a rejection of the import. Everything else, the handler, the config and the git repository, is real.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { gitRepoWithCommit } from './helpers/git-repo.js'
import { makeHookEvent } from './helpers/hook-event.js'
import { clearDirtyQueue, getDirtyPaths } from '../src/hooks_index.js'
import { clearModuleCaches } from '../src/reset.js'

vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, dataDir: () => _testDataDir }
})

vi.mock('../src/git_async.js', () => {
  throw new Error('forced: the git_async chunk failed to load')
})

const _testDataDir = mkdtempSync(join(tmpdir(), 'tg-git-chunk-fails-data-'))

const { postBashHandler } = await import('../src/hooks_bash_post.js')
const { runGitAsyncLazy } = await import('../src/util.js')

const ESC = String.fromCharCode(27)

function postBashEvent(command: string, cwd: string, output = '') {
  return makeHookEvent({
    eventName: 'post_tool_use',
    toolName: 'Bash',
    toolInput: { command },
    sessionId: 'test-session',
    agentId: undefined,
    raw: { tool_name: 'Bash', tool_input: { command }, tool_response: output, cwd },
  })
}

describe('a git_async chunk that fails to load', () => {
  beforeEach(() => {
    clearModuleCaches()
    clearDirtyQueue()
  })

  it('runGitAsyncLazy answers with the shape of a git that never ran, not a rejection', async () => {
    const result = await runGitAsyncLazy(['status'], { cwd: tmpdir() })
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
    expect(result.stderr, 'the reason the git never ran').not.toBe('')
  })

  it('does not stop the post hook: the output after a head-moving git command is still rewritten', async () => {
    const dir = gitRepoWithCommit()
    // The colour sequences are what the last pass of the handler strips; that pass runs after the git reads, so a handler stopped at the failed read never reaches it.
    const colored = `Switched to a new branch ${ESC}[38;2;240;246;252mfeature${ESC}[0m\n`
    const result = await postBashHandler(postBashEvent('git checkout -b feature', dir, colored.repeat(40)))
    if (result.hookType !== 'rewriteOutput') throw new Error(`the handler stopped at the failed git read, so nothing after it ran: ${result.hookType}`)
    expect(result.updatedOutput).toContain('Switched to a new branch feature')
    expect(result.updatedOutput).not.toContain(ESC)
    expect(getDirtyPaths(), 'a git that never ran named no changed file').toEqual([])
  })
})
