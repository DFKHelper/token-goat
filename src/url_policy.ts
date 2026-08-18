/**
 * Shared allow/deny matching for URL policy (`webfetch.allow` / `webfetch.deny`).
 *
 * Lives in its own leaf module because two very different callers need the same decision: the
 * WebFetch pre-hook, which gates the harness's own fetch tool, and performHttpFetch in
 * webfetch.ts, which is the single socket every fetch token-goat performs itself goes through.
 * Keeping one implementation is what stops the two from drifting into disagreeing about what
 * the operator's policy means.
 */

/** Build a case-insensitive RegExp from a wildcard pattern where `*` matches any run of characters (including `/`). Deliberately not minimatch/pack.ts's path-glob semantics -- those treat `/` as a segment boundary a bare `*` won't cross, which is wrong for URL patterns like `*.example.com*` that need to span the `://` and path segments of a URL. `?` is escaped along with the other regex metacharacters because it is an ordinary literal in a URL query string: left unescaped it turns the preceding character optional, so `*example.com/?debug=1*` both failed to match the URL it was written for and matched `https://example.com/debug=1`, which it was not -- a deny list that silently does not deny is the exact failure this wiring exists to remove. */
export function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** The authority (`host[:port]`) section of a wildcard pattern: everything after an optional `scheme://` and before the first `/`, `?` or `#`. `''` when the pattern has no authority to speak of. */
function authorityPatternOf(pattern: string): string {
  const afterScheme = pattern.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const end = afterScheme.search(/[/?#]/);
  return end === -1 ? afterScheme : afterScheme.slice(0, end);
}

/** True when the pattern constrains only the host, so its authority section describes every URL it was written to match. `https://evil.com/private/*` is path-scoped and does not qualify; `https://evil.com`, `https://evil.com/*` and `https://evil.com*` all do. */
function isHostLevelPattern(pattern: string): boolean {
  const afterScheme = pattern.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const end = afterScheme.search(/[/?#]/);
  if (end === -1) return true; // nothing after the authority to scope with
  const rest = afterScheme.slice(end);
  return rest === '/' || rest === '/*';
}

/** The host of a URL as the runtime will actually resolve it, or `null` when it does not parse. Both spellings are returned because a pattern may or may not name a port: `*.example.com` has to match `a.example.com:8443`, and `example.com:8443` has to match it too. */
function urlAuthorities(url: string): string[] | null {
  try {
    const parsed = new URL(url);
    return [parsed.host, parsed.hostname];
  } catch {
    return null;
  }
}

/**
 * True when the URL's real host matches the pattern's authority section.
 *
 * This is the check that makes the whole-string match below mean what it appears to mean. A
 * pattern is matched against the entire URL string, so `https://*.example.com/*` is satisfied by
 * `https://evil.com/steal?x=.example.com/` -- the allowed domain sits in the query, the request
 * goes to evil.com, and an allow-list configured to stop exactly that exfiltration lets it
 * through. Userinfo does the same for a deny list: `https://x@evil.com/` fetches evil.com while
 * dodging a `https://evil.com/*` deny pattern. Both are closed by asking the parsed URL what host
 * it will really contact, rather than trusting where a substring happens to appear in the text.
 */
function matchesAuthority(authorities: string[] | null, pattern: string): boolean {
  if (authorities === null) return false;
  const auth = authorityPatternOf(pattern);
  if (auth === '') return false;
  const re = wildcardToRegExp(auth);
  return authorities.some((host) => re.test(host));
}

/** True when `url` is allowed by at least one pattern: the whole-string match AND the host match, so a pattern can only ever admit a URL that really goes to the host the pattern names. Empty `patterns` never matches anything, so callers gate the allow-list branch on a non-empty list themselves. */
export function matchesAllowPattern(url: string, patterns: string[]): boolean {
  const authorities = urlAuthorities(url);
  return patterns.some((pat) => wildcardToRegExp(pat).test(url) && matchesAuthority(authorities, pat));
}

/** True when `url` is blocked by at least one pattern: the whole-string match OR, for a host-level pattern, the host match. Deny is the direction where matching more is the safe error, so the host check adds to it instead of narrowing it -- but only for patterns that name no path, since widening `https://evil.com/private/*` to the whole host would block URLs the user deliberately left out. */
export function matchesDenyPattern(url: string, patterns: string[]): boolean {
  const authorities = urlAuthorities(url);
  return patterns.some(
    (pat) => wildcardToRegExp(pat).test(url) || (isHostLevelPattern(pat) && matchesAuthority(authorities, pat)),
  );
}

export interface UrlPolicy {
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

/**
 * The reason `url` is refused by `policy`, or `null` when it is permitted.
 *
 * Deny wins over allow, and a non-empty allow list is a closed world: anything it does not name
 * is refused. An empty policy on both sides permits everything, which is the default and keeps
 * an unconfigured install behaving exactly as before.
 */
export function urlPolicyDenialReason(url: string, policy: UrlPolicy): string | null {
  if (policy.deny.length > 0 && matchesDenyPattern(url, [...policy.deny])) {
    return 'URL matches a configured webfetch.deny pattern'
  }
  if (policy.allow.length > 0 && !matchesAllowPattern(url, [...policy.allow])) {
    return 'URL does not match any configured webfetch.allow pattern'
  }
  return null
}
