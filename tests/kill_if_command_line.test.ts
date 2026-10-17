// Guards the test-side kill of a recorded pid. On Windows process.kill(pid, 'SIGKILL') is TerminateProcess(handle, 1), so killing a pid that had already exited ended a new process that took the number: a vitest worker then reported "Worker exited unexpectedly with exit code 1 during started state" with no result line, in files that passed alone. Probed 2026-10-17 on Windows: a fresh node child that took a stale pid and was killed through it exited {code:1, signal:null} (1 of 40 rounds of 40 spawns). Real processes throughout, no stubbed process table. Provenance: HAND-DERIVED. The stand-ins are `node -e` sleepers whose command lines carry a marker chosen here; nothing is read from a producer's output.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { killIfCommandLine } from './helpers/kill_if_command_line.js'

const children: ChildProcess[] = []

// owner: this test file; dies on its own after 60 s, and afterEach ends it through its handle sooner.
function sleeper(marker: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', `/* ${marker} */ setTimeout(() => {}, 60000)`], { stdio: 'ignore', windowsHide: true })
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
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await exited(child)
  }
})

describe('killIfCommandLine', () => {
  it('leaves a live process whose command line is not the expected one', async () => {
    const stranger = sleeper('tg-kill-stranger')
    const pid = stranger.pid as number
    expect(killIfCommandLine(pid, (line) => line.includes('tg-kill-expected'))).toBe(false)
    // The stranger must still be running: a probe with signal 0 throws once it is gone.
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
  })

  it('ends a live process whose command line is the expected one', async () => {
    const target = sleeper('tg-kill-expected')
    expect(killIfCommandLine(target.pid as number, (line) => line.includes('tg-kill-expected'))).toBe(true)
    await exited(target)
    expect(target.exitCode !== null || target.signalCode !== null).toBe(true)
  })

  it('does nothing for a pid that has already exited', () => {
    const done = spawnSync(process.execPath, ['-e', '0'])
    expect(killIfCommandLine(done.pid as number, () => true)).toBe(false)
  })

  it('refuses this process and a non-pid', () => {
    expect(killIfCommandLine(process.pid, () => true)).toBe(false)
    expect(killIfCommandLine(0, () => true)).toBe(false)
    expect(killIfCommandLine(Number.NaN, () => true)).toBe(false)
  })
})
