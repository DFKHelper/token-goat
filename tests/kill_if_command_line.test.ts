// Guards the test-side kill of a recorded pid. On Windows process.kill(pid, 'SIGKILL') is TerminateProcess(handle, 1), so killing a pid that had already exited ended a new process that took the number: a vitest worker then reported "Worker exited unexpectedly with exit code 1 during started state" with no result line, in files that passed alone. Probed 2026-10-17 on Windows: a fresh node child that took a stale pid and was killed through it exited {code:1, signal:null} (1 of 40 rounds of 40 spawns). Real processes throughout, no stubbed process table. Provenance: HAND-DERIVED. The stand-ins are `node -e` sleepers whose command lines carry a marker chosen here; nothing is read from a producer's output.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

import { afterEach, describe, expect, it } from 'vitest'

import { isHookServerCommandLine, isWorkerDaemonCommandLine, killIfCommandLine } from './helpers/kill_if_command_line.js'

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
    const childMarker = 'tg-kill-tree-grandchild'
    const code = `/* ${marker} */ const c = require('node:child_process').spawn(process.execPath, ['-e', '/* ${childMarker} */ setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); process.stdout.write(String(c.pid)); setTimeout(() => {}, 60000)`
    const parent = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    children.push(parent)
    const grandchildPid = await new Promise<number>((resolve) => {
      parent.stdout?.once('data', (d: Buffer) => resolve(Number(d.toString('utf8').trim())))
    })
    const pid = parent.pid as number
    expect(killIfCommandLine(pid, (line) => line.includes('tg-kill-no-such'), { tree: true })).toBe(false)
    expect(() => process.kill(grandchildPid, 0)).not.toThrow()
    expect(killIfCommandLine(pid, (line) => line.includes(marker), { tree: true })).toBe(true)
    await exited(parent)
    // The grandchild goes with the tree; its liveness probe throws once the number is free.
    const until = Date.now() + 15_000
    let alive = true
    while (alive && Date.now() < until) {
      try {
        process.kill(grandchildPid, 0)
        await new Promise((resolve) => setTimeout(resolve, 25))
      } catch {
        alive = false
      }
    }
    expect(alive, 'the grandchild survived a tree kill of its parent').toBe(false)
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
