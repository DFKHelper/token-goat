/** Thin client for the resident hook server, and the entry of `dist/token-goat-hook-client.mjs`. A hook shim or the CLI launcher calls in here first. Starting Node and loading token-goat's hook graph costs about 60ms on every call before any handler runs; a server that loaded it once answers in the time the handler takes. Everything here is built to degrade to the path that ran before it existed: any answer of `undefined`/`false` means "nothing was dispatched, run it yourself", which covers a server that is absent, busy, stale, disabled, unauthenticated or slow to answer. Only a failure after the request was handed over is reported differently, because running a hook twice is worse than failing it open. Absent servers are started in the background, rate-limited per slot, and the call that noticed falls back rather than waiting for one to come up. */
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'

import { envBool } from './env.js'
import {
  configStamp,
  encodeFrame,
  endpointFor,
  envSnapshot,
  frameFits,
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
/** How long a slot gets to answer the handshake before the next slot is asked beside it. An idle server answers in 1 to 3 ms, so a slot silent this long is in synchronous work, and the caller now waits on it and the next slot at once instead of spending its whole budget on one slot and then the next: two slots each held past the handshake allowance used to use up the budget before the third, possibly idle, was ever asked. */
const HEDGE_MS = 40
/** A dispatched hook request that has not answered by now is failed open. Matches the hook relay's own queue wait. A CLI request has no such limit (see attempt). */
const RESPONSE_TIMEOUT_MS = 120_000
/** How long `status` and `stop` keep asking a slot whose handshake timed out. */
const CONTROL_WAIT_MS = 10_000
const SPAWN_RETRY_MS = 30_000
const DISABLED_MARKER_TTL_MS = 10 * 60_000

type Outcome = { kind: 'served'; reply: ServerReply } | { kind: 'absent' } | { kind: 'busy' } | { kind: 'stale' } | { kind: 'refused' } | { kind: 'oversize' } | { kind: 'lost' }

/** What lets several attempts wait on different slots at once while at most one of them dispatches: `claim` is asked on a verified challenge, with the canceller the attempt registered, and answers whether this attempt may send its request; `onCancel` registers what to run once another attempt has claimed. */
type Race = { claim: (self: () => void) => boolean; onCancel: (cancel: () => void) => void }

/** One attempt against one slot. Resolves exactly once. With `race`, an attempt that loses the claim, or is cancelled before its challenge arrives, hangs up without dispatching and resolves `busy`. */
function attempt(slot: number, key: Buffer, request: ServerRequest, handshakeMs: number, dir?: string, race?: Race): Promise<Outcome> {
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
    const cancel = (): void => {
      if (!dispatched) finish({ kind: 'busy' })
    }
    race?.onCancel(cancel)
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (dispatched) finish({ kind: 'lost' })
      else finish({ kind: e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'absent' : 'refused' })
    })
    socket.on('close', () => finish({ kind: dispatched ? 'lost' : 'refused' }))
    // A status or stop request says so up front, so a server in the middle of another caller's request still takes it rather than answering busy.
    const control = request.kind === 'status' || request.kind === 'stop'
    socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc, ...(control ? { ctl: true } : {}) }))
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
          const frame = encodeFrame({ t: 'req', mac: mac(key, 'C', nc, ns, body), body })
          // The server hangs up on a frame this long before reading any of it, which after dispatch would read as a lost request and fail it open unrun.
          if (!frameFits(frame)) return finish({ kind: 'oversize' })
          // Another slot's server answered first and has the request.
          if (race !== undefined && !race.claim(cancel)) return finish({ kind: 'busy' })
          dispatched = true
          clearTimeout(timer)
          // A CLI command waits for its answer however long it runs. The server cannot abandon a command it has started (the work is synchronous and nothing interrupts it), so giving up here only made the caller run the same command a second time beside it, on the same index, never faster (a 342.8 s `symbol` miss on a large project was 120 s of waiting here and then the whole command again). A server that dies mid-command still closes the connection, which reads as lost below, and the caller still runs it itself.
          if (request.kind !== 'cli') timer = setTimeout(() => finish({ kind: 'lost' }), RESPONSE_TIMEOUT_MS)
          socket.write(frame)
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
    // Started in the temp directory, where the server moves itself anyway (runHookServer), never in the calling hook's directory: on Windows a working directory is an open handle, and until the server's own chdir runs it would hold a throwaway project directory undeletable.
    const child = spawn(process.execPath, [launcher, 'hook-server', 'run', '--slot', String(slot)], { cwd: os.tmpdir(), detached: true, stdio: 'ignore', windowsHide: true })
    // A spawn that fails for want of that directory (TEMP naming one since deleted) reports it as an 'error' event after this returns, which the catch below never sees and which, unheard, would crash the hook that asked.
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // a server that cannot start leaves every caller on the path it used before
  }
}

