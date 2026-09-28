/** The native hook client (native/tg-hook) end to end: what it relays, when it falls back to the command after `--`, and what it prints when a request it handed over is never answered. The rule it keeps is src/hook_client.ts's: a call is run by the server or by the wrapped command, never both and never neither, and only a failure after the request was handed over prints the harness's no-op instead. Most cases talk to fake servers listening on the endpoints the client computes for a fake bundle directory, so each can misbehave on purpose; the rest use a real `hook-server run` from the built bundle, started by the wrapped Node command's own autostart. Every fake frame is built with the MAC functions of src/hook_ipc.ts, the server's own definitions. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dataDirForHome } from '../src/constants.js'
import {
  challengeMacV2,
  doneFrameMac,
  endpointFor,
  HARNESS_PROTOCOL_VERSION,
  macMatches,
  markerPath,
  MAX_FRAME_BYTES,
  nonce,
  outFrameMac,
  readFrames,
  requestMacV2,
  serverKeyPath,
  writeFrame,
} from '../src/hook_ipc.js'
import { BUNDLE } from './helpers/bundle.js'
import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'
import { slotStatus, waitIdle } from './helpers/hook_server_probe.js'
import { buildNative } from './helpers/native_bin.js'

type Env = Record<string, string>
type Frame = Record<string, unknown>

const WIN = process.platform === 'win32'
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const sha256 = (b: Buffer): string => crypto.createHash('sha256').update(b).digest('hex')

/** The sandbox every call runs in: data, config and harness homes under one scratch directory, so nothing reaches the real ledger or any real harness setting. */
interface Sandbox {
  base: string
  proj: string
  dataDir: string
  tmp: string
  env: Env
  key: Buffer
  fakeEntry: string
  fakeBundle: string
  fb: string
  counter: string
}

let sb: Sandbox
let bin = ''

function sandboxEnv(base: string, dataDir: string, tmp: string): Env {
  const env: Env = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of HARNESS_DETECTION_ENV_KEYS) delete env[k]
  const envRoot = WIN ? path.dirname(path.dirname(dataDir)) : path.dirname(dataDir)
  return {
    ...env,
    HOME: base,
    USERPROFILE: base,
    CLAUDE_CONFIG_DIR: path.join(base, '.claude'),
    CODEX_HOME: path.join(base, '.codex'),
    KIMI_CODE_HOME: path.join(base, '.kimi-code'),
    COPILOT_HOME: path.join(base, '.copilot'),
    LOCALAPPDATA: envRoot,
    XDG_DATA_HOME: envRoot,
    APPDATA: path.join(base, 'AppData', 'Roaming'),
    XDG_CONFIG_HOME: path.join(base, '.config'),
    TOKEN_GOAT_HOME: path.join(base, 'tg-home'),
    // The project lives beside this temp directory, not under it: the edit handler keeps anything under the system temp directory out of the index queue, which the async-detach case below checks for.
    TEMP: tmp,
    TMP: tmp,
    TMPDIR: tmp,
    TOKEN_GOAT_HOOK_SERVER: '1',
  }
}

/** The wrapped command the fallback cases run: it counts its runs in a file, then prints the length and hash of the stdin it got (`echo`), dies of SIGTERM after that (`signal`), or records its pid and never exits (`hang`). */
const FALLBACK_SCRIPT = [
  "const fs = require('node:fs')",
  "const crypto = require('node:crypto')",
  'const [counter, code, mode, pidFile] = process.argv.slice(2)',
  "fs.appendFileSync(counter, 'x')",
  "if (mode === 'hang') {",
  '  fs.writeFileSync(pidFile, String(process.pid))',
  '  setInterval(() => {}, 1000)',
  '} else {',
  '  const chunks = []',
  "  process.stdin.on('data', (c) => chunks.push(c))",
  "  process.stdin.on('end', () => {",
  '    const b = Buffer.concat(chunks)',
  "    process.stdout.write('FALLBACK ' + b.length + ' ' + crypto.createHash('sha256').update(b).digest('hex'))",
  "    if (mode === 'signal') process.kill(process.pid, 'SIGTERM')",
  '    else process.exitCode = Number(code)',
  '  })',
  '}',
  '',
].join('\n')

function fbTail(code = 0, mode = 'echo', pidFile = ''): string[] {
  return [process.execPath, sb.fb, sb.counter, String(code), mode, pidFile]
}

function fallbackRuns(): number {
  try {
    return fs.readFileSync(sb.counter).length
  } catch {
    return 0
  }
}

const fallbackOutput = (input: Buffer): string => `FALLBACK ${input.length} ${sha256(input)}`

function cli(args: string[], env: Env = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], { cwd: sb.base, env: { ...sb.env, ...env }, encoding: 'utf8', timeout: 120_000 })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

