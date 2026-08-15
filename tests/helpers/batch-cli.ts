// Client for the built bundle's `--batch-serve` mode: run bundle invocations against one
// long-lived server process instead of spawning a fresh one per call.
//
// A bundle spawn costs ~259ms whether or not the command does anything, because that time is Node
// starting and evaluating a 3.3 MB bundle rather than token-goat working. Tests that assert on
// real bundle output therefore pay ~228ms of pure overhead each, and there are hundreds of them.
// This pays it once per test file.
//
// `runBatched` is a drop-in for the `spawnSync(node, [BUNDLE, ...args])` shape those tests use and
// returns the same `{status, stdout, stderr}`. What it does not give you is a fresh process: the
// server restores cwd, environment and `process.exitCode` and clears the module-cache registry
// between requests, but a command that mutates state no reset covers would be visible to the next
// one. Use it for commands that read; keep spawning for anything whose whole point is process
// startup (hook shims, daemon launches, exit-path behaviour), and see
// tests/batch_serve_equivalence.test.ts, which runs a sample both ways and compares byte for byte.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'

import { BUNDLE } from './bundle.js'

export interface RunResult {
  status: number | null
  stdout: string
  stderr: string
}

interface Pending {
  resolve: (r: RunResult) => void
  reject: (e: Error) => void
}

const REQUEST_TIMEOUT_MS = 30000

let child: ChildProcess | null = null
let token = ''
let nextId = 1
const pending = new Map<number, Pending>()

function start(): ChildProcess {
  if (child !== null) return child
  token = crypto.randomBytes(12).toString('hex')
  const proc = spawn(process.execPath, [BUNDLE, '--batch-serve', token], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffered = ''
  proc.stdout?.setEncoding('utf8')
  proc.stdout?.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const nl = buffered.indexOf('\n')
      if (nl === -1) break
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      // Anything not carrying this session's token is stray output from a served command, not a
      // reply. Dropping it rather than parsing it is what keeps a fixture's own text from being
      // mistaken for protocol.
      if (!line.startsWith(`${token} `)) continue
      const res = JSON.parse(line.slice(token.length + 1)) as { id: number } & RunResult
      const waiter = pending.get(res.id)
      if (waiter === undefined) continue
      pending.delete(res.id)
      waiter.resolve({ status: res.status, stdout: res.stdout, stderr: res.stderr })
    }
  })
  proc.on('exit', (code) => {
    child = null
    for (const [, waiter] of pending) {
      waiter.reject(new Error(`batch-serve process exited (code ${String(code)}) with a request in flight`))
    }
    pending.clear()
  })
  child = proc
  return proc
}

/** Stop the shared server. Safe to call when none is running; call it from an `afterAll` so a test file never leaves one behind. */
export function stopBatchCli(): void {
  const proc = child
  child = null
  pending.clear()
  if (proc === null) return
  proc.stdin?.end()
  proc.kill()
}

/** Run the built bundle with `args` against the shared server. Same result shape as spawning it. */
export async function runBatched(
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const proc = start()
  const id = nextId++
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.env ?? process.env)) if (v !== undefined) env[k] = v
  const request = JSON.stringify({ id, argv: args, cwd: opts.cwd ?? process.cwd(), env })
  return new Promise<RunResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`batch-serve request timed out after ${REQUEST_TIMEOUT_MS}ms: ${args.join(' ')}`))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, {
      resolve: (r) => { clearTimeout(timer); resolve(r) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    proc.stdin?.write(`${request}\n`)
  })
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
    timeout: REQUEST_TIMEOUT_MS,
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}
