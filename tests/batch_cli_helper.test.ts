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

describe('batch client cleanup', () => {
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
