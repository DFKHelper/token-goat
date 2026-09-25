/** Wire protocol shared by the resident hook server and its thin client. Frames are a 4-byte big-endian length followed by that many bytes of UTF-8 JSON. Every connection opens with a mutual challenge keyed by a per-user secret in the data directory: the client sends a nonce, the server proves it holds the key before the client sends anything else, and the client's request and the server's reply each carry a MAC over their exact body. The endpoint name is predictable, so on a shared machine another user can bind it first or connect to it; neither gets a payload or a response, because neither can produce a MAC without reading a file only this user can read. Imports nothing heavier than node builtins, env.ts and constants.ts: the client loads this on every hook call, so its whole graph is paid on every hook call. */
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import type * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { configPath, dataDir } from './constants.js'

/** Bumped on any incompatible change to the frames below. A mismatched peer is treated as absent. */
export const PROTOCOL_VERSION = 1
/** How many independent servers may run per data directory. Each serves one request at a time; a client that finds one busy tries the next. */
export const SERVER_SLOTS = 3
/** Hook payloads are bounded well below this; a frame claiming more is a broken or hostile peer. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024
const KEY_BYTES = 32

/** A request the server can serve. `env` and `cwd` are the caller's, applied for the duration of the request. */
export type ServerRequest =
  | { kind: 'hook'; event: string; input: string; harnessWaitMs?: number; elapsedMs: number; env: Record<string, string>; cwd: string }
  | { kind: 'cli'; argv: string[]; env: Record<string, string>; cwd: string }
  | { kind: 'status' }
  | { kind: 'stop' }

export type ServerReply =
  | { ok: true; stdout: string; stderr?: string; status?: number }
  | { ok: true; info: ServerStatus }
  | { ok: false; error: string }

export interface ServerStatus {
  pid: number
  slot: number
  version: string
  startedAt: number
  lastUsedAt: number
  served: number
  errors: number
}

/** The directory holding the running bundle. Both ends compute it from this module's own location, which esbuild places in the same dist/ directory for every entry, so a client only ever reaches a server built from the same install. */
function bundleDir(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url))
  try {
    return fs.realpathSync.native(dir)
  } catch {
    return dir
  }
}

/** Identity of one install under one data directory: two installs, or one install under two data directories, never share a server. `TOKEN_GOAT_HOME` is not part of it: everything derived from it is read from the environment each request carries. */
function endpointId(dir: string): string {
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  return crypto.createHash('sha256').update(`${fold(dir)}\0${fold(bundleDir())}`).digest('hex').slice(0, 16)
}

/** The named pipe (Windows) or Unix socket path for server `slot`. Unix socket paths are capped near 104 bytes, so a long data directory falls back to the temp directory, still keyed by uid. */
export function endpointFor(slot: number, dir: string = dataDir()): string {
  const id = `${endpointId(dir)}-${slot}`
  if (process.platform === 'win32') return String.raw`\\.\pipe\token-goat-hooks-` + id
  const inData = path.join(dir, `hooks-${id}.sock`)
  if (Buffer.byteLength(inData) < 100) return inData
  return path.join(os.tmpdir(), `token-goat-${process.getuid?.() ?? 'u'}-${id}.sock`)
}

export function serverKeyPath(dir: string = dataDir()): string {
  return path.join(dir, 'hook-server.key')
}

/** True when a key file's permissions keep it private to this user. Windows ACLs are inherited from the per-user data directory, so only POSIX mode bits are checked. */
function keyIsPrivate(st: fs.Stats): boolean {
  if (process.platform === 'win32') return true
  return (st.mode & 0o077) === 0 && (process.getuid === undefined || st.uid === process.getuid())
}

/** The shared secret, or `undefined` when it is absent, malformed or readable by anyone else. Never creates it: that is the server's job. */
export function readServerKey(dir: string = dataDir()): Buffer | undefined {
  try {
    const p = serverKeyPath(dir)
    if (!keyIsPrivate(fs.statSync(p))) return undefined
    const key = fs.readFileSync(p)
    return key.length === KEY_BYTES ? key : undefined
  } catch {
    return undefined
  }
}

