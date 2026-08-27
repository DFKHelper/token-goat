import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HARNESS_DETECTION_ENV_KEYS } from './helpers/harness-env.js'

import { registerHook } from '../src/hook_registry.js'
import { clearModuleCaches } from '../src/reset.js'
import { buildEvent, readStdinJson, relay } from '../src/relay.js'
import { getSessionId } from '../src/session.js'

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

  it('resolves the session id from a grok-shaped camelCase pre_compact payload (sessionId, not session_id)', () => {
    // Grok inherits claudecode's full 7-event hook wiring but sends camelCase
    // payloads. On non-tool events (pre_compact/stop/notification/...) there is
    // no session_id key, so without a sessionId fallback the state loads/saves
    // under an empty string.
    const ev = buildEvent('pre_compact', { sessionId: 'grok-sess-1' })
    expect(ev.sessionId).toBe('grok-sess-1')
  })

  it('prefers snake_case session_id over camelCase sessionId when both are present', () => {
    const ev = buildEvent('stop', { session_id: 'snake', sessionId: 'camel' })
    expect(ev.sessionId).toBe('snake')
  })

  it('extracts agent_id when present (subagent hook invocation)', () => {
    const ev = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
      session_id: 's1',
      agent_id: 'agent-42',
    })
    expect(ev.agentId).toBe('agent-42')
  })

  it('leaves agentId undefined on a main-thread payload (no agent_id)', () => {
    const ev = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
      session_id: 's1',
    })
    expect(ev.agentId).toBeUndefined()
  })

  it('extracts traceparent and tracestate from wire payload', () => {
    const ev = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
      session_id: 's1',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'rojo=1,congo=2',
    })
    expect(ev.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(ev.tracestate).toBe('rojo=1,congo=2')
  })

  it('supports camelCase traceParent and traceState', () => {
    const ev = buildEvent('pre_tool_use', {
      tool_name: 'Read',
      tool_input: { file_path: '/x.ts' },
      session_id: 's1',
      traceParent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      traceState: 'vendor=abc',
    })
    expect(ev.traceparent).toBe('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')
    expect(ev.tracestate).toBe('vendor=abc')
  })

  it('falls back to environment TRACEPARENT / TRACESTATE if absent in payload', () => {
    const origTraceparent = process.env['TRACEPARENT']
    const origTracestate = process.env['TRACESTATE']
    try {
      process.env['TRACEPARENT'] = '00-11111111111111111111111111111111-2222222222222222-01'
      process.env['TRACESTATE'] = 'vendor=env'
      const ev = buildEvent('pre_tool_use', {
        tool_name: 'Read',
        tool_input: { file_path: '/x.ts' },
        session_id: 's1',
      })
      expect(ev.traceparent).toBe('00-11111111111111111111111111111111-2222222222222222-01')
      expect(ev.tracestate).toBe('vendor=env')
    } finally {
      if (origTraceparent === undefined) delete process.env['TRACEPARENT']
      else process.env['TRACEPARENT'] = origTraceparent
      if (origTracestate === undefined) delete process.env['TRACESTATE']
      else process.env['TRACESTATE'] = origTracestate
    }
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
  // detectHarness() (bridges/registry.ts) now recognizes more signals than just
  // these four -- CLAUDE_CODE_SESSION_ID/ANTHROPIC_API_KEY (claudecode),
  // CODEX_SESSION (codex), OPENCODE_SESSION (opencode), OPENCLAW_SESSION_ID
  // (openclaw), HERMES_SESSION_ID/HERMES_HOME (hermes), OPENAI_API_KEY/
  // GEMINI_API_KEY/GOOGLE_API_KEY (codex/gemini fallback), and the
  // TOKEN_GOAT_HARNESS_OVERRIDE escape hatch. All of them must be cleared here,
  // not just the original two: this suite runs inside a real Claude Code
  // session, which sets CLAUDE_CODE_SESSION_ID in the test process's ambient
  // environment, so without clearing it the claudecode branch (checked before
  // codex) wins over this test's CODEX_SESSION_ID and silently breaks it.
  const ENV_KEYS = HARNESS_DETECTION_ENV_KEYS
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

  it('normalizes a raw Gemini tool_name through the real relay() path so a toolName-filtered handler actually matches (installGemini restores the bridge harnessForNormalization() previously had no live route to)', async () => {
    process.env['GEMINI_API_KEY'] = 'gemini-test-key'

    let observedToolName: string | undefined
    registerHook(
      'pre_tool_use',
      (event) => {
        observedToolName = event.toolName
        return { hookType: 'pass' }
      },
      { toolName: 'Bash' },
    )

    // Gemini CLI's raw hook payload carries its own snake_case tool name
    // ('run_shell_command'), not token-goat's canonical 'Bash'. Before this
    // fix, harnessForNormalization() collapsed every detected 'gemini' harness
    // down to 'claude', so normalizePayload() never ran its 'gemini' branch
    // and a handler registered via registerHook(..., { toolName: 'Bash' })
    // never matched a real Gemini CLI invocation.
    io.emit(
      JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'echo hi' }, session_id: 's' }),
    )
    await relay('pre_tool_use')

    expect(observedToolName).toBe('Bash')
  })

  it('normalizes a raw grok tool_name/camelCase payload through the real relay() path so a toolName-filtered handler actually matches', async () => {
    // Confirmed empirically (2026-07-09) against grok 0.2.93: grok invokes
    // the same `token-goat hook pre_tool_use` command Claude Code's own
    // ~/.claude/settings.json already registers, but sends an entirely
    // camelCase payload (toolName/toolInput/sessionId, not
    // tool_name/tool_input/session_id) with its own tool-name vocabulary
    // ('run_terminal_command', not 'Bash') -- see hooks_cli.ts's grok branch.
    // GROK_SESSION_ID is set on every hook subprocess grok spawns.
    process.env['GROK_SESSION_ID'] = 'grok-test-session'

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
      JSON.stringify({
        hookEventName: 'pre_tool_use',
        sessionId: 'grok-sess',
        toolName: 'run_terminal_command',
        toolInput: { command: 'echo hi' },
      }),
    )
    await relay('pre_tool_use')

    expect(observedToolName).toBe('Bash')
  })

  it('normalizes a raw Qwen Code tool_name through the real relay() path so a toolName-filtered handler actually matches (regression: harnessForNormalization() collapsed qwen to claude, so every tool-scoped hook was silently dead on Qwen)', async () => {
    // qwen_install.ts wires every hook as `token-goat hook <event> --harness qwen`, which sets TOKEN_GOAT_HARNESS_OVERRIDE=qwen before dispatch -- reproduced here directly. The fixture tool id run_shell_command is Qwen Code's own runtime id for its shell tool (QwenLM/qwen-code packages/core/src/tools/tool-names.ts; coreToolScheduler.ts serializes canonicalToolName(request.name) into the hook payload).
    process.env['TOKEN_GOAT_HARNESS_OVERRIDE'] = 'qwen'

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
      JSON.stringify({ tool_name: 'run_shell_command', tool_input: { command: 'echo hi' }, session_id: 'q' }),
    )
    await relay('pre_tool_use')

    expect(observedToolName).toBe('Bash')
  })
})

