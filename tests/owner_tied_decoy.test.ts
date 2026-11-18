/** A stand-in for a worker daemon that a test starts must leave when the process that owns it does, because a hard-killed test run never reaches its afterEach. Test hygiene, not product behaviour. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { DECOY_OWNER_PID_ENV, OWNER_TIED_DECOY_SOURCE, ownedDecoyEnv, spawnOwnedDecoy } from './helpers/owner_tied_decoy.js'

const started: ChildProcess[] = []
const ownerOf = new Map<ChildProcess, ChildProcess>()

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

// The row's own failure on a missing death condition is vitest's timeout error, which carries no pid, so the survivor is named here: a hook error is added to the test's errors after a timeout too.
afterEach(() => {
  const survivors = [...ownerOf].filter(([decoy, owner]) => alive(decoy) && !alive(owner)).map(([decoy, owner]) => `decoy pid ${decoy.pid} was still alive after its owner pid ${owner.pid} ended`)
  ownerOf.clear()
  for (const child of started.splice(0)) if (alive(child)) child.kill('SIGKILL')
  expect(survivors, 'a decoy outlived its owner').toEqual([])
})

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()))
}

/** Settles when the child exits, or when the test's own signal aborts, whichever comes first. */
function exitedOrAborted(child: ChildProcess, signal: AbortSignal): Promise<void> {
  if (!alive(child) || signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
    child.once('exit', () => resolve())
  })
}

// HAND-DERIVED: the decoy's death rules are a stdin pipe that ends (node documents 'end' on a readable stream) and the pid probe in tests/test_run_root_sweep.test.ts (a liveness probe of the owner's pid with signal 0, which throws ESRCH once the process is gone); node documents process.kill(pid, 0) as the existence probe. No wire format is involved.
describe('the owner-tied decoy', () => {
  it('names its owner in the environment it runs with', () => {
    expect(ownedDecoyEnv(4242)[DECOY_OWNER_PID_ENV]).toBe('4242')
    expect(ownedDecoyEnv()[DECOY_OWNER_PID_ENV]).toBe(String(process.pid))
    expect(OWNER_TIED_DECOY_SOURCE).toContain(DECOY_OWNER_PID_ENV)
  })

  it('exits once the process that owns it is gone', async ({ signal }) => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    started.push(owner)
    expect(owner.pid).toBeDefined()
    const decoy = spawnOwnedDecoy(['--worker-daemon'], owner.pid as number)
    started.push(decoy)
    ownerOf.set(decoy, owner)
    expect(decoy.pid).toBeDefined()
    owner.kill('SIGKILL')
    await exited(owner)
    // Waits on the decoy's own exit event or the test's abort signal (vitest 5.0.2 aborts context.signal at the test timeout, in its runner's abortIfTimeout); afterEach names a decoy that outlived its owner.
    await exitedOrAborted(decoy, signal)
    expect(decoy.exitCode, 'the decoy did not leave on its own accord').toBe(0)
  })

  it('exits once the stdin pipe its owner holds ends, while the owner is still alive', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    started.push(owner)
    expect(owner.pid).toBeDefined()
    const decoy = spawnOwnedDecoy(['--worker-daemon'], owner.pid as number)
    started.push(decoy)
    ownerOf.set(decoy, owner)
    expect(decoy.stdin, 'the decoy was not given a piped stdin').not.toBeNull()
    decoy.stdin!.on('error', () => undefined)
    decoy.stdin!.end()
    // Waits on the decoy's own exit event: the owner pid still answers, so only the pipe can have ended it.
    await exited(decoy)
    expect(decoy.exitCode, 'the decoy did not leave when its pipe ended').toBe(0)
    expect(owner.exitCode === null && owner.signalCode === null, 'the owner was gone, so the pid check could have ended the decoy').toBe(true)
  })
})
