/** Resident hook server: one long-lived process that answers hook calls and read-only CLI calls from an already-loaded module graph. Every hook call used to start Node and load token-goat's hook graph before a handler ran, about 60ms of a ~120ms call measured end to end; a warm process answers in the handler's own time. Up to {@link SERVER_SLOTS} of these run per data directory, each on its own pipe or socket and each serving one request at a time: a request is run with the caller's environment and working directory swapped in, which a process can only hold for one caller at once, so concurrency comes from more processes, never from interleaving inside one. The endpoint name doubles as the single-instance lock, so no pid file is needed. A server stops itself when it goes idle, when the bundle it was loaded from is replaced (the next call is then served by a fresh one), when the config turns it off, or when told to over the authenticated channel. */
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'

import { serveOne, swapEnv } from './batch_serve.js'
import { hookServerEnabled } from './config.js'
import { configPath, ensureDataDirPrivate } from './constants.js'
import {
  bundleEntryFiles,
  configStamp,
  endpointFor,
  ensureServerKey,
  mac,
  macMatches,
  nonce,
  PROTOCOL_VERSION,
  readFrames,
  removeMarker,
  SERVER_SLOTS,
  serverKeyPath,
  touchMarker,
  writeFrame,
  type ServerReply,
  type ServerRequest,
  type ServerStatus,
} from './hook_ipc.js'
import { relayInProcess } from './relay.js'
import { clearPerRequestCaches } from './reset.js'
import { VERSION } from './version.js'

/** The first slot stays up through a normal pause between turns; the overflow slots exist only for bursts of parallel tool calls and go away soon after one. */
const IDLE_EXIT_MS = { primary: 30 * 60_000, overflow: 3 * 60_000 }
/** How often a server checks that its key file is still there. Deleting it (`uninstall --purge`, or a test run cleaning up its data directory) retires every server keyed on it within this interval; one stat every two seconds costs an idle process nothing measurable. */
const KEY_CHECK_MS = 2_000
/** An unauthenticated connection that has not finished the handshake by now is dropped. */
const HANDSHAKE_IDLE_MS = 10_000

type RunCli = (argv: string[]) => Promise<void>

function bundleStamp(): string {
  return bundleEntryFiles()
    .map((f) => {
      try {
        const st = fs.statSync(f)
        return `${st.size}:${st.mtimeMs}`
      } catch {
        return '-'
      }
    })
    .join('|')
}

/** {@link hookServerEnabled} as of the inputs it reads: the environment variable and config.toml, keyed on the file's path and modification time (configStamp, which the client's own autostart check keys on too). Every contact asks, and parsing config.toml each time cost about 1.5ms of a call the server answers. */
let enabledMemo: { key: string; enabled: boolean } | undefined
function stillEnabled(): boolean {
  const key = `${process.env['TOKEN_GOAT_HOOK_SERVER'] ?? ''}|${configPath()}|${configStamp()}`
  if (enabledMemo?.key !== key) enabledMemo = { key, enabled: hookServerEnabled() }
  return enabledMemo.enabled
}

/** Why this server should stop taking requests, or `undefined` while it should keep serving. */
function retirementReason(loadedStamp: string): string | undefined {
  if (bundleStamp() !== loadedStamp) return 'bundle replaced'
  if (!stillEnabled()) return 'disabled'
  return undefined
}

async function handle(request: ServerRequest, runCli: RunCli, status: ServerStatus, send: (res: ServerReply) => Promise<void>): Promise<void> {
  if (request.kind === 'status' || request.kind === 'stop') return send({ ok: true, info: { ...status } })
  clearPerRequestCaches()
  if (request.kind === 'cli') {
    const res = await serveOne({ id: 0, argv: request.argv, cwd: request.cwd, env: request.env }, runCli, clearPerRequestCaches)
    return send({ ok: true, stdout: res.stdout, stderr: res.stderr, status: res.status })
  }
  const startedAt = performance.now()
  const cwdBefore = process.cwd()
  const restoreEnv = swapEnv(request.env)
  const afterReply: (() => void)[] = []
  try {
    process.chdir(request.cwd)
    const payload: unknown = JSON.parse(request.input)
    // What the caller waited on is its own time up to sending this request plus the time spent here, not this process's age.
    const stdout = await relayInProcess(request.event, payload, request.harnessWaitMs, { elapsedMs: () => request.elapsedMs + (performance.now() - startedAt), afterReply: (work) => afterReply.push(work) })
    // The caller has its answer before the stats row is written and the connections are closed, and both still run under this request's environment and directory. The session state the next call reads was saved before the answer, so nothing a follow-up call depends on is left behind it.
    await send({ ok: true, stdout })
    for (const work of afterReply) work()
  } finally {
    restoreEnv()
    try {
      process.chdir(cwdBefore)
    } catch {
      // the directory it sat in between requests is the temp directory, which outlives it
    }
    clearPerRequestCaches()
  }
}