interface Run {
  stdout: Buffer
  stderr: string
  exit: number | null
  signal: NodeJS.Signals | null
  /** Milliseconds from spawn to the first stdout chunk, and to exit. */
  firstChunkMs?: number
  firstChunk?: Buffer
  exitMs: number
  /** Whether stdout or stderr was still open 3 s after the client exited: some process it left behind holds the harness's pipe, and a harness reading to end of output would wait for that process rather than the hook. */
  heldOpen: boolean
}

function runNative(args: readonly string[], input: Buffer | string, env: Env = {}, opts: { cwd?: string; onSpawn?: (child: ChildProcess) => void } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(bin, args, { cwd: opts.cwd ?? sb.proj, env: { ...sb.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    let stderr = ''
    let firstChunkMs: number | undefined
    let exitMs = NaN
    let heldOpen = false
    let settled = false
    child.stdout.on('data', (d: Buffer) => {
      if (firstChunkMs === undefined) firstChunkMs = performance.now() - started
      out.push(d)
    })
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('exit', () => {
      exitMs = performance.now() - started
      setTimeout(() => {
        if (settled) return
        heldOpen = true
        child.stdout.destroy()
        child.stderr.destroy()
      }, 3000).unref()
    })
    child.on('close', (exit, signal) => {
      settled = true
      resolve({ stdout: Buffer.concat(out), stderr, exit, signal, firstChunkMs, firstChunk: out[0], exitMs, heldOpen })
    })
    // A client that stopped reading stdin early would fail this write with EPIPE; that is not what these cases test.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
    opts.onSpawn?.(child)
  })
}

/** The flags an installer writes for a claudecode `pre_tool_use` call, against the fake bundle unless `entry` says otherwise. */
function hookArgs(tail: readonly string[], opts: { event?: string; entry?: string; extra?: string[] } = {}): string[] {
  return ['--harness', 'claudecode', '--event', opts.event ?? 'pre_tool_use', '--entry', opts.entry ?? sb.fakeEntry, '--script-dir', sb.base, ...(opts.extra ?? []), '--', ...tail]
}

// ---------- fake servers ----------

/** One accepted connection, its frames queued for a script to take in order. */
class FakeConn {
  private readonly queue: Frame[] = []
  private readonly waiters: Array<(f: Frame | undefined) => void> = []
  private ended = false

  constructor(readonly socket: net.Socket) {
    readFrames(
      socket,
      (m) => this.push(m),
      () => this.end(),
    )
    socket.on('close', () => this.end())
    socket.on('error', () => this.end())
  }

  private push(m: Frame): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(m)
    else this.queue.push(m)
  }

  private end(): void {
    this.ended = true
    for (const waiter of this.waiters.splice(0)) waiter(undefined)
  }

  next(): Promise<Frame | undefined> {
    const f = this.queue.shift()
    if (f !== undefined) return Promise.resolve(f)
    if (this.ended) return Promise.resolve(undefined)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  send(m: unknown): void {
    writeFrame(this.socket, m)
  }
}

interface Fake {
  slot: number
  hellos: number
  /** Each request frame received, with whether its MAC verified. */
  requests: Array<{ frame: Frame; verified: boolean; body: Record<string, unknown> }>
  server: net.Server
  sockets: Set<net.Socket>
}

interface Session {
  nc: string
  ns: string
  h: string
}

type Script = (c: FakeConn, f: Fake) => Promise<void>

/** The endpoint a client in the sandbox computes for `slot` of `bundle`. A long Unix socket path moves under the temp directory, which is the sandbox's, so it is computed with the sandbox's TMPDIR. CAPTURE: on CI's test-macos job for f285eff0 the real-server cases computed it with this process's TMPDIR, polled `/var/folders/.../T/tg-run-WZTo44/token-goat-501/11df605e7cdbd677-0.sock`, and never saw the server the wrapped command started under the sandbox's; Linux's shorter data directory keeps the socket there, so TMPDIR never entered it. */
function sandboxEndpoint(slot: number, bundle: string): string {
  const saved = process.env['TMPDIR']
  process.env['TMPDIR'] = sb.tmp
  try {
    return endpointFor(slot, sb.dataDir, bundle)
  } finally {
    if (saved === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = saved
  }
}

async function startFake(slot: number, script: Script): Promise<Fake> {
  const fake: Fake = { slot, hellos: 0, requests: [], server: net.createServer(), sockets: new Set() }
  fake.server.on('connection', (socket) => {
    fake.sockets.add(socket)
    socket.on('close', () => fake.sockets.delete(socket))
    socket.on('error', () => undefined)
    script(new FakeConn(socket), fake).catch(() => socket.destroy())
  })
  const endpoint = sandboxEndpoint(slot, sb.fakeBundle)
  if (!WIN) fs.rmSync(endpoint, { force: true })
  await new Promise<void>((resolve, reject) => {
    fake.server.once('error', reject)
    fake.server.listen(endpoint, resolve)
  })
  return fake
}

async function withFakes(scripts: ReadonlyArray<Script | undefined>, fn: (fakes: Fake[]) => Promise<void>): Promise<void> {
  const fakes: Fake[] = []
  try {
    for (let slot = 0; slot < scripts.length; slot++) {
      const script = scripts[slot]
      if (script !== undefined) fakes[slot] = await startFake(slot, script)
    }
    await fn(fakes)
  } finally {
    for (const fake of fakes) {
      if (fake === undefined) continue
      for (const s of fake.sockets) s.destroy()
      await new Promise<void>((resolve) => fake.server.close(() => resolve()))
    }
  }
}

const NOOP = 'NOOP\n'
const NOOPS: Array<[string, string]> = [['post_tool_use', 'POST-NOOP\n']]

async function hello(c: FakeConn, f: Fake): Promise<{ nc: string; h: string } | undefined> {
  const m = await c.next()
  if (m?.['t'] !== 'hello') return undefined
  f.hellos++
  return { nc: String(m['nc']), h: String(m['h']) }
}

/** Takes the hello and answers a v2 challenge signed with `signKey`. */
async function handshake(c: FakeConn, f: Fake, signKey: Buffer = sb.key): Promise<Session | undefined> {
  const h = await hello(c, f)
  if (h === undefined) return undefined
  const ns = nonce()
  c.send({ t: 'challenge', v: HARNESS_PROTOCOL_VERSION, ns, noop: NOOP, noops: NOOPS, mac: challengeMacV2(signKey, h.nc, ns, h.h, NOOP, NOOPS) })
  return { ...h, ns }
}

/** Takes the request frame; `true` when it came and its MAC verified. */
async function request(c: FakeConn, f: Fake, s: Session): Promise<boolean> {
  const m = await c.next()
  if (m?.['t'] !== 'req') return false
  const body = String(m['body'])
  const verified = macMatches(requestMacV2(sb.key, s.nc, s.ns, s.h, body), m['mac'])
  f.requests.push({ frame: m, verified, body: JSON.parse(body) as Record<string, unknown> })
  return verified
}

const outFrame = (s: Session, seq: number, data: string, signKey: Buffer = sb.key): Frame => ({ t: 'out', seq, data, mac: outFrameMac(signKey, s.nc, s.ns, seq, data) })
const doneFrame = (s: Session, stdout: string, exit: number, n: number, signKey: Buffer = sb.key): Frame => ({ t: 'done', stdout, exit, n, mac: doneFrameMac(signKey, s.nc, s.ns, stdout, exit, n) })

/** A fake that serves every request with `frames`, sent in order with `gapMs` between them. */
function serving(frames: (s: Session) => Frame[], gapMs = 0): Script {
  return async (c, f) => {
    const s = await handshake(c, f)
    if (s === undefined || !(await request(c, f, s))) return
    for (const [i, frame] of frames(s).entries()) {
      if (i > 0 && gapMs > 0) await sleep(gapMs)
      c.send(frame)
    }
  }
}

const SERVED = serving((s) => [doneFrame(s, 'SERVED\n', 0, 0)])

/** A fake that only counts hellos and answers nothing, for cases where the client must not have connected at all. */
const SILENT: Script = async (c, f) => {
  await hello(c, f)
}

// ---------- setup ----------

beforeAll(() => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-client-')))
  const dataDir = dataDirForHome(base)
  // The data directory's socket path is too long here, so every endpoint moves to `token-goat-<uid>` under this temp directory, which has to be short for that path to fit the ~104-byte Unix socket limit. Under the run's own temp root it is not on macOS: CAPTURE, CI's test-macos job on 6593e34f bound `/private/var/folders/36/.../T/tg-run-wJAHtZ/tg-native-client-d7NKZn/tmp/token-goat-501/c78dd622d3d3e0ab-0.sock`, 137 bytes, and 31 cases failed with EADDRINUSE. A real macOS temp directory leaves about 87.
  const tmp = WIN ? path.join(base, 'tmp') : fs.realpathSync.native(fs.mkdtempSync('/tmp/tgn-'))
  const proj = path.join(base, 'proj')
  const fakeBundle = path.join(base, 'fake-dist')
  for (const d of [dataDir, tmp, path.join(proj, 'src'), fakeBundle]) fs.mkdirSync(d, { recursive: true })
  // HAND-DERIVED project file the async-detach payload names.
  fs.writeFileSync(path.join(proj, 'src', 'app.ts'), 'export function app(): number {\n  return 1\n}\n')
  const key = crypto.randomBytes(32)
  fs.writeFileSync(serverKeyPath(dataDir), key, { mode: 0o600 })
  const fb = path.join(base, 'fallback.cjs')
  fs.writeFileSync(fb, FALLBACK_SCRIPT)
  sb = { base, proj, dataDir, tmp, env: sandboxEnv(base, dataDir, tmp), key, fakeEntry: path.join(fakeBundle, 'token-goat.mjs'), fakeBundle: fs.realpathSync.native(fakeBundle), fb, counter: path.join(base, 'fallback-runs') }
  bin = buildNative()
}, 900_000)

afterAll(async () => {
  // The real server was started by a wrapped Node command's autostart, so only the stop query reaches it.
  cli(['hook-server', 'stop'])
  const endpoint = sandboxEndpoint(0, fs.realpathSync.native(path.dirname(BUNDLE)))
  const deadline = Date.now() + 10_000
  while ((await slotStatus(endpoint, sb.key)) !== undefined && Date.now() < deadline) await sleep(100)
  fs.rmSync(sb.base, { recursive: true, force: true })
  fs.rmSync(sb.tmp, { recursive: true, force: true })
}, 30_000)

// ---------- the real server ----------

/** HAND-DERIVED: the Bash redirect tests/hook_server.test.ts uses (bashDenyPayload), blocked by the claudecode pre_tool_use handler; each call has its own session, since a repeat in one session gets a shorter refusal. */
const redirectPayload = (sid: string): string => JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'find . -name "*.ts" | xargs grep -l TokenGoat' }, session_id: sid })

