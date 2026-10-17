// An `error` event on a child that has a pid is a failed signal or kill on a child that still runs, so it must stay covered by the owner-exit and signal hooks until it closes; only a child that never started has nothing left to cover. The hooks are observable as listeners on this process's 'exit' event, which spawnOwned adds when its first live child starts and removes when the last one is gone. Provenance: FORMAT-DERIVED for the event, from Node's child_process documentation (nodejs.org/api/child_process.html#event-error: 'error' is emitted when the process could not be killed, as well as when it could not be spawned or sent a message); HAND-DERIVED for the rule (hooked while the child runs, unhooked once it never started).
import { afterEach, describe, expect, it } from 'vitest'

import { spawnOwned } from '../src/process_tree.js'
import type { OwnedChild } from '../src/process_tree.js'

const owned: OwnedChild[] = []

afterEach(async () => {
  for (const o of owned.splice(0)) {
    const closed = new Promise<void>((resolve) => o.child.once('close', () => resolve()))
    o.kill()
    if (o.child.exitCode === null && o.child.signalCode === null) await closed
    o.release()
  }
})

describe('an error event on an owned child', () => {
  it('keeps a running child hooked until it closes', async () => {
    const before = process.listenerCount('exit')
    // Reads stdin, so it stays alive until its handle is killed in the cleanup and cannot end on its own.
    const o = spawnOwned(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    owned.push(o)
    expect(process.listenerCount('exit'), 'spawning did not hook the process').toBe(before + 1)
    o.child.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))
    expect(process.listenerCount('exit'), 'a failed kill unhooked a child that is still running').toBe(before + 1)
  })

  it('releases a child that never started', async () => {
    const before = process.listenerCount('exit')
    const o = spawnOwned('tg-no-such-program-for-process-tree-test', [], { stdio: 'ignore', windowsHide: true })
    owned.push(o)
    expect(o.child.pid).toBeUndefined()
    await new Promise<void>((resolve) => o.child.once('error', () => resolve()))
    expect(process.listenerCount('exit'), 'a child that failed to start stayed hooked').toBe(before)
  })
})
