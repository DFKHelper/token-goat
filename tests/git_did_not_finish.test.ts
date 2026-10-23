// Provenance: HAND-DERIVED from src/util.ts::runGit and src/git_async.ts::runGitAsync. The mocked spawn results are the shapes Node returns: a timeout carries error.code ETIMEDOUT with a SIGTERM (the Node 24.12 CAPTURE in src/util.ts), a signal kill has status null and a signal name, a clean exit has a status, and a spawn that never ran has error.code ENOENT.
import { EventEmitter } from 'node:events'
import * as cp from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'

import { runGitAsync } from '../src/git_async.js'
import { runGit } from '../src/util.js'

// vi.spyOn cannot patch node:child_process (non-configurable namespace exports), so each call passes straight through unless a row queues a result with mockReturnValueOnce or mockImplementationOnce.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cp>()
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => actual.spawn(...args)),
    spawnSync: vi.fn((...args: Parameters<typeof actual.spawnSync>) => actual.spawnSync(...args)),
  }
})

function syncResult(fields: Partial<cp.SpawnSyncReturns<string>>): cp.SpawnSyncReturns<string> {
  return { pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null, ...fields }
}

function errnoError(code: string): Error {
  return Object.assign(new Error(`spawnSync git ${code}`), { code })
}

describe('runGit sets unfinished', () => {
  it('is true for a git killed at its time bound, with timedOut kept for detail', () => {
    vi.mocked(cp.spawnSync).mockReturnValueOnce(syncResult({ error: errnoError('ETIMEDOUT'), signal: 'SIGTERM' }))
    const result = runGit(['status'])
    expect(result.unfinished).toBe(true)
    expect(result.timedOut).toBe(true)
  })

  it('is true for a git killed by a signal, with the signal kept for detail', () => {
    vi.mocked(cp.spawnSync).mockReturnValueOnce(syncResult({ signal: 'SIGKILL' }))
    const result = runGit(['status'])
    expect(result.unfinished).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })

  it('is false for a git that ran and exited 1, which is an answer', () => {
    vi.mocked(cp.spawnSync).mockReturnValueOnce(syncResult({ status: 1, stderr: 'fatal: not a git repository' }))
    expect(runGit(['rev-parse', '--verify', 'HEAD']).unfinished).toBe(false)
  })

  it('is false for a spawn that never ran git', () => {
    vi.mocked(cp.spawnSync).mockReturnValueOnce(syncResult({ error: errnoError('ENOENT') }))
    expect(runGit(['status']).unfinished).toBe(false)
  })
})

describe('runGitAsync sets unfinished', () => {
  it('is true for a git whose process ends by a signal', async () => {
    const child = new EventEmitter()
    vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
    const pending = runGitAsync(['status'])
    child.emit('close', null, 'SIGKILL')
    const result = await pending
    expect(result.unfinished).toBe(true)
    expect(result.signal).toBe('SIGKILL')
  })

  it('is false for a git that exited 0', async () => {
    const child = new EventEmitter()
    vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
    const pending = runGitAsync(['status'])
    child.emit('close', 0, null)
    expect((await pending).unfinished).toBe(false)
  })
})