/** A command after `--` that must never run: reaching it means the client fell back. */
const TRIPWIRE = [process.execPath, '-e', 'process.stdout.write("TRIPWIRE");process.exit(99)']

describe('against a real hook server', () => {
  let shim = ''
  let entry = ''
  let endpoint = ''

  beforeAll(() => {
    const res = cli(['install'])
    expect(res.status, res.stderr).toBe(0)
    // FORMAT-DERIVED from the settings.json the built installer writes here: an `args` array of shim, event, entry, or on a platform that writes one command string, the same three quoted.
    const settings = fs.readFileSync(path.join(sb.base, '.claude', 'settings.json'), 'utf8')
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        if (value.length === 3 && value[1] === 'pre_tool_use' && typeof value[0] === 'string' && value[0].endsWith('token-goat-shim.cjs')) [shim, , entry] = value as string[]
        else value.forEach(walk)
      } else if (typeof value === 'string') {
        const m = /["']([^"']*token-goat-shim\.cjs)["']\s+"?pre_tool_use"?\s+["']([^"']+)["']/.exec(value)
        if (m !== null) [shim, entry] = [m[1] as string, m[2] as string]
      } else if (value !== null && typeof value === 'object') Object.values(value).forEach(walk)
    }
    walk(JSON.parse(settings))
    expect(fs.existsSync(shim), `no pre_tool_use shim in ${settings}`).toBe(true)
    endpoint = sandboxEndpoint(0, fs.realpathSync.native(path.dirname(BUNDLE)))
  }, 120_000)

  it('with no server, the wrapped command runs and starts one, and the next call is served by it', async () => {
    expect(await slotStatus(endpoint, sb.key)).toBeUndefined()
    const wired = [process.execPath, shim, 'pre_tool_use', entry]
    const first = await runNative(hookArgs(wired, { entry }), redirectPayload('absent-1'))
    expect(first.exit, first.stderr).toBe(0)
    expect(first.stdout.toString('utf8')).toMatch(/^\{"decision":"block","reason":"\[tg\] /)
    // The server the wrapped command started must not hold this client's stdout: a Windows child inherits every inheritable handle, not only the three it is given.
    expect(first.heldOpen).toBe(false)
    const deadline = Date.now() + 30_000
    while ((await slotStatus(endpoint, sb.key)) === undefined) {
      if (Date.now() > deadline) throw new Error('the wrapped command did not start a server')
      await sleep(100)
    }
    await waitIdle(endpoint)
    const before = (await slotStatus(endpoint, sb.key))?.served ?? NaN
    const second = await runNative(hookArgs(TRIPWIRE, { entry }), redirectPayload('absent-2'))
    await waitIdle(endpoint)
    const after = (await slotStatus(endpoint, sb.key))?.served
    expect(second.exit, second.stderr).toBe(0)
    expect(second.stdout.toString('utf8')).toMatch(/^\{"decision":"block","reason":"\[tg\] /)
    expect(after).toBe(before + 1)
  }, 120_000)

  it('a harness the server does not know is refused and run by the wrapped command, not the server', async () => {
    await waitIdle(endpoint)
    const before = (await slotStatus(endpoint, sb.key))?.served
    const runs = fallbackRuns()
    const input = Buffer.from(redirectPayload('refused'))
    const res = await runNative(['--harness', 'nosuch', '--event', 'pre_tool_use', '--entry', entry, '--', ...fbTail()], input)
    await waitIdle(endpoint)
    expect(res.stdout.toString('utf8')).toBe(fallbackOutput(input))
    expect(fallbackRuns()).toBe(runs + 1)
    expect((await slotStatus(endpoint, sb.key))?.served).toBe(before)
  })

  it('an async-detached call prints its early line and its after-reply work still lands', async () => {
    await waitIdle(endpoint)
    const before = (await slotStatus(endpoint, sb.key))?.served ?? NaN
    const target = path.join(sb.proj, 'src', 'app.ts')
    // FORMAT-DERIVED from tests/fixtures/harness_hook_payloads.ts, 'Write of a .ts file (async detach)' (Claude Code hooks reference).
    const payload = JSON.stringify({ session_id: 'detach-real', transcript_path: path.join(sb.proj, 't.jsonl'), cwd: sb.proj, permission_mode: 'default', hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: target, content: 'file content' }, tool_response: { filePath: target, type: 'create' }, tool_use_id: 'toolu_01ABC128', duration_ms: 12 })
    const queue = path.join(sb.dataDir, 'queue', 'dirty.txt')
    const queued = (): boolean => {
      try {
        return fs.readFileSync(queue, 'utf8').split(/\r?\n/).some((line) => line.toLowerCase().endsWith(path.join('src', 'app.ts').toLowerCase()) || line.toLowerCase().endsWith('src/app.ts'))
      } catch {
        return false
      }
    }
    expect(queued()).toBe(false)
    const res = await runNative(hookArgs(TRIPWIRE, { entry, event: 'post_tool_use' }), payload)
    expect(res.exit, res.stderr).toBe(0)
    expect(res.stdout.toString('utf8')).toMatch(/^\{"async":true\}\n/)
    const deadline = Date.now() + 15_000
    while (!queued() && Date.now() < deadline) await sleep(50)
    expect(queued(), `nothing queued in ${queue}`).toBe(true)
    await waitIdle(endpoint)
    expect((await slotStatus(endpoint, sb.key))?.served).toBe(before + 1)
  }, 60_000)
})

// ---------- fake servers: served ----------

describe('served by a fake server', () => {
  it('prints the out frames then the done stdout, exits with the done code, and sends a request the server can verify', async () => {
    await withFakes([serving((s) => [outFrame(s, 0, 'EARLY\n'), doneFrame(s, 'LATE\n', 2, 1)])], async ([f]) => {
      const runs = fallbackRuns()
      const input = '{"tool_name":"Bash","ok":"\u00e9\u65e5"}'
      const res = await runNative(hookArgs(fbTail()), input, { TG_PROBE: 'probe \u00e9\u65e5' })
      expect(res.stdout.toString('utf8')).toBe('EARLY\nLATE\n')
      expect(res.exit).toBe(2)
      expect(fallbackRuns()).toBe(runs)
      expect(f?.requests.map((r) => r.verified)).toEqual([true])
      const body = f?.requests[0]?.body ?? {}
      expect(body).toMatchObject({ kind: 'hook', harness: 'claudecode', event: 'pre_tool_use', input, cwd: sb.proj, scriptDir: sb.base })
      expect((body['env'] as Env)['TG_PROBE']).toBe('probe \u00e9\u65e5')
      expect(typeof body['elapsedMs']).toBe('number')
      expect(body['elapsedMs'] as number).toBeGreaterThanOrEqual(0)
      expect(body['elapsedMs'] as number).toBeLessThan(10_000)
    })
  })

  it('streams the early frame before the server has finished (async detach)', async () => {
    await withFakes([serving((s) => [outFrame(s, 0, 'EARLY\n'), doneFrame(s, '', 0, 1)], 400)], async () => {
      const res = await runNative(hookArgs(fbTail()), '{}')
      expect(res.stdout.toString('utf8')).toBe('EARLY\n')
      expect(res.firstChunk?.toString('utf8')).toBe('EARLY\n')
      expect(res.exitMs - (res.firstChunkMs ?? Infinity)).toBeGreaterThanOrEqual(250)
    })
  })

  it('tries the next slot when one is busy, before or after the request', async () => {
    const busyAtHello: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.send({ t: 'busy' })
    }
    const busyAfterRequest: Script = async (c, f) => {
      const s = await handshake(c, f)
      if (s !== undefined && (await request(c, f, s))) c.send({ t: 'busy' })
    }
    await withFakes([busyAtHello, busyAfterRequest, SERVED], async ([a, b, c]) => {
      const runs = fallbackRuns()
      const res = await runNative(hookArgs(fbTail()), '{}')
      expect(res.stdout.toString('utf8')).toBe('SERVED\n')
      expect([a?.hellos, b?.hellos, c?.hellos]).toEqual([1, 1, 1])
      expect(fallbackRuns()).toBe(runs)
    })
  })

  it('a server that does not answer the hello in time counts as busy', async () => {
    await withFakes([SILENT, SERVED], async ([a, b]) => {
      const res = await runNative(hookArgs(fbTail()), '{}')
      expect(res.stdout.toString('utf8')).toBe('SERVED\n')
      expect([a?.hellos, b?.hellos]).toEqual([1, 1])
    })
  })
})

