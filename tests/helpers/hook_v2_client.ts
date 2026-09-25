/** A small client for the hook server's harness-aware protocol (HARNESS_PROTOCOL_VERSION in src/hook_ipc.ts), standing in for the native client in tests. It verifies every MAC the way a real client must: the challenge (which binds the harness and the no-op outputs), each `out` frame in sequence, and the `done` frame with the count of `out` frames before it. {@link verifyResponseFrames} is exported on its own so a test can hand it frames a real server sent, reordered or replayed. */
import * as net from 'node:net'

import {
  challengeMacV2,
  doneFrameMac,
  encodeFrame,
  HARNESS_PROTOCOL_VERSION,
  macMatches,
  nonce,
  outFrameMac,
  readFrames,
  requestMacV2,
  writeFrame,
  type HarnessHookRequest,
} from '../../src/hook_ipc.js'

export type Frame = Record<string, unknown>

export interface V2Served {
  kind: 'served'
  /** Each `out` frame's data, in order. */
  out: string[]
  stdout: string
  exit: number
  noop: string
  noops: Array<[string, string]>
  nc: string
  ns: string
  /** Every frame after the challenge, as received. */
  frames: Frame[]
}

export type V2Outcome = V2Served | { kind: 'refused'; reason: unknown } | { kind: 'busy' } | { kind: 'stale' } | { kind: 'closed'; frames: Frame[] }

export interface V2CallOptions {
  /** The harness named in the hello, when a test wants it to differ from the request's. */
  helloHarness?: string
  /** Rewrites the request body after its MAC is computed, as a tampering peer would. */
  tamperBody?: (body: string) => string
  /** Signs the request with this harness instead of the hello's. */
  macHarness?: string
}

/** The stdout a client prints for the frames a server sent: each `out` frame's data in order, then the `done` frame's stdout. Throws on a bad MAC, a gap, reorder or replay in `seq`, a `done` whose count disagrees, a missing `done`, or anything after it. */
export function verifyResponseFrames(key: Buffer, nc: string, ns: string, frames: readonly Frame[]): { out: string[]; stdout: string; exit: number } {
  const out: string[] = []
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as Frame
    if (f['t'] === 'out') {
      const data = f['data']
      if (typeof data !== 'string') throw new Error('out frame without data')
      if (f['seq'] !== out.length) throw new Error(`out frame seq ${String(f['seq'])} where ${out.length} was due`)
      if (!macMatches(outFrameMac(key, nc, ns, out.length, data), f['mac'])) throw new Error(`out frame ${out.length} MAC mismatch`)
      out.push(data)
      continue
    }
    if (f['t'] === 'done') {
      const stdout = f['stdout']
      const exit = f['exit']
      if (typeof stdout !== 'string' || typeof exit !== 'number') throw new Error('malformed done frame')
      if (f['n'] !== out.length) throw new Error(`done frame counts ${String(f['n'])} out frames, ${out.length} arrived`)
      if (!macMatches(doneFrameMac(key, nc, ns, stdout, exit, out.length), f['mac'])) throw new Error('done frame MAC mismatch')
      if (i !== frames.length - 1) throw new Error('frames after done')
      return { out, stdout, exit }
    }
    throw new Error(`unexpected frame ${JSON.stringify(f)}`)
  }
  throw new Error('no done frame')
}

/** One v2 hook request against `endpoint`. Resolves with what came back; rejects only on a verification failure or a socket error before the server answered. */
export function callV2(endpoint: string, key: Buffer, harness: string, request: Omit<HarnessHookRequest, 'kind' | 'harness'>, opts: V2CallOptions = {}): Promise<V2Outcome> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint)
    const nc = nonce()
    const helloHarness = opts.helloHarness ?? harness
    let ns = ''
    let noop = ''
    let noops: Array<[string, string]> = []
    const frames: Frame[] = []
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      socket.destroy()
      fn()
    }
    socket.on('error', (e) => settle(() => (ns === '' ? reject(e) : resolve({ kind: 'closed', frames }))))
    socket.on('close', () => settle(() => resolve({ kind: 'closed', frames })))
    socket.on('connect', () => writeFrame(socket, { t: 'hello', v: HARNESS_PROTOCOL_VERSION, nc, h: helloHarness }))
    readFrames(
      socket,
      (msg) => {
        if (ns === '') {
          if (msg['t'] === 'refused') return settle(() => resolve({ kind: 'refused', reason: msg['reason'] }))
          if (msg['t'] === 'busy' || msg['t'] === 'stale') return settle(() => resolve({ kind: msg['t'] as 'busy' | 'stale' }))
          if (msg['t'] !== 'challenge' || msg['v'] !== HARNESS_PROTOCOL_VERSION || typeof msg['ns'] !== 'string' || typeof msg['noop'] !== 'string' || !Array.isArray(msg['noops'])) {
            return settle(() => reject(new Error(`unexpected handshake frame ${JSON.stringify(msg)}`)))
          }
          ns = msg['ns']
          noop = msg['noop']
          noops = msg['noops'] as Array<[string, string]>
          if (!macMatches(challengeMacV2(key, nc, ns, helloHarness, noop, noops), msg['mac'])) return settle(() => reject(new Error('challenge MAC mismatch')))
          const body = JSON.stringify({ kind: 'hook', harness, ...request })
          const signed = requestMacV2(key, nc, ns, opts.macHarness ?? helloHarness, body)
          socket.write(encodeFrame({ t: 'req', mac: signed, body: opts.tamperBody ? opts.tamperBody(body) : body }))
          return
        }
        frames.push(msg)
        if (msg['t'] !== 'done') return
        settle(() => {
          try {
            const verified = verifyResponseFrames(key, nc, ns, frames)
            resolve({ kind: 'served', ...verified, noop, noops, nc, ns, frames })
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      },
      (e) => settle(() => reject(e)),
    )
  })
}
