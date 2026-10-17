// Provenance: HAND-DERIVED. The stand-in is a `node -e` sleeper started here; the 'exit' event, exitCode and signalCode are the documented ChildProcess surface (Node.js child_process docs), and the wait is judged under faked timers so that any wait on a clock never ends: a stop that returns anyway waited on the exit event. Real child process, no stubbed handle except the kill spy on the already-exited case.
import { spawn, type ChildProcess } from 'node:child_process'
import * as os from 'node:os'
import * as path from 'node:path'

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
    await stopOwnedChild(child, { graceful: true })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  }, 20_000)

  it('signals nothing for a child that has already exited', async () => {
    const child = sleeper()
    child.kill('SIGKILL')
    await exited(child)
    const kill = vi.spyOn(child, 'kill')
    await stopOwnedChild(child, { graceful: true })
    expect(kill).not.toHaveBeenCalled()
  })
})

// HAND-DERIVED: a Windows kill('SIGTERM') is TerminateProcess and cannot be ignored, so the stand-in swallows the SIGTERM at the handle (it records the signal and returns), which is how a POSIX child that ignores SIGTERM looks to stopOwnedChild; every other signal reaches the real handle.
function swallowSigterm(child: ChildProcess, signals: Array<NodeJS.Signals | number | undefined>): ChildProcess {
  const realKill = child.kill.bind(child)
  child.kill = (signal?: NodeJS.Signals | number): boolean => {
    signals.push(signal)
    return signal === 'SIGTERM' ? true : realKill(signal)
  }
  return child
}

function spawned(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
}

// HAND-DERIVED: the helper's onTestFinished hook runs after the test body and its afterEach hooks, so what it did is read in the describe's afterAll, from state this describe's only test sets. The child is not in `children`: that afterEach would end it before the helper's hook runs, and the check would prove nothing.
describe('stopOwnedChild with a child that ignores SIGTERM, on a graceful stop', () => {
  const signals: Array<NodeJS.Signals | number | undefined> = []
  let stubborn: ChildProcess | undefined
  let pending: Promise<void> | undefined

  afterAll(async () => {
    try {
      expect(stubborn, 'the test never started its child').toBeDefined()
      expect(signals, 'the helper ends a child still alive when the test finishes, through its handle').toEqual(['SIGTERM', 'SIGKILL'])
      await pending
      expect(stubborn?.exitCode !== null || stubborn?.signalCode !== null).toBe(true)
    } finally {
      if (stubborn !== undefined && stubborn.exitCode === null && stubborn.signalCode === null) {
        stubborn.kill('SIGKILL')
        await exited(stubborn)
      }
    }
  })

  it('leaves the wait pending on SIGTERM and returns without it', async () => {
    // owner: this describe; dies on its own after 60 s, and the helper's onTestFinished hook or afterAll ends it through its handle sooner.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
    stubborn = child
    await spawned(child)
    swallowSigterm(child, signals)
    pending = stopOwnedChild(child, { graceful: true })
    expect(signals).toEqual(['SIGTERM'])
    expect(child.exitCode === null && child.signalCode === null).toBe(true)
  })
})

// HAND-DERIVED: the call site of worker_daemon_e2e.test.ts is `try { body; bodyFinished = true } finally { await stopOwnedChild(child, { graceful: bodyFinished }) }`. A body that throws must reach the caller as itself; a stop that waited for a child ignoring SIGTERM would hold the test until its timeout and the body's error would be lost.
describe('stopOwnedChild when the test body threw', () => {
  it('ends a child that ignores SIGTERM without sending it, and returns', async () => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const child = swallowSigterm(sleeper(), signals)
    await spawned(child)
    await stopOwnedChild(child, { graceful: false })
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(signals).not.toContain('SIGTERM')
  })

  it('lets the body error through a finally that stops a child ignoring SIGTERM', async () => {
    const child = swallowSigterm(sleeper(), [])
    await spawned(child)
    const body = async (): Promise<void> => {
      throw new Error('the test body failed')
    }
    const run = async (): Promise<void> => {
      let bodyFinished = false
      try {
        await body()
        bodyFinished = true
      } finally {
        await stopOwnedChild(child, { graceful: bodyFinished })
      }
    }
    await expect(run()).rejects.toThrow('the test body failed')
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
  })
})

// HAND-DERIVED: Node documents that spawn of an executable that does not exist emits 'error' (ENOENT) and leaves pid undefined, and that 'error' is also emitted when a process could not be killed; in both cases 'exit' may never come. A stop that settles does so within microtasks, so the race below is against one macrotask turn and uses no clock: a stop still pending after the turn is a hang.
const hangsAfterOneTurn = (stop: Promise<void>): Promise<boolean> => Promise.race([stop.then(() => false), new Promise<boolean>((resolve) => setImmediate(() => resolve(true)))])

describe('stopOwnedChild when no exit event can come', () => {
  // HAND-DERIVED: probed on Node 24: right after spawn() of a missing executable pid is undefined and exitCode is still null, then only 'error' (ENOENT) is emitted and exitCode becomes negative; no 'exit' follows.
  it.each([{ graceful: true }, { graceful: false }])('settles for a spawn that failed, called before its error is emitted (graceful: $graceful)', async ({ graceful }) => {
    const child = spawn(path.join(os.tmpdir(), 'tg-no-such-executable-for-stop-owned-child'), [], { stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    expect(child.pid, 'a failed spawn has no pid').toBeUndefined()
    expect(child.exitCode, 'the failure is not yet recorded when the stop is called').toBeNull()
    expect(await hangsAfterOneTurn(stopOwnedChild(child, { graceful })), 'the stop must settle without an exit event').toBe(false)
  })

  it.each([{ graceful: true }, { graceful: false }])('settles when the child reports an error instead of exiting, and ends the child (graceful: $graceful)', async ({ graceful }) => {
    const signals: Array<NodeJS.Signals | number | undefined> = []
    const child = swallowSigterm(sleeper(), signals)
    await spawned(child)
    // HAND-DERIVED: the stand-in for a kill that failed is an 'error' event on a live child, which Node documents as the signal for a process that could not be killed.
    const stop = stopOwnedChild(child, { graceful }).then(() => undefined, (error: unknown) => error)
    if (graceful) expect(signals, 'the stop signalled the live child').toEqual(['SIGTERM'])
    const failure = new Error('HAND-DERIVED: the process could not be killed')
    child.emit('error', failure)
    const outcome = await Promise.race([stop.then((value) => ({ value })), new Promise<null>((resolve) => setImmediate(() => resolve(null)))])
    expect(outcome, 'the error event must end the wait').not.toBeNull()
    // A graceful stop follows a finished body, so nothing is masked and the error is shown; after a failed body the body's own error is the one reported.
    expect(outcome?.value, graceful ? 'the error reaches the caller' : 'the error is dropped behind the failed body').toBe(graceful ? failure : undefined)
    await exited(child)
    expect(child.exitCode !== null || child.signalCode !== null, 'the child was ended, not left running').toBe(true)
  })
})