/** Listen on `endpoint`, replacing a Unix socket file left behind by a server that died. Resolves `false` when a live server already holds the endpoint. */
function listen(server: net.Server, endpoint: string): Promise<boolean> {
  const tryListen = (): Promise<NodeJS.ErrnoException | undefined> =>
    new Promise((resolve) => {
      server.once('error', resolve)
      server.listen({ path: endpoint, readableAll: false, writableAll: false }, () => {
        server.removeListener('error', resolve)
        resolve(undefined)
      })
    })
  return tryListen().then(async (err) => {
    if (err === undefined) return true
    if (err.code !== 'EADDRINUSE' || process.platform === 'win32') return false
    // A socket file with nobody behind it refuses the connection; one with a live server accepts it.
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(endpoint)
      probe.once('connect', () => {
        probe.destroy()
        resolve(true)
      })
      probe.once('error', () => resolve(false))
    })
    if (alive) return false
    fs.rmSync(endpoint, { force: true })
    return (await tryListen()) === undefined
  })
}

/** Run a server on `slot` until it retires. `runCli` is the CLI entry point, passed in rather than imported because the CLI is what imports this module. */
export async function runHookServer(slot: number, runCli: RunCli): Promise<void> {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SERVER_SLOTS) throw new Error(`--slot must be an integer from 0 to ${SERVER_SLOTS - 1}`)
  if (!hookServerEnabled()) {
    touchMarker('disabled', configStamp())
    return
  }
  ensureDataDirPrivate()
  const key = ensureServerKey()
  const keyPath = serverKeyPath()
  const loadedStamp = bundleStamp()
  const endpoint = endpointFor(slot)
  // Relative paths anywhere below resolve against the caller's directory, which each request sets. Between requests the server sits in the temp directory: a working directory cannot be deleted on Windows, and the temp directory is the one place nothing ever tries to.
  process.chdir(os.tmpdir())
  const status: ServerStatus = { pid: process.pid, slot, version: VERSION, startedAt: Date.now(), lastUsedAt: Date.now(), served: 0, errors: 0 }
  let busy = false
  let retiring = false
  let idleTimer: NodeJS.Timeout | undefined

  const server = net.createServer((socket) => serveConnection(socket))
  // Stop accepting at once, and exit as soon as no request is in flight; one that is finishes and exits on its way out.
  const stop = (): void => {
    retiring = true
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    server.close()
    if (!busy) process.exit(0)
  }
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(stop, slot === 0 ? IDLE_EXIT_MS.primary : IDLE_EXIT_MS.overflow)
  }

  function serveConnection(socket: net.Socket): void {
    let nc = ''
    let ns = ''
    socket.setTimeout(HANDSHAKE_IDLE_MS, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    const onMessage = (msg: Record<string, unknown>): void => {
      if (msg['t'] === 'hello' && nc === '') {
        if (msg['v'] !== PROTOCOL_VERSION || typeof msg['nc'] !== 'string' || msg['nc'] === '') return void socket.destroy()
        const reason = retiring ? 'retiring' : retirementReason(loadedStamp)
        if (reason !== undefined) {
          if (reason === 'disabled') touchMarker('disabled', configStamp())
          // A newer build is on disk and this server started fine, so nothing argues for making the next call wait out the start throttle before the new build is running: an upgrade within half a minute of this server starting would otherwise leave every call cold until it lapsed.
          if (reason === 'bundle replaced') removeMarker(`spawn-${slot}`)
          writeFrame(socket, { t: 'stale' })
          socket.end(() => {
            if (!retiring) stop()
          })
          return
        }
        if (busy) {
          writeFrame(socket, { t: 'busy' })
          return void socket.end()
        }
        nc = msg['nc']
        ns = nonce()
        writeFrame(socket, { t: 'challenge', v: PROTOCOL_VERSION, ns, mac: mac(key, 'S', nc, ns) })
        return
      }
      if (msg['t'] === 'req' && ns !== '') {
        const body = msg['body']
        if (typeof body !== 'string' || !macMatches(mac(key, 'C', nc, ns, body), msg['mac'])) return void socket.destroy()
        // Another caller may have been dispatched between this one's challenge and its request.
        if (busy) {
          writeFrame(socket, { t: 'busy' })
          return void socket.end()
        }
        busy = true
        socket.setTimeout(0)
        // Resolves once the reply has left this process (or the caller hung up), so an exit that follows never cuts it short. Only the first reply is sent: a failure after it has nothing left to answer.
        let replied = false
        const reply = (res: ServerReply): Promise<void> =>
          new Promise((resolve) => {
            if (replied) return resolve()
            replied = true
            const resBody = JSON.stringify(res)
            socket.once('close', () => resolve())
            writeFrame(socket, { t: 'res', mac: mac(key, 'R', nc, ns, resBody), body: resBody })
            socket.end(() => resolve())
          })
        void (async () => {
          try {
            const request = JSON.parse(body) as ServerRequest
            await handle(request, runCli, status, reply)
            if (request.kind === 'hook' || request.kind === 'cli') status.served++
            if (request.kind === 'stop') retiring = true
          } catch (e) {
            status.errors++
            await reply({ ok: false, error: e instanceof Error ? e.message : String(e) })
          }
          busy = false
          status.lastUsedAt = Date.now()
          if (retiring) stop()
          else armIdle()
        })()
        return
      }
      socket.destroy()
    }
    readFrames(socket, onMessage, () => undefined)
  }

  if (!(await listen(server, endpoint))) return
  removeMarker('failed')
  setInterval(() => {
    if (!fs.existsSync(keyPath)) stop()
  }, KEY_CHECK_MS).unref()
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(endpoint, 0o600)
    } catch {
      // the handshake, not the socket mode, is what keeps other users out
    }
  }
  armIdle()
}
