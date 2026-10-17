// Provenance: HAND-DERIVED. The stand-in is a `node -e` sleeper started here; the 'exit' event, exitCode and signalCode are the documented ChildProcess surface (Node.js child_process docs), and the wait is judged under faked timers so that any wait on a clock never ends: a stop that returns anyway waited on the exit event. Real child process, no stubbed handle except the kill spy on the already-exited case.
import { spawn, type ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { stopOwnedChild } from './helpers/stop_owned_child.js'

const children: ChildProcess[] = []

// owner: this test file; dies on its own after 60 s, and afterEach ends it through its handle sooner.
function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await exited(child)
  }
})

describe('stopOwnedChild', () => {
  it('ends a live child and returns on its exit event, with every timer frozen', async () => {
    const child = sleeper()
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    vi.useFakeTimers()
    await stopOwnedChild(child)
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 20_000)

  it('signals nothing for a child that has already exited', async () => {
    const child = sleeper()
    child.kill('SIGKILL')
    await exited(child)
    const kill = vi.spyOn(child, 'kill')
    await stopOwnedChild(child)
    expect(kill).not.toHaveBeenCalled()
  })
})
