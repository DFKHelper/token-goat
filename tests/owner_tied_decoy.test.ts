/** A stand-in for a worker daemon that a test starts must leave when the process that owns it does, because a hard-killed test run never reaches its afterEach. Test hygiene, not product behaviour. */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { DECOY_OWNER_PID_ENV, OWNER_TIED_DECOY_SOURCE, ownedDecoyEnv, spawnOwnedDecoy } from './helpers/owner_tied_decoy.js'

const started: ChildProcess[] = []

afterEach(() => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
})

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve()))
}

// HAND-DERIVED: the decoy's death rule is the one in tests/test_run_root_sweep.test.ts (a liveness probe of the owner's pid with signal 0, which throws ESRCH once the process is gone); node documents process.kill(pid, 0) as the existence probe. No wire format is involved.
describe('the owner-tied decoy', () => {
  it('names its owner in the environment it runs with', () => {
    expect(ownedDecoyEnv(4242)[DECOY_OWNER_PID_ENV]).toBe('4242')
    expect(ownedDecoyEnv()[DECOY_OWNER_PID_ENV]).toBe(String(process.pid))
    expect(OWNER_TIED_DECOY_SOURCE).toContain(DECOY_OWNER_PID_ENV)
  })

  it('exits once the process that owns it is gone', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    started.push(owner)
    expect(owner.pid).toBeDefined()
    const decoy = spawnOwnedDecoy(['--worker-daemon'], owner.pid as number)
    started.push(decoy)
    expect(decoy.pid).toBeDefined()
    owner.kill('SIGKILL')
    await exited(owner)
    // Waits on the decoy's own exit event: the test's timeout is the only bound, and a decoy with no death condition runs until it.
    await exited(decoy)
    expect(decoy.exitCode, 'the decoy did not leave on its own accord').toBe(0)
  })
})