// ---------- fake servers: fallback before dispatch ----------

describe('falls back when nothing was dispatched', () => {
  const expectFallback = async (fakes: ReadonlyArray<Script | undefined>, opts: { input?: Buffer; env?: Env; args?: string[]; hellos?: number[] } = {}): Promise<void> => {
    await withFakes(fakes, async (started) => {
      const runs = fallbackRuns()
      const input = opts.input ?? Buffer.from('{"tool_name":"Bash"}')
      const res = await runNative(opts.args ?? hookArgs(fbTail(5)), input, opts.env)
      expect(res.stdout.toString('utf8')).toBe(fallbackOutput(input))
      expect(res.exit, res.stderr).toBe(5)
      expect(fallbackRuns()).toBe(runs + 1)
      if (opts.hellos !== undefined) expect(started.map((f) => f?.hellos ?? 0)).toEqual(opts.hellos)
      for (const f of started) expect(f?.requests ?? []).toEqual([])
    })
  }

  it('no server listening', async () => {
    await expectFallback([])
  })

  it('every slot busy', async () => {
    const busy: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.send({ t: 'busy' })
    }
    await expectFallback([busy, busy, busy], { hellos: [1, 1, 1] })
  })

  it('a stale server, without trying the other slots', async () => {
    const stale: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.send({ t: 'stale' })
    }
    await expectFallback([stale, SERVED], { hellos: [1, 0] })
  })

  it('a refused hello, without trying the other slots', async () => {
    const refused: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.send({ t: 'refused', reason: 'unknown harness' })
    }
    await expectFallback([refused, SERVED], { hellos: [1, 0] })
  })

  it('a stale answer to the request itself', async () => {
    const staleAfterRequest: Script = async (c, f) => {
      const s = await handshake(c, f)
      if (s !== undefined && (await request(c, f, s))) c.send({ t: 'stale' })
    }
    await withFakes([staleAfterRequest], async ([f]) => {
      const runs = fallbackRuns()
      const input = Buffer.from('{}')
      const res = await runNative(hookArgs(fbTail()), input)
      expect(res.stdout.toString('utf8')).toBe(fallbackOutput(input))
      expect(fallbackRuns()).toBe(runs + 1)
      expect(f?.requests.length).toBe(1)
    })
  })

  it('a challenge signed with another key: nothing about the request is sent', async () => {
    const forged: Script = async (c, f) => {
      const s = await handshake(c, f, crypto.randomBytes(32))
      if (s !== undefined) await request(c, f, s)
    }
    await expectFallback([forged, SERVED], { hellos: [1, 0] })
  })

  it('garbage instead of a challenge', async () => {
    const garbage: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.socket.write(Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from('nope!')]))
    }
    await expectFallback([garbage], { hellos: [1] })
  })

  it('a connection dropped before the request', async () => {
    const drop: Script = async (c, f) => {
      if ((await hello(c, f)) !== undefined) c.socket.destroy()
    }
    await expectFallback([drop], { hellos: [1] })
  })

  it('a disabled marker younger than ten minutes, and not an older one', async () => {
    const marker = markerPath('disabled', sb.dataDir)
    fs.writeFileSync(marker, 'absent')
    try {
      await expectFallback([SILENT], { hellos: [0] })
      const old = new Date(Date.now() - 11 * 60_000)
      fs.utimesSync(marker, old, old)
      await withFakes([SERVED], async () => {
        const res = await runNative(hookArgs(fbTail()), '{}')
        expect(res.stdout.toString('utf8')).toBe('SERVED\n')
      })
    } finally {
      fs.rmSync(marker, { force: true })
    }
  })

  it('no key', async () => {
    const keyPath = serverKeyPath(sb.dataDir)
    fs.renameSync(keyPath, `${keyPath}.away`)
    try {
      await expectFallback([SILENT], { hellos: [0] })
    } finally {
      fs.renameSync(`${keyPath}.away`, keyPath)
    }
  })

  it.skipIf(WIN)('a key other users can read (POSIX mode bits; Windows keeps the key private by the data directory ACL, which the Node client does not check either)', async () => {
    const keyPath = serverKeyPath(sb.dataDir)
    fs.chmodSync(keyPath, 0o644)
    try {
      await expectFallback([SILENT], { hellos: [0] })
    } finally {
      fs.chmodSync(keyPath, 0o600)
    }
  })

  it('TOKEN_GOAT_HOOK_SERVER turned off, in any spelling envBool reads as false', async () => {
    for (const value of ['0', ' Off ', 'FALSE', 'no']) await expectFallback([SILENT], { env: { TOKEN_GOAT_HOOK_SERVER: value }, hellos: [0] })
  })

  it('stdin over the frame limit reaches the wrapped command whole', async () => {
    const input = Buffer.alloc(MAX_FRAME_BYTES + 1, 0x61)
    await expectFallback([SILENT], { input, hellos: [0] })
  }, 120_000)

  it('stdin under the limit whose request frame would be over it', async () => {
    // Every quote doubles in JSON, so 40 MB of them is an 80 MB request: the server would hang up on it before reading it.
    const input = Buffer.alloc(40 * 1024 * 1024, 0x22)
    await expectFallback([serving((s) => [doneFrame(s, 'SERVED\n', 0, 0)])], { input, hellos: [1] })
  }, 120_000)

  it('stdin that is not UTF-8 reaches the wrapped command byte for byte', async () => {
    const input = Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x80, 0x22, 0x7d])
    await expectFallback([SILENT], { input, hellos: [0] })
  })

  it('incomplete or malformed flags run the wrapped command with stdin untouched', async () => {
    const tail = fbTail(5)
    for (const args of [
      ['--harness', 'claudecode', '--event', 'pre_tool_use', '--', ...tail],
      ['--harness', 'claudecode', '--event', 'pre_tool_use', '--entry', sb.fakeEntry, '--response-timeout-ms', 'soon', '--', ...tail],
      ['--harness', 'claudecode', '--event', 'pre_tool_use', '--entry', sb.fakeEntry, '--bogus', 'x', '--', ...tail],
      ['--harness', 'claudecode', '--event', 'pre_tool_use', '--entry', '--', ...tail],
    ]) {
      await expectFallback([SERVED], { args, hellos: [0] })
    }
  })
})

