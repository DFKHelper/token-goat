/** Unit coverage for the resident hook server's wire protocol and on-disk state (src/hook_ipc.ts): frame codec, HMAC handshake primitives, the shared key, endpoint naming, marker files and the config stamp. The end-to-end behavior of a real server built on these lives in tests/hook_server.test.ts. */
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import type * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { _resetDataDirCacheForTesting, configPath, dataDir, dataDirForHome } from '../src/constants.js'
import {
  bundleEntryFiles,
  configStamp,
  endpointFor,
  ensureServerKey,
  launcherPath,
  mac,
  macMatches,
  markerAgeMs,
  markerPath,
  MAX_FRAME_BYTES,
  readFrames,
  readMarker,
  readServerKey,
  removeMarker,
  SERVER_SLOTS,
  serverKeyPath,
  touchMarker,
  writeFrame,
} from '../src/hook_ipc.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hook-ipc-'))
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** A stand-in for net.Socket carrying only what writeFrame/readFrames touch: `write`, `on('data')` and `destroy`. It lets a test choose exactly where chunk boundaries fall, which a real socket does not. */
class FakeSocket extends EventEmitter {
  written: Buffer[] = []
  destroyed = 0
  write(chunk: Buffer): boolean {
    this.written.push(chunk)
    return true
  }
  destroy(): this {
    this.destroyed++
    return this
  }
  asSocket(): net.Socket {
    return this as unknown as net.Socket
  }
}

function encode(message: unknown): Buffer {
  const s = new FakeSocket()
  writeFrame(s.asSocket(), message)
  return Buffer.concat(s.written)
}

function collect(): { socket: FakeSocket; frames: Array<Record<string, unknown>>; errors: Error[] } {
  const socket = new FakeSocket()
  const frames: Array<Record<string, unknown>> = []
  const errors: Error[] = []
  readFrames(socket.asSocket(), (m) => frames.push(m), (e) => errors.push(e))
  return { socket, frames, errors }
}

function header(len: number): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt32BE(len, 0)
  return h
}

