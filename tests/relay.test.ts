import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { registerHook } from '../src/hook_registry.js'
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
  destroyed: () => boolean
  restore: () => void
} {
  const fakeStdin = new EventEmitter() as EventEmitter & {
    removeListener: typeof EventEmitter.prototype.removeListener
    destroy: () => void
  }
  let wasDestroyed = false
  fakeStdin.destroy = (): void => {
    wasDestroyed = true
  }
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
    destroyed: () => wasDestroyed,
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

  it('rejects once accumulated stdin exceeds maxBytes, instead of buffering unbounded until the timeout fires (regression: M10)', async () => {
    // A generous timeout (5000ms) so the size cap — not the timeout — is what
    // actually stops the read. Without the cap this payload would simply
    // buffer in full and parse successfully well within the timeout.
    io.emit('x'.repeat(50))
    await expect(readStdinJson(5000, 10)).rejects.toThrow(/exceeded 10 bytes/)
  })

  it('still accepts a payload at or under maxBytes', async () => {
    io.emit('{"a":1}')
    await expect(readStdinJson(1000, 1000)).resolves.toEqual({ a: 1 })
  })

  it('destroys the stdin stream once the size cap is hit, instead of leaving it flowing after the application stops consuming it (regression: cap only detached listeners, never tore down the stream)', async () => {
    io.emit('x'.repeat(50))
    await expect(readStdinJson(5000, 10)).rejects.toThrow(/exceeded 10 bytes/)
    expect(io.destroyed()).toBe(true)
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

describe('relay tool-name normalization (regression: M49 — toolName filters inert under Codex)', () => {
  const ENV_KEYS = ['TERM_PROGRAM', 'CLAUDE_CODE_VERSION', 'CODEX_SESSION_ID', 'OPENCODE_SESSION_ID'] as const
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('normalizes a raw Codex tool_name through the real relay() path so a toolName-filtered handler actually matches', async () => {
    process.env['CODEX_SESSION_ID'] = 'codex-test-session'

    let observedToolName: string | undefined
    registerHook(
      'pre_tool_use',
      (event) => {
        observedToolName = event.toolName
        return { hookType: 'pass' }
      },
      { toolName: 'Bash' },
    )

    // Codex's raw hook payload carries its own snake_case tool name ('bash'), not
    // token-goat's canonical 'Bash'. Before this fix, relay() forwarded tool_name
    // straight into buildEvent() with no normalization, so a handler registered
    // via registerHook(..., { toolName: 'Bash' }) never matched — it silently
    // never ran for a real Codex invocation.
    io.emit(
      JSON.stringify({ tool_name: 'bash', tool_input: { command: 'echo hi' }, session_id: 's' }),
    )
    await relay('pre_tool_use')

    expect(observedToolName).toBe('Bash')
  })

  it('leaves an already-canonical Claude Code tool_name unchanged', async () => {
    let observedToolName: string | undefined
    registerHook(
      'pre_tool_use',
      (event) => {
        observedToolName = event.toolName
        return { hookType: 'pass' }
      },
      { toolName: 'Bash' },
    )

    io.emit(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' }, session_id: 's' }),
    )
    await relay('pre_tool_use')

    expect(observedToolName).toBe('Bash')
  })
})
