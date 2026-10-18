/** The batch client in tests/helpers/batch-cli.ts ends a request on an event, never on a clock. A request settles on its reply, and rejects at once when the server exits, cannot start, or closes its stdout, naming the request, the exit code or signal and the tail of the server's stderr. Every row here controls the event itself through a stand-in server (tests/helpers/batch_stand_in.mjs) whose behaviour each request picks, so no row waits for a deadline and none depends on how fast the machine is: a server that never answers is bounded by the per-test timeout alone. Provenance: HAND-DERIVED. The expectations come from the contract above, not from the client's own message builder. */
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { spawnOwned, type OwnedChild } from '../src/process_tree.js'
import { createBatchClient, type BatchClient } from './helpers/batch-cli.js'
import { processAlive } from './helpers/process_alive.js'

const STAND_IN = path.join(import.meta.dirname, 'helpers', 'batch_stand_in.mjs')

const clients: BatchClient[] = []

/** A client whose server is the stand-in, ended after the row whatever the row did. */
function standIn(): BatchClient {
  const client = createBatchClient((token) => spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] }))
  clients.push(client)
  return client
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.stop()))
})

/** The message a request was rejected with; a request that settles instead fails the row. */
async function rejection(request: Promise<unknown>): Promise<string> {
  try {
    await request
  } catch (e) {
    return (e as Error).message
  }
  throw new Error('the request settled with a result, but the server could not have answered it')
}

describe('batch client request settling', () => {
  it('settles a request on its reply', async () => {
    const res = await standIn().run(['echo', 'hello', 'world'])
    expect(res).toEqual({ status: 0, stdout: 'hello world', stderr: '' })
  })

  it('rejects the request in flight when the server exits, naming the request, the exit code and the stderr tail', async () => {
    const message = await rejection(standIn().run(['die', 'the', 'doomed', 'request']))
    expect(message).toContain('die the doomed request')
    expect(message).toContain('code 3')
    expect(message).toContain('stand-in cannot serve: the doomed request')
  })

  it('rejects each of two requests in flight under its own name', async () => {
    const client = standIn()
    const [first, second] = await Promise.all([rejection(client.run(['die', 'first'])), rejection(client.run(['hang', 'second']))])
    expect(first).toContain('die first')
    expect(second).toContain('hang second')
  })

  it('assembles a reply that arrives in two stdout chunks', async () => {
    let owned: OwnedChild | undefined
    const client = createBatchClient((token) => (owned = spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] })))
    clients.push(client)
    const request = client.run(['split', 'whole', 'reply'])
    const stdout = owned?.child.stdout
    if (stdout === null || stdout === undefined) throw new Error('the client did not launch the stand-in')
    // Both listeners run after the client's own, so a chunk they see has already been through the client. The second half is held until the first has arrived, so the reply cannot reach the client in one chunk.
    stdout.once('data', () => owned?.child.stdin?.write(`${JSON.stringify({ id: 0, argv: ['release'] })}\n`))
    const incomplete = new Promise<string>((resolve) => {
      let seen = ''
      stdout.on('data', (chunk: string) => {
        seen += chunk
        if (seen.includes('\n')) resolve('the whole line arrived and the request did not settle')
      })
    })
    // The client resolves the request while handling the chunk that ends the line, before the second listener resolves `incomplete`, so a correct client wins the race and a client that lost the first half loses it.
    expect(await Promise.race([request, incomplete])).toEqual({ status: 0, stdout: 'whole reply', stderr: '' })
  })

  it('rejects the request in flight when the server exits 0, naming the request and code 0', async () => {
    const message = await rejection(standIn().run(['quit', 'while', 'pending']))
    expect(message).toContain('quit while pending')
    expect(message).toContain('code 0')
  })

  it('quotes "(empty)" as the stderr tail of a server that wrote nothing', async () => {
    const message = await rejection(standIn().run(['quit', 'silently']))
    expect(message).toContain('stderr tail: (empty)')
  })

  it('quotes at most the last 2000 characters of a long stderr, ending in its last bytes', async () => {
    // 3000 characters of padding then a marker: the tail is the 1993 last padding characters and the marker.
    const stderr = `${'x'.repeat(3000)}THE-END`
    const message = await rejection(standIn().run(['stderr', stderr]))
    const label = 'stderr tail: '
    expect(message).toContain('code 4')
    expect(message.slice(message.indexOf(label) + label.length)).toBe(`${'x'.repeat(1993)}THE-END`)
  })

  it('never takes a line without the session token as a reply, and the tokened reply still settles the request', async () => {
    const res = await standIn().run(['stray', 'real', 'reply'])
    expect(res).toEqual({ status: 0, stdout: 'real reply', stderr: '' })
  })

  it('starts a fresh server for the request after one that died', async () => {
    const client = standIn()
    await rejection(client.run(['die', 'once']))
    expect((await client.run(['echo', 'again'])).stdout).toBe('again')
  })

  it('rejects at once, naming the request, when the server cannot start', async () => {
    const missing = path.join(tmpdir(), 'tg-no-such-batch-server')
    const client = createBatchClient(() => spawnOwned(missing, [], { stdio: ['pipe', 'pipe', 'pipe'] }))
    clients.push(client)
    const message = await rejection(client.run(['echo', 'never', 'served']))
    expect(message).toContain('echo never served')
    expect(message).toContain('ENOENT')
  })

  it('rejects when a server that is still running closes its stdout, and ends that server', async () => {
    let owned: OwnedChild | undefined
    const client = createBatchClient((token) => (owned = spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] })))
    clients.push(client)
    const request = client.run(['hang', 'no-reply-possible'])
    // The test closes the read side itself, which is the event; the stand-in is still running and would never answer anyway.
    owned?.child.stdout?.destroy()
    const message = await rejection(request)
    expect(message).toContain('after closing its stdout')
    expect(message).toContain('hang no-reply-possible')
    // The stand-in ignores the end of its input, so only the client ending the tree lets this resolve.
    await client.stop()
    expect(owned?.child.pid !== undefined && processAlive(owned.child.pid)).toBe(false)
  })
})

