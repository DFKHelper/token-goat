// The teardown wait in tests/helpers/process_exit.ts: a process Windows already reports gone can still hold its executable and working directory, so a test that deletes its fixture on that report fails with EPERM. A debugger parks a killed holder in exactly that state, so each case below sees the window open for as long as it needs, every run.
import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { alive, buildWindowsBoundary } from './helpers/copilot_session_start_tree.js'
import { awaitProcessExit, childExit } from './helpers/process_exit.js'

describe.runIf(process.platform === 'win32')('waiting for a killed process to release its directory', () => {
  let outside = ''
  let boundary = ''
  const started: ChildProcess[] = []
  const dirs: string[] = []

  beforeAll(() => {
    outside = mkdtempSync(join(tmpdir(), 'tg-exit-debugger-'))
    boundary = buildWindowsBoundary(outside)
  }, 120_000)

  afterEach(async () => {
    await Promise.all(started.splice(0).map((child) => {
      const exit = childExit(child)
      if (child.exitCode === null && child.signalCode === null) child.kill()
      return exit
    }))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  afterAll(() => {
    if (outside !== '') rmSync(outside, { recursive: true, force: true })
  })

  async function waitUntil(condition: () => boolean, what: string): Promise<void> {
    const until = performance.now() + 10_000
    while (!condition()) {
      expect(performance.now(), what).toBeLessThan(until)
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  /** A holder running from inside a fresh directory, with that directory as its working directory, killed while a debugger holds its exit open. */
  async function parkedHolder(): Promise<{ held: string; holder: ChildProcess; pid: number; seen: number }> {
    const held = mkdtempSync(join(tmpdir(), 'tg-exit-held-'))
    dirs.push(held)
    const holderExe = join(held, 'holder.exe')
    copyFileSync(boundary, holderExe)
    const pidFile = join(held, 'holder.pid')
    const marker = join(outside, `debugger-${started.length}.state`)
    const holder = spawn(holderExe, ['hold', pidFile], { cwd: held, stdio: 'ignore', windowsHide: true })
    started.push(holder)
    await waitUntil(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '', 'holder never recorded its PID')
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const seen = Date.now()
    started.push(spawn(boundary, ['debug-exit', String(pid), marker, '1500'], { cwd: outside, stdio: 'ignore', windowsHide: true }))
    const state = (): string => existsSync(marker) ? readFileSync(marker, 'utf8') : ''
    await waitUntil(() => state() === 'attached', 'debugger never attached')
    holder.kill()
    await waitUntil(() => state() === 'exiting', 'holder exit never reached the debugger')
    expect(alive(pid), 'the liveness probe already reads the parked holder as gone').toBe(false)
    return { held, holder, pid, seen }
  }

  it('awaitProcessExit returns only once the directory can be deleted', async () => {
    const { held, pid, seen } = await parkedHolder()
    expect(() => rmSync(held, { recursive: true, force: true }), 'the window this wait closes is open').toThrow(/EPERM|EBUSY/)
    awaitProcessExit(new Map([[pid, seen]]))
    rmSync(held, { recursive: true, force: true })
    expect(existsSync(held)).toBe(false)
  }, 60_000)

  it('childExit resolves only once the directory can be deleted', async () => {
    const { held, holder } = await parkedHolder()
    let settled = false
    const exit = childExit(holder).then(() => { settled = true })
    expect(() => rmSync(held, { recursive: true, force: true }), 'the window this wait closes is open').toThrow(/EPERM|EBUSY/)
    expect(settled).toBe(false)
    await exit
    rmSync(held, { recursive: true, force: true })
    expect(existsSync(held)).toBe(false)
  }, 60_000)

  it('awaitProcessExit passes over a process that took the PID after the one meant was seen', async () => {
    const later = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
    started.push(later)
    // A sighting older than the process under the PID is what a reused number looks like: waiting on it would block on an unrelated process and then throw.
    expect(() => awaitProcessExit(new Map([[later.pid as number, Date.now() - 60_000]]))).not.toThrow()
    expect(later.exitCode).toBeNull()
  }, 60_000)
})
