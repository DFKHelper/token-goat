// Provenance: HAND-DERIVED. The stand-in is a `node -e` sleeper started here; the 'exit' event, exitCode and signalCode are the documented ChildProcess surface (Node.js child_process docs), and the wait is judged under faked timers so that any wait on a clock never ends: a stop that returns anyway waited on the exit event. Real child process, no stubbed handle except the kill spy on the already-exited case.
import { spawn, type ChildProcess } from 'node:child_process'

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

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

// HAND-DERIVED: a Windows kill('SIGTERM') is TerminateProcess and cannot be ignored, so the stand-in swallows the SIGTERM at the handle (it records the signal and returns), which is how a POSIX child that ignores SIGTERM looks to stopOwnedChild; every other signal reaches the real handle. The child is not in `children`: that afterEach would end it before the helper's onTestFinished hook runs, and the second test would prove nothing.
describe('stopOwnedChild with a child that ignores SIGTERM', () => {
  const signals: Array<NodeJS.Signals | number | undefined> = []
  let stubborn: ChildProcess | undefined
  let pending: Promise<void> | undefined

  afterAll(async () => {
    if (stubborn !== undefined && stubborn.exitCode === null && stubborn.signalCode === null) {
      stubborn.kill('SIGKILL')
      await exited(stubborn)
    }
  })

  it('leaves the wait pending on SIGTERM and returns without it', async () => {
    // owner: this describe; dies on its own after 60 s, and the helper's onTestFinished hook or afterAll ends it through its handle sooner.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    stubborn = child
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve())
      child.once('error', reject)
    })
    const realKill = child.kill.bind(child)
    child.kill = (signal?: NodeJS.Signals | number): boolean => {
      signals.push(signal)
      return signal === 'SIGTERM' ? true : realKill(signal)
    }
    pending = stopOwnedChild(child)
    expect(signals).toEqual(['SIGTERM'])
    expect(child.exitCode === null && child.signalCode === null).toBe(true)
  })

  it('had that child ended through its handle when the first test finished', async () => {
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    await pending
    expect(stubborn?.exitCode !== null || stubborn?.signalCode !== null).toBe(true)
  })
})
