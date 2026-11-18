import type { ChildProcess } from 'node:child_process'

import { expect } from 'vitest'

import { killIfCommandLine, tiedToHandles } from './kill_if_command_line.js'

/** One piece of shared work that a row pays for and later rows read the result of (an install and its served calls), together with every process it started. A row whose timeout fires leaves the work running as a promise nothing owns; halting the drive ends its processes and makes its next step throw, so it never finishes half-way and never hands out a count it did not complete. */
export interface Drive<T> {
  /** Why the drive was stopped; set once, and every step of the drive checks it after an await. */
  halted?: string
  /** How many processes the halt signalled; set by the halt, so a caller that cannot wait for the exit can still see a halt that ended nothing. */
  signalled?: number
  /** True once `done` has settled, either way. */
  settled: boolean
  done: Promise<T>
  /** The processes the drive started and has not seen close. */
  children: Set<ChildProcess>
}

/** Starts `run` as a drive. Its rejection is handled here, so a drive nobody awaits any more (its row timed out) is not an unhandled rejection; whoever awaits `done` still sees it. */
export function startDrive<T>(run: (drive: Drive<T>) => Promise<T>): Drive<T> {
  const drive = { settled: false, children: new Set<ChildProcess>() } as Drive<T>
  drive.done = run(drive).finally(() => {
    drive.settled = true
  })
  drive.done.catch(() => undefined)
  return drive
}

/** Records a process the drive started, until it closes. */
export function trackChild(drive: Drive<unknown> | undefined, child: ChildProcess): void {
  if (drive === undefined) return
  drive.children.add(child)
  const forget = (): void => void drive.children.delete(child)
  child.once('close', forget)
  child.once('error', forget)
}

/** Throws once the drive was halted; called after every await in the drive's own steps. */
export function liveOrThrow(drive: Drive<unknown>): void {
  if (drive.halted !== undefined) throw new Error(`the shared drive was stopped before it finished: ${drive.halted}`)
}

/** Stops an unsettled drive: marks it, then ends every process it still holds, tree and all, through the handle this file holds (a pid a live handle holds is ours whatever its command line reads back as). Returns how many it signalled; throws what could not be ended, after trying every child. */
export function haltDrive(drive: Drive<unknown>, why: string): number {
  if (drive.settled) return 0
  drive.halted ??= why
  const held = [...drive.children]
  const tied = tiedToHandles(held)
  let failure: unknown
  let signalled = 0
  for (const child of held) {
    const pid = child.pid
    if (pid === undefined) continue
    try {
      if (killIfCommandLine(pid, () => tied(pid), { tree: true, tied })) signalled++
    } catch (err) {
      failure ??= err
    }
  }
  drive.signalled = signalled
  if (failure !== undefined) throw failure
  return signalled
}

/** Halts the drive when `signal` aborts (vitest aborts a row's signal when the row times out, before it starts the next row), at once when it already has. A child that cannot be ended is raised by the retireDrive that follows, which still holds it. */
export function haltOnAbort(signal: AbortSignal, drive: Drive<unknown>, why: string): void {
  const halt = (): void => {
    try {
      haltDrive(drive, why)
    } catch {
      // the child is still held, so retireDrive raises it
    }
  }
  if (signal.aborted) halt()
  else signal.addEventListener('abort', halt, { once: true })
}

/** Halts the drive and waits for it to stop: the work has ended, and no process of it runs, when this returns. */
export async function retireDrive(drive: Drive<unknown> | undefined, why: string): Promise<void> {
  if (drive === undefined || drive.settled) return
  haltDrive(drive, why)
  await drive.done.then(
    () => undefined,
    () => undefined,
  )
}

/** The result of a drive that finished. The row that started it sees its own failure as it was; any later row fails by assertion naming that the drive did not finish, since reading counts from one that stopped half-way would be reading someone else's partial work. */
export async function driven<T>(drive: Drive<T>, starter: boolean): Promise<T> {
  try {
    return await drive.done
  } catch (err) {
    if (starter) throw err
    expect.fail(`the shared drive did not finish, so none of its counts are read: ${err instanceof Error ? err.message : String(err)}`)
  }
}
