/** End-to-end coverage for the resident hook server (src/hook_server.ts, src/hook_client.ts, src/cli_hook_server.ts) against the BUILT bundle: every server here is a real `node dist/token-goat.mjs hook-server run` process, reached through the real dist/token-goat-hook-client.mjs, a real shim, or the warm CLI in dist/token-goat.mjs. Each test gets its own data directory (LOCALAPPDATA/XDG_DATA_HOME) and TOKEN_GOAT_HOME, which is what keys a server's endpoint, so no test can reach another's server or a developer's live one. tests/setup/isolate-home.ts turns the server off for the rest of the suite; every spawn here turns it back on explicitly. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { CLAUDECODE_HOOK_SCRIPT } from '../src/bridges/claudecode.js'
import { COPILOT_CLI_HOOK_SCRIPT } from '../src/bridges/copilot_cli.js'
import { _resetDataDirCacheForTesting, dataDirForHome } from '../src/constants.js'
import {
  configStamp,
  mac,
  macMatches,
  markerAgeMs,
  markerPath,
  nonce,
  PROTOCOL_VERSION,
  readFrames,
  readMarker,
  readServerKey,
  ensureServerKey,
  touchMarker,
  writeFrame,
  type ServerReply,
  type ServerRequest,
  type ServerStatus,
} from '../src/hook_ipc.js'
import Database from '../src/sqlite_driver.js'
import { BUNDLE, ROOT } from './helpers/bundle.js'

type Env = Record<string, string>

interface Sandbox {
  base: string
  dataDir: string
  home: string
  proj: string
  env: Env
  bundle: string
  pids: Set<number>
  children: ChildProcess[]
  cleanup: Array<() => void>
  /** Lets go of every request {@link occupy} is holding open; run before the servers are stopped so none waits on its own hold. */
  releases: Array<() => void>
}

const sandboxes: Sandbox[] = []
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function processEnv(): Env {
  const env: Env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

/** A private data directory, token-goat home and project directory, and the environment that points a spawned token-goat at them with the server turned on. `bundle` is the launcher to run: the real dist/token-goat.mjs unless a test needs a copy it may modify. `serverEnv: 'unset'` leaves TOKEN_GOAT_HOOK_SERVER out entirely, for tests of the config switch: src/config.ts lets that variable override `hooks.server` either way, so setting it to 1 would hide the config. */
function sandbox(opts: { bundle?: string; serverEnv?: 'on' | 'unset' } = {}): Sandbox {
  const bundle = opts.bundle ?? BUNDLE
  // realpath expands a Windows 8.3 short temp path, so the data directory the server derives from LOCALAPPDATA is spelled exactly as this test spells it.
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hs-')))
  const dataDir = dataDirForHome(base)
  const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
  const home = path.join(base, 'tg-home')
  const proj = path.join(base, 'proj')
  fs.mkdirSync(proj, { recursive: true })
  // HAND-DERIVED fixture: a markdown file needs no index for `section`/`outline`, so the warm and cold runs below answer from the file itself.
  fs.writeFileSync(path.join(proj, 'notes.md'), '# Title\n\nintro\n\n## Alpha\n\nalpha body\n\n## Beta\n\nbeta body\n')
  const env: Env = {
    ...processEnv(),
    HOME: base,
    USERPROFILE: base,
    LOCALAPPDATA: envRoot,
    XDG_DATA_HOME: envRoot,
    APPDATA: base,
    XDG_CONFIG_HOME: base,
    TOKEN_GOAT_HOME: home,
    TOKEN_GOAT_HOOK_SERVER: '1',
  }
  if (opts.serverEnv === 'unset') delete env['TOKEN_GOAT_HOOK_SERVER']
  const sb: Sandbox = { base, dataDir, home, proj, env, bundle, pids: new Set(), children: [], cleanup: [], releases: [] }
  sandboxes.push(sb)
  return sb
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

afterEach(async () => {
  while (sandboxes.length > 0) {
    const sb = sandboxes.pop() as Sandbox
    for (const release of sb.releases) release()
    try {
      cli(sb, ['hook-server', 'stop'])
    } catch {
      // the stop below by pid still runs
    }
    const deadline = Date.now() + 5000
    for (const pid of sb.pids) {
      while (pidAlive(pid) && Date.now() < deadline) await sleep(50)
      if (pidAlive(pid)) process.kill(pid)
    }
    for (const child of sb.children) if (child.exitCode === null && child.signalCode === null) child.kill()
    for (const fn of sb.cleanup) fn()
    fs.rmSync(sb.base, { recursive: true, force: true })
  }
})

interface Run {
  status: number | null
  stdout: string
  stderr: string
  ms: number
}

interface NodeOpts {
  env?: Env
  cwd?: string
  input?: string
}

function runNode(sb: Sandbox, argv: string[], opts: NodeOpts): Run {
  const start = performance.now()
  const res = spawnSync(process.execPath, argv, { cwd: opts.cwd ?? sb.proj, env: { ...sb.env, ...opts.env }, input: opts.input, encoding: 'utf8', timeout: 30_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: performance.now() - start }
}

/** The same as {@link runNode} without blocking this process's event loop, for a test whose own listener has to answer the child while it runs. */
function runNodeAsync(sb: Sandbox, argv: string[], opts: NodeOpts): Promise<Run> {
  const start = performance.now()
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, argv, { cwd: opts.cwd ?? sb.proj, env: { ...sb.env, ...opts.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: performance.now() - start }))
    // A server that stopped reading stdin early would fail this write with EPIPE; that is not what these cases test.
    child.stdin.on('error', () => undefined)
    child.stdin.end(opts.input ?? '')
  })
}

function cli(sb: Sandbox, args: string[], opts: NodeOpts = {}): Run {
  return runNode(sb, [sb.bundle, ...args], opts)
}

function cliAsync(sb: Sandbox, args: string[], opts: NodeOpts = {}): Promise<Run> {
  return runNodeAsync(sb, [sb.bundle, ...args], opts)
}

/** The same call with the server turned off: the path every call took before the server existed, and the output a served call must reproduce byte for byte. */
function cold(sb: Sandbox, args: string[], opts: NodeOpts = {}): Run {
  return cli(sb, args, { ...opts, env: { ...opts.env, TOKEN_GOAT_HOOK_SERVER: '0' } })
}

function statuses(sb: Sandbox): ServerStatus[] {
  const res = cli(sb, ['hook-server', 'status', '--json'])
  expect(res.status, res.stderr).toBe(0)
  const list = JSON.parse(res.stdout) as ServerStatus[]
  for (const s of list) sb.pids.add(s.pid)
  return list
}

