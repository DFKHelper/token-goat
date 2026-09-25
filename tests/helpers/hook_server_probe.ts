/** Control-channel probes of one hook server slot, for tests that must know whether a call was served rather than infer it from output (a client that computed the wrong endpoint falls back and prints the same bytes). {@link slotStatus} asks for the slot's own counters over the v1 control request, which a server answers without counting it as served; {@link waitIdle} waits until the slot would take a new request, since a server finishes a request's after-reply work (the stats row) after the caller already has its answer and says `busy` to a caller that arrives meanwhile. */
import * as net from 'node:net'

import { encodeFrame, mac, macMatches, nonce, PROTOCOL_VERSION, readFrames, writeFrame, type ServerReply, type ServerStatus } from '../../src/hook_ipc.js'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The status `endpoint` reports, or `undefined` when nothing answers there. */
export function slotStatus(endpoint: string, key: Buffer): Promise<ServerStatus | undefined> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint)
    const nc = nonce()
    let ns = ''
    const done = (s: ServerStatus | undefined): void => {
      socket.destroy()
      resolve(s)
    }
    socket.on('error', () => done(undefined))
    socket.on('close', () => done(undefined))
    socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc, ctl: true }))
    readFrames(
      socket,
      (msg) => {
        if (msg['t'] === 'challenge' && ns === '') {
          ns = String(msg['ns'])
          if (!macMatches(mac(key, 'S', nc, ns), msg['mac'])) return done(undefined)
          const body = JSON.stringify({ kind: 'status' })
          socket.write(encodeFrame({ t: 'req', mac: mac(key, 'C', nc, ns, body), body }))
          return
        }
        if (msg['t'] === 'res' && typeof msg['body'] === 'string' && macMatches(mac(key, 'R', nc, ns, msg['body']), msg['mac'])) {
          const reply = JSON.parse(msg['body']) as ServerReply
          return done(reply.ok && 'info' in reply ? reply.info : undefined)
        }
        done(undefined)
      },
      () => done(undefined),
    )
  })
}

/** Resolves once `endpoint` answers a hello with a challenge rather than `busy`; throws when it has not within `timeoutMs`. */
export async function waitIdle(endpoint: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const answer = await new Promise<string>((resolve) => {
      const socket = net.connect(endpoint)
      const finish = (t: string): void => {
        socket.destroy()
        resolve(t)
      }
      socket.on('error', () => finish('error'))
      socket.on('close', () => finish('closed'))
      socket.on('connect', () => writeFrame(socket, { t: 'hello', v: PROTOCOL_VERSION, nc: nonce() }))
      readFrames(
        socket,
        (msg) => finish(String(msg['t'])),
        () => finish('malformed'),
      )
    })
    if (answer === 'challenge') return
    if (Date.now() > deadline) throw new Error(`hook server at ${endpoint} still answers ${answer}`)
    await sleep(5)
  }
}
