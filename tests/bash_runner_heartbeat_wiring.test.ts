import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'

import { expect, it, vi } from 'vitest'

import { run } from '../src/bash_runner.js'
import type * as ProcessTreeModule from '../src/process_tree.js'
import type { spawnOwned as SpawnOwnedFn } from '../src/process_tree.js'

const spawnState = vi.hoisted(() => ({
  spawnOwned: vi.fn<typeof SpawnOwnedFn>(),
}))

vi.mock('../src/process_tree.js', async (importOriginal) => {
  const original = await importOriginal<typeof ProcessTreeModule>()
  return { ...original, spawnOwned: spawnState.spawnOwned }
})

it('resets the running heartbeat when run reads child output', async () => {
  const intervalMs = 1_000
  const heartbeats: string[] = []
  const child = new ChildProcess()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  child.stdout = stdout
  child.stderr = stderr
  const release = vi.fn()
  spawnState.spawnOwned.mockReturnValue({ child, kill: vi.fn(), release })

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const result = run('heartbeat wiring test', {
    filterName: 'generic',
    heartbeatIntervalMs: intervalMs,
    timeout: 30,
    writeStdout: () => {},
    writeStderr: (text) => {
      if (text.startsWith('[token-goat compress] still running')) heartbeats.push(text)
    },
  })
  let closed = false
  const closeChild = (): void => {
    if (closed) return
    closed = true
    stdout.end()
    stderr.end()
    child.emit('close', 0, null)
  }

  try {
    await vi.advanceTimersByTimeAsync(400)
    stdout.write('first output\n')
    await vi.advanceTimersByTimeAsync(600)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(heartbeats, 'output at 400 ms must prevent the original 1 s heartbeat').toEqual([])

    await vi.advanceTimersByTimeAsync(400)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(heartbeats, 'a heartbeat must still arrive 1 s after the output').toHaveLength(1)

    closeChild()
    await expect(result).resolves.toBe(0)
    expect(release).toHaveBeenCalledOnce()
  } finally {
    closeChild()
    await result
    stdout.destroy()
    stderr.destroy()
    vi.useRealTimers()
    spawnState.spawnOwned.mockReset()
  }
})
