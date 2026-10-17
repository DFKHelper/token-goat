// Provenance: HAND-DERIVED for the expectations (a git blocked on a lock it never gets cannot finish, so any default timeout ends it; `rev-parse --git-dir` in a fresh repository prints `.git`). The git behaviour that blocks is the one tests/run_git_timeout_reaps_git.test.ts uses: `pack-refs` with `core.packedRefsTimeout=-1` waits for packed-refs.lock for as long as the file exists (git's refs/files-backend.c lock timeout, -1 = retry indefinitely). The exit -1 plus timedOut shape is the CAPTURE documented at src/util.ts::runGit (Node 24.12 on Windows 11: ETIMEDOUT). Real git, real process: no runGit stub. The default is lowered by mocking the module that defines it, and only in this file; no call below passes a timeoutMs, which is the point.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as types from '../src/types.js'

const defaults = vi.hoisted(() => ({ ms: 60_000 }))
vi.mock('../src/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof types>()
  return {
    ...actual,
    get GIT_DEFAULT_TIMEOUT_MS(): number {
      return defaults.ms
    },
  }
})

import { runGit } from '../src/util.js'

let repo = ''

beforeEach(() => {
  defaults.ms = 60_000
  repo = mkdtempSync(path.join(os.tmpdir(), 'tg-rungit-default-'))
  expect(runGit(['init', '-q'], { cwd: repo }).exitCode).toBe(0)
})

afterEach(() => {
  // Dropping the lock lets a git that outlived its timeout finish by itself before the directory goes.
  rmSync(path.join(repo, '.git', 'packed-refs.lock'), { force: true })
  rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

describe('runGit default timeout', () => {
  it('ends a git blocked on a lock when the call names no timeout, and says it timed out', () => {
    writeFileSync(path.join(repo, '.git', 'packed-refs.lock'), '')
    defaults.ms = 100
    const result = runGit(['-c', 'core.packedRefsTimeout=-1', 'pack-refs', '--all'], { cwd: repo })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(-1)
  })

  it('returns a finished command whole when the default is not reached', () => {
    const result = runGit(['rev-parse', '--git-dir'], { cwd: repo })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('.git')
    expect(result.timedOut).toBeUndefined()
  })
})