// ---------- fake servers: lost after dispatch ----------

describe('prints the no-op, and never runs the call again, once the request was handed over', () => {
  const expectNoop = async (script: Script, opts: { event?: string; noop?: string; extra?: string[]; prefix?: string } = {}): Promise<Run> => {
    let run: Run | undefined
    await withFakes([script, SERVED], async ([f, next]) => {
      const runs = fallbackRuns()
      run = await runNative(hookArgs(fbTail(5), { event: opts.event, extra: opts.extra }), '{}')
      expect(run.stdout.toString('utf8')).toBe((opts.prefix ?? '') + (opts.noop ?? NOOP))
      expect(run.exit, run.stderr).toBe(0)
      expect(fallbackRuns()).toBe(runs)
      expect(f?.requests.length).toBe(1)
      expect(next?.hellos).toBe(0)
    })
    return run as Run
  }

  // The connection ends after the scripted frames unless `hold` says otherwise, so a client that wrongly accepted a bad frame fails on what it printed rather than waiting out its response timeout.
  const afterRequest =
    (then: (c: FakeConn, s: Session) => Promise<void> | void, hold = false): Script =>
    async (c, f) => {
      const s = await handshake(c, f)
      if (s === undefined || !(await request(c, f, s))) return
      await then(c, s)
      if (!hold) c.socket.end()
    }

  it('connection dropped', async () => {
    await expectNoop(afterRequest((c) => void c.socket.destroy()))
  })

  it("the event's own no-op when the challenge names one", async () => {
    await expectNoop(
      afterRequest((c) => void c.socket.destroy()),
      { event: 'post_tool_use', noop: 'POST-NOOP\n' },
    )
  })

  it('garbage instead of a response', async () => {
    await expectNoop(afterRequest((c) => void c.socket.write(Buffer.concat([Buffer.from([0, 0, 0, 5]), Buffer.from('nope!')]))))
  })

  it('no response within the response timeout', async () => {
    const run = await expectNoop(
      afterRequest(() => undefined, true),
      { extra: ['--response-timeout-ms', '500'] },
    )
    expect(run.exitMs).toBeGreaterThanOrEqual(450)
    expect(run.exitMs).toBeLessThan(10_000)
  })

  it('an out frame with a bad MAC, after a good one already printed', async () => {
    await expectNoop(
      afterRequest((c, s) => {
        c.send(outFrame(s, 0, 'EARLY\n'))
        c.send(outFrame(s, 1, 'FORGED\n', crypto.randomBytes(32)))
      }),
      { prefix: 'EARLY\n' },
    )
  })

  it('an out frame out of sequence', async () => {
    await expectNoop(afterRequest((c, s) => void c.send(outFrame(s, 1, 'SKIPPED\n'))))
  })

  it('a done frame with a bad MAC', async () => {
    await expectNoop(
      afterRequest((c, s) => {
        c.send(outFrame(s, 0, 'EARLY\n'))
        c.send(doneFrame(s, '{"decision":"block"}', 0, 1, crypto.randomBytes(32)))
      }),
      { prefix: 'EARLY\n' },
    )
  })

  it('a done frame that miscounts the out frames', async () => {
    await expectNoop(afterRequest((c, s) => void c.send(doneFrame(s, 'LATE\n', 0, 1))))
  })

  it('a busy answer after an out frame was already sent', async () => {
    await expectNoop(
      afterRequest((c, s) => {
        c.send(outFrame(s, 0, 'EARLY\n'))
        c.send({ t: 'busy' })
      }),
      { prefix: 'EARLY\n' },
    )
  })
})

