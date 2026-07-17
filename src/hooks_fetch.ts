import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, getToolName, getToolInput, denyOutput, extractToolResponseField } from './hooks_common.js';
import { recordStat } from './stats.js';
import { storeWebOutput, getWebOutput } from './web_cache.js';
import { recordWebFetch } from './session.js';
import { shortFingerprint } from './fingerprint.js';
import { loadConfig } from './config.js';
import { looksLikeHtml, extractCleanText } from './web_extract.js';
import { scanForInjectionPatterns, fenceUntrustedContent } from './injection_scan.js';

function extractToolResponse(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, ['output', 'body', 'text', 'content']);
}

/** Shared prologue for {@link preFetchHandler}/{@link postFetchHandler}: only a WebFetch call
 * with a valid url and a session id is in scope; everything else passes through untouched. */
function resolveWebFetchContext(event: HookEvent): { toolInput: Record<string, unknown>; url: string } | null {
  const toolName = getToolName(event);
  if (toolName !== 'WebFetch') {
    return null;
  }

  const toolInput = getToolInput(event);
  const url = toolInput['url'] as string;
  if (!url || typeof url !== 'string') {
    return null;
  }

  if (!event.sessionId) {
    return null;
  }

  return { toolInput, url };
}

export function preFetchHandler(event: HookEvent): HookOutput {
  try {
    const ctx = resolveWebFetchContext(event);
    if (ctx === null) {
      return passOutput();
    }
    const { toolInput, url } = ctx;

    // Dedup key includes the prompt: WebFetch answers are prompt-specific, so a
    // repeat fetch of the same URL with a different question must not be redirected
    // to a stale answer for the WRONG question. Deriving the cache id directly (a
    // pure function of url+prompt, mirroring cacheIdForUrl in web_cache.ts) instead
    // of going through the session-scoped webFetches map also makes the lookup work
    // across processes/sessions via getWebOutput's disk fallback - the same
    // cross-process approach getWebOutputByUrlFromDisk uses for gdrive.ts.
    const prompt = typeof toolInput['prompt'] === 'string' ? (toolInput['prompt'] as string) : '';
    const cacheId = shortFingerprint(`${url}\x00${prompt}`);
    // Guard on the content blob (in-memory or on disk), not just the session index, so a pruned or evicted entry never yields a web-output hint that would error - mirrors the curl-GET recall guard in hooks_bash.
    const cached = getWebOutput(cacheId);
    if (cached !== null) {
      const cachedBytes = Buffer.byteLength(cached, 'utf-8');
      if (cachedBytes >= loadConfig().hints.web_dedup_min_bytes) {
        recordStat('webfetch:recall', cachedBytes, Math.round(cached.length / 4));
        return denyOutput(
          'Already fetched this URL with this prompt; the response is cached. ' +
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
    const ctx = resolveWebFetchContext(event);
    if (ctx === null) {
      return passOutput();
    }
    const { toolInput, url } = ctx;

    recordStat('web_fetch');

    const body = extractToolResponse(event.raw);

    // Prompt-injection scan: README's documented contract ("every fetched page is
    // scanned for attack patterns") is unconditional, so this runs ahead of the
    // caching-size gate below rather than being folded into it. A match anywhere
    // in the response wraps the whole response in an untrusted-content fence
    // before it reaches the model; the matched pattern names are written to the
    // stats ledger's `detail` column (README's "matched pattern name written to
    // the log"). `injection.enabled` is the documented one-line opt-out.
    const injCfg = loadConfig().injection;
    const injectionMatches = injCfg.enabled && body ? scanForInjectionPatterns(body) : [];
    if (injectionMatches.length > 0) {
      recordStat('injection_detected', 0, 0, undefined, injectionMatches.join(','));
    }

    if (!body || body.length < 1024) {
      if (injectionMatches.length > 0) {
        return { hookType: 'rewriteOutput', updatedOutput: fenceUntrustedContent(body, injectionMatches) };
      }
      return passOutput();
    }

    // Store under a (url, prompt) dedup key - see preFetchHandler - while keeping
    // the persisted blob's displayed url clean for `token-goat web-history`. Also
    // record it in the session (url-keyed) for the compact-manifest "fetched this
    // session" listing.
    const prompt = typeof toolInput['prompt'] === 'string' ? (toolInput['prompt'] as string) : '';

    // A raw HTML body is the same unshrunk-payload problem image_shrink.ts already
    // solves for images: extract clean text before caching, so a later recall (web-output,
    // or a repeat fetch caught by preFetchHandler's dedup) never re-surfaces raw markup.
    // webfetch.compress_bodies/compress_min_bytes already existed as persisted, validated,
    // env-overridable config with zero consumers until now.
    let storedBody = body;
    const wfCfg = loadConfig().webfetch;
    if (wfCfg.compress_bodies && body.length >= wfCfg.compress_min_bytes && looksLikeHtml(body)) {
      try {
        storedBody = extractCleanText(body);
      } catch {
        storedBody = body;
      }
    }

    const cacheId = storeWebOutput(url, storedBody, `${url}\x00${prompt}`);
    recordWebFetch(url, prompt, cacheId);

    if (injectionMatches.length > 0) {
      // Fence storedBody (the compressed copy just cached above), not the raw body -- fencing
      // the raw body here would both defeat compress_bodies' token savings specifically on the
      // injection-detected path and return content that disagrees with what a later
      // `token-goat web-output <id>` recall of the same cache entry would return.
      return { hookType: 'rewriteOutput', updatedOutput: fenceUntrustedContent(storedBody, injectionMatches) };
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preFetchHandler, { toolName: 'WebFetch' });
registerHook('post_tool_use', postFetchHandler, { toolName: 'WebFetch' });
