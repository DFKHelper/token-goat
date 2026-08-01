import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import type { HookEvent } from '../src/hook_registry.js'
import { postFetchHandler, preFetchHandler } from '../src/hooks_fetch.js'
import { clearModuleCaches } from '../src/reset.js'
import { getWebOutputByUrl } from '../src/web_cache.js'
import { getWebFetchCacheId } from '../src/session.js'

describe('WebFetch hook persistence', () => {
  beforeEach(() => {
    clearModuleCaches()
    process.env['TOKEN_GOAT_HOME'] = path.join(os.tmpdir(), 'tg-webfetch-test')
  })

  afterEach(() => {
    clearModuleCaches()
    delete process.env['TOKEN_GOAT_HOME']
  })

  it('should store and recall WebFetch responses', async () => {
    const url = 'https://example.com/api/data'
    const largeResponse = 'x'.repeat(2000) // Above MIN_CACHE_BYTES threshold

    // Simulate a post_tool_use event for WebFetch
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'test-session-123',
      agentId: undefined,
      raw: {
        tool_response: largeResponse,
      },
    }

    // Call the hook
    const result = await postFetchHandler(event)
    expect(result).toBeDefined()

    // Web output should be stored and retrievable by URL
    const cached = getWebOutputByUrl(url)
    expect(cached).not.toBeNull()
    if (cached) {
      expect(cached.content).toBe(largeResponse)
      // Also verify it's recorded in the session
      const cacheId = getWebFetchCacheId(url)
      expect(cacheId).toBe(cached.cacheId)
    }
  })

  it('should not store small responses below the 1KB threshold', async () => {
    const url = 'https://example.com/small'
    const smallResponse = 'tiny'

    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'test-session-123',
      agentId: undefined,
      raw: {
        tool_response: smallResponse,
      },
    }

    await postFetchHandler(event)

    // Small responses should not be cached
    const cached = getWebOutputByUrl(url)
    expect(cached).toBeNull()
  })

  it('should not store when session id is empty', async () => {
    const url = 'https://example.com/no-session'
    const largeResponse = 'x'.repeat(2000)

    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: '', // Empty session ID
      agentId: undefined,
      raw: {
        tool_response: largeResponse,
      },
    }

    await postFetchHandler(event)

    // Should not cache when session ID is empty
    const cached = getWebOutputByUrl(url)
    expect(cached).toBeNull()
  })

  it('denies a re-fetch of a previously fetched URL, pointing at the web-output cache (regression: m15 — was a non-blocking hint that let the redundant fetch through)', async () => {
    const url = 'https://example.com/page'
    const largeResponse = 'x'.repeat(2000)
    const sessionId = 'test-session-recall'

    // First fetch stores the body and records the URL in the session.
    await postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId,
      agentId: undefined,
      raw: { tool_response: largeResponse },
    } as HookEvent)

    const cacheId = getWebFetchCacheId(url)
    expect(cacheId).not.toBeNull()

    // A subsequent pre-fetch of the same URL/session must be denied, naming the
    // web-output command and the cache id, rather than letting the redundant
    // network fetch proceed.
    const result = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId,
      agentId: undefined,
      raw: {},
    } as HookEvent)
    expect(result.hookType).toBe('deny')
    if (result.hookType === 'deny') {
      expect(result.message).toContain('web-output')
      expect(result.message).toContain(cacheId as string)
    }
  })

  it('does not emit a recall hint for a URL not fetched this session', () => {
    const result = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/never' },
      sessionId: 'test-session-cold',
      agentId: undefined,
      raw: {},
    } as HookEvent)
    expect(result.hookType).toBe('pass')
  })

  it('recognizes a URL already cached by a different process/session (regression: dedup relied on the in-memory, per-session webFetches map)', async () => {
    const url = 'https://example.com/cross-process-page'
    const prompt = 'Summarize the changelog'
    const largeResponse = 'x'.repeat(2000)

    // "Process 1": a WebFetch is made and its response is stored to disk.
    await postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url, prompt },
      sessionId: 'session-process-1',
      agentId: undefined,
      raw: { tool_response: largeResponse },
    } as HookEvent)

    // Simulate a brand-new process (or a new terminal tab / new session): every
    // in-memory module cache is wiped, and a different session id is used, but
    // the on-disk cache under TOKEN_GOAT_HOME survives (same as a real new
    // CLI hook invocation reading the same ~/.token-goat directory).
    clearModuleCaches()

    const result = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url, prompt },
      sessionId: 'session-process-2',
      agentId: undefined,
      raw: {},
    } as HookEvent)

    expect(result.hookType).toBe('deny')
  })
})
