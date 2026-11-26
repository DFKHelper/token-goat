/** The batch client in tests/helpers/batch-cli.ts ends a request on an event, never on a clock. A request settles on its reply, and rejects at once when the server exits, cannot start, or closes its stdout, naming the request, the exit code or signal and the tail of the server's stderr. Every row here controls the event itself through a stand-in server (tests/helpers/batch_stand_in.mjs) whose behaviour each request picks, so no row waits for a deadline and none depends on how fast the machine is: a server that never answers is bounded by the per-test timeout alone. Provenance: HAND-DERIVED. The expectations come from the contract above, not from the client's own message builder. */
import { ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'

import { afterEach, describe, expect, it } from 'vitest'

import { queryProcessCommandLine } from '../src/resident_process.js'
import { spawnOwned, type OwnedChild } from '../src/process_tree.js'
import { createBatchClient, type BatchClient } from './helpers/batch-cli.js'
import { killIfCommandLine } from './helpers/kill_if_command_line.js'
import { processAlive, waitGone } from './helpers/process_alive.js'

const STAND_IN = path.join(import.meta.dirname, 'helpers', 'batch_stand_in.mjs')
// Matches this run's stand-in by its absolute script path, or its grandchild by the watch snippet and this test process's pid, as read at check time.
const isStandIn = (commandLine: string): boolean =>
  commandLine.includes(STAND_IN) ||
  (commandLine.includes('const owner = Number(process.argv[1])') && commandLine.trimEnd().endsWith(` ${process.pid}`))

const clients: BatchClient[] = []
/** Pids of every stand-in tree a row read, so cleanup can end them by pid even when the server is already gone. */
const treePids: number[] = []

/** The stand-in's server and grandchild pids, recorded for cleanup. */
async function treeOf(client: BatchClient): Promise<{ server: number; grandchild: number }> {
  const pids = JSON.parse((await client.run(['tree'])).stdout) as { server: number; grandchild: number }
  treePids.push(pids.server, pids.grandchild)
  return pids
}

/** Drops a pid a row has proven gone, so cleanup never signals a pid the kernel may have reused. */
function proveGone(pid: number): void {
  const at = treePids.indexOf(pid)
  if (at >= 0) treePids.splice(at, 1)
}

/** A client whose server is the stand-in, ended after the row whatever the row did. */
function standIn(): BatchClient {
  const client = createBatchClient((token) => spawnOwned(process.execPath, [STAND_IN, token], { stdio: ['pipe', 'pipe', 'pipe'] }))
  clients.push(client)
  return client
}

// Ends every pid no row proved gone, by its tree, and never awaits close: a survivor holds the pipes, so close would never arrive and an awaited stop would hang this hook after the row's own named failure.
afterEach(() => {
  for (const c of clients.splice(0)) void c.stop()
  const failures: string[] = []
  for (const pid of treePids.splice(0)) {
    // A pid is signalled only while its command line still names the stand-in; the read-to-signal gap remains.
    try {
      if (killIfCommandLine(pid, isStandIn, { tree: true })) continue
      // A false return is a stranger, a gone pid or a failed kill; only a pid still naming the stand-in afterwards is a failed kill.
      const after = queryProcessCommandLine(pid)
      if (after.status === 'found' ? isStandIn(after.commandLine) : after.status === 'failed' && processAlive(pid)) failures.push(`pid ${pid}: a stand-in process still runs after its tree kill failed`)
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  if (failures.length > 0) throw new Error(`batch cleanup could not end ${failures.length} recorded pid(s): ${failures.join('; ')}`)
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
    owned?.child.stdin?.on('error', () => undefined)
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

  it('cuts a long stderr on a code point boundary, so the tail never starts with half of a surrogate pair', async () => {
    // The 2000th character from the end is the low half of the emoji, which a plain cut of the last 2000 would keep alone.
    const stderr = `${'x'.repeat(500)}${String.fromCodePoint(0x1f600)}${'y'.repeat(1999)}`
    const message = await rejection(standIn().run(['stderr', stderr]))
    const label = 'stderr tail: '
    expect(message.slice(message.indexOf(label) + label.length)).toBe('y'.repeat(1999))
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
    expect(message).toContain('stdout closed first')
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

describe('batch client exit reporting', () => {
  it('names the exit code of a server whose stdout closed before its exit was reported, without claiming it closed the stdout itself', async () => {
    // The order is the test's to choose here: a real server dying usually closes its stdout first, but the OS decides, so a row on a real one could not pin it.
    const proc = new ChildProcess()
    proc.stdin = new PassThrough()
    const stdout = new PassThrough()
    proc.stdout = stdout
    proc.stderr = new PassThrough()
    const noop = (): undefined => undefined
    const client = createBatchClient(() => ({ child: proc, kill: noop, endLeftovers: noop, release: noop }))
    clients.push(client)
    const request = rejection(client.run(['quit', 'in', 'order']))
    // The client's own close listener ran before this one, so the close has been handled when this resolves.
    await new Promise<void>((resolve) => {
      stdout.once('close', () => resolve())
      stdout.destroy()
    })
    proc.emit('exit', 0, null)
    const message = await request
    proc.emit('close', 0, null)
    expect(message).toContain('exited (code 0, signal null')
    expect(message).toContain('quit in order')
    expect(message).not.toContain('after closing its stdout')
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
      const pids = await treeOf(client)
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
      expect(await waitGone(pids.grandchild), `batch-serve grandchild ${pids.grandchild} outlived its tree kill`).toBe(true)
      proveGone(pids.grandchild)
      await closed
      expect(processAlive(pids.server)).toBe(false)
      proveGone(pids.server)
    } finally {
      real?.kill()
    }
  })

  it('ends the server and every process holding its pipes while a request is still pending', async () => {
    const client = standIn()
    const pids = await treeOf(client)
    expect(processAlive(pids.server)).toBe(true)
    expect(processAlive(pids.grandchild)).toBe(true)
    // What an `afterAll(stopBatchCli)` runs after a test body threw with this request unanswered.
    void client.run(['hang', 'never-answered'])
    const stopped = client.stop()
    expect(await waitGone(pids.grandchild), `batch-serve grandchild ${pids.grandchild} outlived its tree kill`).toBe(true)
    proveGone(pids.grandchild)
    await stopped
    expect(processAlive(pids.server)).toBe(false)
    proveGone(pids.server)
    expect(treePids, 'every recorded pid was proven gone, so afterEach has nothing left to signal').toEqual([])
  })

  it('resolves true once the probe reads gone', async () => {
    let last: boolean | undefined
    let calls = 0
    // HAND-DERIVED: the probe reads alive twice, then gone, as the row's contract states; the row asserts only the outcome.
    const gone = await waitGone(4242, () => { calls++; last = calls <= 2; return last })
    expect(gone).toBe(true)
    expect(last).toBe(false)
  })

  it('stops cleanly when no server was ever started, and again after it was stopped', async () => {
    const client = standIn()
    await client.stop()
    await client.run(['echo', 'x'])
    await client.stop()
    await client.stop()
  })
})
