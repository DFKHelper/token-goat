/**
 * Reading a JSON payload off stdin, with a timeout and a byte cap.
 *
 * Its own module rather than part of relay.ts, though relay is its main caller. relay.ts
 * side-effect-imports every hook handler in order to register them, so importing anything from it
 * pulls the entire hook subsystem -- every handler, the whole bash tool-filter registry, the HTML
 * extractor -- into the importer's eager module graph. cli_statusline.ts wants only this function,
 * and paid about 1 MB of parse for it on every invocation. Nothing here depends on a hook.
 */

/** Default stdin IDLE timeout: long enough for a piped payload, short enough
 * that a hung upstream never stalls the tool call. Measured between chunks, not
 * from the start of the read -- see readStdinJson. */
const DEFAULT_STDIN_TIMEOUT_MS = 5000

/**
 * Absolute ceiling on one stdin read, however busy the stream stays.
 *
 * The idle timeout alone cannot bound total duration: a sender that trickles one byte every
 * four seconds resets it forever. This is the backstop for that, set far above the idle
 * timeout so it is only ever reached by a stream that really is pathological -- a payload
 * arriving steadily takes seconds, not a minute (a 50 MB payload delivered in one write
 * completes in well under a second).
 */
const MAX_STDIN_WALL_MS = 60_000

/**
 * Default cap on accumulated stdin bytes before readStdinJson aborts the read
 * early, rather than relying solely on DEFAULT_STDIN_TIMEOUT_MS to eventually
 * stop a malformed or adversarial stream. Matches the magnitude of
 * bash_runner.ts's MAX_CAPTURE_BYTES (32 MiB), the closest existing precedent
 * for bounding an unbounded input stream in this codebase, doubled to leave
 * headroom for JSON-string-escaping overhead on the largest legitimate
 * payload today (a captured bash output embedded in a tool_response).
 */
export const MAX_STDIN_BYTES = 64 * 1024 * 1024

/**
 * Read all of stdin and parse it as JSON, with a timeout.
 *
 * Resolves to the parsed value on success. Rejects when stdin goes `timeoutMs`
 * without delivering anything, when the whole read exceeds
 * {@link MAX_STDIN_WALL_MS}, when the stream errors, or when the accumulated
 * text is not valid JSON. Callers treat any rejection as "pass" — see {@link relay}.
 *
 * `timeoutMs` is an IDLE timeout: it is restarted every time a chunk arrives. It used to be
 * armed once and never rescheduled, which made it an absolute deadline instead, and that
 * quietly capped the payload this function can accept at whatever fits through the pipe in
 * five seconds -- about 13 MB/s -- rather than at {@link MAX_STDIN_BYTES}, the 64 MB the
 * module deliberately allows. A payload that streamed steadily for longer than five seconds
 * was discarded mid-delivery even though stdin was never idle for a moment, and because
 * `relay` turns any rejection into an empty payload the failure was silent: exit 0, valid
 * `{}` on stdout, and one stderr line that reads like a benign "no tool_name" notice. Read
 * dedup, image shrinking and the dirty-queue enqueue all stop for that call and the index
 * goes stale, with nothing to indicate why. Reproduced against the built bundle by writing a
 * valid 3 MB payload in 100 KB chunks 200 ms apart: stdin idle for at most 200 ms at a time,
 * total 6.4 s, and the hook answered `{}`. Slow pipes are ordinary -- Windows named pipes
 * under load, a WSL or VM boundary, a bridge shim relaying through another process.
 */
export function readStdinJson(
  timeoutMs: number = DEFAULT_STDIN_TIMEOUT_MS,
  maxBytes: number = MAX_STDIN_BYTES,
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

    let idleTimer = setTimeout(() => {
      finish(() => reject(new Error('readStdinJson: timed out waiting for stdin')))
    }, timeoutMs)
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
      idleTimer = setTimeout(() => {
        finish(() => reject(new Error('readStdinJson: timed out waiting for stdin')))
      }, timeoutMs)
      totalBytes += chunk.length
      if (totalBytes > maxBytes) {
        // Detaching listeners alone leaves the stream flowing at the OS/event-loop level;
        // destroy it so the fd is released and nothing keeps buffering data no one will read.
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
