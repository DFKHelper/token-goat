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

  it('is true for a git whose output overflowed the buffer, since git ran and was ended before it finished', () => {
    vi.mocked(cp.spawnSync).mockReturnValueOnce(syncResult({ error: errnoError('ENOBUFS'), signal: 'SIGTERM' }))
    const result = runGit(['log'])
    expect(result.unfinished).toBe(true)
    expect(result.stderr).toMatch(/ENOBUFS/)
    expect(result.timedOut).toBeUndefined()
  })
})

/** A child process with nothing behind it: no pid, so the tree kill is a no-op and no process exists to reap. The row drives its events by hand. */
function fakeChild(): EventEmitter & { stdout: EventEmitter & { destroy(): void }; stderr: EventEmitter & { destroy(): void }; stdin: { end(): void; destroy(): void; on(): void } } {
  const pipe = (): EventEmitter & { destroy(): void } => Object.assign(new EventEmitter(), { destroy: () => undefined })
  return Object.assign(new EventEmitter(), { stdout: pipe(), stderr: pipe(), stdin: { end: () => undefined, destroy: () => undefined, on: () => undefined } })
}

describe('runGitAsync sets unfinished for a git it ended itself', () => {
  it('is true for a git ended at its time bound, with timedOut kept for detail', async () => {
    vi.useFakeTimers()
    try {
      const child = fakeChild()
      vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
      const pending = runGitAsync(['status'], { timeoutMs: 50 })
      vi.advanceTimersByTime(50)
      child.emit('exit', null, 'SIGTERM')
      const result = await pending
      expect(result.unfinished, 'a timeout is unfinished').toBe(true)
      expect(result.timedOut).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('is true for a git ended because its output overflowed the buffer', async () => {
    const child = fakeChild()
    vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
    const pending = runGitAsync(['log'])
    // Only the chunk's length is read, so a stand-in one byte over the 200 MiB limit costs no memory.
    child.stdout.emit('data', { length: 200 * 1024 * 1024 + 1 })
    child.emit('exit', null, 'SIGTERM')
    const result = await pending
    expect(result.unfinished, 'an overflow is unfinished').toBe(true)
    expect(result.stderr).toMatch(/ENOBUFS/)
    expect(result.timedOut).toBeUndefined()
    expect(result.exitCode).toBe(-1)
  })

  it('is true for a git ended because the caller aborted it', async () => {
    const child = fakeChild()
    vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
    const controller = new AbortController()
    const pending = runGitAsync(['status'], { signal: controller.signal })
    controller.abort()
    child.emit('exit', null, 'SIGTERM')
    const result = await pending
    expect(result.unfinished, 'an abort is unfinished').toBe(true)
    expect(result.stderr).toBe('git was aborted')
    expect(result.timedOut).toBeUndefined()
  })

  it('is false for a spawn that failed before git ran, which only a missing binary or directory causes', async () => {
    const child = fakeChild()
    vi.mocked(cp.spawn).mockImplementationOnce((() => child) as unknown as typeof cp.spawn)
    const pending = runGitAsync(['status'])
    child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    const result = await pending
    expect(result.unfinished).toBe(false)
    expect(result.exitCode).toBe(-1)
  })

  it('is false for a call aborted before git started, since git never ran', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await runGitAsync(['status'], { signal: controller.signal })
    expect(result.unfinished).toBe(false)
    expect(result.stderr).toBe('git was aborted before it started')
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
