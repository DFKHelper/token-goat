import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_mcp) for its
// side-effects, so runHook dispatches through the real production registry —
// not a test-only handler reference. buildEvent maps a Claude Code payload onto
// a HookEvent exactly as relay() does on stdin.
//
// Do NOT call clearModuleCaches() here: it runs hook_registry's reset, which
// drops every registered handler and would make runHook a no-op. Isolation
// comes from a per-test TOKEN_GOAT_HOME temp dir plus a per-test session id
// (so blob ids never collide across tests in the shared in-memory map).
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { extractMcpResultText } from '../src/hooks_mcp.js'
import { getBashOutput } from '../src/bash_output_cache.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-mcp-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `mcp-${path.basename(tmpHome)}`
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('extractMcpResultText', () => {
  it('reads a plain string tool_response', () => {
    expect(extractMcpResultText({ tool_response: 'hello' })).toBe('hello')
  })

  it('joins an Anthropic content[] text array', () => {
    const raw = {
      tool_response: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    }
    expect(extractMcpResultText(raw)).toBe('a\nb')
  })

  it('falls back to output/text/body string fields', () => {
    expect(extractMcpResultText({ tool_response: { output: 'o' } })).toBe('o')
    expect(extractMcpResultText({ tool_response: { text: 't' } })).toBe('t')
    expect(extractMcpResultText({ tool_response: { body: 'b' } })).toBe('b')
  })

  it('stringifies a structured object with no known text field', () => {
    expect(extractMcpResultText({ tool_response: { foo: 1 } })).toBe('{"foo":1}')
  })

  it('returns empty string when there is no tool_response', () => {
    expect(extractMcpResultText({})).toBe('')
  })
})

describe('MCP caching hooks (real runHook dispatch)', () => {
  const toolName = 'mcp__plugin_github_github__get_file_contents'
  const toolInput = { owner: 'o', repo: 'r', path: 'README.md' }

  function postPayload(result: unknown): Record<string, unknown> {
    return { tool_name: toolName, tool_input: toolInput, session_id: sessionId, tool_response: result }
  }
  function prePayload(): Record<string, unknown> {
    return { tool_name: toolName, tool_input: toolInput, session_id: sessionId }
  }

  it('caches a read-only result on post and denies the identical pre with a recall id', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('the file body')))
    expect(post.hookType).toBe('pass')

    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('deny')
    if (pre.hookType === 'deny') {
      const m = /token-goat bash-output (mcp_[0-9a-f]{16})/.exec(pre.message)
      expect(m).not.toBeNull()
      expect(pre.message).toContain('already cached')
      // The recalled id resolves to the stored body on disk — the result a later
      // `token-goat bash-output <id>` process would serve.
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe('the file body')
    }
  })

  it('passes the first pre (cold cache) for a read-only call', async () => {
    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('pass')
  })

  it('does not cache or deny a mutating mcp tool', async () => {
    const mutTool = 'mcp__plugin_github_github__create_issue'
    const mutInput = { owner: 'o', repo: 'r', title: 't' }
    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: mutTool,
        tool_input: mutInput,
        session_id: sessionId,
        tool_response: 'created',
      }),
    )
    expect(post.hookType).toBe('pass')
    const pre = await runHook(
      buildEvent('pre_tool_use', { tool_name: mutTool, tool_input: mutInput, session_id: sessionId }),
    )
    expect(pre.hookType).toBe('pass')
  })

  it('ignores a non-mcp tool entirely', async () => {
    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: 'Grep',
        tool_input: { pattern: 'x' },
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('pass')
  })
})
