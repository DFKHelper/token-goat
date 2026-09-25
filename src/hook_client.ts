/** Thin client for the resident hook server, and the entry of `dist/token-goat-hook-client.mjs`. A hook shim or the CLI launcher calls in here first. Starting Node and loading token-goat's hook graph costs about 60ms on every call before any handler runs; a server that loaded it once answers in the time the handler takes. Everything here is built to degrade to the path that ran before it existed: any answer of `undefined`/`false` means "nothing was dispatched, run it yourself", which covers a server that is absent, busy, stale, disabled, unauthenticated or slow to answer. Only a failure after the request was handed over is reported differently, because running a hook twice is worse than failing it open. Absent servers are started in the background, rate-limited per slot, and the call that noticed falls back rather than waiting for one to come up. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'

import { envBool } from './env.js'
import {
  configStamp,
  endpointFor,
  envSnapshot,
  launcherPath,
  mac,
  macMatches,
  markerAgeMs,
  nonce,
  PROTOCOL_VERSION,
  readFrames,
  readMarker,
  readServerKey,
  SERVER_SLOTS,
  touchMarker,
  writeFrame,
  type ServerReply,
  type ServerRequest,
  type ServerStatus,
} from './hook_ipc.js'

/** How long a server gets to answer the opening challenge. One that cannot is busy in synchronous work for another caller, and the next slot, or the caller's own fallback, is cheaper than queueing behind it. */
const HANDSHAKE_TIMEOUT_MS = 150
/** Total time spent finding a server before giving up and falling back; a fallback costs about 100ms, so waiting longer than this never pays. */
const FIND_BUDGET_MS = 300
/** A dispatched request that has not answered by now is failed open. Matches the hook relay's own queue wait. */
const RESPONSE_TIMEOUT_MS = 120_000
const SPAWN_RETRY_MS = 30_000
const DISABLED_MARKER_TTL_MS = 10 * 60_000

type Outcome = { kind: 'served'; reply: ServerReply } | { kind: 'absent' } | { kind: 'busy' } | { kind: 'stale' } | { kind: 'refused' } | { kind: 'lost' }

/** One attempt against one slot. Resolves exactly once. */
function attempt(slot: number, key: Buffer, request: ServerRequest, handshakeMs: number, dir?: string): Promise<Outcome> {
  return new Promise((resolve) => {
    const socket = net.connect(endpointFor(slot, dir))
    const nc = nonce()
    let dispatched = false
    let settled = false
    const finish = (outcome: Outcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(outcome)
    }
    let timer = setTimeout(() => finish({ kind: 'busy' }), handshakeMs)
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (dispatched) finish({ kind: 'lost' })
      else finish({ kind: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'absent' : 'refused' })
    })
    socket.on('close', () => finish({ kind: dispatched ? 'lost' : 'refused' }))
    socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc }))
    let ns = ''
    readFrames(
      socket,
      (msg) => {
        if (msg['t'] === 'busy') return finish({ kind: 'busy' })
        if (msg['t'] === 'stale') return finish({ kind: 'stale' })
        if (msg['t'] === 'challenge' && !dispatched) {
          ns = typeof msg['ns'] === 'string' ? msg['ns'] : ''
          // The server proves it holds the key before anything about the request leaves this process.
          if (ns === '' || msg['v'] !== PROTOCOL_VERSION || !macMatches(mac(key, 'S', nc, ns), msg['mac'])) return finish({ kind: 'refused' })
          const body = JSON.stringify(request)
          dispatched = true
          clearTimeout(timer)
          timer = setTimeout(() => finish({ kind: 'lost' }), RESPONSE_TIMEOUT_MS)
          writeFrame(socket, { t: 'req', mac: mac(key, 'C', nc, ns, body), body })
          return
        }
        if (msg['t'] === 'res' && dispatched) {
          const body = msg['body']
          if (typeof body !== 'string' || !macMatches(mac(key, 'R', nc, ns, body), msg['mac'])) return finish({ kind: 'lost' })
          try {
            return finish({ kind: 'served', reply: JSON.parse(body) as ServerReply })
          } catch {
            return finish({ kind: 'lost' })
          }
        }
        finish({ kind: dispatched ? 'lost' : 'refused' })
      },
      () => finish({ kind: dispatched ? 'lost' : 'refused' }),
    )
  })
}

