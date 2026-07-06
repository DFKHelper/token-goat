import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent } from '../src/hook_registry.js';
import { postFetchHandler, preFetchHandler } from '../src/hooks_fetch.js';
import { getWebOutput } from '../src/web_cache.js';
import { clearModuleCaches } from '../src/reset.js';

beforeEach(() => {
  clearModuleCaches();
});

afterEach(() => {
  clearModuleCaches();
});

describe('preFetchHandler', () => {
  it('passes through non-WebFetch tools', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'SomeOtherTool',
      toolInput: {},
      sessionId: 'test-session',
      raw: {},
    };
    expect(preFetchHandler(event).hookType).toBe('pass');
  });

  it('passes through WebFetch with a missing url', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: {},
      sessionId: 'test-session',
      raw: {},
    };
    expect(preFetchHandler(event).hookType).toBe('pass');
  });

  it('passes through WebFetch with a missing sessionId', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/no-session' },
      sessionId: '',
      raw: {},
    };
    expect(preFetchHandler(event).hookType).toBe('pass');
  });

  it('passes through a URL that was never fetched this session', () => {
    const event: HookEvent = {
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/never-fetched' },
      sessionId: 'test-session',
      raw: {},
    };
    expect(preFetchHandler(event).hookType).toBe('pass');
  });

  it('denies a re-fetch of an already-cached URL instead of a soft hint (regression: m15 — a contextOutput hint let the redundant fetch proceed anyway)', () => {
    const url = 'https://example.com/cached';
    const sessionId = 'cache-session';

    // Seed the cache the way a real prior WebFetch would: run postFetchHandler on a
    // large response for this URL/session first.
    const postResult = postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId,
      raw: { tool_response: 'x'.repeat(2000) },
    });
    expect(postResult.hookType).toBe('pass');

    const result = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId,
      raw: {},
    });

    expect(result.hookType).toBe('deny');
    if (result.hookType === 'deny') {
      expect(result.message).toContain('token-goat web-output');
    }
  });

  it('does not redirect a different prompt against the same URL to the wrong cached answer (regression: dedup key ignored prompt)', () => {
    const url = 'https://example.com/prompt-dedup';
    const sessionId = 'prompt-dedup-session';

    // First fetch: cache an answer for prompt A.
    const postResult = postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url, prompt: 'What is the pricing?' },
      sessionId,
      raw: { tool_response: 'x'.repeat(2000) },
    });
    expect(postResult.hookType).toBe('pass');

    // Second fetch: same URL, a genuinely different question. Must NOT be denied
    // and redirected to the cached answer for the first (unrelated) prompt.
    const result = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url, prompt: 'What is the refund policy?' },
      sessionId,
      raw: {},
    });

    expect(result.hookType).toBe('pass');
  });
});

describe('postFetchHandler', () => {
  it('passes through non-WebFetch tools', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'SomeOtherTool',
      toolInput: {},
      sessionId: 'test-session',
      raw: {
        tool_response: 'test response',
      },
    };
    expect(postFetchHandler(event).hookType).toBe('pass');
  });

  it('passes through a WebFetch response smaller than the cache threshold', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/small' },
      sessionId: 'test-session',
      raw: {
        tool_response: 'small',
      },
    };
    expect(postFetchHandler(event).hookType).toBe('pass');
  });

  it('passes through WebFetch with a missing sessionId, even for a large response', () => {
    const event: HookEvent = {
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url: 'https://example.com/no-session-large' },
      sessionId: '',
      raw: {
        tool_response: 'x'.repeat(2000),
      },
    };
    expect(postFetchHandler(event).hookType).toBe('pass');
  });

  it('stores extracted clean text, not raw markup, for an HTML body at/above the compress threshold', () => {
    const url = 'https://example.com/article';
    const paragraph = '<p>Real article content that a reader actually cares about.</p>\n'.repeat(400);
    const html = `<!DOCTYPE html><html><head><title>Test</title><script>evilTrackingPixel();</script></head><body>${paragraph}</body></html>`;

    const result = postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'html-extract-session',
      raw: { tool_response: html },
    });
    expect(result.hookType).toBe('pass');

    // Recover the cache id the same way a real dedup deny would carry it.
    const denyResult = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'html-extract-session',
      raw: {},
    });
    expect(denyResult.hookType).toBe('deny');
    if (denyResult.hookType !== 'deny') throw new Error('unreachable');
    const cacheId = /token-goat web-output ([0-9a-f]+)/.exec(denyResult.message)?.[1];
    expect(cacheId).toBeTruthy();

    const stored = getWebOutput(cacheId as string);
    expect(stored).not.toBeNull();
    expect(stored).not.toContain('<html>');
    expect(stored).not.toContain('<script>');
    expect(stored).not.toContain('evilTrackingPixel');
    expect(stored).toContain('Real article content');
    expect((stored as string).length).toBeLessThan(html.length);
  });

  it('leaves a large non-HTML body untouched', () => {
    const url = 'https://example.com/plain-data.json';
    const body = JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i })) });

    postFetchHandler({
      eventName: 'post_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'plain-body-session',
      raw: { tool_response: body },
    });

    const denyResult = preFetchHandler({
      eventName: 'pre_tool_use',
      toolName: 'WebFetch',
      toolInput: { url },
      sessionId: 'plain-body-session',
      raw: {},
    });
    expect(denyResult.hookType).toBe('deny');
    if (denyResult.hookType !== 'deny') throw new Error('unreachable');
    const cacheId = /token-goat web-output ([0-9a-f]+)/.exec(denyResult.message)?.[1];

    expect(getWebOutput(cacheId as string)).toBe(body);
  });
});
