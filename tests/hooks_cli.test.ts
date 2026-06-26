import { describe, expect, it } from 'vitest'

import {
  denormalizeResponse,
  failSoft,
  normalizePayload,
  type HookPayload,
  type HookResponse,
} from '../src/hooks_cli.js'

describe('normalizePayload', () => {
  it('returns empty dict for non-dict payload', () => {
    expect(normalizePayload(null, 'claude')).toEqual({})
    expect(normalizePayload('string', 'claude')).toEqual({})
    expect(normalizePayload([1, 2], 'claude')).toEqual({})
  })

  it('returns empty dict for empty payload', () => {
    expect(normalizePayload({}, 'claude')).toEqual({})
  })

  it('returns empty dict when tool_name is missing or invalid', () => {
    expect(normalizePayload({ foo: 'bar' }, 'claude')).toEqual({})
    expect(normalizePayload({ tool_name: '' }, 'claude')).toEqual({})
    expect(normalizePayload({ tool_name: null }, 'claude')).toEqual({})
  })

  it('preserves Claude harness payloads and stamps harness', () => {
    const payload: HookPayload = {
      tool_name: 'Read',
      tool_input: { file_path: 'test.py' },
      session_id: 'abc123',
    }
    const result = normalizePayload(payload, 'claude')
    expect(result).toEqual({
      ...payload,
      _tg_harness: 'claude',
    })
  })

  it('remaps Codex snake_case tool names to PascalCase', () => {
    const payload: HookPayload = {
      tool_name: 'bash',
      tool_input: { command: 'ls -la' },
    }
    const result = normalizePayload(payload, 'codex')
    expect(result['tool_name']).toBe('Bash')
    expect(result['_tg_harness']).toBe('codex')
  })

  it('remaps Gemini tool names and input keys', () => {
    const payload: HookPayload = {
      tool_name: 'read_file',
      tool_input: { path: '/tmp/test.txt' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt' })
    expect(result['_tg_harness']).toBe('gemini')
  })

  it('remaps Gemini functionCallId to toolUseId', () => {
    const payload: HookPayload = {
      tool_name: 'read_file',
      tool_input: { path: '/tmp/test.txt' },
      functionCallId: 'call_123',
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['toolUseId']).toBe('call_123')
    expect(result).not.toHaveProperty('functionCallId')
  })

  it('round-trip: normalizePayload then back works for Claude', () => {
    const original: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
      session_id: 'sess_123',
      cwd: '/home/user',
    }
    const normalized = normalizePayload(original, 'claude')
    expect(normalized['_tg_harness']).toBe('claude')
    expect(normalized['tool_name']).toBe('Bash')
    expect(normalized['tool_input']).toEqual(original['tool_input'])
  })
})

describe('denormalizeResponse', () => {
  it('passes through Claude responses unchanged', () => {
    const response: HookResponse = {
      continue: true,
      hookSpecificOutput: { reason: 'allowed' },
    }
    const result = denormalizeResponse(response, 'claude', 'pre_tool_use')
    expect(result).toEqual(response)
  })

  it('strips _tg_* keys from Codex responses', () => {
    const response: HookResponse = {
      continue: true,
      _tg_elapsed_ms: 42,
      _tg_handler: 'test',
      hookSpecificOutput: {},
    }
    const result = denormalizeResponse(response, 'codex', 'pre_tool_use')
    expect(result).not.toHaveProperty('_tg_elapsed_ms')
    expect(result).not.toHaveProperty('_tg_handler')
    expect(result).toHaveProperty('continue')
  })

  it('maps continue→decision for Gemini (true→allow)', () => {
    const response: HookResponse = {
      continue: true,
    }
    const result = denormalizeResponse(response, 'gemini', 'pre_tool_use')
    expect(result['decision']).toBe('allow')
  })

  it('maps continue→decision for Gemini (false→deny)', () => {
    const response: HookResponse = {
      continue: false,
      hookSpecificOutput: { permissionDecisionReason: 'denied' },
    }
    const result = denormalizeResponse(response, 'gemini', 'pre_tool_use')
    expect(result['decision']).toBe('deny')
    expect(result['reason']).toBe('denied')
  })

  it('preserves systemMessage for Gemini', () => {
    const response: HookResponse = {
      continue: true,
      systemMessage: 'This is a system message',
    }
    const result = denormalizeResponse(response, 'gemini', 'pre_tool_use')
    expect(result['systemMessage']).toBe('This is a system message')
  })

  it('preserves additionalContext for Gemini', () => {
    const response: HookResponse = {
      continue: true,
      hookSpecificOutput: { additionalContext: 'some context' },
    }
    const result = denormalizeResponse(response, 'gemini', 'pre_tool_use')
    const hso = result['hookSpecificOutput']
    if (typeof hso === 'object' && hso !== null) {
      expect((hso as Record<string, unknown>)['additionalContext']).toBe('some context')
    } else {
      throw new Error('hookSpecificOutput missing')
    }
  })
})

describe('failSoft', () => {
  it('returns handler result on success', () => {
    const handler = (_payload: HookPayload): HookResponse => ({ continue: true })
    const wrapped = failSoft(handler)
    expect(wrapped({})).toEqual({ continue: true })
  })

  it('catches errors and returns safe continue response', () => {
    const handler = (): HookResponse => {
      throw new Error('handler crashed')
    }
    const wrapped = failSoft(handler)
    const result = wrapped({})
    expect(result['continue']).toBe(true)
    expect(result).toHaveProperty('_tg_error')
  })

  it('preserves handler error message in _tg_error', () => {
    const handler = (): HookResponse => {
      throw new Error('specific error')
    }
    const wrapped = failSoft(handler)
    const result = wrapped({})
    expect(result['_tg_error']).toBe('specific error')
  })

  it('records handler name in _tg_handler', () => {
    const handler = function namedHandler(): HookResponse {
      throw new Error('test')
    }
    const wrapped = failSoft(handler)
    const result = wrapped({})
    expect(result['_tg_handler']).toBe('namedHandler')
  })

  it('catches non-Error exceptions', () => {
    const handler = (): HookResponse => {
      throw 'raw string error'
    }
    const wrapped = failSoft(handler)
    const result = wrapped({})
    expect(result['continue']).toBe(true)
    expect(result).toHaveProperty('_tg_error')
  })

  it('handles errors thrown in handler successfully', () => {
    const handler = (): HookResponse => {
      throw new TypeError('type error')
    }
    const wrapped = failSoft(handler)
    const result = wrapped({})
    expect(result['continue']).toBe(true)
    expect(result['_tg_error']).toContain('type error')
  })

  it('logs all error types, including TypeError and RangeError (regression: error logging bug)', () => {
    const handlerTypeError = (): HookResponse => {
      throw new TypeError('type error')
    }
    const wrappedTypeError = failSoft(handlerTypeError)
    const resultTypeError = wrappedTypeError({})
    expect(resultTypeError['continue']).toBe(true)
    expect(resultTypeError['_tg_error']).toContain('type error')

    const handlerRangeError = (): HookResponse => {
      throw new RangeError('range error')
    }
    const wrappedRangeError = failSoft(handlerRangeError)
    const resultRangeError = wrappedRangeError({})
    expect(resultRangeError['continue']).toBe(true)
    expect(resultRangeError['_tg_error']).toContain('range error')
  })
})
