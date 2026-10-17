// Provenance: FORMAT-DERIVED for the alias form `alias.NAME=!command` (git runs it through the shell), from git's own documentation, Documentation/git-config.adoc, section "alias.*"; HAND-DERIVED for the rule that a call whose tree kill failed must still settle with runGit's shape (exit -1, timedOut for a timeout). The tree helper (taskkill on Windows, ps on POSIX) is made to fail by answering for it in the spawnSync seam process_tree.ts already calls; everything else, including git's spawn, is real. Events only: the call settles on git's own exit once the child is ended through its handle, and a red run is that settle never coming, which the vitest per-test timeout ends. The holder tells the test it exists by writing to a socket and dies when that socket closes or cannot open, so it cannot outlive the test.
import type * as ChildProcessModule from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const failing = vi.hoisted(() => ({ on: false }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const answering = ((file: string, ...rest: unknown[]) => {
    const helper = file.toLowerCase().endsWith('taskkill.exe') || file === 'ps'
    if (!failing.on || !helper) return (real.spawnSync as (...args: unknown[]) => unknown)(file, ...rest)
    return { status: null, signal: null, output: [], pid: 0, stdout: '', stderr: '', error: new Error('forced: the helper could not run') }
  }) as typeof real.spawnSync
  return { ...real, spawnSync: answering }
})

const { runGitAsync } = await import('../src/git_async.js')

/** Connects to the test's server, announces its pid, then blocks. It ends when that socket closes or cannot open. */
const HOLDER = [
  "const net = require('node:net')",
  "const s = net.connect(Number(process.env.TG_HOLD_PORT), '127.0.0.1', () => s.write(String(process.pid)))",
  "s.on('error', () => process.exit(0))",
  "s.on('close', () => process.exit(0))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

let dir = ''
let server: net.Server
let sockets: net.Socket[] = []
let controller: AbortController
let pending: Promise<unknown>[] = []
let announced: Promise<string>
const savedEnv: Record<string, string | undefined> = {}

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-rungit-killfail-'))
  writeFileSync(path.join(dir, 'holder.cjs'), HOLDER)
  controller = new AbortController()
  let announce!: (pid: string) => void
  announced = new Promise((resolve) => {
    announce = resolve
  })
  server = net.createServer((socket) => {
    sockets.push(socket)
    // Windows reports a killed peer as a reset before the close.
    socket.on('error', () => undefined)
    socket.once('data', (data) => announce(String(data)))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  // The failed tree kill is reported on stderr by design; keep it out of the run's output.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  setEnv('TG_HOLD_PORT', String((server.address() as net.AddressInfo).port))
  setEnv('TG_HOLDER', path.join(dir, 'holder.cjs'))
})

afterEach(async () => {
  failing.on = false
  vi.restoreAllMocks()
  controller.abort()
  await Promise.allSettled(pending)
  pending = []
  for (const socket of sockets) socket.destroy()
  sockets = []
  await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key] as string
    delete savedEnv[key]
  }
  rmSync(dir, { recursive: true, force: true })
})

/** A git whose alias runs the holder and so never ends by itself. */
function holdingGit(opts: { timeoutMs?: number } = {}): Promise<Awaited<ReturnType<typeof runGitAsync>>> {
  const run = runGitAsync(['-c', 'alias.hold=!node "$TG_HOLDER"', 'hold'], { signal: controller.signal, ...opts })
  pending.push(run)
  return run
}

describe('runGitAsync settles when the tree kill fails', () => {
  it('an abort settles as aborted (a hang at the last await means git was left running)', async () => {
    failing.on = true
    const run = holdingGit()
    expect(await announced, 'the holder announces its pid').toMatch(/^\d+$/)
    controller.abort()
    const result = await run
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
  })

  it('a timeout settles as timedOut (a hang at the last await means git was left running)', async () => {
    failing.on = true
    const result = await holdingGit({ timeoutMs: 1 })
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBe(true)
  })
})
