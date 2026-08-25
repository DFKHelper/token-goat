import type { HookEvent } from './hook_registry.js';
import { registerHook } from './hook_registry.js';
import type { HookOutput } from './types.js';
import { passOutput, getToolName, getToolInput, denyOutput, extractToolResponseField, BODY_FIRST_TOOL_RESPONSE_KEYS, emitRewrite } from './hooks_common.js';
import { recordStat } from './stats.js';
import { storeWebOutput, getWebOutput } from './web_cache.js';
import { recordWebFetch } from './session.js';
import { shortFingerprint } from './fingerprint.js';
import { loadConfig } from './config.js';
import { looksLikeHtml, extractCleanText } from './web_extract.js';
import { scanForInjectionPatterns, fenceUntrustedContent } from './injection_scan.js';
import { redactSecrets } from './secret_redact.js';
import { isRewriteWorthwhile, resolveMinNetSavingsBytes } from './tool_filters/base.js';
import { matchesAllowPattern, matchesDenyPattern } from './url_policy.js';

function extractToolResponse(raw: Record<string, unknown>): string {
  return extractToolResponseField(raw, BODY_FIRST_TOOL_RESPONSE_KEYS);
}

/** Identity check shared by every WebFetch handler below: only a WebFetch call with a valid url
 * is in scope. Deliberately does NOT require a session id -- see {@link resolveWebFetchContext}
 * for the session-scoped variant used by the caching/dedup paths, and postFetchHandler's own
 * comment for why the injection scan must run even without one. */
function resolveWebFetchUrl(event: HookEvent): { toolInput: Record<string, unknown>; url: string } | null {
  const toolName = getToolName(event);
  if (toolName !== 'WebFetch') {
    return null;
  }

  const toolInput = getToolInput(event);
  const url = toolInput['url'] as string;
  if (!url || typeof url !== 'string') {
    return null;
  }

  return { toolInput, url };
}

/** Shared prologue for the session-scoped caching/dedup paths (preFetchHandler's recall check,
 * postFetchHandler's storeWebOutput): only a WebFetch call with a valid url AND a session id is
 * in scope -- caching is inherently session-keyed, so a call with no session id has nothing to
 * cache against. Everything else passes through untouched. */
function resolveWebFetchContext(event: HookEvent): { toolInput: Record<string, unknown>; url: string } | null {
  if (!event.sessionId) {
    return null;
  }
  return resolveWebFetchUrl(event);
}