describe('batch client reply lines it cannot read', () => {
  it('rejects the request, quoting a bounded prefix of a tokened line that is not JSON, and ends the server', async () => {
    let kills = 0
    const client = createBatchClient((token) => {
      const spawned = spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] })
      return { ...spawned, kill: () => { kills++; spawned.kill() } }
    })
    clients.push(client)
    const payload = `not-json-${'z'.repeat(500)}`
    const message = await rejection(client.run(['garble', payload]))
    expect(message).toContain('garble not-json-')
    expect(message).toContain(JSON.stringify(payload.slice(0, 200)))
    expect(message).not.toContain(JSON.stringify(payload.slice(0, 201)))
    // The server is alive and would never answer sensibly again, so only the client ending it stops it; the count is read right after the rejection, which the end of the tree follows synchronously.
    expect(kills).toBe(1)
  })
})

describe('batch client cleanup', () => {
  it('ends the server and every process holding its pipes when the server process emits an error, and rejects the request naming it', async () => {
    let real: OwnedChild | undefined
    let kills = 0
    const client = createBatchClient((token) => {
      const spawned = spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] })
      real = spawned
      return { ...spawned, kill: () => { kills++; spawned.kill() } }
    })
    clients.push(client)
    try {
      const pids = JSON.parse((await client.run(['tree'])).stdout) as { server: number; grandchild: number }
      const proc = real?.child
      if (proc === undefined) throw new Error('the client did not launch the stand-in')
      const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()))
      const request = rejection(client.run(['hang', 'after-error']))
      // The event a failed signal or send raises on a running child; the test emits it because nothing else here can make Node raise it.
      proc.emit('error', new Error('send failed'))
      const message = await request
      expect(message).toContain('hang after-error')
      expect(message).toContain('failed (send failed)')
      // The error does not stop the process, so only the client ending the tree makes the close below arrive.
      expect(kills).toBeGreaterThan(0)
      await closed
      expect(processAlive(pids.server)).toBe(false)
      expect(processAlive(pids.grandchild)).toBe(false)
    } finally {
      real?.kill()
    }
  })

  it('ends the server and every process holding its pipes while a request is still pending', async () => {
    const client = standIn()
    const pids = JSON.parse((await client.run(['tree'])).stdout) as { server: number; grandchild: number }
    expect(processAlive(pids.server)).toBe(true)
    expect(processAlive(pids.grandchild)).toBe(true)
    // What an `afterAll(stopBatchCli)` runs after a test body threw with this request unanswered.
    void client.run(['hang', 'never-answered'])
    await client.stop()
    expect(processAlive(pids.server)).toBe(false)
    expect(processAlive(pids.grandchild)).toBe(false)
  })

  it('stops cleanly when no server was ever started, and again after it was stopped', async () => {
    const client = standIn()
    await client.stop()
    await client.run(['echo', 'x'])
    await client.stop()
    await client.stop()
  })
})