// Holds slot 0 inside a real request until `release()`: `compress` runs a child that writes a marker once it is running and then waits for a release file, and a server serves one request at a time. Waiting on the marker, not a fixed sleep, is what says the server is mid-request, and holding until released rather than for a fixed time keeps a slow machine from letting the request finish before the concurrent call arrives. The child gives up on its own after `holdMs`, which a test sets short when the server is blocked in the request and the test needs it to finish by itself: the server runs the child synchronously, so it answers nothing, not even `status`, until the child is gone.
function occupy(sb: Sandbox, key: Buffer, holdMs = 60_000, env: Env = sb.env): { dispatched: Promise<void>; reply: Promise<ServerReply>; running: () => Promise<void>; release: () => void } {
  const fwd = (p: string): string => p.split(path.sep).join('/')
  const hold = fwd(path.join(sb.base, 'hold.cjs'))
  const started = fwd(path.join(sb.base, 'hold-started'))
  const released = fwd(path.join(sb.base, 'hold-release'))
  fs.writeFileSync(hold, `const fs = require('fs')\nconst [started, released] = process.argv.slice(2)\nfs.writeFileSync(started, '1')\nconst end = Date.now() + ${holdMs}\nconst timer = setInterval(() => { if (fs.existsSync(released) || Date.now() > end) clearInterval(timer) }, 50)\n`)
  const release = (): void => fs.writeFileSync(released, '1')
  sb.releases.push(release)
  const req = rawRequest(distEndpoint(sb, 0), key, { kind: 'cli', argv: ['compress', '--shell', 'native', '-c', `node "${hold}" "${started}" "${released}"`], env, cwd: sb.proj })
  return { dispatched: req.dispatched, reply: req.reply, running: () => until('the held request to be running', () => (fs.existsSync(started) ? true : undefined), 30_000).then(() => undefined), release }
}

function servedBySlot(sb: Sandbox): Record<number, number> {
  return Object.fromEntries(statuses(sb).map((s) => [s.slot, s.served]))
}

/** Calls served across every slot. Which slot answers is timing, not behavior: a slot 0 held past HEDGE_MS (src/hook_client.ts) has the client ask slot 1 beside it and start it when absent, and a loaded machine's pre-push once failed on `{ 0: 5, 1: 0 }` for exactly that. That each call was served is what these tests are about. */
function servedTotal(sb: Sandbox): number {
  return statuses(sb).reduce((sum, s) => sum + s.served, 0)
}

/** Waits for the served count to reach `n`, then asserts it exactly. The stats row is written after the caller has its answer (src/hook_server.ts handle), so a status read straight after a call can precede the row; polling for the real count, and asserting it once it arrives, keeps a slow machine from reading the moment before while still failing on a count that is wrong. */
async function expectServedTotal(sb: Sandbox, n: number, label?: string): Promise<void> {
  await until(`${n} served calls`, () => (servedTotal(sb) === n ? true : undefined)).catch(() => undefined)
  expect(servedTotal(sb), label).toBe(n)
}

/** {@link expectServedTotal} per slot. */
async function expectServedBySlot(sb: Sandbox, expected: Record<number, number>): Promise<void> {
  await until('the expected per-slot served counts', () => (JSON.stringify(servedBySlot(sb)) === JSON.stringify(expected) ? true : undefined)).catch(() => undefined)
  expect(servedBySlot(sb)).toEqual(expected)
}

async function until<T>(label: string, probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(100)
  }
}

/** Waits until exactly `slots` answer status, and returns their reports in slot order. */
async function waitForSlots(sb: Sandbox, slots: number[]): Promise<ServerStatus[]> {
  return until(`servers on slots ${slots.join(',')}`, () => {
    const list = statuses(sb).sort((a, b) => a.slot - b.slot)
    return list.map((s) => s.slot).join(',') === slots.join(',') ? list : undefined
  })
}

/** Start a server in the foreground of this test, so its exit code and stderr are observable. */
function startServer(sb: Sandbox, slot: number, env: Env = {}): { child: ChildProcess; exit: Promise<number | null>; stderr: () => string } {
  const child = spawn(process.execPath, [sb.bundle, 'hook-server', 'run', '--slot', String(slot)], { cwd: sb.base, env: { ...sb.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  sb.children.push(child)
  if (child.pid !== undefined) sb.pids.add(child.pid)
  let err = ''
  child.stderr?.on('data', (d: Buffer) => (err += d.toString('utf8')))
  child.stdout?.resume()
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))
  return { child, exit, stderr: () => err }
}

async function exitsWithin(exit: Promise<number | null>, ms: number): Promise<number | null | 'still running'> {
  return Promise.race([exit, sleep(ms).then(() => 'still running' as const)])
}

/** Marks slots as recently spawned, which the client's 30s autostart rate limit (hook_client.ts startServer) honours: a test that must observe a fallback without a background server appearing under it pre-empts the spawn this way. */
function blockAutostart(sb: Sandbox, slots: number[]): void {
  for (const slot of slots) touchMarker(`spawn-${slot}`, 'blocked by test', sb.dataDir)
}

/** Driver for the real client module: relays one hook call through `relayViaServer` and prints what came back, `null` meaning nothing was dispatched and a shim would run the hook itself. */
function writeDriver(sb: Sandbox): string {
  const p = path.join(sb.base, 'relay-driver.mjs')
  fs.writeFileSync(
    p,
    [
      "import { readFileSync } from 'node:fs'",
      "import { pathToFileURL } from 'node:url'",
      'const [clientPath, event] = process.argv.slice(2)',
      'const { relayViaServer } = await import(pathToFileURL(clientPath).href)',
      "const out = await relayViaServer(event, readFileSync(0, 'utf8'))",
      'process.stdout.write(JSON.stringify({ out: out ?? null }))',
      '',
    ].join('\n'),
  )
  return p
}

function relayArgv(sb: Sandbox, event: string): string[] {
  const driver = path.join(sb.base, 'relay-driver.mjs')
  if (!fs.existsSync(driver)) writeDriver(sb)
  return [driver, path.join(path.dirname(sb.bundle), 'token-goat-hook-client.mjs'), event]
}

function relayResult(res: Run): string | null {
  expect(res.status, res.stderr).toBe(0)
  return (JSON.parse(res.stdout) as { out: string | null }).out
}

function relay(sb: Sandbox, event: string, input: string, opts: Omit<NodeOpts, 'input'> = {}): string | null {
  return relayResult(runNode(sb, relayArgv(sb, event), { ...opts, input }))
}

async function relayAsync(sb: Sandbox, event: string, input: string): Promise<string | null> {
  return relayResult(await runNodeAsync(sb, relayArgv(sb, event), { input }))
}

// HAND-DERIVED payload: preBashHandler (src/hooks_bash.ts) denies `find | xargs grep -l` outright with no index or config behind the decision. The same call repeated in one session gets a shorter repeat-refusal instead, so every run compared below uses its own session id.
function bashDenyPayload(sessionId: string): string {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'find . -name "*.ts" | xargs grep -l TokenGoat' }, session_id: sessionId })
}

