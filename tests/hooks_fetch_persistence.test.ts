import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as path from 'node:path'
import * as os from 'node:os'
import type { HookEvent } from '../src/hook_registry.js'
import { postFetchHandler } from '../src/hooks_fetch.js'
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
      raw: {
        tool_response: largeResponse,
      },
    }

    await postFetchHandler(event)

    // Should not cache when session ID is empty
    const cached = getWebOutputByUrl(url)
    expect(cached).toBeNull()
  })
})
