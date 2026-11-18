/** The shared-drive rule of the native install file: work a timed-out row left running is stopped, its processes are ended, and a later row never reads counts from it. Test hygiene, not product behaviour. */
import { type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { driven, haltDrive, haltOnAbort, liveOrThrow, retireDrive, startDrive, trackChild, type Drive } from './helpers/halting_drive.js'
import { spawnOwnedDecoy } from './helpers/owner_tied_decoy.js'

const started: ChildProcess[] = []

function alive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function exited(child: ChildProcess): Promise<void> {
  return alive(child) ? new Promise((resolve) => child.once('exit', () => resolve())) : Promise.resolve()
}

afterEach(() => {
  for (const child of started.splice(0)) if (alive(child)) child.kill('SIGKILL')
})

/** A drive that starts one tracked process, waits until `release` is called, and then checks it was not halted, as the install drive does after each await. */
function pendingDrive(): { drive: Drive<string>; child: ChildProcess; release: () => void } {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => (release = resolve))
  let child!: ChildProcess
  const drive = startDrive<string>(async (d) => {
    child = spawnOwnedDecoy(['--drive-probe'])
    started.push(child)
    trackChild(d, child)
    await gate
    liveOrThrow(d)
    return 'counts'
  })
  return { drive, child, release }
}

// HAND-DERIVED: the expected sequences follow from the rule alone (a halted drive ends its process, throws at its next step, and is never read as finished); no wire format is involved.
describe('a shared drive left running by a timed-out row', () => {
  it('ends the process it started and stops at its next step instead of finishing', async () => {
    const { drive, child, release } = pendingDrive()
    expect(alive(child)).toBe(true)
    expect(haltDrive(drive, 'row timed out'), 'the process the drive holds was not signalled').toBe(1)
    await exited(child)
    expect(alive(child)).toBe(false)
    release()
    await expect(drive.done).rejects.toThrow('the shared drive was stopped before it finished: row timed out')
    expect(drive.settled).toBe(true)
  })

  it('is waited for by retireDrive, which returns only once the drive has stopped', async () => {
    const { drive, child, release } = pendingDrive()
    const retired = retireDrive(drive, 'describe finished')
    release()
    await retired
    expect(drive.settled, 'retireDrive returned while the drive still ran').toBe(true)
    expect(drive.signalled, 'retireDrive ended no process of the drive').toBe(1)
    await exited(child)
    expect(drive.halted).toBe('describe finished')
  })

  it('fails a later row by assertion that names the unfinished drive, while the row that started it sees its own failure', async () => {
    const { drive, release } = pendingDrive()
    haltDrive(drive, 'row timed out')
    release()
    await expect(driven(drive, true)).rejects.toThrow('the shared drive was stopped before it finished: row timed out')
    await expect(driven(drive, false)).rejects.toThrow('the shared drive did not finish, so none of its counts are read: the shared drive was stopped before it finished: row timed out')
  })

  it('hands a finished drive its counts to every row, and halting or retiring it afterwards changes nothing', async () => {
    const { drive, release } = pendingDrive()
    release()
    expect(await driven(drive, true)).toBe('counts')
    expect(haltDrive(drive, 'too late')).toBe(0)
    await retireDrive(drive, 'too late')
    expect(drive.halted).toBeUndefined()
    expect(await driven(drive, false)).toBe('counts')
  })
})

// HAND-DERIVED: the row's signal is the AbortSignal vitest aborts when a row times out (the Node-form run of the native install file is halted through it); the rule is that aborting it ends the drive's process and stops the drive at its next step.
describe('a drive halted by the abort of its row', () => {
  it('ends the process it started when the signal aborts, and stops at its next step', async () => {
    const { drive, child, release } = pendingDrive()
    const row = new AbortController()
    haltOnAbort(row.signal, drive, 'the row that started it timed out')
    expect(alive(child), 'halted before the row timed out').toBe(true)
    row.abort()
    expect(drive.signalled, 'the abort ended no process of the drive').toBe(1)
    await exited(child)
    expect(alive(child), 'the abort left the drive process running').toBe(false)
    release()
    await expect(drive.done).rejects.toThrow('the shared drive was stopped before it finished: the row that started it timed out')
  })

  it('halts at once when the signal had already aborted, and leaves a finished drive alone', async () => {
    const gone = pendingDrive()
    const aborted = new AbortController()
    aborted.abort()
    haltOnAbort(aborted.signal, gone.drive, 'already timed out')
    expect(gone.drive.signalled, 'an already aborted row ended no process of the drive').toBe(1)
    await exited(gone.child)
    expect(alive(gone.child), 'an already aborted row left the drive process running').toBe(false)
    gone.release()
    await expect(gone.drive.done).rejects.toThrow('already timed out')
    const finished = pendingDrive()
    finished.release()
    await finished.drive.done
    const later = new AbortController()
    haltOnAbort(later.signal, finished.drive, 'too late')
    later.abort()
    expect(finished.drive.halted).toBeUndefined()
    expect(alive(finished.child), 'aborting the row of a finished drive signalled a process').toBe(true)
  })
})