/** The endpoint the built client and server use for `slot`. FORMAT-DERIVED from src/hook_ipc.ts endpointFor/endpointId: the id hashes the data directory and the realpath of the bundle's own directory, which this process (running from src/) cannot ask the bundle for. Every use below is self-checking: the real client must connect to a listener bound here, or the real server must pass the key challenge on it. */
function distEndpoint(sb: Sandbox, slot: number): string {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const bundleDir = fs.realpathSync.native(path.dirname(sb.bundle))
  const id = `${crypto.createHash('sha256').update(`${fold(sb.dataDir)}\0${fold(bundleDir)}`).digest('hex').slice(0, 16)}-${slot}`
  if (process.platform === 'win32') return String.raw`\\.\pipe\token-goat-hooks-` + id
  const inData = path.join(sb.dataDir, `hooks-${id}.sock`)
  if (Buffer.byteLength(inData) < 100) return inData
  return path.join(os.tmpdir(), `token-goat-${process.getuid?.() ?? 'u'}`, `${id}.sock`)
}

/** Speaks the client side of the handshake by hand (FORMAT-DERIVED from src/hook_client.ts attempt) to hold a server busy with a request of the test's choosing. With `stall`, it stops reading once the request is sent, as a caller slow to take its answer would, until `resume` is called. */
function rawRequest(endpoint: string, key: Buffer, request: ServerRequest, opts: { stall?: boolean } = {}): { dispatched: Promise<void>; reply: Promise<ServerReply>; resume: () => void } {
  let markDispatched: () => void = () => undefined
  const dispatched = new Promise<void>((resolve) => (markDispatched = resolve))
  const socket = net.connect(endpoint)
  const reply = new Promise<ServerReply>((resolve, reject) => {
    const nc = nonce()
    let ns = ''
    socket.on('error', reject)
    socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc }))
    readFrames(
      socket,
      (msg) => {
        if (msg['t'] === 'challenge') {
          ns = String(msg['ns'])
          if (!macMatches(mac(key, 'S', nc, ns), msg['mac'])) return reject(new Error('server failed the key challenge'))
          const body = JSON.stringify(request)
          writeFrame(socket, { t: 'req', mac: mac(key, 'C', nc, ns, body), body })
          if (opts.stall) socket.pause()
          markDispatched()
          return
        }
        if (msg['t'] === 'res') {
          const body = String(msg['body'])
          if (!macMatches(mac(key, 'R', nc, ns, body), msg['mac'])) return reject(new Error('reply MAC mismatch'))
          socket.destroy()
          return resolve(JSON.parse(body) as ServerReply)
        }
        reject(new Error(`unexpected frame ${JSON.stringify(msg)}`))
      },
      reject,
    )
  })
  return { dispatched, reply, resume: () => void socket.resume() }
}

/** Evaluates `fn` with this process's data directory pointed at the sandbox's, so real exports that read it (configStamp) answer for the sandbox. */
function inDataDir<T>(sb: Sandbox, fn: () => T): T {
  const saved = { LOCALAPPDATA: process.env['LOCALAPPDATA'], XDG_DATA_HOME: process.env['XDG_DATA_HOME'] }
  process.env['LOCALAPPDATA'] = sb.env['LOCALAPPDATA']
  process.env['XDG_DATA_HOME'] = sb.env['XDG_DATA_HOME']
  _resetDataDirCacheForTesting()
  try {
    return fn()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    _resetDataDirCacheForTesting()
  }
}

function writeConfig(sb: Sandbox, text: string, mtime: Date): void {
  const p = path.join(sb.dataDir, 'config.toml')
  fs.mkdirSync(sb.dataDir, { recursive: true })
  fs.writeFileSync(p, text)
  fs.utimesSync(p, mtime, mtime)
}

function expectSameRun(actual: Run, expected: Run): void {
  expect({ status: actual.status, stdout: actual.stdout, stderr: actual.stderr }).toEqual({ status: expected.status, stdout: expected.stdout, stderr: expected.stderr })
}