describe('relay Gemini deny wire format (regression: Gemini CLI has no output-reshaping bridge -- gemini_install.ts wires `token-goat hook <event>` directly into ~/.gemini/settings.json, with no shim script the way Codex/Copilot CLI have, so serializeOutput\'s wire JSON is exactly what a real Gemini CLI process reads from stdout -- this suite verifies token-goat\'s deny shape against Gemini CLI\'s documented BeforeTool contract instead of merely assuming compatibility, since a plausible fail-open regression here would mean a real Gemini user\'s dangerous-command/confirmed-re-read/dedup denials silently proceed)', () => {
  // Verified against docs/hooks/reference.md in google-gemini/gemini-cli (raw
  // GitHub source fetched directly, 2026-07-09) -- gemini CLI itself is not
  // installed on this machine (checked: `gemini --version`/`where gemini`/npm
  // global list/a recursive $env:USERPROFILE search all came up empty), so
  // this is documentation-verified, not live-dogfooded against a real gemini
  // binary. Relevant excerpts from that doc:
  //   "Common output fields" table: `decision` (string) -- "allow" or "deny"
  //   (alias "block")"; `reason` (string) -- "The feedback/error message
  //   provided when a decision is deny."
  //   "BeforeTool" section, "Relevant Output Fields": `decision`: Set to
  //   "deny" (or "block") to prevent the tool from executing. `reason`:
  //   Required if denied. This text is sent to the agent as a tool error.
  //   BeforeTool has no additionalContext/hookSpecificOutput-wrapped output
  //   field at all (that only exists on AfterTool/SessionStart/BeforeAgent).
  // token-goat's serializeOutput (src/hook_registry.ts) emits exactly
  // {"decision":"block","reason":"<message>"} for every deny, on every
  // harness -- there is no per-harness output branch anywhere in the
  // relay()/hook_registry.ts pipeline. "block" is a documented Gemini alias
  // for "deny", so this already is Gemini's own native BeforeTool shape,
  // with zero translation code required -- the real bug being verified here
  // was that this compatibility was previously assumed, never actually
  // checked against Gemini's real contract or exercised by a test.
  const ENV_KEYS = HARNESS_DETECTION_ENV_KEYS
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    // A real Gemini CLI hook subprocess inherits Gemini CLI's own ambient
    // environment (GEMINI_API_KEY / GOOGLE_API_KEY) -- see
    // harnessForNormalization()'s doc comment in src/relay.ts. Setting this
    // is what makes detectHarness() resolve to 'gemini' for these tests,
    // exactly as it would for a real installed Gemini CLI.
    process.env['GEMINI_API_KEY'] = 'gemini-test-key'
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
  })

  it('serializes a pre_tool_use deny into Gemini BeforeTool\'s documented {decision:"deny"|"block", reason} shape, with no unsupported wrapper fields', async () => {
    registerHook(
      'pre_tool_use',
      () => ({ hookType: 'deny', message: 'blocked by test policy' }),
      { toolName: 'GeminiDenyProbe' },
    )

    io.emit(JSON.stringify({ tool_name: 'GeminiDenyProbe', tool_input: {}, session_id: 'gemini-deny-test' }))
    await relay('pre_tool_use')

    const parsed = JSON.parse(io.written()) as Record<string, unknown>
    // Gemini's BeforeTool schema accepts "deny" or its documented alias "block".
    expect(['deny', 'block']).toContain(parsed['decision'])
    expect(parsed['reason']).toBe('blocked by test policy')
    // BeforeTool has no hookSpecificOutput-wrapped field in its schema at
    // all -- confirm the response is the flat shape Gemini actually parses,
    // not Claude Code's hookSpecificOutput-nested additionalContext shape
    // (used by other hookType variants) leaking into a deny response.
    expect(parsed['hookSpecificOutput']).toBeUndefined()
    expect(Object.keys(parsed).sort()).toEqual(['decision', 'reason'])
  })

  it('actually blocks a real shipping-path deny (hooks_mcp.ts\'s repeated read-only MCP call dedup handler, not a synthetic probe) under Gemini harness detection', async () => {
    const toolName = 'mcp__github__get_file_contents'
    const toolInput = { owner: 'octo', repo: 'demo', path: 'README.md' }
    const sessionId = 'gemini-mcp-dedup-test'

    // First pre_tool_use: nothing cached yet, must pass through untouched.
    io.emit(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: sessionId }))
    await relay('pre_tool_use')
    expect(JSON.parse(io.written())).toEqual({})
    io.restore()
    io = withFakeIo()

    // post_tool_use records the (fake) result so the dedup cache has something to key on.
    io.emit(
      JSON.stringify({
        tool_name: toolName,
        tool_input: toolInput,
        session_id: sessionId,
        tool_response: { output: '# README' },
      }),
    )
    await relay('post_tool_use')
    io.restore()
    io = withFakeIo()

    // Second identical pre_tool_use call: the real production handler must now deny it.
    io.emit(JSON.stringify({ tool_name: toolName, tool_input: toolInput, session_id: sessionId }))
    await relay('pre_tool_use')

    const parsed = JSON.parse(io.written()) as Record<string, unknown>
    expect(['deny', 'block']).toContain(parsed['decision'])
    expect(typeof parsed['reason']).toBe('string')
    expect(parsed['reason'] as string).toContain('already cached this session')
    expect(parsed['hookSpecificOutput']).toBeUndefined()
  })
})

