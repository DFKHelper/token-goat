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

/**
 * Every spelling of `url` a pattern may legitimately be matched against: the string as written,
 * plus the form the request will actually take.
 *
 * Matching the raw string alone let four different rewrites of the same request slip past a deny
 * pattern, because each one names the denied resource in a way the literal text does not:
 * `https://example.com./private/x` (a trailing dot on the host, which DNS resolves identically),
 * `https://example.com/a/../private/x` and `https://example.com/./private/x` (dot segments, which
 * the URL parser collapses before the request goes out), and `https://example.com:443/private/x`
 * (the scheme's default port written out). All four reach exactly the resource a pattern like
 * `https://example.com/private/*` was written to block, and all four were permitted. The failure
 * landed on precisely the careful, narrowly-written patterns: a loose `*example.com*` still
 * matched, so the more specific an operator's policy was, the easier it was to step around.
 *
 * The canonical form is what the server will see, so it is the honest thing to test. The raw
 * string is kept alongside it because normalisation is lossy in the other direction too -- a
 * pattern written as `https://example.com:443/*` matches the raw text and not the canonical form
 * -- and dropping it would silently break policies that work today.
 */
function urlSpellings(url: string): string[] {
  const out = [url]
  try {
    const parsed = new URL(url)
    // A single trailing dot is a fully-qualified hostname: same DNS answer, different string.
    if (parsed.hostname.endsWith('.')) parsed.hostname = parsed.hostname.replace(/\.+$/, '')
    if (!out.includes(parsed.href)) out.push(parsed.href)
    // The same interchangeability the authority check gets, for the whole-string match: a policy
    // written as `https://example.com:443/*` has to match a URL written without the default port,
    // and the parser has already thrown that port away by the time we see it.
    const defaultPort = DEFAULT_PORTS[parsed.protocol]
    if (parsed.port === '' && defaultPort !== undefined) {
      // Assigning the scheme's default port is a no-op in the parser, so build the string directly.
      const spelled = `${parsed.protocol}//${parsed.username === '' && parsed.password === '' ? '' : `${parsed.username}${parsed.password === '' ? '' : `:${parsed.password}`}@`}${parsed.hostname}:${defaultPort}${parsed.pathname}${parsed.search}${parsed.hash}`
      if (!out.includes(spelled)) out.push(spelled)
    }
  } catch {
    // Unparseable: the raw string is all there is, and matchesAuthority already refuses it.
  }
  return out
}

/**
 * Additional spellings that only a deny list is matched against.
 *
 * `https://example.com/%70rivate/x` is served by most origins as `/private/x`, so a deny pattern
 * naming that path should catch it -- but percent-decoding is not something the URL parser does,
 * and decoding it for an *allow* list would be the unsafe direction (admitting a URL because a
 * decoded form of it happens to match). Deny is where matching more is the safe error, which is
 * the same asymmetry {@link matchesDenyPattern} already relies on for host-level patterns.
 */
function denyOnlySpellings(url: string): string[] {
  const out: string[] = []
  for (const spelling of urlSpellings(url)) {
    try {
      const decoded = decodeURI(spelling)
      if (decoded !== spelling) out.push(decoded)
    } catch {
      // Malformed percent-escape: nothing to add, the undecoded spellings still apply.
    }
  }
  return out
}

/** Ports the URL parser treats as implicit for their scheme, and so removes from `URL.host`. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  'http:': '80',
  'https:': '443',
  'ws:': '80',
  'wss:': '443',
  'ftp:': '21',
};

/** The host of a URL as the runtime will actually resolve it, or `null` when it does not parse. Both spellings are returned because a pattern may or may not name a port: `*.example.com` has to match `a.example.com:8443`, and `example.com:8443` has to match it too. */
function urlAuthorities(url: string): string[] | null {
  try {
    const parsed = new URL(url);
    const hosts = [parsed.host, parsed.hostname];
    // The URL parser drops a port that is the scheme's default, so `https://example.com:443/x`
    // yields only `example.com` here -- and a pattern whose authority spells that port out
    // (`https://example.com:443/*`) then matched no host at all. An allow list written that way
    // refused every URL and a deny list written that way stopped widening to the host, both
    // silently. Offering the explicit spelling as well makes the two forms interchangeable.
    const defaultPort = DEFAULT_PORTS[parsed.protocol];
    if (parsed.port === '' && defaultPort !== undefined) hosts.push(`${parsed.hostname}:${defaultPort}`);
    return hosts;
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
  const spellings = urlSpellings(url);
  return patterns.some(
    (pat) => spellings.some((s) => wildcardToRegExp(pat).test(s)) && matchesAuthority(authorities, pat),
  );
}

/** True when `url` is blocked by at least one pattern: the whole-string match OR, for a host-level pattern, the host match. Deny is the direction where matching more is the safe error, so the host check adds to it instead of narrowing it -- but only for patterns that name no path, since widening `https://evil.com/private/*` to the whole host would block URLs the user deliberately left out. */
export function matchesDenyPattern(url: string, patterns: string[]): boolean {
  const authorities = urlAuthorities(url);
  const spellings = [...urlSpellings(url), ...denyOnlySpellings(url)];
  return patterns.some(
    (pat) =>
      spellings.some((s) => wildcardToRegExp(pat).test(s)) ||
      (isHostLevelPattern(pat) && matchesAuthority(authorities, pat)),
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
