// Provenance: FORMAT-DERIVED. The alias form `alias.NAME=!command` (git runs it through the shell) is from git's own documentation, Documentation/git-config.adoc, section "alias.*"; the socket events (`connection`, `data`, `close`, which the OS raises when the peer process is gone) are from Node's net documentation. The sha1 below is the output of `printf 'x\n' | git hash-object --stdin`, computed independently of the code. Platform: the tree is git -> shell -> node on every platform. Killing only the root leaves the node holder running, so the abort test is red under a root-only kill (child.kill()) wherever git starts an alias through a shell, which Git for Windows does with its bundled sh. Events only: no clock. The holder tells the test it exists by writing to a socket, and the test learns it is gone when the server side of that socket closes. A red run is that close never arriving, which the vitest per-test timeout ends.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runGitAsync } from '../src/git_async.js'

/** Connects to the test's server, announces its pid, then blocks. It ends when that socket closes or cannot open, so a holder that outlives a failed test dies as soon as the test tears its server down. */
const HOLDER = [
  "const net = require('node:net')",
  "const s = net.connect(Number(process.env.TG_HOLD_PORT), '127.0.0.1', () => s.write(String(process.pid)))",
  "s.on('error', () => process.exit(0))",
  "s.on('close', () => process.exit(0))",
  'setInterval(() => {}, 1 << 30)',
].join('\n')

/** Writes without end until the pipe is closed on it, so only a limit on the output can stop it. It also ends when the stdout pipe breaks. */
const FLOOD = [
  'const chunk = Buffer.alloc(1 << 20, 97)',
  "process.stdout.on('error', () => process.exit(0))",
  'function pump() {',
  '  while (process.stdout.write(chunk)) {}',
  "  process.stdout.once('drain', pump)",
  '}',
  'pump()',
].join('\n')

const savedEnv: Record<string, string | undefined> = {}
let dir = ''
let server: net.Server
let sockets: net.Socket[] = []
let controller: AbortController
let pending: Promise<unknown>[] = []
/** Resolves with the holder's announcement once its first bytes reach the server; `closed` resolves when that same socket closes. */
let announced: Promise<string>
let closed: Promise<void>

function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key]
  process.env[key] = value
}

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tg-rungit-async-'))
  writeFileSync(path.join(dir, 'holder.cjs'), HOLDER)
  writeFileSync(path.join(dir, 'flood.cjs'), FLOOD)
  controller = new AbortController()
  let announce!: (pid: string) => void
  let close!: () => void
  announced = new Promise((resolve) => {
    announce = resolve
  })
  closed = new Promise((resolve) => {
    close = resolve
  })
  server = net.createServer((socket) => {
    sockets.push(socket)
    // Windows reports a killed peer as a reset before the close.
    socket.on('error', () => undefined)
    socket.once('data', (data) => announce(String(data)))
    socket.once('close', close)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  setEnv('TG_HOLD_PORT', String((server.address() as net.AddressInfo).port))
  setEnv('TG_HOLDER', path.join(dir, 'holder.cjs'))
  setEnv('TG_FLOOD', path.join(dir, 'flood.cjs'))
})

afterEach(async () => {
  // A call still pending is ended through its own handle, which takes its tree; the sockets then go, which also ends a holder that outlived that.
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

/** A git whose alias runs the holder and so never ends by itself. It runs in the inherited working directory, not in `dir`, which a live holder would keep locked on Windows; `$TG_HOLDER` is expanded by the shell git starts, so no path appears in the test source. */
function holdingGit(opts: { timeoutMs?: number } = {}): Promise<Awaited<ReturnType<typeof runGitAsync>>> {
  const run = runGitAsync(['-c', 'alias.hold=!node "$TG_HOLDER"', 'hold'], { signal: controller.signal, ...opts })
  pending.push(run)
  return run
}

describe('runGitAsync ends the whole tree', () => {
  it('abort ends the holder behind the alias (a hang at the last await means the holder survived the kill)', async () => {
    const run = holdingGit()
    expect(await announced, 'the holder announces its pid').toMatch(/^\d+$/)
    controller.abort()
    const result = await run
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
    await closed
  })

  it('a timeout settles as timedOut', async () => {
    const result = await holdingGit({ timeoutMs: 1 })
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBe(true)
  })

  it('a signal already aborted starts no git', async () => {
    controller.abort()
    const result = await runGitAsync(['--version'], { signal: controller.signal })
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
    expect(result.stdout).toBe('')
  })

  it('output beyond the buffer ends the tree and reports ENOBUFS, as runGit does', async () => {
    const run = runGitAsync(['-c', 'alias.flood=!node "$TG_FLOOD"', 'flood'], { signal: controller.signal })
    pending.push(run)
    const result = await run
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
    expect(result.stderr).toMatch(/ENOBUFS/)
    expect(result.stdout).toBe('')
  })
})

describe('runGitAsync returns what runGit returns', () => {
  it('captures stdout and exit 0', async () => {
    const result = await runGitAsync(['--version'])
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toMatch(/^git version /)
    expect(result.timedOut).toBeUndefined()
  })

  it('captures stderr and a git exit code', async () => {
    const result = await runGitAsync(['rev-parse', '--verify', '--quiet', 'refs/heads/no-such-ref-here'], { cwd: dir })
    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBe(-1)
  })

  it('writes input to stdin', async () => {
    const result = await runGitAsync(['hash-object', '--stdin'], { cwd: dir, input: 'x\n' })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('587be6b4c3f93f93c489c0111bba5596147a26cb')
  })

  it('a working directory that is gone is exit -1 without timedOut', async () => {
    const result = await runGitAsync(['--version'], { cwd: path.join(dir, 'no', 'such', 'dir') })
    expect(result.exitCode).toBe(-1)
    expect(result.timedOut).toBeUndefined()
    expect(result.stderr).not.toBe('')
  })
})
