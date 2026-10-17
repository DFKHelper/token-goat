// Guards the test-side kill of a recorded pid. On Windows process.kill(pid, 'SIGKILL') is TerminateProcess(handle, 1), so killing a pid that had already exited ended a new process that took the number: a vitest worker then reported "Worker exited unexpectedly with exit code 1 during started state" with no result line, in files that passed alone. Probed 2026-10-17 on Windows: a fresh node child that took a stale pid and was killed through it exited {code:1, signal:null} (1 of 40 rounds of 40 spawns). Real processes throughout, no stubbed process table. Provenance: HAND-DERIVED. The stand-ins are `node -e` sleepers whose command lines carry a marker chosen here; nothing is read from a producer's output.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { isHookServerCommandLine, isWorkerDaemonCommandLine, killAllIfCommandLine, killIfCommandLine } from './helpers/kill_if_command_line.js'

const children: ChildProcess[] = []
// Pids of grandchildren a test started through a parent it then killed, ended here when the kill under test did not.
const grandchildren: number[] = []
const GRANDCHILD_MARKER = 'tg-kill-tree-grandchild'

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
  try {
    killAllIfCommandLine(grandchildren.splice(0), (line) => line.includes(GRANDCHILD_MARKER))
  } finally {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL')
      await exited(child)
    }
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

  it('honours the signal option and still checks the command line first', async () => {
    const stranger = sleeper('tg-kill-stranger-sig')
    expect(killIfCommandLine(stranger.pid as number, (line) => line.includes('tg-kill-expected'), { signal: 'SIGTERM' })).toBe(false)
    expect(stranger.exitCode).toBeNull()
    expect(stranger.signalCode).toBeNull()
    const target = sleeper('tg-kill-expected-sig')
    expect(killIfCommandLine(target.pid as number, (line) => line.includes('tg-kill-expected-sig'), { signal: 'SIGTERM' })).toBe(true)
    await exited(target)
    expect(target.exitCode !== null || target.signalCode !== null).toBe(true)
  })

  it('ends the whole tree under tree, and only when the command line matches', async () => {
    const marker = 'tg-kill-tree-parent'
    const code = `/* ${marker} */ const c = require('node:child_process').spawn(process.execPath, ['-e', '/* ${GRANDCHILD_MARKER} */ setTimeout(() => {}, 600000)'], { stdio: ['ignore', 'inherit', 'ignore'] }); process.stdout.write(String(c.pid)); setTimeout(() => {}, 60000)`
    // owner: this test; leads its own process group on POSIX, where the tree kill signals the group, and dies when the kill under test or afterEach ends it (the grandchild's 600 s timer is the backstop).
    const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' })
    children.push(parent)
    const grandchildPid = await new Promise<number>((resolve) => {
      parent.stdout?.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())))
    })
    grandchildren.push(grandchildPid)
    // The grandchild holds the parent's stdout pipe, so the pipe closes only when the parent and every process it passed the pipe to have exited: an event, not a clock.
    const pipeClosed = new Promise<void>((resolve) => {
      parent.stdout?.once('close', () => resolve())
      parent.stdout?.resume()
    })
    const pid = parent.pid as number
    expect(killIfCommandLine(pid, (line) => line.includes('tg-kill-no-such'), { tree: true })).toBe(false)
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()
    expect(killIfCommandLine(pid, (line) => line.includes(marker), { tree: true })).toBe(true)
    await exited(parent)
    // A grandchild that survived the tree kill keeps the pipe open and this wait runs into the test timeout.
    await pipeClosed
  })
})

// Provenance: HAND-DERIVED. readProcessCommandLine returns null both for a gone process and for a failed query (a spawn error, a nonzero exit, its timeout, empty output), read off src/resident_process.ts; the failed query is stood in for by an injected reader that returns null for a real, live sleeper, since no portable way makes the real query fail on demand.
describe('killIfCommandLine when the command line cannot be read', () => {
  it('throws, naming the pid, for a live process, and leaves it unsignalled', () => {
    const live = sleeper('tg-kill-unreadable')
    const pid = live.pid as number
    expect(() => killIfCommandLine(pid, () => true, { readCommandLine: () => null })).toThrow(`pid ${pid}: its command line could not be read`)
    expect(live.exitCode).toBeNull()
    expect(live.signalCode).toBeNull()
    expect(() => process.kill(pid, 0)).not.toThrow()
  })

  it('returns false for a process that is gone', () => {
    const done = spawnSync(process.execPath, ['-e', '0'])
    expect(killIfCommandLine(done.pid as number, () => true, { readCommandLine: () => null })).toBe(false)
  })

  it('killAllIfCommandLine signals every pid it can read, then throws for the one it could not', async () => {
    const unreadable = sleeper('tg-kill-all-unreadable')
    const readable = sleeper('tg-kill-all-readable')
    const read = (pid: number): string | null => (pid === unreadable.pid ? null : `node -e /* tg-kill-all-readable */ ${pid}`)
    expect(() => killAllIfCommandLine([unreadable.pid as number, readable.pid as number], (line) => line.includes('tg-kill-all-readable'), { readCommandLine: read })).toThrow('its command line could not be read')
    await exited(readable)
    expect(readable.exitCode !== null || readable.signalCode !== null).toBe(true)
    expect(unreadable.exitCode).toBeNull()
    expect(unreadable.signalCode).toBeNull()
  })
})

// HAND-DERIVED: command lines written out as src/hook_client.ts:125 and the daemon start build them (node, launcher, then the resident's argument), plus lines that merely mention the words.
describe('resident command-line predicates', () => {
  it('accept a daemon and a hook server and refuse a line that only names them', () => {
    expect(isWorkerDaemonCommandLine('node /x/token-goat.mjs --worker-daemon --claim-worker')).toBe(true)
    expect(isWorkerDaemonCommandLine('"C:/node.exe" "C:/x/token-goat.mjs" --worker-daemon')).toBe(true)
    expect(isWorkerDaemonCommandLine('node /x/token-goat.mjs worker start')).toBe(false)
    expect(isWorkerDaemonCommandLine('node /x/vitest.mjs --worker-daemon-suite')).toBe(false)
    expect(isHookServerCommandLine('node /x/token-goat.mjs hook-server run --slot 0')).toBe(true)
    expect(isHookServerCommandLine('node /x/token-goat.mjs hook-server status --json')).toBe(false)
    expect(isHookServerCommandLine('node /x/vitest.mjs run tests/hook-server-run.test.ts')).toBe(false)
  })
})