describe('frame codec', () => {
  it('writes a 4-byte big-endian length followed by the UTF-8 JSON body', () => {
    // HAND-DERIVED: '{"t":"héllo"}' is 13 characters and 14 UTF-8 bytes (é is two), so the header must count bytes, not characters.
    const buf = encode({ t: 'héllo' })
    expect(buf.readUInt32BE(0)).toBe(14)
    expect(buf.subarray(4).toString('utf8')).toBe('{"t":"héllo"}')
    expect(buf.length).toBe(18)
  })

  it('reassembles a frame split across chunks, including a split inside the length header', () => {
    const buf = encode({ t: 'req', body: 'x'.repeat(50) })
    const { socket, frames, errors } = collect()
    socket.emit('data', buf.subarray(0, 2))
    socket.emit('data', buf.subarray(2, 7))
    expect(frames).toEqual([])
    socket.emit('data', buf.subarray(7))
    expect(frames).toEqual([{ t: 'req', body: 'x'.repeat(50) }])
    expect(errors).toEqual([])
    expect(socket.destroyed).toBe(0)
  })

  it('delivers two frames that arrive in one chunk, in order, and keeps a trailing partial frame for the next chunk', () => {
    const third = encode({ n: 3 })
    const { socket, frames } = collect()
    socket.emit('data', Buffer.concat([encode({ n: 1 }), encode({ n: 2 }), third.subarray(0, 5)]))
    expect(frames).toEqual([{ n: 1 }, { n: 2 }])
    socket.emit('data', third.subarray(5))
    expect(frames).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('rejects a length header above MAX_FRAME_BYTES before any body arrives, and destroys the socket', () => {
    const { socket, frames, errors } = collect()
    socket.emit('data', header(MAX_FRAME_BYTES + 1))
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe(`frame of ${MAX_FRAME_BYTES + 1} bytes exceeds ${MAX_FRAME_BYTES}`)
    expect(socket.destroyed).toBe(1)
    expect(frames).toEqual([])
  })

  it('treats a header of exactly MAX_FRAME_BYTES as legal and waits for the body', () => {
    const { socket, errors } = collect()
    socket.emit('data', header(MAX_FRAME_BYTES))
    expect(errors).toEqual([])
    expect(socket.destroyed).toBe(0)
  })

  it.each([
    ['an array', '[1,2]'],
    ['a string', '"hello"'],
    ['null', 'null'],
    ['a number', '42'],
  ])('rejects a body that is %s rather than a JSON object', (_label, body) => {
    const { socket, frames, errors } = collect()
    socket.emit('data', Buffer.concat([header(Buffer.byteLength(body)), Buffer.from(body)]))
    expect(errors.map((e) => e.message)).toEqual(['frame is not a JSON object'])
    expect(socket.destroyed).toBe(1)
    expect(frames).toEqual([])
  })

  it('rejects malformed JSON, stops at the bad frame, and never delivers the frames queued behind it', () => {
    const bad = Buffer.from('{"t":')
    const { socket, frames, errors } = collect()
    socket.emit('data', Buffer.concat([encode({ n: 1 }), header(bad.length), bad, encode({ n: 2 })]))
    expect(frames).toEqual([{ n: 1 }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(SyntaxError)
    expect(socket.destroyed).toBe(1)
  })
})

describe('mac / macMatches', () => {
  const key = Buffer.alloc(32, 7)
  const otherKey = Buffer.alloc(32, 8)

  it('matches the same key over the same parts', () => {
    expect(macMatches(mac(key, 'C', 'nc', 'ns', 'body'), mac(key, 'C', 'nc', 'ns', 'body'))).toBe(true)
  })

  it('fails for a tampered body', () => {
    expect(macMatches(mac(key, 'C', 'nc', 'ns', '{"kind":"hook"}'), mac(key, 'C', 'nc', 'ns', '{"kind":"hooK"}'))).toBe(false)
  })

  it('fails for a different key', () => {
    expect(macMatches(mac(key, 'S', 'nc', 'ns'), mac(otherKey, 'S', 'nc', 'ns'))).toBe(false)
  })

  it('fails when the role tag differs, so a server proof cannot be replayed as a client request', () => {
    expect(macMatches(mac(key, 'S', 'nc', 'ns'), mac(key, 'C', 'nc', 'ns'))).toBe(false)
  })

  it('length-prefixes each part, so moving a boundary between parts changes the MAC', () => {
    // HAND-DERIVED: without per-part length prefixes both of these would hash the byte string "abc".
    expect(mac(key, 'ab', 'c')).not.toBe(mac(key, 'a', 'bc'))
  })

  it('rejects a non-string and a wrong-length candidate without throwing', () => {
    const good = mac(key, 'S', 'a', 'b')
    expect(macMatches(good, undefined)).toBe(false)
    expect(macMatches(good, 42)).toBe(false)
    expect(macMatches(good, good.slice(1))).toBe(false)
    expect(macMatches(good, `${good}0`)).toBe(false)
  })
})

describe('server key', () => {
  it('creates a 32-byte key on first call and returns the same key on the second', () => {
    expect(readServerKey(tmp)).toBeUndefined()
    const first = ensureServerKey(tmp)
    expect(first.length).toBe(32)
    expect(fs.readFileSync(serverKeyPath(tmp)).equals(first)).toBe(true)
    const second = ensureServerKey(tmp)
    expect(second.equals(first)).toBe(true)
    expect(readServerKey(tmp)?.equals(first)).toBe(true)
  })

  it('creates the data directory when it does not exist yet', () => {
    const nested = path.join(tmp, 'a', 'b')
    const key = ensureServerKey(nested)
    expect(fs.readFileSync(path.join(nested, 'hook-server.key')).equals(key)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('writes the key owner-only (0600)', () => {
    ensureServerKey(tmp)
    expect(fs.statSync(serverKeyPath(tmp)).mode & 0o777).toBe(0o600)
  })

  it.skipIf(process.platform === 'win32')('refuses to read a key that other users can read', () => {
    ensureServerKey(tmp)
    fs.chmodSync(serverKeyPath(tmp), 0o644)
    expect(readServerKey(tmp)).toBeUndefined()
  })

  it('does not read a key of the wrong length, and replaces a stale one with a fresh 32-byte key', () => {
    const p = serverKeyPath(tmp)
    fs.writeFileSync(p, Buffer.alloc(5, 1), { mode: 0o600 })
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(p, old, old)
    expect(readServerKey(tmp)).toBeUndefined()
    const key = ensureServerKey(tmp)
    expect(key.length).toBe(32)
    expect(readServerKey(tmp)?.equals(key)).toBe(true)
  })
})

describe('endpointFor', () => {
  it('names a distinct endpoint for every slot', () => {
    const names = Array.from({ length: SERVER_SLOTS }, (_, slot) => endpointFor(slot, tmp))
    expect(new Set(names).size).toBe(SERVER_SLOTS)
    names.forEach((name, slot) => expect(name.endsWith(`-${slot}`) || name.endsWith(`-${slot}.sock`)).toBe(true))
  })

  it('names a distinct endpoint for another data directory, and the same one for the same directory', () => {
    const other = path.join(tmp, 'other')
    expect(endpointFor(0, tmp)).not.toBe(endpointFor(0, other))
    expect(endpointFor(0, tmp)).toBe(endpointFor(0, tmp))
  })

  it.runIf(process.platform === 'win32')('is a named pipe on Windows, and folds the data directory case', () => {
    // HAND-DERIVED: Windows paths are case-insensitive, so two spellings of one directory must reach one server.
    expect(endpointFor(1, tmp)).toMatch(/^\\\\\.\\pipe\\token-goat-hooks-[0-9a-f]{16}-1$/)
    expect(endpointFor(1, tmp.toUpperCase())).toBe(endpointFor(1, tmp.toLowerCase()))
  })

  it.skipIf(process.platform === 'win32')('is a socket file in the data directory when the path is short enough', () => {
    const short = fs.mkdtempSync('/tmp/tgk-')
    try {
      expect(endpointFor(2, short)).toMatch(new RegExp(`^${short}/hooks-[0-9a-f]{16}-2\\.sock$`))
    } finally {
      fs.rmSync(short, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('falls back to the temp directory when the socket path would pass the Unix length cap', () => {
    const long = path.join(tmp, 'x'.repeat(120))
    const endpoint = endpointFor(0, long)
    expect(path.dirname(endpoint)).toBe(os.tmpdir())
    expect(path.basename(endpoint)).toMatch(/^token-goat-.+-[0-9a-f]{16}-0\.sock$/)
  })
})

describe('marker files', () => {
  it('reports Infinity age and undefined content for a marker that does not exist', () => {
    expect(markerAgeMs('spawn-0', tmp)).toBe(Infinity)
    expect(readMarker('spawn-0', tmp)).toBeUndefined()
  })

  it('touches, reads and removes a marker next to the key, defaulting its content to this pid', () => {
    touchMarker('spawn-1', undefined, tmp)
    expect(markerPath('spawn-1', tmp)).toBe(path.join(tmp, 'hook-server.spawn-1'))
    expect(fs.existsSync(path.join(tmp, 'hook-server.spawn-1'))).toBe(true)
    expect(readMarker('spawn-1', tmp)).toBe(String(process.pid))
    const age = markerAgeMs('spawn-1', tmp)
    // A file's mtime can land a fraction of a millisecond after Date.now() read the clock, so a just-touched marker may be very slightly negative in age; what matters is that it is finite and fresh.
    expect(age).toBeGreaterThan(-1000)
    expect(age).toBeLessThan(10_000)
    removeMarker('spawn-1', tmp)
    expect(readMarker('spawn-1', tmp)).toBeUndefined()
    expect(markerAgeMs('spawn-1', tmp)).toBe(Infinity)
  })

  it('stores custom content verbatim, and overwrites it on the next touch', () => {
    touchMarker('failed', 'slot 2: boom', tmp)
    expect(readMarker('failed', tmp)).toBe('slot 2: boom')
    touchMarker('failed', 'slot 0: other', tmp)
    expect(readMarker('failed', tmp)).toBe('slot 0: other')
  })

  it('ages a marker by its mtime', () => {
    touchMarker('spawn-0', 'x', tmp)
    const old = new Date(Date.now() - 45_000)
    fs.utimesSync(markerPath('spawn-0', tmp), old, old)
    expect(markerAgeMs('spawn-0', tmp)).toBeGreaterThanOrEqual(44_000)
  })

  it('creates the directory on touch, and removing an absent marker does not throw', () => {
    const nested = path.join(tmp, 'n')
    touchMarker('disabled', 'absent', nested)
    expect(readMarker('disabled', nested)).toBe('absent')
    expect(() => removeMarker('never-written', nested)).not.toThrow()
  })
})

describe('configStamp', () => {
  const ENV_KEYS = ['LOCALAPPDATA', 'XDG_DATA_HOME'] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
    // Same data-dir redirect as tests/relay_hook_latency.test.ts: configPath() is derived from the cached DATA_DIR, so set the env var the real code reads and force it to re-resolve.
    const dataRoot = dataDirForHome(tmp)
    const envRoot = process.platform === 'win32' ? path.dirname(path.dirname(dataRoot)) : path.dirname(dataRoot)
    process.env['LOCALAPPDATA'] = envRoot
    process.env['XDG_DATA_HOME'] = envRoot
    _resetDataDirCacheForTesting()
    expect(dataDir()).toBe(dataRoot)
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    _resetDataDirCacheForTesting()
  })

  it("is 'absent' when there is no config file", () => {
    expect(fs.existsSync(configPath())).toBe(false)
    expect(configStamp()).toBe('absent')
  })

  it('changes when the config file changes, and is stable while it does not', () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), '[hooks]\nserver = false\n')
    const t1 = new Date('2026-01-01T00:00:00Z')
    fs.utimesSync(configPath(), t1, t1)
    const first = configStamp()
    expect(first).not.toBe('absent')
    expect(configStamp()).toBe(first)
    fs.writeFileSync(configPath(), '[hooks]\nserver = true\n')
    const t2 = new Date('2026-01-01T00:00:05Z')
    fs.utimesSync(configPath(), t2, t2)
    expect(configStamp()).not.toBe(first)
    fs.rmSync(configPath())
    expect(configStamp()).toBe('absent')
  })
})

describe('bundle files', () => {
  it('names the built entries a server watches for replacement, and the launcher beside them, in one directory', () => {
    // FORMAT-DERIVED from scripts/build-options.mjs ENTRY_POINTS (token-goat.core, token-goat-hook, token-goat-hook-client), CJS_CLIENT (the client again as a .cjs, the build a shim loads) and the launcher esbuild.config.mjs writes as dist/token-goat.mjs.
    const files = bundleEntryFiles()
    expect(files.map((f) => path.basename(f))).toEqual(['token-goat.core.mjs', 'token-goat-hook.mjs', 'token-goat-hook-client.mjs', 'token-goat-hook-client.cjs'])
    expect(new Set(files.map((f) => path.dirname(f))).size).toBe(1)
    expect(path.basename(launcherPath())).toBe('token-goat.mjs')
    expect(path.dirname(launcherPath())).toBe(path.dirname(files[0] as string))
  })
})
