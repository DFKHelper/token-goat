/**
 * Framing tests for the stdio transport that `token-goat mcp-serve` actually runs on.
 *
 * The protocol layer is covered against the reference SDK in tests/mcp_jsonrpc.test.ts, but that
 * runs over an in-memory transport pair -- which is exactly the injected-seam shape CLAUDE.md
 * warns about: the transport the tests use is not the transport that ships. The built bundle is
 * driven over real pipes by the `mcp-serve` case in tests/helpers/matrix_cases.ts, and that proves
 * the happy path end to end. What neither covers is the framing itself, because a local pipe
 * delivers small writes whole and never produces the cases that break a naive reader.
 *
 * So these drive the transport over fake streams and force the splits the OS would otherwise have
 * to be unlucky enough to produce: a message arriving in pieces, several messages arriving in one
 * chunk, a split landing mid-multibyte-character, CRLF line endings, and a peer that never sends a
 * newline at all.
 */
import { PassThrough } from 'node:stream'

import { describe, expect, it } from 'vitest'

import type { JsonRpcMessage } from '../src/mcp_jsonrpc.js'
import { STDIO_MAX_BUFFER_BYTES, StdioServerTransport } from '../src/mcp_stdio.js'

interface Harness {
  stdin: PassThrough
  stdout: PassThrough
  transport: StdioServerTransport
  received: JsonRpcMessage[]
  errors: Error[]
  written: () => string
}

async function harness(): Promise<Harness> {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const chunks: Buffer[] = []
  stdout.on('data', (c: Buffer) => chunks.push(c))
  const transport = new StdioServerTransport(stdin, stdout)
  const received: JsonRpcMessage[] = []
  const errors: Error[] = []
  transport.onmessage = (m) => received.push(m)
  transport.onerror = (e) => errors.push(e)
  await transport.start()
  return { stdin, stdout, transport, received, errors, written: () => Buffer.concat(chunks).toString('utf8') }
}

const REQUEST = { jsonrpc: '2.0' as const, id: 1, method: 'tools/list' }

describe('StdioServerTransport framing', () => {
  it('reassembles one message split across several chunks', async () => {
    const h = await harness()
    const line = `${JSON.stringify(REQUEST)}\n`
    // A single JSON object routinely spans multiple 'data' events on a real pipe; a reader that
    // treats each chunk as a message loses every request larger than the pipe's chunk size.
    for (let i = 0; i < line.length; i += 7) h.stdin.write(line.slice(i, i + 7))
    expect(h.received).toEqual([REQUEST])
    expect(h.errors).toEqual([])
  })

  it('delivers several messages that arrive in one chunk, in order', async () => {
    const h = await harness()
    const three = [1, 2, 3].map((id) => ({ ...REQUEST, id }))
    h.stdin.write(three.map((m) => `${JSON.stringify(m)}\n`).join(''))
    expect(h.received).toEqual(three)
  })

  it('holds a trailing partial message until its newline arrives', async () => {
    const h = await harness()
    h.stdin.write(`${JSON.stringify(REQUEST)}\n${JSON.stringify({ ...REQUEST, id: 2 })}`)
    // The second has no newline yet, so it is not a message.
    expect(h.received).toEqual([REQUEST])
    h.stdin.write('\n')
    expect(h.received).toEqual([REQUEST, { ...REQUEST, id: 2 }])
  })

  it('survives a chunk boundary inside a multibyte character', async () => {
    const h = await harness()
    const message = { ...REQUEST, params: { text: 'naïve — 日本語' } }
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, 'utf8')
    // Decoding each chunk on arrival would turn the split bytes into replacement characters and
    // the JSON would parse to the wrong string -- silently, since it still parses. Buffering the
    // bytes and decoding only a complete line is what avoids it.
    const cut = bytes.indexOf(Buffer.from('—', 'utf8')) + 1
    h.stdin.write(bytes.subarray(0, cut))
    h.stdin.write(bytes.subarray(cut))
    expect(h.received).toEqual([message])
  })

  it('accepts CRLF line endings, including a bare CRLF blank line', async () => {
    const h = await harness()
    // Anything writing to us through a Windows pipe may terminate with CRLF. Stated precisely,
    // because deleting the `\r$` strip in drain() does NOT make this red: JSON.parse treats the
    // trailing carriage return as whitespace. What this does guard is the framing -- splitting on
    // \n rather than on \r\n, so a CRLF stream is still cut into messages at all -- and the blank
    // line below, which arrives as "\r" and must be skipped rather than reported as malformed.
    h.stdin.write(`${JSON.stringify(REQUEST)}\r\n\r\n${JSON.stringify({ ...REQUEST, id: 2 })}\r\n`)
    expect(h.received).toEqual([REQUEST, { ...REQUEST, id: 2 }])
    expect(h.errors).toEqual([])
  })

  it('reports a malformed line and keeps going instead of dropping the session', async () => {
    const h = await harness()
    h.stdin.write('{not json at all\n')
    h.stdin.write(`${JSON.stringify(REQUEST)}\n`)
    expect(h.errors).toHaveLength(1)
    // The next message still arrives: one bad line is not a reason to hang up on a working client.
    expect(h.received).toEqual([REQUEST])
  })

  it('ignores blank lines', async () => {
    const h = await harness()
    h.stdin.write(`\n\n${JSON.stringify(REQUEST)}\n\n`)
    expect(h.received).toEqual([REQUEST])
    expect(h.errors).toEqual([])
  })

  it('closes rather than growing without bound when a peer never sends a newline', async () => {
    const h = await harness()
    let closed = 0
    h.transport.onclose = () => (closed += 1)
    const megabyte = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 11; i += 1) h.stdin.write(megabyte)
    // Without the cap this is a memory-exhaustion path reachable by anything that can write to our
    // stdin: the buffer grows for as long as the peer withholds a single byte.
    expect(h.errors.some((e) => /read buffer exceeded/i.test(e.message))).toBe(true)
    expect(closed).toBe(1)
    expect(STDIO_MAX_BUFFER_BYTES).toBe(10 * 1024 * 1024)
  })

  it('writes each outgoing message as one newline-terminated line', async () => {
    const h = await harness()
    await h.transport.send({ jsonrpc: '2.0', id: 1, result: { tools: [] } })
    await h.transport.send({ jsonrpc: '2.0', id: 2, result: {} })
    const out = h.written()
    expect(out).toBe('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n{"jsonrpc":"2.0","id":2,"result":{}}\n')
    // A message containing a newline of its own would break the framing for the reader; JSON
    // encoding escapes it, and this pins that the encoder, not the raw text, is what goes out.
    await h.transport.send({ jsonrpc: '2.0', id: 3, result: { text: 'a\nb' } })
    expect(h.written().split('\n').filter((l) => l.length > 0)).toHaveLength(3)
  })

  it('stops listening on close and leaves another reader of the same stdin alone', async () => {
    const h = await harness()
    const other: Buffer[] = []
    h.stdin.on('data', (c: Buffer) => other.push(c))
    await h.transport.close()
    h.stdin.write(`${JSON.stringify(REQUEST)}\n`)
    // Our handler is gone...
    expect(h.received).toEqual([])
    // ...but the stream was not paused out from under the other listener, which is why close()
    // checks the remaining listener count instead of pausing unconditionally.
    expect(Buffer.concat(other).toString('utf8')).toContain('tools/list')
  })

  it('refuses to start twice', async () => {
    const h = await harness()
    // A second start would attach a second 'data' listener to the same stream and every message
    // would be handled twice.
    await expect(h.transport.start()).rejects.toThrow(/already started/i)
  })
})
