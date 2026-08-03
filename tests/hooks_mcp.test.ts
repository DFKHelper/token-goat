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
import { extractToolResultText as extractMcpResultText } from '../src/hooks_common.js'
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

describe('postMcpHandler generic compression (real runHook dispatch)', () => {
  const compressTool = 'mcp__plugin_github_github__search_issues'
  const compressInput = { query: 'is:issue' }

  function homogeneousRows(n: number): Array<Record<string, unknown>> {
    return Array.from({ length: n }, (_, i) => ({
      id: i,
      title: `issue number ${i}`,
      state: 'open',
      url: `https://github.com/o/r/issues/${i}`,
    }))
  }

  let prevCompressFlag: string | undefined

  beforeEach(() => {
    prevCompressFlag = process.env['TOKEN_GOAT_MCP_COMPRESS']
  })

  afterEach(() => {
    if (prevCompressFlag === undefined) delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    else process.env['TOKEN_GOAT_MCP_COMPRESS'] = prevCompressFlag
  })

  it('rewrites a large homogeneous-array MCP result to a labeled, compressed table', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const rows = homogeneousRows(200)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: compressTool,
        tool_input: compressInput,
        session_id: sessionId,
        tool_response: JSON.stringify(rows),
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).toMatch(/^\[token-goat: compressed, full via mcp-output mcp_[0-9a-f]{16}\]\n/)
      // The full original is still recoverable via the labeled recall id.
      const m = /mcp-output (mcp_[0-9a-f]{16})/.exec(result.updatedOutput)
      expect(m).not.toBeNull()
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe(JSON.stringify(rows))
    }
  })

  it('leaves a small result untouched (below the size threshold)', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const rows = homogeneousRows(3)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: compressTool,
        tool_input: compressInput,
        session_id: sessionId,
        tool_response: JSON.stringify(rows),
      }),
    )
    expect(result.hookType).toBe('pass')
  })

  it('leaves a large but non-homogeneous result untouched (generic pass only)', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const proseBody = 'a '.repeat(2000)
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: compressTool,
        tool_input: compressInput,
        session_id: sessionId,
        tool_response: proseBody,
      }),
    )
    expect(result.hookType).toBe('pass')
  })

  // Bug: take_snapshot trips MUTATING_VERBS_RE's `snapshot` token (isMcpReadOnly
  // returns false), but mcp_compress_packs.ts's browser-snapshot pack exists
  // specifically for take_snapshot/read_page results. Before the fix, postMcpHandler
  // gated the entire compression attempt behind isMcpReadOnly, so a non-idempotent
  // but compressible tool like take_snapshot never reached the pack at all — this
  // asserts it now does, while still never being cached/dedup'd on the pre side.
  it('compresses a non-idempotent take_snapshot result via its pack, without caching/dedup', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const snapshotTool = 'mcp__plugin_chrome-devtools-mcp_chrome-devtools__take_snapshot'
    const snapshotInput = {}
    const longParagraph = (
      'This paragraph describes the quarterly results in extensive detail, covering revenue trends, ' +
      'headcount changes, and forward-looking guidance for the next fiscal year across every region. '
    ).repeat(5)
    const rows = Array.from({ length: 20 }, (_, i) => `    uid=${i} StaticText "${longParagraph}"`)
    const text = ['uid=1 RootWebArea "Example Page"', ...rows].join('\n')

    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: snapshotTool,
        tool_input: snapshotInput,
        session_id: sessionId,
        tool_response: text,
      }),
    )
    expect(post.hookType).toBe('rewriteOutput')
    if (post.hookType === 'rewriteOutput') {
      expect(post.updatedOutput).toMatch(/^\[token-goat: compressed, full via mcp-output mcp_[0-9a-f]{16}\]\n/)
      expect(post.updatedOutput).toContain('chars elided')
    }

    // Never cached/dedup'd: take_snapshot's result can legitimately differ between
    // identical calls, so a repeat must still be let through, not denied.
    const pre = await runHook(
      buildEvent('pre_tool_use', { tool_name: snapshotTool, tool_input: snapshotInput, session_id: sessionId }),
    )
    expect(pre.hookType).toBe('pass')
  })

  // Bug: storeMcpOutput() redacts before writing to the recall cache/index, but the
  // rewriteOutput text returned here for THIS turn was built straight from the raw
  // resultText by mcp_compress.ts/mcp_compress_packs.ts, neither of which redact --
  // so a secret embedded in a field that survives compression (e.g. a per-row `title`
  // column that differs across rows and so isn't hoisted/dropped) reached the model
  // in plaintext on the live path even though the cached copy was clean.
  it('redacts a secret embedded in a compressed MCP result before the live rewrite', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const secret = 'ghp_' + 'a'.repeat(36)
    const rows = homogeneousRows(200).map((r, i) =>
      i === 0 ? { ...r, title: `leaked token ${secret} in issue title` } : r,
    )
    const result = await runHook(
      buildEvent('post_tool_use', {
        tool_name: compressTool,
        tool_input: compressInput,
        session_id: sessionId,
        tool_response: JSON.stringify(rows),
      }),
    )
    expect(result.hookType).toBe('rewriteOutput')
    if (result.hookType === 'rewriteOutput') {
      expect(result.updatedOutput).not.toContain(secret)
      expect(result.updatedOutput).toContain('[REDACTED:github_token]')
    }
  })

  // Proves the shared net-benefit gate (tool_filters/base.ts::isRewriteWorthwhile,
  // resolveMinNetSavingsBytes) is actually wired into this path, not just present
  // in bash_runner.ts: cranking the SAME config key/env var bash_runner already
  // used (TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES) to an impossible floor flips this
  // otherwise-compressible result from rewriteOutput to pass.
  it('leaves an otherwise-compressible result untouched when TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES is set impossibly high', async () => {
    delete process.env['TOKEN_GOAT_MCP_COMPRESS']
    const prevFloor = process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
    process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = '10000000'
    try {
      const rows = homogeneousRows(200)
      const result = await runHook(
        buildEvent('post_tool_use', {
          tool_name: compressTool,
          tool_input: compressInput,
          session_id: sessionId,
          tool_response: JSON.stringify(rows),
        }),
      )
      expect(result.hookType).toBe('pass')
    } finally {
      if (prevFloor === undefined) delete process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES']
      else process.env['TOKEN_GOAT_BASH_MIN_NET_SAVINGS_BYTES'] = prevFloor
    }
  })

  it('is disabled by TOKEN_GOAT_MCP_COMPRESS=0, still caches the raw result', async () => {
    process.env['TOKEN_GOAT_MCP_COMPRESS'] = '0'
    const rows = homogeneousRows(200)
    const rawText = JSON.stringify(rows)
    const post = await runHook(
      buildEvent('post_tool_use', {
        tool_name: compressTool,
        tool_input: compressInput,
        session_id: sessionId,
        tool_response: rawText,
      }),
    )
    expect(post.hookType).toBe('pass')
    // Caching/dedup still works normally with compression disabled.
    const pre = await runHook(
      buildEvent('pre_tool_use', { tool_name: compressTool, tool_input: compressInput, session_id: sessionId }),
    )
    expect(pre.hookType).toBe('deny')
  })
})

