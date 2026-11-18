/** The launcher lowers the daemon's priority itself, at once, instead of leaving it at the launcher's priority until the daemon's own boot reaches applyIndexingPriority. A launcher is usually a hook running at normal priority, and a daemon takes seconds to boot on a slow or busy machine. The spawn is replaced by a stand-in that never lowers anything, so the only thing that can have lowered it by the time startDetachedWorker returns is startDetachedWorker; the real daemon, on the real default path, is tests/worker_priority_e2e.test.ts. Provenance: HAND-DERIVED. The expectation comes from Node's documented priority scale (os.constants.priority: a larger number is a lower priority). */
import type * as ChildProcessModule from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { killAllIfCommandLine, tiedToHandles, type KillOptions } from './helpers/kill_if_command_line.js'

// tg-no-regex-preload

// The stand-in ends when its owner (this test process) does, or when the test kills it. Every stand-in the mocked spawn started: the handle is what vouches that a pid is ours when its command line cannot be read.
const spawned = vi.hoisted(() => [] as ChildProcessModule.ChildProcess[])
const STAND_IN_MARK = 'const owner = Number(process.argv[1])'
const STAND_IN = 'const owner = Number(process.argv[1]); setInterval(() => { try { process.kill(owner, 0) } catch { process.exit(0) } }, 500)'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  return {
    ...real,
    spawn: () => {
      const child = real.spawn(process.execPath, ['-e', STAND_IN, String(process.pid)], { stdio: 'ignore', windowsHide: true })
      spawned.push(child)
      return child
    },
  }
})

const { startDetachedWorker } = await import('../src/worker_lifecycle.js')

const tempDirs: string[] = []
const started: number[] = []

/** Ends the stand-ins this file started. A command line that reads back empty (Windows hides some) says nothing about whose process it is, so a pid a handle of the mocked spawn still holds stands in for it; a line that reads back and is not the stand-in's is still a stranger, and an unreadable pid no handle holds throws instead of being killed. */
function endStarted(opts: KillOptions = {}): void {
  killAllIfCommandLine(started.splice(0), (cmd) => cmd.includes(STAND_IN_MARK), { tree: true, ...opts, tied: tiedToHandles(spawned) })
}

afterEach(() => {
  try {
    endStarted()
  } finally {
    spawned.length = 0
    for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
})

// The stand-in inherits this process's priority. A test process that already runs below normal (CI under nice, an earlier in-process lowering) would pass whether or not the launcher lowered anything, so there the test is skipped rather than left to pass vacuously.
const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL

describe('startDetachedWorker', () => {
  it.skipIf(os.getPriority(0) >= BELOW_NORMAL)('lowers the daemon it just spawned before it returns', () => {
    expect(os.getPriority(0), 'the test process itself must start above the level it asserts').toBeLessThan(BELOW_NORMAL)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-launcher-priority-'))
    tempDirs.push(dir)
    const pid = startDetachedWorker({ dataDir: dir })
    started.push(pid)
    expect(os.getPriority(pid), 'the freshly spawned daemon is still at the launcher priority').toBeGreaterThanOrEqual(BELOW_NORMAL)
  })

  // HAND-DERIVED: no wire format is involved; the stand-in is this file's own script, and the rule is that an unreadable command line is unknown, not ours and not a stranger's.
  const unreadable: KillOptions = { readCommandLine: () => null }
  const exitOf = (child: ChildProcessModule.ChildProcess): Promise<void> => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', () => resolve())))

  it('ends the stand-in it spawned when its command line reads back empty, because the handle of the spawn holds the pid', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-launcher-priority-'))
    tempDirs.push(dir)
    const pid = startDetachedWorker({ dataDir: dir })
    started.push(pid)
    const child = spawned.find((c) => c.pid === pid)
    expect(child, 'no spawn handle holds the pid startDetachedWorker returned').toBeDefined()
    try {
      expect(() => endStarted(unreadable)).not.toThrow()
      await exitOf(child!)
      expect(child!.exitCode !== null || child!.signalCode !== null, 'the stand-in was left running').toBe(true)
    } finally {
      if (child!.exitCode === null && child!.signalCode === null) child!.kill('SIGKILL')
    }
  })

  it('leaves an unreadable pid alone, and throws, when no handle of the mocked spawn holds it', async () => {
    const real = await vi.importActual<typeof ChildProcessModule>('node:child_process')
    const stranger = real.spawn(process.execPath, ['-e', STAND_IN, String(process.pid)], { stdio: 'ignore', windowsHide: true })
    try {
      started.push(stranger.pid as number)
      expect(() => endStarted(unreadable)).toThrow()
      expect(stranger.exitCode === null && stranger.signalCode === null, 'a pid no spawn handle holds was signalled').toBe(true)
    } finally {
      if (stranger.exitCode === null && stranger.signalCode === null) stranger.kill('SIGKILL')
    }
  })
})