/** Start the server for `slot` in the background unless one was started recently, the config has turned it off, or there is no built launcher to start it from. */
function startServer(slot: number): void {
  const launcher = launcherPath()
  // A server that found itself turned off leaves a marker naming the config it read; editing the config, or waiting out the marker, lets the next call try again.
  const disabled = markerAgeMs('disabled') < DISABLED_MARKER_TTL_MS && readMarker('disabled') === configStamp()
  if (disabled || markerAgeMs(`spawn-${slot}`) < SPAWN_RETRY_MS || !fs.existsSync(launcher)) return
  touchMarker(`spawn-${slot}`)
  try {
    spawn(process.execPath, [launcher, 'hook-server', 'run', '--slot', String(slot)], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch {
    // a server that cannot start leaves every caller on the path it used before
  }
}

/** Whether this process may use the server at all. */
export function serverEnabled(): boolean {
  return envBool('TOKEN_GOAT_HOOK_SERVER', true)
}

/** Send `request` to the first free server. `undefined` means nothing was dispatched and the caller should do the work itself; `'lost'` means a server took the request and then failed to answer. */
export async function callServer(request: ServerRequest, opts: { autostart?: boolean; handshakeMs?: number } = {}): Promise<ServerReply | 'lost' | undefined> {
  if (!serverEnabled()) return undefined
  const autostart = opts.autostart !== false
  const key = readServerKey()
  if (key === undefined) {
    if (autostart) startServer(0)
    return undefined
  }
  const deadline = Date.now() + FIND_BUDGET_MS
  for (let slot = 0; slot < SERVER_SLOTS && Date.now() < deadline; slot++) {
    const outcome = await attempt(slot, key, request, opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS)
    if (outcome.kind === 'served') return outcome.reply
    if (outcome.kind === 'lost') return 'lost'
    if (outcome.kind === 'absent') {
      if (autostart) startServer(slot)
      return undefined
    }
    if (outcome.kind === 'stale') return undefined
  }
  return undefined
}

/** Run hook `event` on a resident server. Returns the hook's stdout, `'{}'` when a dispatched request failed (fail open, never run twice), or `undefined` to fall back. */
export async function relayViaServer(event: string, input: string | object, harnessWaitMs?: number): Promise<string | undefined> {
  try {
    const request: ServerRequest = {
      kind: 'hook',
      event,
      input: typeof input === 'string' ? input : JSON.stringify(input),
      elapsedMs: performance.now(),
      env: envSnapshot(),
      cwd: process.cwd(),
    }
    if (harnessWaitMs !== undefined) request.harnessWaitMs = harnessWaitMs
    const reply = await callServer(request)
    if (reply === undefined) return undefined
    if (reply === 'lost' || !reply.ok || !('stdout' in reply)) return '{}'
    return reply.stdout
  } catch {
    return undefined
  }
}

/** Read-only commands a server may answer on the CLI's behalf. Each reads its arguments and the index, writes to stdout, and never reads stdin, so running one in a warm process is indistinguishable from running it in a fresh one, and re-running one after a lost reply is harmless. */
export const WARM_CLI_COMMANDS: ReadonlySet<string> = new Set([
  'answer',
  'brief',
  'changed',
  'exports',
  'imports',
  'map',
  'outline',
  'read',
  'refs',
  'section',
  'semantic',
  'skeleton',
  'symbol',
])

/** Whether `argv` (a full `process.argv`) is a CLI call a server may answer: an allowlisted command, output going to a pipe rather than a terminal (the only case the caller is an agent and the startup cost is paid per call), and no argument that could mean stdin. */
export function warmCliEligible(argv: readonly string[]): boolean {
  const command = argv[2]
  if (command === undefined || !WARM_CLI_COMMANDS.has(command) || process.stdout.isTTY === true) return false
  return !argv.slice(3).some((a) => a === '-' || a === '--stdin' || a === '--help' || a === '-h')
}

/** Answer a CLI invocation from a resident server. Returns `false` to run it locally. */
export async function runCliViaServer(argv: readonly string[]): Promise<boolean> {
  if (!warmCliEligible(argv)) return false
  try {
    const reply = await callServer({ kind: 'cli', argv: argv.slice(2), env: envSnapshot(), cwd: process.cwd() })
    if (reply === undefined || reply === 'lost' || !reply.ok || !('stdout' in reply)) return false
    if (reply.stdout !== '') process.stdout.write(reply.stdout)
    if (reply.stderr !== undefined && reply.stderr !== '') process.stderr.write(reply.stderr)
    process.exitCode = reply.status ?? 0
    return true
  } catch {
    return false
  }
}

/** Every running server's own report. A server running superseded code retires on being asked instead of answering, so it never shows up here. */
export async function serverStatuses(dir?: string): Promise<ServerStatus[]> {
  return (await queryServers('status', dir)).flatMap(({ reply }) => (reply.ok && 'info' in reply ? [reply.info] : []))
}

/** Ask every slot for its status, or tell every slot to stop. Never starts a server. Returns one entry per slot that answered. */
export async function queryServers(kind: 'status' | 'stop', dir?: string): Promise<Array<{ slot: number; reply: ServerReply }>> {
  const key = readServerKey(dir)
  if (key === undefined) return []
  const answered: Array<{ slot: number; reply: ServerReply }> = []
  for (let slot = 0; slot < SERVER_SLOTS; slot++) {
    const outcome = await attempt(slot, key, { kind }, 2000, dir)
    if (outcome.kind === 'served') answered.push({ slot, reply: outcome.reply })
  }
  return answered
}