describe('relay seeds CLAUDE_CODE_SESSION_ID from the wire session id on non-Claude-Code harnesses (regression: getSessionId() previously resolved only from that env var, which Claude Code sets itself but Codex/opencode/pi/Gemini/Grok/Copilot/OpenClaw never do -- each hook invocation is a fresh short-lived process, so without seeding, every call on those harnesses got a brand-new random session id from getSessionId(), breaking read-dedup/reread-diffing, context-pressure tiering, and manifest continuity)', () => {
  const ENV_KEYS = HARNESS_DETECTION_ENV_KEYS
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    // A real Codex hook subprocess sets CODEX_SESSION_ID in its own ambient environment (see
    // harnessForNormalization()'s Codex branch), but -- unlike Claude Code -- never sets
    // CLAUDE_CODE_SESSION_ID. Simulate that: harness detection resolves to 'codex', while
    // getSessionId() has nothing to resolve from except what relay() seeds from the wire.
    process.env['CODEX_SESSION_ID'] = 'codex-test-session'
    // getSessionId() memoizes its result in a module-level variable; reset it (and every other
    // session.ts global) so this suite starts from a clean slate regardless of test order.
    clearModuleCaches()
  })

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]
      else process.env[k] = savedEnv[k]
    }
    clearModuleCaches()
  })

  it('seeds CLAUDE_CODE_SESSION_ID from event.sessionId so getSessionId() resolves it consistently across two separate simulated hook calls', async () => {
    const wireSessionId = 'codex-wire-session-77'

    // First simulated hook call (pre_tool_use): CLAUDE_CODE_SESSION_ID starts unset, as it
    // would for a genuine Codex subprocess. relay() must seed it from the wire payload's
    // session_id before any handler (including getSessionId() consumers like hooks_read.ts)
    // runs.
    io.emit(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/never-seen-codex-session.ts' },
        session_id: wireSessionId,
      }),
    )
    await relay('pre_tool_use')

    expect(process.env['CLAUDE_CODE_SESSION_ID']).toBe(wireSessionId)
    expect(getSessionId()).toBe(wireSessionId)

    io.restore()
    io = withFakeIo()

    // Second simulated hook call (post_tool_use), same wire session id: getSessionId() must
    // keep resolving to the same id it did on the first call, proving continuity across
    // separate hook invocations rather than a fresh random id per call.
    io.emit(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/never-seen-codex-session.ts' },
        session_id: wireSessionId,
        tool_response: { output: 'ok' },
      }),
    )
    await relay('post_tool_use')

    expect(process.env['CLAUDE_CODE_SESSION_ID']).toBe(wireSessionId)
    expect(getSessionId()).toBe(wireSessionId)
  })

  it('does not overwrite an already-set CLAUDE_CODE_SESSION_ID with a different wire session id', async () => {
    process.env['CLAUDE_CODE_SESSION_ID'] = 'preexisting-session'

    io.emit(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/never-seen-codex-session-2.ts' },
        session_id: 'a-different-wire-session',
      }),
    )
    await relay('pre_tool_use')

    expect(process.env['CLAUDE_CODE_SESSION_ID']).toBe('preexisting-session')
  })

  it('propagates wire traceparent and tracestate to process.env', async () => {
    delete process.env['TRACEPARENT']
    delete process.env['TRACESTATE']

    io.emit(
      JSON.stringify({
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/trace-file.ts' },
        session_id: 'trace-session',
        traceparent: '00-abcdef0123456789abcdef0123456789-0123456789abcdef-01',
        tracestate: 'vendor1=val1',
      }),
    )
    await relay('pre_tool_use')

    expect(process.env['TRACEPARENT']).toBe('00-abcdef0123456789abcdef0123456789-0123456789abcdef-01')
    expect(process.env['TRACESTATE']).toBe('vendor1=val1')
  })
})
