import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, getToolName, getToolInput, contextOutput } from './hooks_common.js';
import { recordStat } from './stats.js';
import { storeWebOutput, getWebOutput } from './web_cache.js';
import { recordWebFetch, getWebFetchCacheId } from './session.js';

function extractToolResponse(raw: Record<string, unknown>): string {
  const toolResponse = raw['tool_response'];
  if (typeof toolResponse === 'string') {
    return toolResponse;
  }
  if (toolResponse && typeof toolResponse === 'object') {
    const resp = toolResponse as Record<string, unknown>;
    const text =
      typeof resp['output'] === 'string'
        ? resp['output']
        : typeof resp['body'] === 'string'
          ? resp['body']
          : typeof resp['text'] === 'string'
            ? resp['text']
            : typeof resp['content'] === 'string'
              ? resp['content']
              : '';
    return text;
  }
  return '';
}

export function preFetchHandler(event: HookEvent): HookOutput {
  try {
    const toolName = getToolName(event);

    if (toolName !== 'WebFetch') {
      return passOutput();
    }

    const toolInput = getToolInput(event);
    const url = toolInput['url'] as string;
    if (!url || typeof url !== 'string') {
      return passOutput();
    }

    if (!event.sessionId) {
      return passOutput();
    }

    const cacheId = getWebFetchCacheId(url);
    if (cacheId !== null) {
      // Guard on the content blob (in-memory or on disk), not just the session index, so a pruned or evicted entry never yields a web-output hint that would error - mirrors the curl-GET recall guard in hooks_bash.
      const cached = getWebOutput(cacheId);
      if (cached !== null) {
        recordStat('webfetch:recall', Buffer.byteLength(cached, 'utf-8'), Math.round(cached.length / 4));
        return contextOutput(
          'You already fetched this URL this session; the response is cached. ' +
          'Use `token-goat web-output ' + cacheId + '` to recall it ' +
          '(append `--grep PATTERN` to filter or `--section Heading` for a markdown section) instead of re-fetching.',
        );
      }
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

export function postFetchHandler(event: HookEvent): HookOutput {
  try {
    const toolName = getToolName(event);

    if (toolName !== 'WebFetch') {
      return passOutput();
    }

    const toolInput = getToolInput(event);
    const url = toolInput['url'] as string;
    if (!url || typeof url !== 'string') {
      return passOutput();
    }

    if (!event.sessionId) {
      return passOutput();
    }

    recordStat('web_fetch');

    const body = extractToolResponse(event.raw);
    if (!body || body.length < 1024) {
      return passOutput();
    }

    // Store the fetched content and record it in the session for cross-process recall
    const cacheId = storeWebOutput(url, body);
    recordWebFetch(url, cacheId);

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preFetchHandler, { toolName: 'WebFetch' });
registerHook('post_tool_use', postFetchHandler, { toolName: 'WebFetch' });
