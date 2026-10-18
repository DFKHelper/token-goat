// Provenance: FORMAT-DERIVED. Node v24.12.0 lib/internal/child_process.js, printed with ChildProcess.prototype.kill.toString() on 2026-10-17: kill() calls this._handle.kill(signal) and, for an errno that is neither 0, ESRCH, EINVAL nor ENOSYS ("almost certainly EPERM"), does this.emit('error', new ErrnoException(err, 'kill')); emit throws an 'error' only when no listener is attached. The EPERM code is read from util.getSystemErrorMap() because libuv's value differs by platform. The failing handle is real (a replaced _handle.kill returning that code), restored before the child is reaped. The real child is a `node -e` sleeper started here.
import { spawn, type ChildProcess } from 'node:child_process'
import * as util from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

// HAND-DERIVED: vitest runs an onTestFinished hook after the test body, where a throw fails the test itself and cannot be asserted on, so the registration is captured here and the hook is called by the test, which reads what it throws. Only the registration is replaced; the helper's own code is the unit under test.
const hooks = vi.hoisted(() => [] as Array<() => void>)
vi.mock('vitest', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  onTestFinished: (hook: () => void): void => {
    hooks.push(hook)
  },
}))

const { stopOwnedChild, trackOwnedChild } = await import('./helpers/stop_owned_child.js')

const children: ChildProcess[] = []

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

type KillHandle = { kill: (signal: number) => number }

// owner: this test file; dies on its own after 60 s, and afterEach ends it through its handle sooner.
async function spawnedSleeper(): Promise<{ child: ChildProcess; handle: KillHandle; realKill: KillHandle['kill'] }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true })
  children.push(child)
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve())
    child.once('error', reject)
  })
  const handle = (child as unknown as { _handle: KillHandle })._handle
  return { child, handle, realKill: handle.kill.bind(handle) }
}

function epermCode(): number {
  const eperm = [...util.getSystemErrorMap()].find(([, [name]]) => name === 'EPERM')?.[0]
  expect(eperm, 'this platform defines EPERM').toBeDefined()
  return eperm!
}

afterEach(async () => {
  hooks.splice(0)
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await exited(child)
  }
})

describe('stopOwnedChild when a kill fails with EPERM', () => {
  it('reports a backstop kill that fails while the stop is still waiting on the child', async () => {
    const { child, handle, realKill } = await spawnedSleeper()
    // HAND-DERIVED: a POSIX child that ignores SIGTERM looks to the stop like a SIGTERM the handle accepted and the child never acted on, so the stop stays pending with its own once('error') listener attached, which is the state the backstop meets.
    const realChildKill = child.kill.bind(child)
    child.kill = (signal?: NodeJS.Signals | number): boolean => (signal === 'SIGTERM' ? true : realChildKill(signal))
    const pending = stopOwnedChild(child, { graceful: true }).then(() => undefined, (error: unknown) => error)
    expect(hooks, 'the stop registered its backstop').toHaveLength(1)
    handle.kill = (): number => epermCode()
    let backstop: unknown
    try {
      try {
        hooks[0]!()
      } catch (error) {
        backstop = error
      }
    } finally {
      handle.kill = realKill
    }
    // The stop's own once('error') listener swallows the event, so only the backstop's listener can return the failure; without it the backstop passes silently and the child is left running unreported.
    expect(backstop, 'the backstop must throw the kill failure').toBeInstanceOf(Error)
    expect((backstop as Error).message, 'the failure names the kill and its errno').toContain('kill EPERM')
    const stopOutcome = await pending
    expect(stopOutcome, 'the waiting stop sees the same error event and rethrows it, being graceful').toBeInstanceOf(Error)
    await exited(child)
    expect(child.exitCode !== null || child.signalCode !== null, 'the child was ended, not left running').toBe(true)
  })

  it('rethrows the failure of the first signal on a graceful stop and ends the child in the backstop', async () => {
    const { child, handle, realKill } = await spawnedSleeper()
    handle.kill = (): number => epermCode()
    let outcome: unknown
    try {
      outcome = await stopOwnedChild(child, { graceful: true }).then(() => undefined, (error: unknown) => error)
    } finally {
      handle.kill = realKill
    }
    expect(outcome, 'the graceful stop rethrows the kill failure').toBeInstanceOf(Error)
    expect((outcome as Error).message, 'the failure names the kill and its errno').toContain('kill EPERM')
    expect(hooks, 'the stop registered its backstop').toHaveLength(1)
    expect(() => hooks[0]!(), 'with the handle healthy again the backstop ends the child quietly').not.toThrow()
    await exited(child)
    expect(child.signalCode ?? child.exitCode, 'the backstop ended the child').not.toBeNull()
  })
})

describe('trackOwnedChild, called at spawn before any wait', () => {
  it('registers a backstop that ends a child nothing ever stops, as when vitest times the test out mid-wait', async () => {
    const { child } = await spawnedSleeper()
    trackOwnedChild(child)
    expect(hooks, 'tracking registered one backstop, with no stop call').toHaveLength(1)
    expect(child.exitCode === null && child.signalCode === null, 'the child is still running before the backstop').toBe(true)
    hooks[0]!()
    await exited(child)
    expect(child.signalCode ?? child.exitCode, 'the backstop ended the child').not.toBeNull()
  })

  it('registers once when the child is tracked and then stopped', async () => {
    const { child } = await spawnedSleeper()
    trackOwnedChild(child)
    trackOwnedChild(child)
    await stopOwnedChild(child, { graceful: true })
    expect(hooks).toHaveLength(1)
  })

  it('listens for error from the moment of the call and leaves a child whose spawn failed alone', async () => {
    // HAND-DERIVED: spawning a program that does not exist emits 'error' (ENOENT) on a later turn and leaves pid undefined, so the child has no process to end.
    const child = spawn('tg-no-such-program-for-the-track-test', [], { stdio: 'ignore', windowsHide: true })
    trackOwnedChild(child)
    expect(child.listenerCount('error'), 'an error listener is attached at the call').toBeGreaterThan(0)
    await new Promise<void>((resolve) => child.once('error', () => resolve()))
    expect(child.pid, 'the spawn failed').toBeUndefined()
    expect(() => hooks[0]!(), 'the backstop has nothing to end and does not throw').not.toThrow()
  })
})