describe('serving hook calls', () => {
  it('autostarts on the first hook call, then serves the next one with output identical to a cold run', async () => {
    const sb = sandbox()
    const baseline = cold(sb, ['hook', 'pre_tool_use'], { input: bashDenyPayload('hs-serve-cold') })
    expect(baseline.status, baseline.stderr).toBe(0)
    expect((JSON.parse(baseline.stdout) as { decision?: string }).decision, `stdout ${baseline.stdout}; stderr ${baseline.stderr}`).toBe('block')

    // Nothing to talk to yet: the client dispatches nothing, and starts slot 0 in the background.
    expect(relay(sb, 'pre_tool_use', bashDenyPayload('hs-serve-first'))).toBeNull()
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(true)
    const [started] = await waitForSlots(sb, [0])
    expect(started?.served).toBe(0)

    expect(relay(sb, 'pre_tool_use', bashDenyPayload('hs-serve-warm'))).toBe(baseline.stdout)
    await expectServedTotal(sb, 1)
  })

  // HAND-DERIVED: a hook payload past MAX_FRAME_BYTES (64 MiB, src/hook_ipc.ts) was handed over, the server dropped the connection on reading its length, and the client counted that as a lost request and failed it open, so the hook ran nowhere.
  it('runs a hook whose payload is too large for one frame locally, rather than failing it open', async () => {
    const sb = sandbox()
    blockAutostart(sb, [1])
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    const payload = JSON.stringify({ ...(JSON.parse(bashDenyPayload('hs-oversize')) as object), padding: 'x'.repeat(65 * 1024 * 1024) })
    expect(relay(sb, 'pre_tool_use', payload)).toBeNull()
    expect(servedBySlot(sb)).toEqual({ 0: 0 })
  })

  it('does the same through the CommonJS client a shim loads, which finds the launcher beside its own file', async () => {
    const sb = sandbox()
    const baseline = cold(sb, ['hook', 'pre_tool_use'], { input: bashDenyPayload('hs-cjs-cold') })
    const driver = path.join(sb.base, 'relay-driver.cjs')
    fs.writeFileSync(driver, "const [clientPath, event] = process.argv.slice(2)\nrequire(clientPath).relayViaServer(event, require('node:fs').readFileSync(0, 'utf8')).then((out) => process.stdout.write(JSON.stringify({ out: out ?? null })))\n")
    const argv = [driver, path.join(path.dirname(sb.bundle), 'token-goat-hook-client.cjs'), 'pre_tool_use']
    // The CommonJS build has no import.meta.url; the start it makes here is proof its stand-in named the right directory, since the launcher it spawns is the one beside the client.
    expect(relayResult(runNode(sb, argv, { input: bashDenyPayload('hs-cjs-first') }))).toBeNull()
    await waitForSlots(sb, [0])
    expect(relayResult(runNode(sb, argv, { input: bashDenyPayload('hs-cjs-warm') }))).toBe(baseline.stdout)
    await expectServedTotal(sb, 1)
  })

  it('runs each request under its caller environment and working directory, so session state lands in each caller own home', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    const homeA = path.join(sb.base, 'home-a')
    const homeB = path.join(sb.base, 'home-b')
    const envFile = path.join(sb.proj, '.env')
    fs.writeFileSync(envFile, 'FOO=bar\n')
    // Same session id from both homes: the .env re-read deny (src/hooks_read.ts) is keyed on session state under TOKEN_GOAT_HOME, so B must see a first read even after A has read the file.
    const read = JSON.stringify({ tool_name: 'Read', tool_input: { file_path: envFile }, session_id: 'hs-shared-session' })
    const decision = (out: string | null): string | undefined => {
      expect(out).not.toBeNull()
      return (JSON.parse(out as string) as { decision?: string }).decision
    }

    const a1 = relay(sb, 'pre_tool_use', read, { env: { TOKEN_GOAT_HOME: homeA } })
    expect(decision(a1)).not.toBe('block')
    const b1 = relay(sb, 'pre_tool_use', read, { env: { TOKEN_GOAT_HOME: homeB } })
    expect(b1).toBe(a1)
    const a2 = relay(sb, 'pre_tool_use', read, { env: { TOKEN_GOAT_HOME: homeA } })
    expect(decision(a2), `second read answered ${String(a2)}`).toBe('block')
    expect(fs.existsSync(path.join(homeA, 'sessions', 'hs-shared-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(homeB, 'sessions', 'hs-shared-session.json'))).toBe(true)
    expect(fs.existsSync(path.join(sb.home, 'sessions', 'hs-shared-session.json'))).toBe(false)

    // Relative paths resolve against each caller's own directory, one after the other in the same process.
    const dirA = path.join(sb.base, 'cwd-a')
    const dirB = path.join(sb.base, 'cwd-b')
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    fs.writeFileSync(path.join(dirA, 'doc.md'), '# A\n\n## Part\n\nfrom directory A\n')
    fs.writeFileSync(path.join(dirB, 'doc.md'), '# B\n\n## Part\n\nfrom directory B\n')
    expect(cli(sb, ['section', 'doc.md::Part'], { cwd: dirA }).stdout).toContain('from directory A')
    expect(cli(sb, ['section', 'doc.md::Part'], { cwd: dirB }).stdout).toContain('from directory B')
    await expectServedTotal(sb, 5)
  })
})

describe('warm CLI', () => {
  it('answers read-only commands with the same stdout, stderr and exit code as a cold run, including a failing one', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    const cases: string[][] = [
      ['section', 'notes.md::Alpha'],
      ['outline', 'notes.md'],
      ['section', 'missing.md::Alpha'],
    ]
    let served = 0
    for (const args of cases) {
      const expected = cold(sb, args)
      const actual = cli(sb, args)
      expectSameRun(actual, expected)
      served++
      await expectServedTotal(sb, served, args.join(' '))
    }
    // HAND-DERIVED guard on the fixture itself: the failing case really fails, and the others really print the file.
    expect(cold(sb, ['section', 'missing.md::Alpha']).status).toBe(1)
    expect(cold(sb, ['section', 'notes.md::Alpha']).stdout).toContain('alpha body')
  })

  // The index-backed analysis commands. Each was left to a fresh Node start on every call although it only reads the index, and a served run is worth having only if it prints what the cold run prints, byte for byte.
  it('answers the index-backed analysis commands with the same stdout, stderr and exit code as a cold run', async () => {
    const sb = sandbox()
    // HAND-DERIVED fixture: two source files and a test file whose call graph is written out below, so each command's answer is known before it runs.
    fs.mkdirSync(path.join(sb.proj, 'src'))
    fs.mkdirSync(path.join(sb.proj, 'tests'))
    fs.writeFileSync(path.join(sb.proj, 'src', 'helper.ts'), 'export function scaleValue(value: number, factor: number): number {\n  return value * factor\n}\n\nexport function unusedHelper(): number {\n  return 0\n}\n')
    fs.writeFileSync(
      path.join(sb.proj, 'src', 'calc.ts'),
      "import { scaleValue } from './helper'\n\nexport interface CalcOptions {\n  factor: number\n}\n\nexport function computeTotal(values: number[], opts: CalcOptions): number {\n  let total = 0\n  for (const v of values) total += scaleValue(v, opts.factor)\n  return total\n}\n\nexport function reportTotal(values: number[]): string {\n  return String(computeTotal(values, { factor: 2 }))\n}\n",
    )
    fs.writeFileSync(path.join(sb.proj, 'tests', 'calc.test.ts'), "import { computeTotal } from '../src/calc'\n\nexport function checkComputeTotal(): boolean {\n  return computeTotal([1], { factor: 1 }) === 1\n}\n")
    for (const args of [['init', '-q'], ['add', '-A']]) expect(spawnSync('git', args, { cwd: sb.proj }).status).toBe(0)
    const indexed = cold(sb, ['index', '.'])
    expect(indexed.status, indexed.stderr).toBe(0)
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    // Each case with a line its cold run must print, so a pair of empty answers cannot pass as equal.
    const cases: Array<[string[], string]> = [
      [['find', 'compute'], 'src/calc.ts'],
      [['locate', 'computeTotal'], 'src/calc.ts:7-11 [function] computeTotal'],
      [['callers', 'scaleValue'], 'computeTotal\tsrc/calc.ts:9'],
      [['call-chain', 'scaleValue'], 'scaleValue -> computeTotal -> reportTotal'],
      [['impact', 'scaleValue'], 'reportTotal\t(hops: 2)'],
      [['dead'], 'unusedHelper\tsrc/helper.ts:5'],
      [['deps', 'src/calc.ts'], 'src/helper.ts'],
      [['types'], 'CalcOptions\tinterface\tsrc/calc.ts:3'],
      [['scope', 'src/calc.ts:9'], 'computeTotal\tfunction\tsrc/calc.ts:7-11'],
      [['similar', 'src/calc.ts::computeTotal'], 'reportTotal\tfunction\tsrc/calc.ts:13'],
      [['context-for', 'compute the scaled total'], 'src/calc.ts::computeTotal'],
      [['test-for', 'src/calc.ts'], 'tests/calc.test.ts'],
      [['callers', 'noSuchSymbolAnywhere'], 'Symbol not found: "noSuchSymbolAnywhere"'],
    ]
    let served = 0
    for (const [args, mustPrint] of cases) {
      const expected = cold(sb, args)
      expect(expected.stdout + expected.stderr, args.join(' ')).toContain(mustPrint)
      const actual = cli(sb, args)
      expectSameRun(actual, expected)
      served++
      expect(servedTotal(sb), args.join(' ')).toBe(served)
    }
    // The failing case really fails, so the exit code is compared on a non-zero one too.
    expect(cold(sb, ['callers', 'noSuchSymbolAnywhere']).status).toBe(1)
  }, 120_000)

  it('leaves --help to the local CLI', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    expectSameRun(cli(sb, ['section', '--help']), cold(sb, ['section', '--help']))
    expect(servedTotal(sb)).toBe(0)
  })
})

