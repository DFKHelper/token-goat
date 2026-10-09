/** Reading a JSON payload off stdin, with a timeout and a byte cap. Its own module rather than part of relay.ts, though relay is its main caller. relay.ts side-effect-imports every hook handler in order to register them, so importing anything from it pulls the entire hook subsystem -- every handler, the whole bash tool-filter registry, the HTML extractor -- into the importer's eager module graph. cli_statusline.ts wants only this function, and paid about 1 MB of parse for it on every invocation. Nothing here depends on a hook. */

/** Default stdin IDLE timeout: long enough for a piped payload, short enough that a hung upstream never stalls the tool call. Measured between chunks, not from the start of the read -- see readStdinJson. */
const DEFAULT_STDIN_TIMEOUT_MS = 5000

/** How many idle windows a stdin may stay silent before its FIRST byte; see armIdle in readStdinJson. */
const FIRST_BYTE_GRACE_FACTOR = 4

/** The tail of every idle window spent confirming the silence rather than waiting for it: the window is `ms - confirm` of waiting plus `confirm` of confirming, so the total time a silent sender is given is unchanged. See confirmSilence in readStdinJson. */
const IDLE_CONFIRM_MS = 50

/** Absolute ceiling on one stdin read, however busy the stream stays. The idle timeout alone cannot bound total duration: a sender that trickles one byte every four seconds resets it forever. This is the backstop for that, set far above the idle timeout so it is only ever reached by a stream that really is pathological -- a payload arriving steadily takes seconds, not a minute (a 50 MB payload delivered in one write completes in well under a second). */
const MAX_STDIN_WALL_MS = 60_000

/** Default cap on accumulated stdin bytes before readStdinJson aborts the read early, rather than relying solely on DEFAULT_STDIN_TIMEOUT_MS to eventually stop a malformed or adversarial stream. Matches the magnitude of bash_runner.ts's MAX_CAPTURE_BYTES (32 MiB), the closest existing precedent for bounding an unbounded input stream in this codebase, doubled to leave headroom for JSON-string-escaping overhead on the largest legitimate payload today (a captured bash output embedded in a tool_response). */
const MAX_STDIN_BYTES = 64 * 1024 * 1024

/** The parsed value when the buffered bytes are already one complete JSON object or array, else undefined. Scalars are not accepted: a prefix of a number or `true` parses, and no payload this module reads is one. */
function completeDocument(chunks: Buffer[]): { value: object } | undefined {
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null ? { value } : undefined
  } catch {
    return undefined
  }
}