// ---------- process behaviour ----------

describe('process behaviour', () => {
  it('the environment and working directory it sends are what Node would read', () => {
    const extra: Env = { TG_UNICODE: 'caf\u00e9 \u65e5\u672c \u{1f600}', TG_EMPTY: '' }
    if (WIN) extra['=Z:'] = 'Z:\\'
    const env = { ...sb.env, ...extra }
    const dirs = [sb.proj]
    if (WIN) dirs.push(path.parse(sb.proj).root)
    for (const cwd of dirs) {
      const native = spawnSync(bin, ['--selftest-env'], { cwd, env, encoding: 'utf8' })
      expect(native.status, native.stderr).toBe(0)
      const node = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }))'], { cwd, env, encoding: 'utf8' })
      expect(node.status, node.stderr).toBe(0)
      const n = JSON.parse(node.stdout) as { env: Env; cwd: string }
      const r = JSON.parse(native.stdout) as { env: Env; cwd: string }
      expect(r.cwd).toBe(n.cwd)
      expect(r.env).toEqual(n.env)
      expect(r.env['TG_UNICODE']).toBe(extra['TG_UNICODE'])
      expect(r.env['TG_EMPTY']).toBe('')
    }
  })

  it("passes the wrapped command's exit code through", async () => {
    const res = await runNative(hookArgs(fbTail(7)), '{}', { TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(res.exit).toBe(7)
  })

  it.skipIf(WIN)('dies of the signal the wrapped command died of (POSIX only: Windows has no signal exits)', async () => {
    const res = await runNative(hookArgs(fbTail(0, 'signal')), '{}', { TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(res.signal).toBe('SIGTERM')
    expect(res.exit).toBeNull()
  })

  it('a wrapped command that cannot be started exits 127 with a message', async () => {
    const res = await runNative(hookArgs([path.join(sb.base, 'no-such-program')]), '{}', { TOKEN_GOAT_HOOK_SERVER: '0' })
    expect(res.exit).toBe(127)
    expect(res.stderr).toMatch(/^tg-hook: cannot run /)
  })

  it('usage errors exit 2 without running anything', () => {
    const runs = fallbackRuns()
    for (const args of [[], ['--harness', 'claudecode'], ['--']]) {
      const res = spawnSync(bin, args, { cwd: sb.proj, env: sb.env, input: '{}', encoding: 'utf8' })
      expect(res.status, JSON.stringify(args)).toBe(2)
      expect(res.stderr).toMatch(/usage: tg-hook/)
    }
    expect(fallbackRuns()).toBe(runs)
  })

  it.skipIf(process.platform === 'darwin')('killing the client kills the wrapped command it started (Windows job object, Linux parent-death signal; macOS has neither)', async () => {
    const pidFile = path.join(sb.base, `hang-${Date.now()}.pid`)
    let grandchild = 0
    const alive = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    try {
      await runNative(hookArgs(fbTail(0, 'hang', pidFile)), '{}', { TOKEN_GOAT_HOOK_SERVER: '0' }, {
        onSpawn: (child) => {
          const poll = setInterval(() => {
            if (!fs.existsSync(pidFile)) return
            const text = fs.readFileSync(pidFile, 'utf8')
            if (text === '') return
            grandchild = Number(text)
            clearInterval(poll)
            child.kill()
          }, 20)
          setTimeout(() => clearInterval(poll), 20_000)
        },
      })
      expect(grandchild).toBeGreaterThan(0)
      const deadline = Date.now() + 5000
      while (alive(grandchild) && Date.now() < deadline) await sleep(50)
      expect(alive(grandchild)).toBe(false)
    } finally {
      if (grandchild > 0 && alive(grandchild)) process.kill(grandchild)
    }
  }, 30_000)
})