describe('busy servers', () => {
  it('sends a second concurrent call to the next slot while slot 0 is busy, and both answer correctly', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    startServer(sb, 1)
    await waitForSlots(sb, [0, 1])
    const expected = cold(sb, ['section', 'notes.md::Beta'])
    const held = occupy(sb, readServerKey(sb.dataDir) as Buffer)
    await held.dispatched
    await held.running()
    expectSameRun(cli(sb, ['section', 'notes.md::Beta']), expected)
    held.release()
    const reply = await held.reply
    expect(reply.ok).toBe(true)
    expect('status' in reply ? reply.status : undefined).toBe(0)
    // Slot 0 served only the request holding it, and the concurrent call was served once somewhere else; a third slot may have been started beside them (hedging on a loaded machine) but serves nothing.
    const served = servedBySlot(sb)
    expect(served[0]).toBe(1)
    expect(Object.values(served).reduce((sum, n) => sum + n, 0)).toBe(2)
  })

  it('falls back to a local run when every running slot is busy, and starts the next slot for later calls', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    const expected = cold(sb, ['section', 'notes.md::Beta'])
    const held = occupy(sb, readServerKey(sb.dataDir) as Buffer)
    await held.dispatched
    await held.running()
    expectSameRun(cli(sb, ['section', 'notes.md::Beta']), expected)
    expect(fs.existsSync(markerPath('spawn-1', sb.dataDir))).toBe(true)
    held.release()
    expect((await held.reply).ok).toBe(true)
    // Slot 0 served only the request holding it: the concurrent call ran locally rather than queueing behind it.
    const list = await waitForSlots(sb, [0, 1])
    expect(list.map((s) => [s.slot, s.served])).toEqual([
      [0, 1],
      [1, 0],
    ])
  })

  // HAND-DERIVED: a server mid-request used to answer every handshake with `busy`, which `hook-server status` and `stop` read as no server at all.
  it('lists and stops a server that is in the middle of a request, which still gets its answer', async () => {
    const sb = sandbox()
    blockAutostart(sb, [1])
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    const held = occupy(sb, readServerKey(sb.dataDir) as Buffer, 3000)
    await held.dispatched
    await held.running()
    const status = cli(sb, ['hook-server', 'status'])
    expect(status.stdout).toContain('slot 0: pid')
    const stop = cli(sb, ['hook-server', 'stop'])
    expect(stop.stdout.trim()).toBe('Stopped 1 hook server.')
    const reply = await held.reply
    expect('status' in reply ? reply.status : reply).toBe(0)
    expect(await exitsWithin(server.exit, 5000)).toBe(0)
  })

  it('writes each call stats row after answering it, without losing a row or turning away the next back-to-back call', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    blockAutostart(sb, [1, 2])
    const calls = 25
    const driver = path.join(sb.base, 'back-to-back.mjs')
    fs.writeFileSync(
      driver,
      [
        "import { pathToFileURL } from 'node:url'",
        'const [clientPath, input, calls] = process.argv.slice(2)',
        'const { callServer } = await import(pathToFileURL(clientPath).href)',
        // FORMAT-DERIVED from src/hook_client.ts relayViaServer, which builds this request with the same fields. The handshake allowance is raised from its 150ms default because that default is how long a caller will wait on a slow machine before running locally, a tuning choice this test is not about: with it out of the way, a call turned away here was told busy, which is the defect.
        'const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined))',
        'let served = 0',
        'const turnedAway = []',
        'for (let i = 0; i < Number(calls); i++) {',
        "  const reply = await callServer({ kind: 'hook', event: 'pre_tool_use', input, elapsedMs: performance.now(), env, cwd: process.cwd() }, { handshakeMs: 10000 })",
        '  if (reply !== undefined) served++',
        '  else turnedAway.push(i)',
        '}',
        "if (turnedAway.length > 0) process.stderr.write('turned away: calls ' + turnedAway.join(', '))",
        'process.stdout.write(String(served))',
        '',
      ].join('\n'),
    )
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'back-to-back' })
    const run = await runNodeAsync(sb, [driver, path.join(path.dirname(sb.bundle), 'token-goat-hook-client.mjs'), input, String(calls)], {})
    expect(run.status, run.stderr).toBe(0)
    // Every call reached slot 0. One told it was busy would have gone to slot 1, found nothing there, and run locally.
    expect(run.stdout, run.stderr).toBe(String(calls))
    await expectServedBySlot(sb, { 0: calls })
    // The server answers before it writes the row, so a row missing here is one that was deferred and never written.
    const db = new Database(path.join(sb.dataDir, 'global.db'), { readonly: true })
    try {
      expect((db.prepare("SELECT COUNT(*) AS c FROM stats WHERE kind = 'hook:pre_tool_use'").get() as { c: number }).c).toBe(calls)
    } finally {
      db.close()
    }
  })

  // CI caught the back-to-back test above turning away 3 to 5 of 25 calls on Windows: the server stayed busy until its answer had drained, and a caller that had already read it could reconnect first. A caller that stops reading stretches that window without limit, so it makes the case deterministic.
  it('serves the next call while an earlier caller is still reading its answer', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    blockAutostart(sb, [1, 2])
    // HAND-DERIVED size: 50,000 keys of about 70 bytes each print as roughly 4 MB, far past what a socket or pipe buffers, so the answer cannot finish leaving the server while its caller is not reading. json-query prints a subtree whole, where section and read cap what they print.
    const keys = 50_000
    const big: Record<string, string> = {}
    for (let i = 0; i < keys; i++) big[`k${i}`] = `${'v'.repeat(60)}${i}`
    fs.writeFileSync(path.join(sb.proj, 'big.json'), JSON.stringify({ big }))
    const slow = rawRequest(distEndpoint(sb, 0), readServerKey(sb.dataDir) as Buffer, { kind: 'cli', argv: ['json-query', 'big.json', 'big'], env: sb.env, cwd: sb.proj }, { stall: true })
    await slow.dispatched
    const driver = path.join(sb.base, 'until-served.mjs')
    fs.writeFileSync(
      driver,
      [
        "import { pathToFileURL } from 'node:url'",
        'const [clientPath, input] = process.argv.slice(2)',
        'const { relayViaServer } = await import(pathToFileURL(clientPath).href)',
        // The slow request's command takes a moment to run, and the slot is rightly busy until it has, so the call is retried until it is served or the deadline passes.
        'const deadline = Date.now() + 20000',
        'let served = false',
        'while (!served && Date.now() < deadline) {',
        "  served = (await relayViaServer('pre_tool_use', input)) !== undefined",
        '  if (!served) await new Promise((r) => setTimeout(r, 200))',
        '}',
        'process.stdout.write(String(served))',
        '',
      ].join('\n'),
    )
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 'slow-reader' })
    const run = await runNodeAsync(sb, [driver, path.join(path.dirname(sb.bundle), 'token-goat-hook-client.mjs'), input], {})
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe('true')
    slow.resume()
    const reply = await slow.reply
    expect(reply.ok).toBe(true)
    // The answer drained whole once its caller read it: every key is there.
    expect('stdout' in reply ? Object.keys(JSON.parse(reply.stdout) as object).length : undefined).toBe(keys)
    await expectServedBySlot(sb, { 0: 2 })
  })
})

