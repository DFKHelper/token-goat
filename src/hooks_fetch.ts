import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, getToolName, getToolInput } from './hooks_common.js';
import { recordStat } from './stats.js';
import { storeWebOutput } from './web_cache.js';
import { recordWebFetch } from './session.js';

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
