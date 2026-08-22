/**
 * The stdio transport for token-goat's MCP server -- newline-delimited JSON over the process's own
 * stdin and stdout, which is the only transport `token-goat mcp-serve` has ever offered.
 *
 * Split out from mcp_jsonrpc.ts because it is the one piece that touches the process: the protocol
 * layer stays testable over an in-memory pair, and this file is what a real client talks to.
 *
 * Two properties are load-bearing and easy to break:
 *
 * - **stdout carries the protocol and nothing else.** A stray `console.log` anywhere in the server
 *   corrupts the stream and the client sees a parse error rather than a message. That rule is
 *   older than this file (see tests/guards/hook_stdout_console_calls.test.ts, which enforces it for
 *   the hook path for the same reason) and it is why every tool handler in mcp_server.ts captures
 *   its own output instead of printing.
 * - **A partial read is not a message.** Data arrives in whatever chunks the OS feels like, so a
 *   single JSON object can span several `data` events and one event can carry several objects.
 *   Buffering until a newline, then splitting on it, is the whole framing.
 *
 * The buffer is capped. Without a cap a peer that never sends a newline grows it without bound,
 * which is a memory-exhaustion path reachable by anything that can write to our stdin. The limit
 * matches the SDK's 10 MB, comfortably above any real request: token-goat's own tool arguments are
 * paths and short strings, and the largest is a compress_text payload.
 */

import process from 'node:process'
import type { Readable, Writable } from 'node:stream'

import type { JsonRpcMessage, McpTransport } from './mcp_jsonrpc.js'

/** Matches the SDK's `STDIO_DEFAULT_MAX_BUFFER_SIZE`. */
export const STDIO_MAX_BUFFER_BYTES = 10 * 1024 * 1024

export class StdioServerTransport implements McpTransport {
  private readonly stdin: Readable
  private readonly stdout: Writable
  private buffer: Buffer | undefined
  private started = false

  onmessage: ((message: JsonRpcMessage) => void) | undefined
  onclose: (() => void) | undefined
  onerror: ((error: Error) => void) | undefined

  // Arrow properties rather than bound methods so `off()` can remove the exact same function
  // reference `on()` added -- a fresh `.bind(this)` at removal time would leave the listener
  // attached, and a second `mcp-serve` in the same process would then see every message twice.
  private readonly ondata = (chunk: Buffer): void => {
    const size = (this.buffer?.length ?? 0) + chunk.length
    if (size > STDIO_MAX_BUFFER_BYTES) {
      this.buffer = undefined
      this.onerror?.(new Error(`MCP stdio read buffer exceeded ${STDIO_MAX_BUFFER_BYTES} bytes`))
      void this.close()
      return
    }
    this.buffer = this.buffer === undefined ? chunk : Buffer.concat([this.buffer, chunk])
    this.drain()
  }

  private readonly onstreamerror = (error: Error): void => {
    this.onerror?.(error)
  }

  constructor(stdin: Readable = process.stdin, stdout: Writable = process.stdout) {
    this.stdin = stdin
    this.stdout = stdout
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('StdioServerTransport already started')
    this.started = true
    this.stdin.on('data', this.ondata)
    this.stdin.on('error', this.onstreamerror)
    return Promise.resolve()
  }

  /**
   * Consumes every complete line currently buffered. A line that is not valid JSON is reported and
   * skipped rather than closing the connection: one malformed message is not a reason to drop a
   * working session, and the next line may well be fine.
   */
  private drain(): void {
    for (;;) {
      const buffer = this.buffer
      if (buffer === undefined) return
      const index = buffer.indexOf('\n')
      if (index === -1) return
      // `\r$` is stripped so a client writing CRLF -- which anything speaking to us through a
      // Windows pipe may well do -- hands the parser exactly the message text. Being precise about
      // what it buys: `JSON.parse` already tolerates a trailing carriage return as whitespace, so
      // removing this line does not break CRLF input, and a test claiming it does would be
      // guarding nothing. It stays because the reference implementation does it and because the
      // one thing that must never depend on the parser's tolerance is the framing itself.
      const line = buffer.toString('utf8', 0, index).replace(/\r$/, '')
      this.buffer = buffer.subarray(index + 1)
      if (line.trim().length === 0) continue
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line) as JsonRpcMessage
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)))
        continue
      }
      this.onmessage?.(message)
    }
  }

  /**
   * Resolves once the message is handed off. Waiting for `drain` when the stream says it is full
   * is what keeps a long reply from being silently truncated on a slow or small pipe.
   */
  send(message: JsonRpcMessage): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.stdout.write(`${JSON.stringify(message)}\n`)) resolve()
      else this.stdout.once('drain', resolve)
    })
  }

  async close(): Promise<void> {
    this.stdin.off('data', this.ondata)
    this.stdin.off('error', this.onstreamerror)
    // Only pause the stream if nobody else is reading it. Pausing a shared stdin would starve
    // whatever else in the process is listening, which is why the SDK checks the same thing.
    if (this.stdin.listenerCount('data') === 0) this.stdin.pause()
    this.buffer = undefined
    this.onclose?.()
    return Promise.resolve()
  }
}
