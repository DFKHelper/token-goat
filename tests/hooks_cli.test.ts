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

    // Fixture tool id from the grok 0.2.93 binary's own registered-tool table (tool.run_terminal_cmd in ~/.grok/bin/agent.exe's tracing-id strings) and its newer embedded hooks doc's PreToolUse example ("toolName": "run_terminal_cmd") -- NOT from token-goat's map. The older doc revision and a 2026-07-09 live capture show run_terminal_command on the same version, so both spellings must resolve to Bash.
    it('remaps the run_terminal_cmd spelling to Bash too (0.2.93 registers tool.run_terminal_cmd; a live capture on the same version sent run_terminal_command)', () => {
      const result = normalizePayload(
        { toolName: 'run_terminal_cmd', toolInput: { command: 'echo hi' } },
        'grok',
      )
      expect(result['tool_name']).toBe('Bash')
      expect(result['tool_input']).toEqual({ command: 'echo hi' })
    })

    // Fixture ids/keys from the 0.2.93 binary (tool.web_fetch / tool.web_search registered ids) and grok_build's input schemas: WebFetchInput carries the URL under `url`, WebSearchInput carries query/citations/allowed_domains.
    it('remaps web_fetch and web_search to WebFetch/WebSearch with their schema keys untouched (previously unmapped: URL policy and search dedup never fired on grok)', () => {
      const fetchResult = normalizePayload(
        { toolName: 'web_fetch', toolInput: { url: 'https://example.com/page' } },
        'grok',
      )
      expect(fetchResult['tool_name']).toBe('WebFetch')
      expect(fetchResult['tool_input']).toEqual({ url: 'https://example.com/page' })

      const searchResult = normalizePayload(
        { toolName: 'web_search', toolInput: { query: 'token goat', allowed_domains: ['example.com'] } },
        'grok',
      )
      expect(searchResult['tool_name']).toBe('WebSearch')
      expect(searchResult['tool_input']).toEqual({ query: 'token goat', allowed_domains: ['example.com'] })
    })

    // Fixture id from the 0.2.93 binary's tracing-id table: tool.glob is a registered tool distinct from tool.list_dir.
    it('remaps grok\'s distinct glob tool to Glob (previously only list_dir was mapped)', () => {
      const result = normalizePayload({ toolName: 'glob', toolInput: { pattern: 'src/**/*.ts' } }, 'grok')
      expect(result['tool_name']).toBe('Glob')
    })

    // Fixture ids from the 0.2.93 binary's tracing-id table (tool.hashline_read etc., paired with Read/Edit/Grep in grok's own hook alias table) and the GrokBuildConcise profile's *_concise registrations of the same core tools.
    it('remaps the hashline_* and *_concise profile variants onto the same canonical tools', () => {
      expect(normalizePayload({ toolName: 'hashline_read', toolInput: {} }, 'grok')['tool_name']).toBe('Read')
      expect(normalizePayload({ toolName: 'hashline_edit', toolInput: {} }, 'grok')['tool_name']).toBe('Edit')
      expect(normalizePayload({ toolName: 'hashline_grep', toolInput: {} }, 'grok')['tool_name']).toBe('Grep')
      expect(normalizePayload({ toolName: 'read_file_concise', toolInput: {} }, 'grok')['tool_name']).toBe('Read')
      expect(normalizePayload({ toolName: 'search_replace_concise', toolInput: {} }, 'grok')['tool_name']).toBe('Edit')
      expect(normalizePayload({ toolName: 'run_terminal_cmd_concise', toolInput: {} }, 'grok')['tool_name']).toBe('Bash')
    })
  })

  // Kimi is the reason remapToolName() keys its input-key map off the EFFECTIVE tool name rather
  // than off a successful rename: Kimi's Read is already spelled `Read`, but its path argument is
  // `path`, not `file_path`. Remapping only on a rename would leave every path-scoped handler
  // seeing no path at all.
  it('renames Kimi Read\'s `path` argument to file_path even though the tool name needs no rename', () => {
    const payload: HookPayload = {
      tool_name: 'Read',
      tool_input: { path: '/tmp/test.txt' },
    }
    const result = normalizePayload(payload, 'kimi')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt' })
    expect(result['_tg_harness']).toBe('kimi')
  })

  it('renames Kimi ReadMediaFile to Read and its `path` argument to file_path', () => {
    const payload: HookPayload = {
      tool_name: 'ReadMediaFile',
      tool_input: { path: '/tmp/shot.png' },
    }
    const result = normalizePayload(payload, 'kimi')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/shot.png' })
  })

  it('renames Kimi FetchURL to WebFetch and leaves its input alone (no key map entry)', () => {
    const payload: HookPayload = {
      tool_name: 'FetchURL',
      tool_input: { url: 'https://example.com' },
    }
    const result = normalizePayload(payload, 'kimi')
    expect(result['tool_name']).toBe('WebFetch')
    expect(result['tool_input']).toEqual({ url: 'https://example.com' })
  })

  // Fixture keys from Kimi's own ReadInputSchema (MoonshotAI/kimi-code packages/agent-core-v2/src/agent/tools/os/read/read.ts): `path`, `line_offset` ("the line number to start reading from"), `n_lines` ("the number of lines to read") -- NOT from token-goat's key map. Unmapped, a ranged Kimi read looked unbounded to estimateRequestedSlice (hooks_read.ts) and was gated on the whole file's size.
  it('renames Kimi Read\'s line_offset/n_lines paging keys to offset/limit alongside the path rename', () => {
    const payload: HookPayload = {
      tool_name: 'Read',
      tool_input: { path: '/tmp/big.log', line_offset: 100, n_lines: 40 },
    }
    const result = normalizePayload(payload, 'kimi')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/big.log', offset: 100, limit: 40 })
  })

  it('leaves an unmapped Kimi tool name and its input untouched', () => {
    const payload: HookPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    }
    const result = normalizePayload(payload, 'kimi')
    expect(result['tool_name']).toBe('Bash')
    expect(result['tool_input']).toEqual({ command: 'echo hello' })
  })

  // Generalizing remapToolName's key lookup must not start remapping keys for the other harnesses:
  // grok's own tool vocabulary is snake_case, so a raw `read_file` still routes through the rename
  // and an unrelated grok tool never collides with the PascalCase GROK_INPUT_KEY_MAP entries.
  it('still remaps grok read_file target_file to file_path after the shared-helper generalization', () => {
    const payload: HookPayload = {
      toolName: 'read_file',
      toolInput: { target_file: '/tmp/test.txt' },
    }
    const result = normalizePayload(payload, 'grok')
    expect(result['tool_name']).toBe('Read')
    expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt' })
  })

  describe('qwen harness', () => {
    // Fixture tool ids and input keys come from QwenLM/qwen-code's own source, not token-goat's maps: tool-names.ts (ToolNames runtime ids -- coreToolScheduler.ts passes canonicalToolName(request.name) into the hook triggers, so the wire carries these ids, never the display names), read-file.ts (file_path/offset/limit), shell.ts (command), grep.ts (pattern/path), web-fetch.ts (url), web-search.ts (query), ls.ts (LSToolParams.path -- NOT the dir_path its Gemini ancestor uses), and toolHookTriggers.ts (post payload tool_response = {llmContent, returnDisplay}).

    it('remaps read_file to Read with its already-canonical keys untouched (regression: qwen fell through to the claude branch, so read_file matched no handler and every tool-scoped hook was dead)', () => {
      const payload: HookPayload = {
        tool_name: 'read_file',
        tool_input: { file_path: '/tmp/test.txt', offset: 10, limit: 50 },
        session_id: 'q-sess-1',
      }
      const result = normalizePayload(payload, 'qwen')
      expect(result['tool_name']).toBe('Read')
      expect(result['tool_input']).toEqual({ file_path: '/tmp/test.txt', offset: 10, limit: 50 })
      expect(result['_tg_harness']).toBe('qwen')
    })

    it('remaps run_shell_command to Bash and grep_search/search_file_content to Grep', () => {
      const bash = normalizePayload({ tool_name: 'run_shell_command', tool_input: { command: 'ls -la' } }, 'qwen')
      expect(bash['tool_name']).toBe('Bash')
      expect(bash['tool_input']).toEqual({ command: 'ls -la' })

      const grep = normalizePayload({ tool_name: 'grep_search', tool_input: { pattern: 'foo', path: '/tmp' } }, 'qwen')
      expect(grep['tool_name']).toBe('Grep')
      expect(grep['tool_input']).toEqual({ pattern: 'foo', path: '/tmp' })

      const legacyGrep = normalizePayload({ tool_name: 'search_file_content', tool_input: { pattern: 'foo' } }, 'qwen')
      expect(legacyGrep['tool_name']).toBe('Grep')
    })

    it('remaps list_directory to Read and its path key to file_path (qwen ls.ts sends path, not Gemini\'s dir_path)', () => {
      const result = normalizePayload({ tool_name: 'list_directory', tool_input: { path: '/tmp/project' } }, 'qwen')
      expect(result['tool_name']).toBe('Read')
      expect(result['tool_input']).toEqual({ file_path: '/tmp/project' })
    })

    it('remaps web_fetch/web_search to WebFetch/WebSearch with their schema keys untouched', () => {
      const fetch = normalizePayload({ tool_name: 'web_fetch', tool_input: { url: 'https://example.com' } }, 'qwen')
      expect(fetch['tool_name']).toBe('WebFetch')
      expect(fetch['tool_input']).toEqual({ url: 'https://example.com' })

      const search = normalizePayload({ tool_name: 'web_search', tool_input: { query: 'token goat' } }, 'qwen')
      expect(search['tool_name']).toBe('WebSearch')
      expect(search['tool_input']).toEqual({ query: 'token goat' })
    })

    it('adds output alongside llmContent in a post tool_response so the response-reading handlers see the body (llmContent is in neither tool_response key list)', () => {
      const payload: HookPayload = {
        tool_name: 'run_shell_command',
        tool_input: { command: 'echo hi' },
        tool_response: { llmContent: 'hi\n', returnDisplay: 'hi' },
      }
      const result = normalizePayload(payload, 'qwen')
      expect(result['tool_response']).toEqual({ llmContent: 'hi\n', returnDisplay: 'hi', output: 'hi\n' })
    })

    it('leaves a non-string llmContent (PartListUnion array) untouched rather than inventing an output', () => {
      const payload: HookPayload = {
        tool_name: 'read_file',
        tool_input: { file_path: '/tmp/x.png' },
        tool_response: { llmContent: [{ inlineData: { data: 'AAAA' } }], returnDisplay: 'image' },
      }
      const result = normalizePayload(payload, 'qwen')
      expect(result['tool_response']).toEqual({ llmContent: [{ inlineData: { data: 'AAAA' } }], returnDisplay: 'image' })
    })

    it('leaves an unmapped qwen tool (todo_write, agent) and its input untouched', () => {
      const todo = normalizePayload({ tool_name: 'todo_write', tool_input: { todos: [] } }, 'qwen')
      expect(todo['tool_name']).toBe('todo_write')

      const agent = normalizePayload({ tool_name: 'agent', tool_input: { goal: 'x' } }, 'qwen')
      expect(agent['tool_name']).toBe('agent')
      expect(agent['tool_input']).toEqual({ goal: 'x' })
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
