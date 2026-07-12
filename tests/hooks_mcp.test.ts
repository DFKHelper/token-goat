import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

  it('denies a repeat within the dedup TTL window but allows it again once the TTL has elapsed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      const post = await runHook(buildEvent('post_tool_use', postPayload('the file body')))
      expect(post.hookType).toBe('pass')

      // Still well inside the default 45s dedup TTL: the repeat is denied.
      vi.setSystemTime(1_700_000_000_000 + 30_000)
      const preWithinTtl = await runHook(buildEvent('pre_tool_use', prePayload()))
      expect(preWithinTtl.hookType).toBe('deny')

      // Past the default 45s dedup TTL: the identical call is no longer treated
      // as a stale duplicate — a real re-call is allowed through again, since a
      // cached read-only result forever (no expiry) is unsound even for
      // genuinely read-only tools whose results can change between calls.
      vi.setSystemTime(1_700_000_000_000 + 46_000)
      const preAfterTtl = await runHook(buildEvent('pre_tool_use', prePayload()))
      expect(preAfterTtl.hookType).toBe('pass')
    } finally {
      vi.useRealTimers()
    }
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

  it('does not cache an in-band MCP error result, and lets the identical retry through', async () => {
    // MCP's CallToolResult shape signals a tool-level failure via `isError: true`
    // alongside normal `content` — it is still a successful protocol response,
    // not a transport error, so extractMcpResultText would otherwise happily
    // pull text out of it and cache it like any other result.
    const errorResult = { content: [{ type: 'text', text: 'tool not found' }], isError: true }
    const post = await runHook(buildEvent('post_tool_use', postPayload(errorResult)))
    expect(post.hookType).toBe('pass')

    // Nothing was cached for the error response, so the identical call is not
    // treated as a dedup hit and is allowed through to actually retry.
    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
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

  // Bug: Anthropic's Claude-in-Chrome docs (code.claude.com/docs/en/chrome) state that
  // an otherwise read-only call that sets createIfEmpty/clear/save_to_disk is treated
  // as state-changing by their own permission system (v2.1.199+). Before this fix,
  // preMcpHandler/postMcpHandler classified purely off tool name, so a repeat
  // read_console_messages({..., clear: true}) call would be denied and silently
  // redirected to the FIRST call's cached messages — even though the real second
  // call would see only whatever arrived after the first clear (likely different,
  // possibly empty). These two tests fail on the pre-fix isMcpReadOnly(toolName)
  // (both would be denied) and pass once the toolInput flag check is added.
  it('does not dedup a claude-in-chrome read with a truthy clear flag (state-changing)', async () => {
    const chromeToolName = 'mcp__claude-in-chrome__read_console_messages'
    const chromeInput = { tabId: 5, clear: true }
    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: chromeToolName,
        tool_input: chromeInput,
        session_id: sessionId,
        tool_response: 'messages batch A',
      }),
    )
    expect(post.hookType).toBe('pass')

    // Never cached/dedup'd: an identical repeat with clear:true must be let through,
    // not denied and redirected to the first call's now-stale cached result.
    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: chromeToolName,
        tool_input: chromeInput,
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('pass')
  })

  it('still dedups the same claude-in-chrome read when clear is false/absent', async () => {
    const chromeToolName = 'mcp__claude-in-chrome__read_console_messages'
    const chromeInput = { tabId: 5, clear: false }
    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: chromeToolName,
        tool_input: chromeInput,
        session_id: sessionId,
        tool_response: 'messages batch A',
      }),
    )
    expect(post.hookType).toBe('pass')

    // With no state-changing flag set, this is a genuinely read-only call and the
    // existing dedup behavior still applies: the identical repeat is denied and
    // redirected to the cached result.
    const pre = await runHook(
      buildEvent('pre_tool_use', {
        tool_name: chromeToolName,
        tool_input: chromeInput,
        session_id: sessionId,
      }),
    )
    expect(pre.hookType).toBe('deny')
    if (pre.hookType === 'deny') {
      expect(pre.message).toContain('already cached')
    }
  })
})

describe('mcpRewriteSpikeHandler (TOKEN_GOAT_MCP_REWRITE_SPIKE feasibility spike)', () => {
  const spikeTool = 'mcp__plugin_github_github__get_teams'
  let prevFlag: string | undefined

  beforeEach(() => {
    prevFlag = process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE']
  })

  afterEach(() => {
    if (prevFlag === undefined) delete process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE']
    else process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE'] = prevFlag
  })

  it('is inert by default (env var unset) even on its matched tool', async () => {
    delete process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE']
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: spikeTool,
        tool_input: {},
        session_id: sessionId,
        tool_response: 'team list',
      }),
    )
    expect(result.hookType).toBe('pass')
  })

  it('is inert for other tools even when the env var is on', async () => {
    process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE'] = '1'
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: 'mcp__plugin_github_github__get_file_contents',
        tool_input: {},
        session_id: sessionId,
        tool_response: 'file body',
      }),
    )
    expect(result.hookType).toBe('pass')
  })

  it('round-trips the result unchanged through rewriteOutput when enabled on its matched tool', async () => {
    process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE'] = '1'
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: spikeTool,
        tool_input: {},
        session_id: sessionId,
        tool_response: 'team list unchanged',
      }),
    )
    expect(result).toEqual({ hookType: 'rewriteOutput', updatedOutput: 'team list unchanged' })
  })

  it('still caches under postMcpHandler before the spike handler rewrites the output', async () => {
    process.env['TOKEN_GOAT_MCP_REWRITE_SPIKE'] = '1'
    await runHook(
      buildEvent('post_tool_use', {
        tool_name: spikeTool,
        tool_input: {},
        session_id: sessionId,
        tool_response: 'team list unchanged',
      }),
    )
    const pre = await runHook(
      buildEvent('pre_tool_use', { tool_name: spikeTool, tool_input: {}, session_id: sessionId }),
    )
    expect(pre.hookType).toBe('deny')
  })
})
