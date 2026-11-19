// `gate` leaves nothing running: a background child holding the pipes past the shell exit is ended.
import type * as ChildProcessModule from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { runGate } from '../src/cli_diagnostics.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive } from './helpers/process_alive.js'

// Every spawnSync tree kill and every child the runner starts is recorded, so rows need no clock.
const syncCalls = vi.hoisted(() => [] as string[])
const spawned = vi.hoisted(() => [] as ChildProcess[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const counting = ((file: string, ...rest: unknown[]) => {
    syncCalls.push(file)
    return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof real.spawnSync
  const recording = ((...args: unknown[]) => {
    const child = (real.spawn as (...a: unknown[]) => ChildProcess)(...args)
    spawned.push(child)
    return child
  }) as typeof real.spawn
  return { ...real, spawn: recording, spawnSync: counting }
})

// Taken before the timers are faked, so polling keeps real time while the runner's timeout is the faked one.
const realSetTimeout = globalThis.setTimeout
const pause = (ms: number): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, ms))
const GATE_TIMEOUT_SECONDS = 600

async function pollUntil(check: () => boolean): Promise<void> {
  while (!check()) await pause(25)
}

// The holder records its pid, then lives until its directory is deleted, so a dying row leaves nothing.
const HOLDER_SCRIPT = `
const fs = require('node:fs')
const path = require('node:path')
const dir = process.argv[2]
fs.writeFileSync(path.join(dir, 'holder.tmp'), String(process.pid))
fs.renameSync(path.join(dir, 'holder.tmp'), path.join(dir, 'holder.pid'))
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`
const quoted = (p: string): string => JSON.stringify(p.replace(/\\/g, '/'))

let dir: string | undefined
let holderPid: number | undefined
let pending: Promise<number> | undefined

afterEach(async () => {
  if (vi.isFakeTimers()) vi.advanceTimersByTime(GATE_TIMEOUT_SECONDS * 1000)
  vi.useRealTimers()
  vi.restoreAllMocks()
  try {
    if (holderPid !== undefined) {
      const recorded = holderPid
      killIfCommandLine(recorded, (cmd) => cmd.includes('holder.cjs'), { tied: (pid) => pid === recorded })
    }
  } finally {
    holderPid = undefined
    if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true })
    dir = undefined
    if (pending !== undefined) await pending
    pending = undefined
    spawned.length = 0
    syncCalls.length = 0
  }
})

describe('gate ends a descendant that outlives its shell', () => {
  it('the background child holding the pipes is gone after the timeout, the shell having exited', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-gate-orphan-'))
    const holder = path.join(dir, 'holder.cjs')
    fs.writeFileSync(holder, HOLDER_SCRIPT)
    const killSignals: string[] = []
    const realKill = process.kill.bind(process)
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
      if (signal === 'SIGKILL') killSignals.push(String(pid))
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)

    // The shell backgrounds the holder and exits at once; the holder keeps the pipes the gate reads open.
    const command = `${quoted(process.execPath)} ${quoted(holder)} ${quoted(dir)} &`
    const started = runGate(command, { timeout: GATE_TIMEOUT_SECONDS })
    pending = started
    const pidFile = path.join(dir, 'holder.pid')
    await pollUntil(() => fs.existsSync(pidFile))
    holderPid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(processAlive(holderPid), 'the holder is not running before the timeout').toBe(true)
    const shell = spawned[0]!
    if (shell.exitCode === null && shell.signalCode === null)
      await new Promise<void>((resolve) => shell.once('exit', () => resolve()))
    // One more turn so the runner has seen the shell's exit event before the timeout fires.
    await new Promise<void>((resolve) => setImmediate(resolve))
    syncCalls.length = 0
    killSignals.length = 0
    vi.advanceTimersByTime(GATE_TIMEOUT_SECONDS * 1000)
    // The sweep is synchronous inside the timer callback, so a missing descendant kill fails by assertion here.
    const swept = process.platform === 'win32'
      ? syncCalls.filter((file) => /taskkill/i.test(file)).length
      : killSignals.length
    const seen = `spawnSync saw ${JSON.stringify(syncCalls)}, SIGKILL to ${JSON.stringify(killSignals)}`
    expect(swept, `the timeout ended no descendant of the exited shell (${seen})`).toBeGreaterThan(0)
    expect(await started).toBe(2)
    pending = undefined
    await pollUntil(() => !processAlive(holderPid!))
    expect(processAlive(holderPid), 'the pipe-holding background child is gone after gate returned').toBe(false)
  })
})
