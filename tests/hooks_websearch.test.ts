import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Importing relay registers EVERY hook module (including hooks_websearch) for its
// side-effects, so runHook dispatches through the real production registry --
// not a test-only handler reference. buildEvent maps a Claude Code payload onto
// a HookEvent exactly as relay() does on stdin.
import { buildEvent } from '../src/relay.js'
import { runHook } from '../src/hook_registry.js'
import { getBashOutput } from '../src/bash_output_cache.js'

let tmpHome: string
let prevHome: string | undefined
let sessionId: string

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-hooks-websearch-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  sessionId = `ws-${path.basename(tmpHome)}`
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

describe('WebSearch caching/dedup hooks (real runHook dispatch)', () => {
  const toolName = 'WebSearch'
  const query = 'latest React 20 release notes'

  function postPayload(result: unknown, input: Record<string, unknown> = { query }): Record<string, unknown> {
    return { tool_name: toolName, tool_input: input, session_id: sessionId, tool_response: result }
  }
  function prePayload(input: Record<string, unknown> = { query }): Record<string, unknown> {
    return { tool_name: toolName, tool_input: input, session_id: sessionId }
  }

  it('caches a first-time query result on post and lets it through untouched', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('search result text')))
    expect(post.hookType).toBe('pass')
  })

  it('passes the first pre (cold cache) for a query', async () => {
    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('pass')
  })

  it('denies a repeat of the identical query with a recall pointer to the cached result', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('search result text')))
    expect(post.hookType).toBe('pass')

    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('deny')
    if (pre.hookType === 'deny') {
      const m = /token-goat bash-output (mcp_[0-9a-f]{16})/.exec(pre.message)
      expect(m).not.toBeNull()
      expect(pre.message).toContain('already ran this session')
      const entry = getBashOutput(m![1] as string)
      expect(entry?.output).toBe('search result text')
    }
  })

  it('denies a near-identical query (different casing/whitespace) as a repeat', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('search result text')))
    expect(post.hookType).toBe('pass')

    const pre = await runHook(
      buildEvent('pre_tool_use', prePayload({ query: '  LATEST react 20   release   notes  ' })),
    )
    expect(pre.hookType).toBe('deny')
  })

  it('treats a query with different allowed_domains as a distinct signature (not a repeat)', async () => {
    const post = await runHook(
      buildEvent('post_tool_use', postPayload('result a', { query, allowed_domains: ['react.dev'] })),
    )
    expect(post.hookType).toBe('pass')

    const pre = await runHook(
      buildEvent('pre_tool_use', prePayload({ query, allowed_domains: ['github.com'] })),
    )
    expect(pre.hookType).toBe('pass')
  })

  it('allows the identical query again once the dedup TTL has elapsed', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_700_000_000_000)
      const post = await runHook(buildEvent('post_tool_use', postPayload('search result text')))
      expect(post.hookType).toBe('pass')

      // Still inside the default 45s mcp_dedup_ttl_secs window.
      vi.setSystemTime(1_700_000_000_000 + 30_000)
      const preWithinTtl = await runHook(buildEvent('pre_tool_use', prePayload()))
      expect(preWithinTtl.hookType).toBe('deny')

      // Past the TTL: the query is no longer treated as a stale duplicate.
      vi.setSystemTime(1_700_000_000_000 + 46_000)
      const preAfterTtl = await runHook(buildEvent('pre_tool_use', prePayload()))
      expect(preAfterTtl.hookType).toBe('pass')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not deny or cache a WebSearch call with no sessionId', async () => {
    const payload = { tool_name: toolName, tool_input: { query }, tool_response: 'result', session_id: '' }
    const post = await runHook(buildEvent('post_tool_use', payload))
    expect(post.hookType).toBe('pass')
    const pre = await runHook(buildEvent('pre_tool_use', payload))
    expect(pre.hookType).toBe('pass')
  })

  it('passes through on an empty/missing tool result (nothing cached)', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('')))
    expect(post.hookType).toBe('pass')

    const post2 = await runHook(buildEvent('post_tool_use', { tool_name: toolName, tool_input: { query }, session_id: sessionId }))
    expect(post2.hookType).toBe('pass')

    // Nothing was cached, so the identical query is not treated as a dedup hit.
    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('pass')
  })

  it('passes through and does not cache a query with no `query` field', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('result', {})))
    expect(post.hookType).toBe('pass')
    const pre = await runHook(buildEvent('pre_tool_use', prePayload({})))
    expect(pre.hookType).toBe('pass')
  })

  it('caches even a very small result (no size floor, unlike the Agent-report cache)', async () => {
    const post = await runHook(buildEvent('post_tool_use', postPayload('ok')))
    expect(post.hookType).toBe('pass')

    const pre = await runHook(buildEvent('pre_tool_use', prePayload()))
    expect(pre.hookType).toBe('deny')
  })

  it('ignores a non-WebSearch tool entirely', async () => {
    const pre = await runHook(
      buildEvent('pre_tool_use', { tool_name: 'WebFetch', tool_input: { url: 'https://x.com' }, session_id: sessionId }),
    )
    expect(pre.hookType).toBe('pass')
  })
})