/** Server side: the existing key, or a fresh one. The create is exclusive, so two servers starting together agree on one key; the loser re-reads until the winner's write lands. An insecure or malformed key is replaced. */
export function ensureServerKey(dir: string = dataDir()): Buffer {
  const p = serverKeyPath(dir)
  for (let attempt = 0; attempt < 50; attempt++) {
    const existing = readServerKey(dir)
    if (existing !== undefined) return existing
    const fresh = crypto.randomBytes(KEY_BYTES)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(p, fresh, { flag: 'wx', mode: 0o600 })
      return fresh
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // Either another server is mid-write, or the file on disk is unusable. Only the second case is ours to repair.
      try {
        const st = fs.statSync(p)
        if (!keyIsPrivate(st) || (st.size !== 0 && st.size !== KEY_BYTES) || Date.now() - st.mtimeMs > 1000) fs.rmSync(p, { force: true })
      } catch {
        // vanished between the two calls: the next attempt creates it
      }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  throw new Error(`could not establish ${p}`)
}

export function nonce(): string {
  return crypto.randomBytes(16).toString('hex')
}

/** HMAC-SHA256 over the parts, each length-prefixed so no two different part lists can collide. */
export function mac(key: Buffer, ...parts: string[]): string {
  const h = crypto.createHmac('sha256', key)
  for (const part of parts) h.update(`${Buffer.byteLength(part)}:`).update(part)
  return h.digest('hex')
}

export function macMatches(expected: string, actual: unknown): boolean {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

export function writeFrame(socket: net.Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length, 0)
  socket.write(Buffer.concat([header, body]))
}

/** Calls `onFrame` with each complete JSON frame read from `socket`, and `onError` once on a malformed or oversized frame (after which the socket is destroyed). */
export function readFrames(socket: net.Socket, onFrame: (message: Record<string, unknown>) => void, onError: (err: Error) => void): void {
  let buffered: Buffer = Buffer.alloc(0)
  socket.on('data', (chunk: Buffer) => {
    buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk])
    while (buffered.length >= 4) {
      const len = buffered.readUInt32BE(0)
      if (len > MAX_FRAME_BYTES) {
        onError(new Error(`frame of ${len} bytes exceeds ${MAX_FRAME_BYTES}`))
        socket.destroy()
        return
      }
      if (buffered.length < 4 + len) return
      const body = buffered.subarray(4, 4 + len)
      buffered = buffered.subarray(4 + len)
      let message: unknown
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch (e) {
        onError(e as Error)
        socket.destroy()
        return
      }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) {
        onError(new Error('frame is not a JSON object'))
        socket.destroy()
        return
      }
      onFrame(message as Record<string, unknown>)
    }
  })
}

/** The process environment as a plain string map, the shape a request carries. */
export function envSnapshot(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return env
}

/** Marker files next to the key. `spawn-<slot>` rate-limits autostart; `disabled` records that the config turned the server off, so clients stop starting one; `failed` holds why the last start failed, since a server started in the background has nowhere else to say. */
export function markerPath(name: string, dir: string = dataDir()): string {
  return path.join(dir, `hook-server.${name}`)
}

/** Age of a marker in milliseconds, or `Infinity` when it does not exist. */
export function markerAgeMs(name: string, dir: string = dataDir()): number {
  try {
    return Date.now() - fs.statSync(markerPath(name, dir)).mtimeMs
  } catch {
    return Infinity
  }
}

export function touchMarker(name: string, content: string = String(process.pid), dir: string = dataDir()): void {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(markerPath(name, dir), content)
  } catch {
    // best effort: a missing marker only means a spawn is not rate-limited, or a failure goes unexplained
  }
}

/** Identifies the current state of the global config file, so a `disabled` marker written under one state stops counting once the file changes. */
export function configStamp(): string {
  try {
    return String(fs.statSync(configPath()).mtimeMs)
  } catch {
    return 'absent'
  }
}

/** A marker's content, or `undefined` when it does not exist. */
export function readMarker(name: string, dir: string = dataDir()): string | undefined {
  try {
    return fs.readFileSync(markerPath(name, dir), 'utf8')
  } catch {
    return undefined
  }
}

export function removeMarker(name: string, dir: string = dataDir()): void {
  fs.rmSync(markerPath(name, dir), { force: true })
}

/** The files whose replacement means this server is running superseded code. */
export function bundleEntryFiles(): string[] {
  const dir = bundleDir()
  return ['token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs'].map((f) => path.join(dir, f))
}

/** The CLI launcher beside this bundle, which the client spawns a server through. Absent when running from source. */
export function launcherPath(): string {
  return path.join(bundleDir(), 'token-goat.mjs')
}
