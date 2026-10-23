// Provenance: HAND-DERIVED from src/cli_bench.ts::currentCommit and src/types.ts::GitResult. The git answers are canned: a git that did not finish is the shape src/util.ts::runGit returns for a timeout or a signal (exit -1, unfinished, tests/git_did_not_finish.test.ts drives the real runners to it); the sha and the porcelain line are the shapes git prints, with no value read from the implementation.
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { GitResult } from '../src/types.js'
import type * as UtilModule from '../src/util.js'

const answers = vi.hoisted(() => ({ head: null as unknown, status: null as unknown }))

vi.mock('../src/util.js', async (importOriginal) => {
  const actual = await importOriginal<typeof UtilModule>()
  return {
    ...actual,
    runGit: (args: string[]) => (args[0] === 'rev-parse' ? answers.head : answers.status),
  }
})

const { currentCommit } = await import('../src/cli_bench.js')

const SHA: GitResult = { stdout: 'abc1234\n', stderr: '', exitCode: 0, unfinished: false }
const UNFINISHED: GitResult = { stdout: '', stderr: 'spawnSync git ETIMEDOUT', exitCode: -1, unfinished: true, timedOut: true }
const KILLED: GitResult = { stdout: '', stderr: 'git was killed by SIGKILL', exitCode: -1, unfinished: true, signal: 'SIGKILL' }

beforeEach(() => {
  answers.head = SHA
  answers.status = { stdout: '', stderr: '', exitCode: 0, unfinished: false } satisfies GitResult
})

describe('currentCommit labels a row from a git status that may not have finished', () => {
  it('names the bare sha for a status that finished clean', () => {
    expect(currentCommit()).toBe('abc1234')
  })

  it('adds -dirty for a status that finished with changes', () => {
    answers.status = { stdout: ' M f.txt\n', stderr: '', exitCode: 0, unfinished: false } satisfies GitResult
    expect(currentCommit()).toBe('abc1234-dirty')
  })

  it('labels the row unknown, not clean, when the status timed out', () => {
    answers.status = UNFINISHED
    expect(currentCommit()).toBe('unknown')
  })

  it('labels the row unknown, not clean, when the status was killed by a signal', () => {
    answers.status = KILLED
    expect(currentCommit()).toBe('unknown')
  })

  it('labels the row unknown when the rev-parse did not finish', () => {
    answers.head = UNFINISHED
    expect(currentCommit()).toBe('unknown')
  })
})