/** Read all of stdin and parse it as JSON, with a timeout. Resolves to the parsed value on success. Rejects when stdin goes `timeoutMs` without delivering anything, when the whole read exceeds {@link MAX_STDIN_WALL_MS}, when the stream errors, or when the accumulated text is not valid JSON. Callers treat any rejection as "pass" — see {@link relay}. `timeoutMs` is an IDLE timeout: it is restarted every time a chunk arrives. It used to be armed once and never rescheduled, which made it an absolute deadline instead, and that quietly capped the payload this function can accept at whatever fits through the pipe in five seconds -- about 13 MB/s -- rather than at {@link MAX_STDIN_BYTES}, the 64 MB the module deliberately allows. A payload that streamed steadily for longer than five seconds was discarded mid-delivery even though stdin was never idle for a moment, and because `relay` turns any rejection into an empty payload the failure was silent: exit 0, valid `{}` on stdout, and one stderr line that reads like a benign "no tool_name" notice. Read dedup, image shrinking and the dirty-queue enqueue all stop for that call and the index goes stale, with nothing to indicate why. Reproduced against the built bundle by writing a valid 3 MB payload in 100 KB chunks 200 ms apart: stdin idle for at most 200 ms at a time, total 6.4 s, and the hook answered `{}`. Slow pipes are ordinary -- Windows named pipes under load, a WSL or VM boundary, a bridge shim relaying through another process. */
export function readStdinJson(
  timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS,
  maxBytes: number = MAX_STDIN_BYTES,
  firstByteGraceFactor: number = FIRST_BYTE_GRACE_FACTOR,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = []
    let totalBytes = 0
    let settled = false

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      clearTimeout(wallTimer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      fn()
    }

    // Idle with bytes already buffered is not a dead sender when those bytes are a whole JSON object or array: a starved process can see the payload but not yet the pipe's EOF, which is a separate read completion that lands later, and the harness did send everything (measured: 9 to 13 of 24 starved children rejected with the full 8-byte payload buffered). A document that parses to an object is complete by construction, so it is accepted; anything that does not parse still rejects as before. A fired timer is not yet proof the sender went quiet: each event-loop turn runs its timers before the poll that delivers I/O, so a process starved of CPU past the window wakes to its own timeout with the payload already in the pipe, and relay then passes `{}` for a hook the harness did send. setImmediate runs after that poll, so a chunk it delivers still counts.
    const confirmSilence = (confirmMs: number): void => {
      const seen = totalBytes
      const armedAt = performance.now()
      idleTimer = setTimeout(() => {
        setImmediate(() => {
          if (totalBytes !== seen) return
          // A confirmation that itself ran late means the loop was starved through it, so the silence was never observed: take it again.
          if (performance.now() - armedAt > confirmMs * 2) {
            confirmSilence(confirmMs)
            return
          }
          finish(() => {
            const done = completeDocument(chunks)
            if (done !== undefined) resolve(done.value)
            else reject(new Error('readStdinJson: timed out waiting for stdin'))
          })
        })
      }, confirmMs)
    }
    // The last IDLE_CONFIRM_MS of the window is a second timer, not a second setImmediate: on a Windows pipe the first read is a thread-pool wait followed by the read proper, so the bytes can land several loop turns after the timer (19 of 24 starved children still rejected after one deferral), and only real time spent in the poll lets them in.
    const armIdle = (ms: number = timeoutMs): ReturnType<typeof setTimeout> => {
      const confirmMs = Math.min(IDLE_CONFIRM_MS, Math.floor(ms / 2))
      return setTimeout(() => confirmSilence(confirmMs), ms - confirmMs)
    }
    // Before the first byte the window is FIRST_BYTE_GRACE_FACTOR times wider: a starved process can see its timer fire several loop turns before the pipe's first read completes (measured: a hook whose idle timer fired at 5.3 s with the payload written at spawn, under 50 busy processes), so silence at that point is not yet evidence of a dead sender. A stdin that never delivers still gives up, just later.
    let idleTimer = armIdle(timeoutMs * firstByteGraceFactor)
    // Unbounded-duration backstop, never rescheduled -- see MAX_STDIN_WALL_MS.
    const wallTimer = setTimeout(() => {
      finish(() => {
        process.stdin.destroy()
        reject(new Error(`readStdinJson: stdin took longer than ${MAX_STDIN_WALL_MS} ms`))
      })
    }, MAX_STDIN_WALL_MS)

    const onData = (chunk: Buffer): void => {
      // Restart the idle window: this timeout bounds a stalled sender, not a slow one.
      clearTimeout(idleTimer)
      idleTimer = armIdle()
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        // Detaching listeners alone leaves the stream flowing at the OS/event-loop level; destroy it so the fd is released and nothing keeps buffering data no one will read.
        finish(() => {
          process.stdin.destroy()
          reject(new Error(`readStdinJson: stdin exceeded ${maxBytes} bytes`))
        })
        return
      }
      chunks.push(chunk)
    }
    const onEnd = (): void => {
      finish(() => {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text === '') {
          reject(new Error('readStdinJson: empty stdin'))
          return
        }
        try {
          resolve(JSON.parse(text))
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    }
    const onError = (err: unknown): void => {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    }

    process.stdin.on('data', onData)
    process.stdin.on('end', onEnd)
    process.stdin.on('error', onError)
  })
}