describe('authentication', () => {
  it('never hands a request to a listener that cannot prove it holds the key, and the call still answers locally', async () => {
    const sb = sandbox()
    ensureServerKey(sb.dataDir)
    blockAutostart(sb, [1, 2])
    const frames: Array<Record<string, unknown>> = []
    const raw: Buffer[] = []
    // A squatter bound to slot 0's predictable name: it answers the hello with a challenge MACed under a key it made up, which is the best a process without the key file can do.
    const wrongKey = crypto.randomBytes(32)
    const squatter = net.createServer((socket) => {
      socket.on('data', (d: Buffer) => raw.push(d))
      socket.on('error', () => undefined)
      readFrames(
        socket,
        (msg) => {
          frames.push(msg)
          if (msg['t'] === 'hello') {
            const ns = nonce()
            writeFrame(socket, { t: 'challenge', v: PROTOCOL_VERSION, ns, mac: mac(wrongKey, 'S', String(msg['nc']), ns) })
          }
        },
        () => undefined,
      )
    })
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(distEndpoint(sb, 0), () => resolve())
    })
    sb.cleanup.push(() => squatter.close())

    // Async spawns: the squatter lives in this process, and a blocking spawn would leave it unable to answer the client at all.
    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(await cliAsync(sb, ['section', 'notes.md::Alpha']), expected)
    expect(await relayAsync(sb, 'pre_tool_use', bashDenyPayload('hs-squatter'))).toBeNull()

    // The client did reach the squatter (so the endpoint really is slot 0's), sent only its hellos, and nothing identifying the request.
    expect(frames.map((f) => f['t'])).toEqual(['hello', 'hello'])
    const seen = Buffer.concat(raw).toString('utf8')
    expect(seen).not.toContain('notes.md')
    expect(seen).not.toContain('xargs')
    expect(seen).not.toContain('"req"')
    // Closed here as well as in cleanup, for the reason the byte-long MAC test below gives: afterEach's blocking `hook-server stop` cannot be answered by a listener in this process and would wait out its 30s spawn timeout.
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })

  it('refuses a server whose key no longer matches the key file, then serves again once the file is restored', async () => {
    const sb = sandbox()
    startServer(sb, 0)
    await waitForSlots(sb, [0])
    blockAutostart(sb, [1, 2])
    const keyPath = path.join(sb.dataDir, 'hook-server.key')
    const original = fs.readFileSync(keyPath)
    fs.writeFileSync(keyPath, crypto.randomBytes(32), { mode: 0o600 })

    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(statuses(sb)).toEqual([])

    fs.writeFileSync(keyPath, original, { mode: 0o600 })
    expect(servedBySlot(sb)).toEqual({ 0: 0 })
  })

  it('dispatches nothing once the key file is gone, and the server exits on its own soon after', async () => {
    const sb = sandbox()
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    blockAutostart(sb, [0, 1, 2])
    fs.rmSync(path.join(sb.dataDir, 'hook-server.key'))

    expect(statuses(sb)).toEqual([])
    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(relay(sb, 'pre_tool_use', bashDenyPayload('hs-nokey'))).toBeNull()
    // KEY_CHECK_MS in src/hook_server.ts is 2s; 8s leaves room for a loaded machine without letting a server that never checks pass.
    expect(await exitsWithin(server.exit, 8000)).toBe(0)
  })

  // HAND-DERIVED: 'é' is one UTF-16 code unit and two UTF-8 bytes, so this is as many characters as a hex HMAC-SHA256 digest and one byte longer, which is what a peer without the key can send in place of a MAC.
  const byteLongMac = `é${'0'.repeat(63)}`

  it('hangs up on a request whose MAC is as long as the real one in characters but not in bytes, and keeps serving', async () => {
    const sb = sandbox()
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    blockAutostart(sb, [0, 1, 2])
    const frames: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve) => {
      const socket = net.connect(distEndpoint(sb, 0))
      socket.on('error', () => undefined)
      socket.on('close', () => resolve())
      socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc: nonce() }))
      readFrames(
        socket,
        (msg) => {
          frames.push(msg)
          if (msg['t'] === 'challenge') writeFrame(socket, { t: 'req', mac: byteLongMac, body: JSON.stringify({ kind: 'status' }) })
        },
        () => undefined,
      )
    })
    expect(frames.map((f) => f['t'])).toEqual(['challenge'])
    expect(await exitsWithin(server.exit, 2000), server.stderr()).toBe('still running')
    expect(servedBySlot(sb)).toEqual({ 0: 0 })
  })

  it('refuses a listener whose challenge MAC is as long as the real one in characters but not in bytes, and the call still answers locally', async () => {
    const sb = sandbox()
    ensureServerKey(sb.dataDir)
    blockAutostart(sb, [1, 2])
    const frames: Array<Record<string, unknown>> = []
    const squatter = net.createServer((socket) => {
      socket.on('error', () => undefined)
      readFrames(
        socket,
        (msg) => {
          frames.push(msg)
          if (msg['t'] === 'hello') writeFrame(socket, { t: 'challenge', v: PROTOCOL_VERSION, ns: nonce(), mac: byteLongMac })
        },
        () => undefined,
      )
    })
    await new Promise<void>((resolve, reject) => {
      squatter.once('error', reject)
      squatter.listen(distEndpoint(sb, 0), () => resolve())
    })
    sb.cleanup.push(() => squatter.close())

    // Async spawns, as in the squatter test above: the listener lives in this process.
    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(await cliAsync(sb, ['section', 'notes.md::Alpha']), expected)
    expect(await relayAsync(sb, 'pre_tool_use', bashDenyPayload('hs-byte-long-mac'))).toBeNull()
    // Both calls reached the squatter, so the endpoint really is slot 0's and each one met the byte-long MAC, and neither sent a request after it.
    expect(frames.map((f) => f['t'])).toEqual(['hello', 'hello'])
    // Closed here as well as in cleanup: the `hook-server stop` in afterEach is a blocking spawn, and a listener in this process still bound to slot 0 could not answer it, holding the stop to its 30s spawn timeout.
    await new Promise<void>((resolve) => squatter.close(() => resolve()))
  })
})

/** A sandbox running a private copy of dist/, for a test that rewrites one of its files. The copy resolves its native dependencies through a junction to this repo's node_modules, as tests/bridges/inprocess.test.ts's hook fixture does. */
function sandboxOnDistCopy(): { sb: Sandbox; copy: string } {
  const copy = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hs-dist-')))
  const dist = path.join(ROOT, 'dist')
  for (const f of fs.readdirSync(dist)) if (fs.statSync(path.join(dist, f)).isFile()) fs.copyFileSync(path.join(dist, f), path.join(copy, f))
  const link = path.join(copy, 'node_modules')
  fs.symlinkSync(path.join(ROOT, 'node_modules'), link, 'junction')
  const sb = sandbox({ bundle: path.join(copy, 'token-goat.mjs') })
  // Registered after the sandbox's own cleanup would run, so the junction is unlinked on its own before anything recursive touches the copy.
  sb.cleanup.push(() => {
    fs.unlinkSync(link)
    fs.rmSync(copy, { recursive: true, force: true })
  })
  return { sb, copy }
}

