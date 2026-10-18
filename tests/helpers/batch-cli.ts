// Client for the built bundle's `--batch-serve` mode: run bundle invocations against one long-lived server process instead of spawning a fresh one per call.
//
// A bundle spawn costs ~259ms whether or not the command does anything, because that time is Node starting and evaluating a 3.3 MB bundle rather than token-goat working. Tests that assert on real bundle output therefore pay ~228ms of pure overhead each, and there are hundreds of them. This pays it once per test file.
//
// `runBatched` is a drop-in for the `spawnSync(node, [BUNDLE, ...args])` shape those tests use and returns the same `{status, stdout, stderr}`. What it does not give you is a fresh process: the server restores cwd, environment and `process.exitCode` and clears the module-cache registry between requests, but a command that mutates state no reset covers would be visible to the next one. Use it for commands that read; keep spawning for anything whose whole point is process startup (hook shims, daemon launches, exit-path behaviour), and see tests/batch_serve_equivalence.test.ts, which runs a sample both ways and compares byte for byte.
//
// A request ends on an event, never on a clock: the server's reply settles it, and the server exiting, failing to start, failing on a pipe, closing its stdout, or writing a reply line that is not JSON rejects it at once, naming the request, the exit code or signal and the tail of the server's stderr. A server that is alive and never answers is bounded by the per-test timeout alone, so a slow machine cannot fail a correct build here; the server's whole tree is ended by `stopBatchCli`, and by the process-exit and signal hooks of `spawnOwned` from the moment it starts.
import { spawnSync } from 'node:child_process'
import * as crypto from 'node:crypto'

import { spawnOwned, type OwnedChild } from '../../src/process_tree.js'
import { BUNDLE } from './bundle.js'

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

interface Pending {
  /** The request as the test wrote it, so a rejection names it. */
  label: string
  resolve: (r: RunResult) => void
  reject: (e: Error) => void
}