/** Whether this process may use the server at all. */
export function serverEnabled(): boolean {
  return envBool('TOKEN_GOAT_HOOK_SERVER', true)
}

/** Send `request` to the first free server. `undefined` means nothing was dispatched and the caller should do the work itself; `'lost'` means a server took the request and then failed to answer. Slot 0 is asked first; a slot that has not answered within {@link HEDGE_MS} keeps being waited on while the next slot is asked beside it, and the first server to answer the handshake takes the request. A server in synchronous work answers the handshake the moment that work ends, so waiting on every held slot at once is a bounded wait for whichever frees first, and no slot is newly asked once {@link FIND_BUDGET_MS} has passed. A slot that answers busy or refuses moves the call on to the next slot at once, and an absent slot is started in the background and asked about no further, as before. */
export async function callServer(request: ServerRequest, opts: { autostart?: boolean; handshakeMs?: number } = {}): Promise<ServerReply | 'lost' | undefined> {
  if (!serverEnabled()) return undefined
  const autostart = opts.autostart !== false
  const key = readServerKey()
  if (key === undefined) {
    if (autostart) startServer(0)
    return undefined
  }
  const deadline = Date.now() + FIND_BUDGET_MS
  const handshakeMs = opts.handshakeMs ?? HANDSHAKE_TIMEOUT_MS
  return new Promise((resolve) => {
    let claimed = false
    let settled = false
    // Nothing further is asked once a slot is found absent: that call falls back, as it always has, once the slots already asked have answered.
    let exhausted = false
    let next = 0
    let pending = 0
    let hedge: NodeJS.Timeout | undefined
    const cancels: Array<() => void> = []
    const settle = (value: ServerReply | 'lost' | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(hedge)
      for (const cancel of cancels) cancel()
      resolve(value)
    }
    const race: Race = {
      claim: (self) => {
        if (claimed || settled) return false
        claimed = true
        clearTimeout(hedge)
        for (const cancel of cancels) if (cancel !== self) cancel()
        return true
      },
      onCancel: (cancel) => cancels.push(cancel),
    }
    const askNext = (): void => {
      clearTimeout(hedge)
      if (settled || claimed || exhausted || next >= SERVER_SLOTS || Date.now() >= deadline) {
        if (pending === 0 && !claimed) settle(undefined)
        return
      }
      const slot = next++
      pending++
      // Each slot gets the whole handshake allowance from when it is asked, as it did when slots were asked one after another; asking the next slot at most {@link HEDGE_MS} later is what keeps the total inside the budget.
      void attempt(slot, key, request, handshakeMs, undefined, race).then((outcome) => {
        pending--
        if (outcome.kind === 'served') return settle(outcome.reply)
        if (outcome.kind === 'lost') return settle('lost')
        // The winner settles the call.
        if (claimed) return
        // Every slot would refuse it alike.
        if (outcome.kind === 'stale' || outcome.kind === 'oversize') return settle(undefined)
        if (outcome.kind === 'absent') {
          if (autostart) startServer(slot)
          exhausted = true
        }
        askNext()
      })
      if (next < SERVER_SLOTS) hedge = setTimeout(askNext, HEDGE_MS)
    }
    askNext()
  })
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

/** Read-only commands a server may answer on the CLI's behalf. Each reads its arguments and the index, writes to stdout, and never reads stdin, so running one in a warm process is indistinguishable from running it in a fresh one, and re-running one after a lost reply is harmless. A reply is lost only when the server fails (the connection drops, or the answer does not authenticate), never because the command is slow: the client waits for a slow one rather than start it again beside the server's run. */
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

/** Ask every slot for its status, or tell every slot to stop. Never starts a server. Returns one entry per slot that answered. A server takes these in the middle of another request, and one too deep in synchronous work to answer the handshake is asked again until {@link CONTROL_WAIT_MS} has passed, so a slot is left out only when it is not running or never came free. */
export async function queryServers(kind: 'status' | 'stop', dir?: string): Promise<Array<{ slot: number; reply: ServerReply }>> {
  const key = readServerKey(dir)
  if (key === undefined) return []
  const deadline = Date.now() + CONTROL_WAIT_MS
  const answered: Array<{ slot: number; reply: ServerReply }> = []
  for (let slot = 0; slot < SERVER_SLOTS; slot++) {
    let outcome = await attempt(slot, key, { kind }, 2000, dir)
    while (outcome.kind === 'busy' && Date.now() < deadline) outcome = await attempt(slot, key, { kind }, 2000, dir)
    if (outcome.kind === 'served') answered.push({ slot, reply: outcome.reply })
  }
  return answered
}