export function preFetchHandler(event: HookEvent): HookOutput {
  try {
    // webfetch.allow/webfetch.deny gate every WebFetch call regardless of session id -- unlike the dedup check below, blocking a URL has nothing to do with caching, so it must run even for a harness that sends no session_id (see resolveWebFetchContext's own comment).
    const urlOnlyCtx = resolveWebFetchUrl(event);
    if (urlOnlyCtx !== null) {
      const wfCfg = loadConfig().webfetch;
      if (wfCfg.deny.length > 0 && matchesDenyPattern(urlOnlyCtx.url, wfCfg.deny)) {
        return denyOutput(`WebFetch blocked: URL matches a configured webfetch.deny pattern.`);
      }
      if (wfCfg.allow.length > 0 && !matchesAllowPattern(urlOnlyCtx.url, wfCfg.allow)) {
        return denyOutput(`WebFetch blocked: URL does not match any configured webfetch.allow pattern.`);
      }
    }

    const ctx = resolveWebFetchContext(event);
    if (ctx === null) {
      return passOutput();
    }
    const { toolInput, url } = ctx;

    // Dedup key includes the prompt: WebFetch answers are prompt-specific, so a repeat fetch of the same URL with a different question must not be redirected to a stale answer for the WRONG question. Deriving the cache id directly (a pure function of url+prompt, mirroring cacheIdForUrl in web_cache.ts) instead of going through the session-scoped webFetches map also makes the lookup work across processes/sessions via getWebOutput's disk fallback - the same cross-process approach getWebOutputByUrlFromDisk uses for gdrive.ts.
    const prompt = typeof toolInput['prompt'] === 'string' ? (toolInput['prompt'] as string) : '';
    const cacheId = shortFingerprint(`${url}\x00${prompt}`);
    // Guard on the content blob (in-memory or on disk), not just the session index, so a pruned or evicted entry never yields a web-output hint that would error - mirrors the curl-GET recall guard in hooks_bash.
    const cached = getWebOutput(cacheId);
    if (cached !== null) {
      const cachedBytes = Buffer.byteLength(cached, 'utf-8');
      if (cachedBytes >= loadConfig().hints.web_dedup_min_bytes) {
        recordStat('webfetch:recall', cachedBytes, Math.round(cachedBytes / 4));
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
    // Deliberately resolved WITHOUT requiring a session id (unlike the caching path below): the injection scan's contract per README ("every fetched page is scanned for attack patterns") is unconditional, but relay.ts's sessionId derivation falls back to '' for any harness that doesn't send session_id/sessionId on the wire (see its own comment) -- a call from such a harness must still get scanned, even though it has nothing to cache against.
    const urlCtx = resolveWebFetchUrl(event);
    if (urlCtx === null) {
      return passOutput();
    }
    const { toolInput, url } = urlCtx;

    recordStat('web_fetch');

    const body = extractToolResponse(event.raw);

    // Prompt-injection scan: README's documented contract ("every fetched page is scanned for attack patterns") is unconditional, so this runs ahead of both the session gate and the caching-size gate below rather than being folded into either. A match anywhere in the response wraps the whole response in an untrusted-content fence before it reaches the model; the matched pattern names are written to the stats ledger's `detail` column. `injection.enabled` is the documented one-line opt-out.
    const injCfg = loadConfig().injection;
    const injectionMatches = injCfg.enabled && body ? scanForInjectionPatterns(body) : [];
    if (injectionMatches.length > 0) {
      recordStat('injection_detected', 0, 0, undefined, injectionMatches.join(','));
    }
    // Redact secrets on this same live path, computed here ahead of every early-return guard below -- neither WebFetch's caching store (storeWebOutput redacts its own persisted copy separately) nor this handler redacted what the model actually reads THIS turn, so a fetched page carrying a credential that trips no injection pattern (an API key pasted into a forum answer, a leaked token in an indexed gist) reached the model unredacted. Mirrors hooks_websearch.ts's postWebSearchHandler fix for the same gap.
    const bodyRedacted = body ? redactSecrets(body) : { text: body, count: 0 };

    // Everything below this point (dedup cache lookup key reuse aside, the actual store) is inherently session-scoped -- a missing session id has nothing to cache against, but the fence and redaction above must still apply to whatever was scanned.
    if (!event.sessionId) {
      if (injectionMatches.length > 0) {
        return emitRewrite(fenceUntrustedContent(bodyRedacted.text, injectionMatches), 'fetch');
      }
      if (bodyRedacted.count > 0) {
        return emitRewrite(bodyRedacted.text, 'fetch');
      }
      return passOutput();
    }

    if (!body || body.length < 1024) {
      if (injectionMatches.length > 0) {
        return emitRewrite(fenceUntrustedContent(bodyRedacted.text, injectionMatches), 'fetch');
      }
      if (bodyRedacted.count > 0) {
        return emitRewrite(bodyRedacted.text, 'fetch');
      }
      return passOutput();
    }

    // Store under a (url, prompt) dedup key - see preFetchHandler - while keeping the persisted blob's displayed url clean for `token-goat web-history`. Also record it in the session (url-keyed) for the compact-manifest "fetched this session" listing.
    const prompt = typeof toolInput['prompt'] === 'string' ? (toolInput['prompt'] as string) : '';

    // A raw HTML body is the same unshrunk-payload problem image_shrink.ts already solves for images: extract clean text before caching, so a later recall (web-output, or a repeat fetch caught by preFetchHandler's dedup) never re-surfaces raw markup by default. webfetch.compress_bodies/compress_min_bytes already existed as persisted, validated, env-overridable config with zero consumers until now. The uncleaned body is passed through to storeWebOutput below as `rawContent` so it stays recoverable via `web-output --raw` rather than being lost -- a lossy store with no recovery path is the defect this closes, not the cleaning itself.
    let storedBody = body;
    const wfCfg = loadConfig().webfetch;
    if (wfCfg.compress_bodies && body.length >= wfCfg.compress_min_bytes && looksLikeHtml(body)) {
      try {
        storedBody = extractCleanText(body);
      } catch {
        storedBody = body;
      }
    }

    const cacheId = storeWebOutput(url, storedBody, `${url}\x00${prompt}`, storedBody !== body ? body : undefined);
    recordWebFetch(url, prompt, cacheId);

    // storedBody may differ from body (extractCleanText above), so redact it fresh rather than reusing bodyRedacted -- same "redact what is actually about to be shown" reasoning as fencing storedBody rather than the raw body just below.
    const storedRedacted = storedBody === body ? bodyRedacted : redactSecrets(storedBody);

    if (injectionMatches.length > 0) {
      // Fence storedBody (the compressed copy just cached above), not the raw body -- fencing the raw body here would both defeat compress_bodies' token savings specifically on the injection-detected path and return content that disagrees with what a later `token-goat web-output <id>` recall of the same cache entry would return.
      return emitRewrite(fenceUntrustedContent(storedRedacted.text, injectionMatches), 'fetch');
    }

    // Normal path: ship the compressed copy already computed and cached above instead of discarding it -- previously storedBody was only ever consumed by the injection-detected branch, so a compressed HTML body's savings never reached the model. Gated on compression having actually happened (storedBody !== body) so an unchanged body is never rewritten, and on the same net-benefit floor bash_compress uses so a rewrite whose savings don't clear the recall notice's own cost isn't shipped.
    if (storedBody !== body) {
      const noticeFor = (id: string): string => `\n[token-goat: WebFetch body compressed via extractCleanText; use \`token-goat web-output ${id} --raw\` to recall it]`
      const notice = noticeFor(cacheId)
      const noticeBytes = Buffer.byteLength(notice, 'utf-8')
      const originalBytes = Buffer.byteLength(body, 'utf-8');
      const rewrittenBytes = Buffer.byteLength(storedBody, 'utf-8');
      if (
        isRewriteWorthwhile({
          originalBytes,
          rewrittenBytes,
          noticeBytes,
          minNetSavingsBytes: resolveMinNetSavingsBytes(),
        })
      ) {
        const bytesDelta = originalBytes - rewrittenBytes;
        recordStat('webfetch:compress', bytesDelta, Math.round(bytesDelta / 4))
        return emitRewrite(storedRedacted.text + notice, 'fetch');
      }
    }

    // Reached when neither the fence nor the compression rewrite fired -- redaction is a security action, not a compression one, so it must not inherit the net-benefit floor or the compress_bodies gate above: a short page with a bare credential and no other savings is exactly the case those would drop.
    if (storedRedacted.count > 0) {
      return emitRewrite(storedRedacted.text, 'fetch');
    }

    return passOutput();
  } catch {
    return passOutput();
  }
}

registerHook('pre_tool_use', preFetchHandler, { toolName: 'WebFetch' });
registerHook('post_tool_use', postFetchHandler, { toolName: 'WebFetch' });
