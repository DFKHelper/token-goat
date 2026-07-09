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

  it('leaves Gemini read_file input keys untouched (file_path is already token-goat\'s own canonical key)', () => {
    // Confirmed against gemini-cli's own ReadFileToolParams interface: Gemini's
    // real read_file tool sends `file_path`, identical to token-goat's internal
    // key (see getFilePath() in hooks_common.ts) -- no remap needed or performed.
    const payload: HookPayload = {
      tool_name: 'read_file',
      tool_input: { file_path: '/tmp/test.txt' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt' })
    expect(result['_tg_harness']).toBe('gemini')
  })

  it('leaves Gemini replace (Edit) input keys untouched (file_path/old_string/new_string already match token-goat names)', () => {
    const payload: HookPayload = {
      tool_name: 'replace',
      tool_input: { file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Edit')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt', old_string: 'foo', new_string: 'bar' })
  })

  it('remaps Gemini list_directory\'s dir_path to token-goat\'s file_path key (regression: GEMINI_INPUT_KEY_MAP had no Read entry, so getFilePath() silently saw undefined for every list_directory call)', () => {
    // list_directory's real target-directory argument is `dir_path` (confirmed
    // against gemini-cli's own LSToolParams interface), not `file_path` --
    // getFilePath() (hooks_common.ts) only ever reads `file_path`/`notebook_path`.
    const payload: HookPayload = {
      tool_name: 'list_directory',
      tool_input: { dir_path: '/tmp/project' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/project' })
  })

  it('leaves Gemini read_many_files\'s include key untouched (no single-file-path remap is possible for a glob-pattern array)', () => {
    // read_many_files's real argument is `include` (confirmed against
    // gemini-cli's own ReadManyFilesParams interface): an array of glob
    // patterns, not a single file path. There is no string to remap it to, so
    // it is deliberately left as-is; getFilePath() returns undefined for this
    // call and preReadHandler/postReadHandler already fall back to
    // passOutput() on an undefined path, so the real tool call still succeeds
    // -- it just gets no session-dedup tracking or read-count hints.
    const payload: HookPayload = {
      tool_name: 'read_many_files',
      tool_input: { include: ['src/**/*.ts', 'README.md'] },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ include: ['src/**/*.ts', 'README.md'] })
  })

  it('remaps Gemini grep_search\'s dir_path to token-goat\'s path key', () => {
    // grep_search's real target-directory argument is `dir_path` (confirmed
    // against gemini-cli's GrepToolParams interface); preReadHandler's Grep
    // fallback only recognizes `path`, so this one still needs remapping.
    const payload: HookPayload = {
      tool_name: 'grep_search',
      tool_input: { pattern: 'foo', dir_path: '/tmp' },
    }
    const result = normalizePayload(payload, 'gemini')
    expect(result['tool_name']).toBe('Grep')
    expect(result['tool_input']).toEqual({ pattern: 'foo', path: '/tmp' })
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

  describe('grok harness', () => {
    // Confirmed empirically (2026-07-09) against grok 0.2.93: unlike Codex/
    // Gemini, grok's entire wire payload is camelCase (toolName/toolInput/
    // sessionId), not just its tool-name vocabulary. See the live-capture
    // notes on GROK_TOOL_NAME_MAP / grokToCanonicalWire in hooks_cli.ts.

    it('translates camelCase wire keys to snake_case and remaps read_file to Read', () => {
      const payload: HookPayload = {
        hookEventName: 'pre_tool_use',
        sessionId: 'g-sess-1',
        toolName: 'read_file',
        toolInput: { target_file: 'C:\\proj\\package.json' },
      }
      const result = normalizePayload(payload, 'grok')
      expect(result['tool_name']).toBe('Read')
      expect(result['tool_input']).toEqual({ file_path: 'C:\\proj\\package.json' })
      expect(result['session_id']).toBe('g-sess-1')
      expect(result['_tg_harness']).toBe('grok')
    })

    it('remaps run_terminal_command to Bash, leaving its command key untouched', () => {
      const payload: HookPayload = {
        toolName: 'run_terminal_command',
        toolInput: { command: 'echo hi', description: 'say hi' },
        sessionId: 'g-sess-2',
      }
      const result = normalizePayload(payload, 'grok')
      expect(result['tool_name']).toBe('Bash')
      expect(result['tool_input']).toEqual({ command: 'echo hi', description: 'say hi' })
    })

    it('remaps write and search_replace to Write/Edit, leaving their keys untouched (already token-goat-shaped)', () => {
      const writeResult = normalizePayload(
        { toolName: 'write', toolInput: { file_path: 'notes.txt', content: 'hi' } },
        'grok',
      )
      expect(writeResult['tool_name']).toBe('Write')
      expect(writeResult['tool_input']).toEqual({ file_path: 'notes.txt', content: 'hi' })

      const editResult = normalizePayload(
        {
          toolName: 'search_replace',
          toolInput: { file_path: 'notes.txt', old_string: 'a', new_string: 'b' },
        },
        'grok',
      )
      expect(editResult['tool_name']).toBe('Edit')
      expect(editResult['tool_input']).toEqual({ file_path: 'notes.txt', old_string: 'a', new_string: 'b' })
    })

    it('remaps grep and list_dir to Grep/Glob', () => {
      const grepResult = normalizePayload({ toolName: 'grep', toolInput: { pattern: 'foo', path: '.' } }, 'grok')
      expect(grepResult['tool_name']).toBe('Grep')
      expect(grepResult['tool_input']).toEqual({ pattern: 'foo', path: '.' })

      const globResult = normalizePayload(
        { toolName: 'list_dir', toolInput: { target_directory: '.' } },
        'grok',
      )
      expect(globResult['tool_name']).toBe('Glob')
    })

    it('returns empty dict when toolName is missing (mirrors the tool_name-missing contract for other harnesses)', () => {
      expect(normalizePayload({ toolInput: { command: 'ls' } }, 'grok')).toEqual({})
    })

    it('unwraps run_terminal_command\'s tagged toolResult into tool_response with content + exit_code (post_tool_use)', () => {
      // Confirmed shape from a live grok run_terminal_command postToolUse
      // capture: { type: "Bash", output: [...bytes], output_for_prompt:
      // "exit: 0\n<stdout>\n", exit_code: 0, command, ... }.
      const payload: HookPayload = {
        toolName: 'run_terminal_command',
        toolInput: { command: 'echo hi' },
        toolResult: { type: 'Bash', output_for_prompt: 'exit: 0\nhi\n', exit_code: 0, command: 'echo hi' },
      }
      const result = normalizePayload(payload, 'grok')
      expect(result['tool_response']).toEqual({ content: 'exit: 0\nhi\n', exit_code: 0 })
    })

    it('falls back to the first string field (other than type) for tools whose toolResult shape is not the Bash one', () => {
      // Confirmed shapes from live captures: list_dir -> { type, Content },
      // read_file -> { type, FileContent }, search_replace -> { type, EditsApplied }.
      // The exact key name is tool-specific and not otherwise enumerated here.
      const payload: HookPayload = {
        toolName: 'read_file',
        toolInput: { target_file: 'notes.txt' },
        toolResult: { type: 'FileContent', FileContent: 'hello world' },
      }
      const result = normalizePayload(payload, 'grok')
      expect(result['tool_response']).toEqual({ content: 'hello world' })
    })
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
