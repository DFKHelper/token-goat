/**
 * Reading a JSON payload off stdin, with a timeout and a byte cap.
 *
 * Its own module rather than part of relay.ts, though relay is its main caller. relay.ts
 * side-effect-imports every hook handler in order to register them, so importing anything from it
 * pulls the entire hook subsystem -- every handler, the whole bash tool-filter registry, the HTML
 * extractor -- into the importer's eager module graph. cli_statusline.ts wants only this function,
 * and paid about 1 MB of parse for it on every invocation. Nothing here depends on a hook.
 */

/** Default stdin read timeout: long enough for a piped payload, short enough
 * that a hung upstream never stalls the tool call. */
const DEFAULT_STDIN_TIMEOUT_MS = 5000

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
 * Resolves to the parsed value on success. Rejects when stdin yields no data
 * before `timeoutMs`, when the stream errors, or when the accumulated text is
 * not valid JSON. Callers treat any rejection as "pass" — see {@link relay}.
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
      clearTimeout(timer)
      process.stdin.removeListener('data', onData)
      process.stdin.removeListener('end', onEnd)
      process.stdin.removeListener('error', onError)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() => reject(new Error('readStdinJson: timed out waiting for stdin')))
    }, timeoutMs)

    const onData = (chunk: Buffer): void => {
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
