/**
 * `--batch-serve`: run many CLI invocations inside one already-started process.
 *
 * Every one of the suite's built-bundle tests spawns `node dist/token-goat.mjs <args>` and asserts
 * on the real output, deliberately, so that no injected seam can hide a broken shipping path. The
 * problem is what that costs. Measured on this repo: a bundle spawn that does nothing at all
 * (`--version`) takes 259ms, and one that does real work (`todo .`) takes 258ms. The command is
 * free; ~228ms of every such test is Node starting up and evaluating a 3.3 MB bundle. Across the
 * ~534 tests in that shape it is about 122 seconds of the suite's 452 seconds of test time.
 *
 * So this serves invocations from a process that has already paid that cost once. What it
 * deliberately does NOT change is anything the tests are actually asserting about: it is the real
 * built artifact, the real `run(argv)` entrypoint, the real commander parse, and the real command
 * implementations. Only the process boundary is amortised.
 *
 * What a shared process does change is state, and that is the whole risk. Between requests this
 * restores the working directory, restores the environment key by key, resets `process.exitCode`,
 * and calls `clearModuleCaches()` (the same reset registry the in-process tests already rely on).
 * A module-level cache that no reset covers would make a batched run disagree with a spawned one
 * -- which is why tests/batch_serve_equivalence.test.ts runs a sample of commands both ways and
 * compares stdout, stderr and exit status byte for byte. Batching is only as trustworthy as that
 * guard, so the guard is not optional.
 *
 * Protocol, newline-delimited JSON over stdin, replies on stdout prefixed with a caller-supplied
 * random token: `<token> {"id":N,...}`. The token exists because a command's own output is
 * captured in-process but a stray async write is not, and a reply stream that a test's own output
 * could be mistaken for would be worse than no speedup at all. The caller generates the token, so
 * nothing in a fixture can predict it.
 */
import { clearModuleCaches } from './reset.js'

export interface BatchRequest {
  id: number
  argv: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface BatchResponse {
  id: number
  status: number
  stdout: string
  stderr: string
}

/** Apply `next` as the whole environment, returning a restore function. Applied key by key rather than by replacing `process.env`, which Node does not fully honour. */
function swapEnv(next: Record<string, string>): () => void {
  const before = { ...process.env } as Record<string, string>
  for (const key of Object.keys(process.env)) if (!(key in next)) delete process.env[key]
  for (const [key, value] of Object.entries(next)) process.env[key] = value
  return () => {
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key]
    for (const [key, value] of Object.entries(before)) process.env[key] = value
  }
}

/** Capture everything written to stdout and stderr for the duration of one request. */
function captureOutput(): { stdout: () => string; stderr: () => string; restore: () => void } {
  let out = ''
  let errText = ''
  const realOut = process.stdout.write.bind(process.stdout)
  const realErr = process.stderr.write.bind(process.stderr)
  const sink = (append: (s: string) => void) =>
    ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      append(typeof chunk === 'string' ? chunk : String(chunk))
      const done = typeof enc === 'function' ? enc : cb
      if (typeof done === 'function') (done as () => void)()
      return true
    }) as unknown as typeof process.stdout.write
  process.stdout.write = sink((s) => { out += s })
  process.stderr.write = sink((s) => { errText += s })
  return {
    stdout: () => out,
    stderr: () => errText,
    restore: () => {
      process.stdout.write = realOut
      process.stderr.write = realErr
    },
  }
}

/** Run one request against the real entrypoint, isolating it from the last one and from the next. */
export async function serveOne(
  req: BatchRequest,
  runFn: (argv: string[]) => Promise<void>,
): Promise<BatchResponse> {
  const cwdBefore = process.cwd()
  const restoreEnv = req.env === undefined ? (): void => {} : swapEnv(req.env)
  const cap = captureOutput()
  let status: number
  try {
    if (req.cwd !== undefined) process.chdir(req.cwd)
    process.exitCode = undefined
    await runFn([process.execPath, 'token-goat', ...req.argv])
    status = typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (e) {
    // A throw that escapes run() would kill a real CLI process with a nonzero status, so report
    // that rather than a clean exit; the message goes to stderr exactly as an uncaught error does.
    cap.restore()
    process.stderr.write('')
    status = 1
    const captured = { out: cap.stdout(), err: cap.stderr() + String(e instanceof Error ? e.stack ?? e.message : e) + '\n' }
    restoreEnv()
    process.exitCode = undefined
    try {
      process.chdir(cwdBefore)
    } catch {
      // the directory a request chdir'd into may have been removed by the request itself
    }
    clearModuleCaches()
    return { id: req.id, status, stdout: captured.out, stderr: captured.err }
  }
  cap.restore()
  const stdout = cap.stdout()
  const stderr = cap.stderr()
  restoreEnv()
  process.exitCode = undefined
  try {
    process.chdir(cwdBefore)
  } catch {
    // as above: the request may have deleted the directory it ran in
  }
  clearModuleCaches()
  return { id: req.id, status, stdout, stderr }
}

/**
 * Read requests from stdin until it closes, replying to each on stdout. Requests are handled
 * strictly one at a time: two commands sharing this process concurrently would share its cwd and
 * environment too, which is precisely the isolation the per-request restore exists to provide.
 */
export function serveBatch(token: string, runFn: (argv: string[]) => Promise<void>): void {
  let buffered = ''
  let chain: Promise<void> = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffered += chunk
    for (;;) {
      const nl = buffered.indexOf('\n')
      if (nl === -1) break
      const line = buffered.slice(0, nl)
      buffered = buffered.slice(nl + 1)
      if (line.trim() === '') continue
      const req = JSON.parse(line) as BatchRequest
      chain = chain.then(async () => {
        const res = await serveOne(req, runFn)
        // Written straight to the descriptor: process.stdout.write is swapped out during a
        // request, and a reply must never end up in the buffer of the command being served.
        process.stdout.write(`${token} ${JSON.stringify(res)}\n`)
      })
    }
  })
  process.stdin.on('end', () => {
    void chain.then(() => {
      process.exitCode = 0
    })
  })
}
