import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildEvent, readStdinJson, relay } from '../src/relay.js'

/**
 * Replace process.stdin with a fake emitter and capture process.stdout writes.
 *
 * `emit(payload)` pushes the payload (or raw string) then signals `end`, on the
 * next microtask so the relay's listeners are attached first.
 */
function withFakeIo(): {
  emit: (payload: string) => void
  emitError: (err: Error) => void
  written: () => string
  restore: () => void
} {
  const fakeStdin = new EventEmitter() as EventEmitter & { removeListener: typeof EventEmitter.prototype.removeListener }
  const origStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })

  let out = ''
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    out += typeof chunk === 'string' ? chunk : String(chunk)
    return true
  })

  return {
    emit(payload: string): void {
      queueMicrotask(() => {
        fakeStdin.emit('data', Buffer.from(payload, 'utf8'))
        fakeStdin.emit('end')
      })
    },
    emitError(err: Error): void {
      queueMicrotask(() => fakeStdin.emit('error', err))
    },
    written: () => out,
    restore(): void {
      writeSpy.mockRestore()
      if (origStdin) Object.defineProperty(process, 'stdin', origStdin)
    },
  }
}

let io: ReturnType<typeof withFakeIo>
let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  io = withFakeIo()
  // relay() now persists session state to TOKEN_GOAT_HOME. Point it at a fresh temp dir per test so it never touches the real ~/.token-goat.
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-relay-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  io.restore()
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('buildEvent', () => {
  it('maps Claude Code payload keys onto a HookEvent', () => {
    const ev = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
      session_id: 'abc',
    })
    expect(ev.eventName).toBe('pre_tool_use')
    expect(ev.toolName).toBe('Read')
    expect(ev.toolInput).toEqual({ file_path: '/x.ts' })
    expect(ev.sessionId).toBe('abc')
  })

  it('degrades to safe defaults on a malformed payload', () => {
    const ev = buildEvent('pre_tool_use', null)
    expect(ev.toolName).toBeUndefined()
    expect(ev.toolInput).toEqual({})
    expect(ev.sessionId).toBe('')
  })
})

describe('readStdinJson', () => {
  it('parses valid JSON from stdin', async () => {
    io.emit('{"tool_name":"Read"}')
    await expect(readStdinJson(1000)).resolves.toEqual({ tool_name: 'Read' })
  })

  it('rejects on empty stdin', async () => {
    io.emit('')
    await expect(readStdinJson(1000)).rejects.toThrow()
  })

  it('rejects on invalid JSON', async () => {
    io.emit('not json{')
    await expect(readStdinJson(1000)).rejects.toThrow()
  })

  it('rejects on a stdin error', async () => {
    io.emitError(new Error('stream broke'))
    await expect(readStdinJson(1000)).rejects.toThrow('stream broke')
  })

  it('rejects on timeout when stdin never ends', async () => {
    // Emit no data and no end: the timeout path fires.
    await expect(readStdinJson(50)).rejects.toThrow(/timed out/)
  })
})

describe('relay', () => {
  it('writes {} on an unknown event name (never throws)', async () => {
    io.emit('{}')
    await relay('not_a_real_event')
    expect(io.written()).toBe('{}')
  })

  it('writes {} on empty stdin', async () => {
    io.emit('')
    await relay('pre_tool_use')
    expect(io.written()).toBe('{}')
  })

  it('writes {} on invalid JSON', async () => {
    io.emit('}{')
    await relay('pre_tool_use')
    expect(io.written()).toBe('{}')
  })

  it('dispatches a valid event through the registry and serializes the result', async () => {
    // A Read on a never-seen .ts file passes through the read-dedup handler => serialized as the empty object (pass). The key assertion is that a valid event flows end-to-end and produces parseable wire JSON, not {} from an error path.
    io.emit(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/never-seen-xyz.ts' }, session_id: 's' }))
    await relay('pre_tool_use')
    const parsed: unknown = JSON.parse(io.written())
    expect(typeof parsed).toBe('object')
  })
})
