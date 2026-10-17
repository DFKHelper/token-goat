// Ending a spawned child's tree happens at most once, and never after the child has exited: a pid that has exited may belong to an unrelated process by now, and a second pass would signal it. Every pass goes through spawnSync (ps on POSIX, taskkill on Windows), so counting those calls is the same observation on both platforms; a spy on process.kill would see nothing on Windows. Provenance: HAND-DERIVED. The expected counts follow from the rule (one pass for the first kill, none after), not from the implementation's flags; taskkill exiting non-zero for a pid that is gone is its documented behaviour.
import type * as ChildProcessModule from 'node:child_process'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { killIfCommandLine } from './helpers/kill_if_command_line.js'

const passes = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const counting = ((file: string, ...rest: unknown[]) => {
    passes.push(file)
    return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof real.spawnSync
  return { ...real, spawnSync: counting }
})

const { killProcessTree, spawnOwned } = await import('../src/process_tree.js')

// The child ends on its own when its directory is deleted, so a test that dies midway cannot leave it running past the cleanup.
const IDLE_SCRIPT = `
const fs = require('node:fs')
const dir = process.argv[1]
setInterval(() => { if (!fs.existsSync(dir)) process.exit(0) }, 200)
`

let dir: string | undefined
const children: Array<{ exitCode: number | null; signalCode: NodeJS.Signals | null; kill: (signal: NodeJS.Signals) => boolean }> = []
const cleanups: Array<() => void> = []

afterEach(() => {
  passes.length = 0
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
  if (dir !== undefined) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  dir = undefined
})

describe('the tree of an owned child is ended at most once', () => {
  it('a second kill() of a live child makes no further pass', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tree-once-'))
    const script = path.join(dir, 'idle.cjs')
    fs.writeFileSync(script, IDLE_SCRIPT)
    const owned = spawnOwned(process.execPath, [script, dir], { stdio: 'ignore', windowsHide: true })
    children.push(owned.child)
    passes.length = 0
    owned.kill()
    const afterFirst = passes.length
    expect(afterFirst, 'the first kill made no pass at all').toBeGreaterThan(0)
    owned.kill()
    expect(passes.length, 'the second kill walked the tree again').toBe(afterFirst)
  })

  it('kill() after the child has exited makes no pass and reports nothing', async () => {
    const owned = spawnOwned(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    children.push(owned.child)
    await new Promise<void>((resolve) => owned.child.once('close', () => resolve()))
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    passes.length = 0
    owned.kill()
    const written = stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.includes('could not end'))
    vi.restoreAllMocks()
    expect(passes, 'a pid that has already exited was handed to the tree walk').toEqual([])
    expect(written, 'a finished child was reported as an unkillable tree').toEqual([])
  })
})

// A running process is one ps lists whose state is not Z (a zombie is dead, merely not reaped yet).
function liveWithArgs(args: string): number[] {
  const listing = execFileSync('ps', ['-A', '-o', 'pid=,stat=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const found: number[] = []
  for (const line of listing.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match !== null && !match[2]!.startsWith('Z') && match[3]!.trim() === args) found.push(Number(match[1]))
  }
  return found
}

describe.skipIf(process.platform === 'win32')('a tree that is forking while it is ended is frozen before anything is killed', () => {
  it('stops the root first and kills only after the last stop', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-tree-once-'))
    const script = path.join(dir, 'idle.cjs')
    fs.writeFileSync(script, IDLE_SCRIPT)
    const owned = spawnOwned(process.execPath, [script, dir], { stdio: 'ignore', windowsHide: true })
    children.push(owned.child)
    const root = owned.child.pid as number
    const kill = vi.spyOn(process, 'kill')
    owned.kill()
    const signals = kill.mock.calls.filter(([, signal]) => signal === 'SIGSTOP' || signal === 'SIGKILL').map(([pid, signal]) => `${String(pid)} ${String(signal)}`)
    vi.restoreAllMocks()
    expect(signals[0], 'the root was not frozen before the tree was listed').toBe(`${root} SIGSTOP`)
    const firstKill = signals.findIndex((s) => s.endsWith('SIGKILL'))
    const lastStop = signals.map((s) => s.endsWith('SIGSTOP')).lastIndexOf(true)
    expect(firstKill, 'nothing was killed').toBeGreaterThan(-1)
    expect(lastStop, 'a stop came after the first kill').toBeLessThan(firstKill)
  })

  it('leaves none of a shell loop\'s many children alive', async () => {
    // The sleep argument is unique to this run so the survivors can be found, and removed in the cleanup, by their command line alone.
    const marker = `sleep ${3_000_000 + (process.pid % 1_000_000)}`
    const loop = `i=0; while [ $i -lt 20000 ]; do ${marker} & i=$((i+1)); done; wait`
    const owned = spawnOwned('sh', ['-c', loop], { stdio: 'ignore' })
    children.push(owned.child)
    cleanups.push(() => {
      for (const pid of liveWithArgs(marker)) killIfCommandLine(pid, (cmd) => cmd.includes(marker))
    })
    // Only a kill that lands while the loop is still forking is the case under test.
    while (liveWithArgs(marker).length < 30) await new Promise<void>((resolve) => setImmediate(resolve))
    owned.kill()
    while (liveWithArgs(marker).length > 0) await new Promise<void>((resolve) => setImmediate(resolve))
    expect(liveWithArgs(marker)).toEqual([])
  })
})

describe.skipIf(process.platform !== 'win32')('a failed taskkill is reported, not retried with a bare pid kill', () => {
  it('returns the failure and signals no pid itself', async () => {
    const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    children.push(gone)
    await new Promise<void>((resolve) => gone.once('close', () => resolve()))
    const kill = vi.spyOn(process, 'kill')
    const result = killProcessTree(gone.pid)
    const signalled = kill.mock.calls.length
    vi.restoreAllMocks()
    expect(result.ok, 'taskkill of a pid that is gone reported success').toBe(false)
    expect(result.note).toMatch(/taskkill/)
    expect(signalled, 'the failure was papered over with a bare process.kill').toBe(0)
  })
})
