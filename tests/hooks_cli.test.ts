import { describe, expect, it } from 'vitest'

import { normalizePayload, type HookPayload } from '../src/hooks_cli.js'

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

  it('remaps Codex apply_patch to Edit', () => {
    const payload: HookPayload = {
      tool_name: 'apply_patch',
      tool_input: { file_path: '/src/foo.ts', patch: 'some diff' },
    }
    const result = normalizePayload(payload, 'codex')
    expect(result['tool_name']).toBe('Edit')
    expect(result['_tg_harness']).toBe('codex')
  })

  it('remaps Gemini tool names and input keys', () => {
    // Gemini's real_file tool sends `file_path`, not token-goat's internal `path` -
    // this must come out the other side keyed by token-goat's internal name.
    const payload: HookPayload = {
      tool_name: 'read_file',
      tool_input: { file_path: '/tmp/test.txt' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ path: '/tmp/test.txt' })
    expect(result['_tg_harness']).toBe('gemini')
  })

  it('remaps every Gemini Edit input key (file_path/old_string/new_string) to token-goat names', () => {
    const payload: HookPayload = {
      tool_name: 'replace',
      tool_input: { file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Edit')
    expect(result['tool_input']).toEqual({ path: '/tmp/test.txt', old_str: 'foo', new_str: 'bar' })
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
