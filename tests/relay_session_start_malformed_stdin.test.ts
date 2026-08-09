import { tempConfigPath } from './helpers/temp-config.js'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Redirect configPath()/globalDbPath() to per-test-file temp locations, mirroring
// tests/hooks_session_start.test.ts's config mock, so the session_start_reminder gate
// and countSymbols() lookups this suite exercises are deterministic.
vi.mock('../src/constants.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return {
    ...original,
    configPath: () => _testConfigPath,
    globalDbPath: () => _testDbPath,
  }
})

const _testConfigPath = tempConfigPath('tg-relay-session-start-config.toml')
const _testDbPath = tempConfigPath('tg-relay-session-start-db.sqlite')

import { relay } from '../src/relay.js'
import '../src/hooks_session_start.js' // side-effect: registers sessionStartHandler on session_start
import { defaultConfig, invalidateConfigCache, saveConfig } from '../src/config.js'

/** Replace process.stdin with a fake emitter and capture process.stdout writes (mirrors relay.test.ts's withFakeIo). */
function withFakeIo(): { emit: (payload: string) => void; written: () => string; restore: () => void } {
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
    written: () => out,
    restore(): void {
      writeSpy.mockRestore()
      if (origStdin) Object.defineProperty(process, 'stdin', origStdin)
    },
  }
}

let io: ReturnType<typeof withFakeIo>

beforeEach(() => {
  io = withFakeIo()
  // Deliberately NOT clearModuleCaches() here: it resets the hook registry (see
  // hook_registry.ts's registerReset(clearHooks)), and sessionStartHandler is only
  // ever registered once, as a side effect of importing hooks_session_start.js above
  // -- clearing the registry per-test would permanently unregister it for every test
  // in this file with no re-registration path.
  invalidateConfigCache()
  for (const p of [_testConfigPath, _testDbPath]) {
    try {
      fs.rmSync(p)
    } catch {
      // absent is fine
    }
  }
})

afterEach(() => {
  io.restore()
  for (const p of [_testConfigPath, _testDbPath]) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

describe('relay(session_start) with a malformed stdin payload (regression: relay() previously collapsed any JSON.parse failure — e.g. a cwd value with a raw, un-escaped backslash — straight to a bare {} pass-through, silently skipping every handler, including sessionStartHandler\'s own designed-in GENERIC_REMINDER degrade path for a missing/unusable cwd)', () => {
  it('still emits the generic reminder instead of a silent {} when stdin is not valid JSON', async () => {
    // A raw backslash before a non-escape character (`\U`) is invalid JSON and makes
    // JSON.parse throw -- exactly what a naive, non-JSON-aware caller produces when it
    // string-interpolates a native Windows path (e.g. "C:\Users\...\proj") into the hook
    // payload without escaping it.
    io.emit('{"hook_event_name":"SessionStart","cwd":"C:\\Users\\bad"}')

    await relay('session_start')

    const written = io.written()
    expect(written).not.toBe('{}')
    const parsed = JSON.parse(written) as { hookSpecificOutput?: { additionalContext?: string } }
    const context = parsed.hookSpecificOutput?.additionalContext
    expect(context).toBeDefined()
    expect(context).toContain('token-goat index .')
    expect(context).toContain('Read/Grep tools')
  })

  it('still emits {} (pass) on malformed stdin when hints.session_start_reminder is disabled — a malformed payload must not turn a deliberate opt-out into an emitted reminder', async () => {
    const cfg = defaultConfig()
    cfg.hints.session_start_reminder = false
    saveConfig(cfg)
    invalidateConfigCache()

    io.emit('{"hook_event_name":"SessionStart","cwd":"C:\\Users\\bad"}')

    await relay('session_start')

    expect(io.written()).toBe('{}')
  })
})