describe('retirement', () => {
  it('retires on its next contact once a bundle entry file is replaced, and the next call starts a fresh server', async () => {
    const { sb, copy } = sandboxOnDistCopy()
    const server = startServer(sb, 0)
    const [first] = await waitForSlots(sb, [0])
    expect(first?.pid).toBe(server.child.pid)
    fs.appendFileSync(path.join(copy, 'token-goat-hook-client.mjs'), '\n// replaced by a newer build\n')

    expect(statuses(sb)).toEqual([])
    expect(await exitsWithin(server.exit, 5000)).toBe(0)

    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(true)
    const [fresh] = await waitForSlots(sb, [0])
    expect(fresh?.pid).not.toBe(first?.pid)
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    await expectServedTotal(sb, 1)
  })

  it('starts the new build on the next call even when the retired server was itself started moments before', async () => {
    const { sb, copy } = sandboxOnDistCopy()
    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    // The first call starts slot 0 and records when, which is what throttles the next start.
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    const [first] = await waitForSlots(sb, [0])
    expect(markerAgeMs('spawn-0', sb.dataDir)).toBeLessThan(30_000)
    fs.appendFileSync(path.join(copy, 'token-goat-hook-client.mjs'), '\n// replaced by a newer build\n')
    expect(statuses(sb)).toEqual([])
    await until('the retired server to exit', () => (first !== undefined && !pidAlive(first.pid) ? true : undefined))

    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    const [fresh] = await waitForSlots(sb, [0])
    expect(fresh?.pid).not.toBe(first?.pid)
  })

  it('exits at once under TOKEN_GOAT_HOOK_SERVER=0, recording the config it read, and clients stop starting one until the config changes', async () => {
    const sb = sandbox()
    const run = cli(sb, ['hook-server', 'run', '--slot', '0'], { env: { TOKEN_GOAT_HOOK_SERVER: '0' } })
    expect(run.status).toBe(0)
    const stamp = inDataDir(sb, () => configStamp())
    expect(stamp).toBe('absent')
    expect(readMarker('disabled', sb.dataDir)).toBe(stamp)

    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(false)

    writeConfig(sb, '[hooks]\nserver = true\n', new Date('2026-02-01T00:00:00Z'))
    expect(inDataDir(sb, () => configStamp())).not.toBe(stamp)
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(true)
    await waitForSlots(sb, [0])
  })

  it('exits at once when hooks.server = false, and a config edit re-enables autostart', async () => {
    const sb = sandbox({ serverEnv: 'unset' })
    writeConfig(sb, '[hooks]\nserver = false\n', new Date('2026-02-01T00:00:00Z'))
    const run = cli(sb, ['hook-server', 'run', '--slot', '0'])
    expect(run.status).toBe(0)
    const stamp = inDataDir(sb, () => configStamp())
    expect(stamp).not.toBe('absent')
    expect(readMarker('disabled', sb.dataDir)).toBe(stamp)

    expect(relay(sb, 'pre_tool_use', bashDenyPayload('hs-disabled-1'))).toBeNull()
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(false)

    writeConfig(sb, '[hooks]\nserver = true\n', new Date('2026-02-01T00:00:10Z'))
    expect(relay(sb, 'pre_tool_use', bashDenyPayload('hs-disabled-2'))).toBeNull()
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(true)
    await waitForSlots(sb, [0])
  })

  it('retires a running server on its next contact once the config turns it off', async () => {
    const sb = sandbox({ serverEnv: 'unset' })
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    writeConfig(sb, '[hooks]\nserver = false\n', new Date('2026-03-01T00:00:00Z'))

    const expected = cold(sb, ['section', 'notes.md::Alpha'])
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(await exitsWithin(server.exit, 5000)).toBe(0)
    expect(readMarker('disabled', sb.dataDir)).toBe(inDataDir(sb, () => configStamp()))
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), expected)
    expect(fs.existsSync(markerPath('spawn-0', sb.dataDir))).toBe(false)
  })

  // HAND-DERIVED: a request runs under its caller's environment (swapEnv), and a contact arriving meanwhile used to be judged under that environment too. A caller with TOKEN_GOAT_HOOK_SERVER unset (which hook_client.ts serverEnabled treats as on) made a server started with it set read hooks.server = false instead, and retire.
  it("judges a contact that arrives mid-request by the server's own environment, not the environment of the request in flight", async () => {
    const sb = sandbox()
    writeConfig(sb, '[hooks]\nserver = false\n', new Date('2026-03-01T00:00:00Z'))
    blockAutostart(sb, [1, 2])
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    const callerEnv: Env = { ...sb.env }
    delete callerEnv['TOKEN_GOAT_HOOK_SERVER']
    // `compress` runs a child that holds the server inside the request, under callerEnv, while the next contact arrives; the child's own marker says it is running.
    const held = occupy(sb, readServerKey(sb.dataDir) as Buffer, 3000, callerEnv)
    await held.dispatched
    await held.running()
    expect(cli(sb, ['hook-server', 'status']).stdout).toContain('slot 0: pid')
    const reply = await held.reply
    expect('status' in reply ? reply.status : reply).toBe(0)
    expect(readMarker('disabled', sb.dataDir)).toBeUndefined()
    expect(await exitsWithin(server.exit, 500)).toBe('still running')
    expectSameRun(cli(sb, ['section', 'notes.md::Alpha']), cold(sb, ['section', 'notes.md::Alpha']))
    await expectServedBySlot(sb, { 0: 2 })
  })

  it('records why a start failed in the failed marker, and clears it once a server is listening', async () => {
    const sb = sandbox()
    const bad = cli(sb, ['hook-server', 'run', '--slot', '9'])
    expect(bad.status).not.toBe(0)
    expect(bad.stderr).toContain('--slot must be an integer from 0 to 2')
    expect(readMarker('failed', sb.dataDir)).toBe('slot 9: --slot must be an integer from 0 to 2')

    startServer(sb, 0)
    await waitForSlots(sb, [0])
    expect(readMarker('failed', sb.dataDir)).toBeUndefined()
  })

  // A caller that has its challenge but not yet its answer counts its request as handed over the moment it sends it, and a request handed over and never answered fails open to `{}`: the hook's own output is lost rather than run twice. So a server that stops must tell such a caller it is retiring, which the caller reads as "run it yourself", instead of exiting under it. HAND-DERIVED interleaving: a caller that holds its challenge while another asks the server to stop, the order an idle timeout or a `hook-server stop` meets a call in progress.
  it('tells a caller waiting between its challenge and its request that it is retiring, rather than exiting under it', async () => {
    const sb = sandbox()
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    const key = readServerKey(sb.dataDir) as Buffer
    const endpoint = distEndpoint(sb, 0)
    const held = net.connect(endpoint)
    const frames: Array<Record<string, unknown>> = []
    let challenged: () => void = () => undefined
    const gotChallenge = new Promise<void>((resolve) => (challenged = resolve))
    const closed = new Promise<void>((resolve) => held.once('close', () => resolve()))
    held.on('error', () => undefined)
    held.on('connect', () => writeFrame(held, { t: 'hello', v: PROTOCOL_VERSION, nc: nonce() }))
    readFrames(
      held,
      (msg) => {
        frames.push(msg)
        if (msg['t'] === 'challenge') challenged()
      },
      () => undefined,
    )
    await gotChallenge

    const stopped = rawRequest(endpoint, key, { kind: 'stop' })
    expect((await stopped.reply).ok).toBe(true)
    await closed

    expect(frames.map((f) => f['t'])).toEqual(['challenge', 'stale'])
    expect(await exitsWithin(server.exit, 5000)).toBe(0)
  })

  // HAND-DERIVED: two servers started past the same dead socket file each remove it and listen, so the first is left listening on a file the second replaced, reachable by nobody, and a Unix socket is unlinked by whichever server closes it: the orphan's eventual close took the live server's socket with it.
  it.skipIf(process.platform === 'win32')('exits on its own once another server has replaced its socket file, and leaves that file in place', async () => {
    const sb = sandbox()
    blockAutostart(sb, [0, 1])
    const orphan = startServer(sb, 0)
    await waitForSlots(sb, [0])
    const endpoint = distEndpoint(sb, 0)
    fs.rmSync(endpoint)
    const other = net.createServer()
    await new Promise<void>((resolve) => other.listen(endpoint, resolve))
    try {
      expect(await exitsWithin(orphan.exit, 8000)).toBe(0)
      expect(fs.existsSync(endpoint)).toBe(true)
    } finally {
      other.close()
    }
  })

  it('uninstall --purge stops every running server before deleting the data directory', async () => {
    const sb = sandbox()
    const server = startServer(sb, 0)
    await waitForSlots(sb, [0])
    const purge = cli(sb, ['uninstall', '--purge'])
    expect(purge.status, purge.stderr).toBe(0)
    expect(purge.stdout).toContain('Purged')
    expect(fs.existsSync(sb.dataDir)).toBe(false)
    // Without the stop the server outlives the purge by up to KEY_CHECK_MS (2s), waiting to notice its key file is gone.
    expect(await exitsWithin(server.exit, 5000)).toBe(0)
  })
})