export interface BatchClient {
  /** Run `args` against this client's server, starting it on first use. Same result shape as spawning the bundle. */
  run(args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<RunResult>
  /** End the server's whole tree. Resolves once the most recent server has closed, which is after every process holding its pipes is gone (immediately when none was started). Requests still pending are dropped, not rejected: a rejection nobody awaits would fail the run as unhandled. */
  stop(): Promise<void>
}

/** How much of the server's stderr a rejection quotes. It is the end of the stream that says why a server died, so the cut keeps the last characters. */
const STDERR_TAIL_CHARS = 2000

/** How much of a reply line the server wrote that is not JSON a rejection quotes. It is the start of the line that shows what it was. */
const BAD_LINE_PREFIX_CHARS = 200

/** The first `max` characters of `text`, ending on a character boundary: a cut between the two halves of a surrogate pair drops the orphaned high half. */
function firstChars(text: string, max: number): string {
  const cut = text.slice(0, max)
  return cut.length < text.length && isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff
}

/** Spawn timeout for {@link runSpawned}. It stays a clock because `spawnSync` blocks this process's event loop, so neither an event nor the per-test timeout can fire while it waits. */
const SPAWN_SYNC_TIMEOUT_MS = 30000

/** A client whose server is whatever `launch` starts. `launch` receives the session token the server must put in front of every reply line and returns the owned child; the default client below starts the built bundle's `--batch-serve`. */
export function createBatchClient(launch: (token: string) => OwnedChild): BatchClient {
  let child: OwnedChild | null = null
  let token = ''
  let nextId = 1
  let closing: Promise<void> = Promise.resolve()
  const pending = new Map<number, Pending>()

  /** Reject every request in flight with its own name and why the server is gone, then forget this server so the next request starts a fresh one. `end` also ends the tree, for a server that is still running but can no longer be used. */
  function fail(owned: OwnedChild, why: string, stderrTail: string, end: boolean): void {
    if (child !== owned) return
    child = null
    for (const [, waiter] of pending) {
      waiter.reject(new Error(`batch-serve server ${why} with a request in flight: ${waiter.label}; stderr tail: ${stderrTail.trim() === '' ? '(empty)' : stderrTail.trim()}`))
    }
    pending.clear()
    if (end) owned.kill()
  }

  function start(): OwnedChild {
    if (child !== null) return child
    token = crypto.randomBytes(12).toString('hex')
    const owned = launch(token)
    const proc = owned.child
    child = owned
    closing = new Promise<void>((resolve) => proc.once('close', () => resolve()))
    let stderrTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })
    // A server that exits before reading a request fails the write with EPIPE; the exit handler below already rejects the request in flight.
    proc.stdin?.on('error', () => undefined)
    let buffered = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffered += chunk
      for (;;) {
        const nl = buffered.indexOf('\n')
        if (nl === -1) break
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        // Anything not carrying this session's token is stray output from a served command, not a reply. Dropping it rather than parsing it is what keeps a fixture's own text from being mistaken for protocol.
        if (!line.startsWith(`${token} `)) continue
        const payload = line.slice(token.length + 1)
        let res: { id: number } & RunResult
        try {
          const parsed: unknown = JSON.parse(payload)
          if (typeof parsed !== 'object' || parsed === null) throw new TypeError('a reply is an object')
          res = parsed as { id: number } & RunResult
        } catch {
          // The server is alive but its replies can no longer be trusted, so every request in flight is rejected and the tree is ended; the unread rest of the buffer belongs to it.
          fail(owned, `wrote a reply line that is not JSON (starts ${JSON.stringify(firstChars(payload, BAD_LINE_PREFIX_CHARS))})`, stderrTail, true)
          buffered = ''
          return
        }
        const waiter = pending.get(res.id)
        if (waiter === undefined) continue
        pending.delete(res.id)
        waiter.resolve({ status: res.status, stdout: res.stdout, stderr: res.stderr })
      }
    })
    let stdoutClosed = false
    // The exit is what rejects, because it carries the code and signal. A reply written just before the exit can still be unread when `exit` fires; the in-flight requests are the ones with no reply yet, which is what a dead server leaves.
    proc.on('exit', (code, signal) => fail(owned, `exited (code ${String(code)}, signal ${String(signal)}${stdoutClosed ? ', stdout closed first' : ''})`, stderrTail, false))
    // Spawn failure (no such executable) and a failed signal or send arrive here and never as an exit.
    proc.on('error', (err) => fail(owned, `failed (${err.message})`, stderrTail, true))
    // A server that closed its stdout can never answer again, so it is ended and its exit then rejects the requests. Its own pipe closing as it dies is the same event, and ending a process that is already exiting cannot change the code it chose.
    proc.stdout?.on('close', () => {
      stdoutClosed = true
      if (proc.exitCode === null && proc.signalCode === null) owned.kill()
    })
    return owned
  }

  return {
    run(args, opts = {}) {
      const owned = start()
      const id = nextId++
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v
      const request = JSON.stringify({ id, argv: args, cwd: opts.cwd ?? process.cwd(), env })
      return new Promise<RunResult>((resolve, reject) => {
        pending.set(id, { label: args.join(' '), resolve, reject })
        const proc = owned.child
        proc.stdin?.write(`${request}\n`)
      })
    },
    stop() {
      const owned = child
      child = null
      pending.clear()
      if (owned !== null) {
        const proc = owned.child
        proc.stdin?.end()
        owned.kill()
      }
      return closing
    },
  }
}

const shared = createBatchClient((token) => spawnOwned(process.execPath, [BUNDLE, '--batch-serve', token], { stdio: ['pipe', 'pipe', 'pipe'] }))

/** Stop the shared server. Safe to call when none is running; call it from an `afterAll` so a test file never leaves one behind. */
export function stopBatchCli(): void {
  void shared.stop()
}

/** Run the built bundle with `args` against the shared server. Same result shape as spawning it. */
export async function runBatched(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return shared.run(args, opts)
}

/** Spawn the bundle for real, the way these tests did before batching. The equivalence guard compares this against {@link runBatched}. */
export function runSpawned(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RunResult {
  const res = spawnSync(process.execPath, [BUNDLE, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    encoding: 'utf8',
    timeout: SPAWN_SYNC_TIMEOUT_MS,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}
