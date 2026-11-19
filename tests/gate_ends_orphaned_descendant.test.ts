// `gate` leaves nothing running: a background child holding the pipes past the shell exit is ended.
import type * as ChildProcessModule from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
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
    syncCalls.push([file, ...(Array.isArray(rest[0]) ? (rest[0] as string[]) : [])].join(' '))
    return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof real.spawnSync
  const recording = ((...args: unknown[]) => {
    const child = (real.spawn as (...a: unknown[]) => ChildProcess)(...args)
    spawned.push(child)
    return child
  }) as typeof real.spawn
  return { ...real, spawn: recording, spawnSync: counting }
})

const GATE_TIMEOUT_SECONDS = 600

// The holder reports its pid and its parent's over a loopback socket; the socket closing is its death event.
const HOLDER_SCRIPT = `
const fs = require('node:fs')
const net = require('node:net')
const dir = process.argv[2]
const socket = net.connect(Number(process.argv[3]), '127.0.0.1', () =>
  socket.write(process.pid + ' ' + process.ppid),
)
socket.on('error', () => process.exit(0))
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`
const quoted = (p: string): string => JSON.stringify(p.replace(/\\/g, '/'))

let dir: string | undefined
let holderPid: number | undefined
let pending: Promise<number> | undefined
let server: net.Server | undefined
let holderGone: Promise<void> | undefined
const sockets: net.Socket[] = []

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
    for (const socket of sockets.splice(0)) socket.destroy()
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    holderGone = undefined
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
    // The holder's first write is its pid; its socket closing is its death. Neither waits on clock or count.
    const reported = new Promise<[number, number]>((resolve) => {
      server = net.createServer((socket) => {
        sockets.push(socket)
        socket.on('error', () => undefined)
        socket.once('data', (chunk) => resolve(chunk.toString().split(' ').map(Number) as [number, number]))
        holderGone = new Promise<void>((gone) => socket.once('close', () => gone()))
      })
    })
    const port = await new Promise<number>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve((server!.address() as net.AddressInfo).port))
    })
    const command = `${quoted(process.execPath)} ${quoted(holder)} ${quoted(dir)} ${port} &`
    const started = runGate(command, { timeout: GATE_TIMEOUT_SECONDS })
    pending = started
    let holderParent: number
    ;[holderPid, holderParent] = await reported
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
      ? syncCalls.filter(
          (call) =>
            /taskkill/i.test(call) &&
            [holderPid, holderParent].some((pid) => call.endsWith(`/PID ${pid}`)),
        )
      : killSignals.filter((signalled) => signalled === String(holderPid))
    const seen = `spawnSync saw ${JSON.stringify(syncCalls)}, SIGKILL to ${JSON.stringify(killSignals)}`
    expect(swept.length, `the timeout did not end the holder, pid ${holderPid} (${seen})`).toBeGreaterThan(0)
    expect(await started).toBe(2)
    pending = undefined
    await holderGone
    expect(processAlive(holderPid), 'the pipe-holding background child is gone after gate returned').toBe(false)
  })
})