describe('through a real shim', () => {
  function latestHookRow(sb: Sandbox): { seq: number; kind: string; harness: string; duration_ms: number | null } | undefined {
    const db = new Database(path.join(sb.dataDir, 'global.db'))
    try {
      return db.prepare("SELECT rowid AS seq, kind, harness, duration_ms FROM stats WHERE kind LIKE 'hook:%' ORDER BY rowid DESC LIMIT 1").get() as
        | { seq: number; kind: string; harness: string; duration_ms: number | null }
        | undefined
    } finally {
      db.close()
    }
  }

  function runShim(sb: Sandbox, shim: string, event: string, payload: string, env: Env = {}): Run {
    const start = performance.now()
    const res = spawnSync(process.execPath, [shim, event, sb.bundle], { cwd: sb.proj, env: { ...sb.env, ...env }, input: payload, encoding: 'utf8', timeout: 30_000 })
    return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', ms: performance.now() - start }
  }

  it('Claude Code and Copilot CLI shims are served by an autostarted server with cold-identical output, and each call is recorded with its own harness and a duration inside its wall time', async () => {
    const sb = sandbox()
    const claude = path.join(sb.base, 'claude-shim.cjs')
    const copilot = path.join(sb.base, 'copilot-shim.cjs')
    fs.writeFileSync(claude, CLAUDECODE_HOOK_SCRIPT)
    fs.writeFileSync(copilot, COPILOT_CLI_HOOK_SCRIPT)
    // Payload shapes are each harness's own (Claude Code tool_name/tool_input; Copilot CLI toolName/toolArgs with its native `bash` tool, src/copilot_tool_names.ts), FORMAT-DERIVED from the shapes tests/bridges/inprocess.test.ts drives these shims with.
    const claudePayload = (session: string): string => bashDenyPayload(`hs-shim-claude-${session}`)
    const copilotPayload = (session: string): string =>
      JSON.stringify({ sessionId: `hs-shim-copilot-${session}`, workingDirectory: sb.proj, toolName: 'bash', toolArgs: { command: 'find . -name "*.ts" | xargs grep -l TokenGoat' } })

    const claudeCold = runShim(sb, claude, 'pre_tool_use', claudePayload('cold'), { TOKEN_GOAT_HOOK_SERVER: '0' })
    const copilotCold = runShim(sb, copilot, 'preToolUse', copilotPayload('cold'), { TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(claudeCold.stdout).toContain('xargs grep -l')
    expect(copilotCold.stdout).toContain('xargs grep -l')
    expect(statuses(sb)).toEqual([])

    // The first server call comes from the Copilot shim, so the server that starts inherits TOKEN_GOAT_HARNESS_OVERRIDE=copilot_cli: a served Claude Code call can only be recorded as claudecode if the caller's environment is the one in force.
    const first = runShim(sb, copilot, 'preToolUse', copilotPayload('first'))
    expectSameRun(first, copilotCold)
    await waitForSlots(sb, [0])

    const claudeServed = runShim(sb, claude, 'pre_tool_use', claudePayload('served'))
    expectSameRun(claudeServed, claudeCold)
    await expectServedTotal(sb, 1)
    const claudeRow = latestHookRow(sb)
    expect(claudeRow?.kind).toBe('hook:pre_tool_use')
    expect(claudeRow?.harness).toBe('claudecode')
    expect(claudeRow?.duration_ms).not.toBeNull()
    expect(claudeRow?.duration_ms as number).toBeGreaterThanOrEqual(0)
    expect(claudeRow?.duration_ms as number).toBeLessThanOrEqual(Math.ceil(claudeServed.ms))

    const copilotServed = runShim(sb, copilot, 'preToolUse', copilotPayload('served'))
    expectSameRun(copilotServed, copilotCold)
    await expectServedTotal(sb, 2)
    const copilotRow = latestHookRow(sb)
    expect(copilotRow?.seq).toBeGreaterThan(claudeRow?.seq as number)
    expect(copilotRow?.kind).toBe('hook:pre_tool_use')
    expect(copilotRow?.harness).toBe('copilot_cli')
    expect(copilotRow?.duration_ms as number).toBeGreaterThanOrEqual(0)
    expect(copilotRow?.duration_ms as number).toBeLessThanOrEqual(Math.ceil(copilotServed.ms))
  })
})
