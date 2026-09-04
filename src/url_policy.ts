/**
 * Shared allow/deny matching for URL policy (`webfetch.allow` / `webfetch.deny`).
 *
 * Lives in its own leaf module because two very different callers need the same decision: the
 * WebFetch pre-hook, which gates the harness's own fetch tool, and performHttpFetch in
 * webfetch.ts, which is the single socket every fetch token-goat performs itself goes through.
 * Keeping one implementation is what stops the two from drifting into disagreeing about what
 * the operator's policy means.
 */

import { domainToUnicode } from 'node:url'

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
    // Assigning a default port or a Unicode host is a no-op in the parser, so both spellings below
    // are built as strings directly rather than by mutating `parsed`.
    const spellWith = (authority: string): string =>
      `${parsed.protocol}//${parsed.username === '' && parsed.password === '' ? '' : `${parsed.username}${parsed.password === '' ? '' : `:${parsed.password}`}@`}${authority}${parsed.pathname}${parsed.search}${parsed.hash}`
    const defaultPort = DEFAULT_PORTS[parsed.protocol]
    if (parsed.port === '' && defaultPort !== undefined) {
      const spelled = spellWith(`${parsed.hostname}:${defaultPort}`)
      if (!out.includes(spelled)) out.push(spelled)
    }
    // The parser stores an internationalised host punycode-encoded, because that is what DNS is
    // asked for. A pattern written in the spelling an operator actually types then matched neither
    // the host nor the whole string.
    const unicodeHost = domainToUnicode(parsed.hostname)
    if (unicodeHost !== '' && unicodeHost !== parsed.hostname) {
      const spelled = spellWith(parsed.port === '' ? unicodeHost : `${unicodeHost}:${parsed.port}`)
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
    // Same interchangeability for an internationalised host. `https://exämple.com/*` as an allow
    // pattern matched no host at all, because the parser hands back `xn--exmple-cua.com`, so a policy
    // written in the operator's own spelling refused every URL to that host and said nothing. This is
    // a decode of that exact hostname, so it can only ever add the same host under its other name.
    const unicodeHost = domainToUnicode(parsed.hostname);
    if (unicodeHost !== '' && unicodeHost !== parsed.hostname) {
      hosts.push(unicodeHost);
      if (parsed.port !== '') hosts.push(`${unicodeHost}:${parsed.port}`);
      else if (defaultPort !== undefined) hosts.push(`${unicodeHost}:${defaultPort}`);
    }
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

/**
 * Cloud instance-metadata endpoints, which no agent has a legitimate reason to fetch.
 *
 * These addresses answer only from inside a cloud instance, and what they answer with is the
 * instance's own role credentials. That makes them the classic SSRF target: an attacker who can
 * influence one fetched URL turns it into the machine's cloud identity.
 *
 * token-goat's own fetching already refuses them -- `performHttpFetch` blocks link-local and
 * private ranges, re-checks every redirect hop, and pins DNS. This list exists for the other
 * surface: the harness's own `WebFetch` tool runs outside our process, and all we can do is refuse
 * to let the call start.
 */
export /** Parses an IPv6 literal into its eight 16-bit groups, or null if it isn't one. Handles `::`
 * zero-compression, a `%zone` suffix, and a dotted-quad tail (`::ffff:127.0.0.1`), which it
 * folds into the equivalent two hex groups so the classifier only ever sees one representation.
 * Needed because a substring/prefix test can't see through those spellings: `::ffff:127.0.0.1`
 * is normalized by `new URL` to `::ffff:7f00:1`, which matches no textual loopback pattern. */
function parseIpv6Groups(text: string): number[] | null {
  let rest = text
  const zoneAt = rest.indexOf('%')
  if (zoneAt !== -1) rest = rest.slice(0, zoneAt)
  if (!/^[0-9a-f:.]+$/i.test(rest) || !rest.includes(':')) return null

  const lastColon = rest.lastIndexOf(':')
  const tail = rest.slice(lastColon + 1)
  if (tail.includes('.')) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(tail)
    if (!quad) return null
    const octets = [Number(quad[1]), Number(quad[2]), Number(quad[3]), Number(quad[4])]
    if (octets.some((n) => n > 255)) return null
    const hi = ((octets[0] as number) << 8) | (octets[1] as number)
    const lo = ((octets[2] as number) << 8) | (octets[3] as number)
    rest = `${rest.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`
  }

  const parseGroup = (g: string): number | null => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : null)
  const halves = rest.split('::')
  if (halves.length > 2) return null

  let parts: string[]
  if (halves.length === 2) {
    const left = (halves[0] as string).length > 0 ? (halves[0] as string).split(':') : []
    const right = (halves[1] as string).length > 0 ? (halves[1] as string).split(':') : []
    if (left.length + right.length > 7) return null // `::` must stand for at least one group
    parts = [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  } else {
    parts = rest.split(':')
    if (parts.length !== 8) return null
  }

  const groups: number[] = []
  for (const part of parts) {
    const value = parseGroup(part)
    if (value === null) return null
    groups.push(value)
  }
  return groups
}

const METADATA_HOSTNAMES: ReadonlySet<string> = new Set([
  'metadata.google.internal',
  'metadata.goog',
  // GCE answers on the bare name too, and it is the form most of Google's own docs use.
  'metadata',
  // Alibaba Cloud's equivalent of 169.254.169.254.
  '100.100.100.200',
  // EC2 resolves both of these to 169.254.169.254 inside a VPC, and neither is a dotted quad, so
  // the link-local test below never sees them.
  'instance-data',
  'instance-data.ec2.internal',
])
const METADATA_IPV6: ReadonlySet<string> = new Set(['fd00:ec2::254', '[fd00:ec2::254]'])

/**
 * Why `url` must not be fetched at all, or `null` when nothing here objects.
 *
 * Unconditional on purpose. This deliberately is not a default value for `webfetch.deny`: a
 * default is something an operator can remove without noticing they removed it, and a config file
 * that has drifted, been copied from an older install, or been written by a generator would then
 * silently reopen the hole. Ordinary hosts stay governed by `webfetch.allow` / `webfetch.deny`,
 * which is where operator policy belongs. Note that `localhost` is deliberately absent: fetching a
 * local development server is normal work, and refusing it would cost real users something real to
 * defend against nothing.
 *
 * Numeric spellings of 169.254.169.254 -- decimal `2852039166`, hex `0xA9FEA9FE`, octal
 * `0251.0376.0251.0376` -- need no handling here, because WHATWG `URL` has already normalised them
 * to the dotted quad by the time `hostname` is read. IPv6 is the case that does need handling, and
 * an adversarial review found it missing: `URL` normalises `[::ffff:169.254.169.254]` to
 * `[::ffff:a9fe:a9fe]`, which matches no dotted-quad pattern and no name. So the address is parsed
 * and any embedded IPv4 is decoded before it is classified, through {@link parseIpv6Groups} -- the
 * same parser `screenshot.ts` uses, imported rather than reimplemented, because a second
 * hand-rolled copy of this classification is exactly how the gap arose. A second review then found
 * the decode was written as a list of three named encodings and there are more than three, so it
 * reads the positions an IPv4 address can occupy instead ({@link embeddedIpv4Candidates}).
 *
 * What this cannot do, stated because the limit matters more than the check: the test is on the
 * address as written. A *name* that resolves into 169.254.0.0/16 is not caught, and neither is a
 * redirect from an allowed host onto a metadata address, because the fetch this guards runs in
 * another process that follows its own redirects. Token-goat's own fetcher closes both of those
 * ({@link performHttpFetch} pins DNS and re-checks each hop); this function governs the URL a
 * harness tool was asked to fetch, and that is the whole of its reach.
 */
export function metadataEndpointRefusal(url: string): string | null {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }

  if (METADATA_HOSTNAMES.has(host) || METADATA_IPV6.has(host)) {
    return `URL is a cloud instance-metadata endpoint (${host})`
  }
  // The whole 169.254.0.0/16 link-local block, not just 169.254.169.254: AWS ECS serves task
  // credentials from 169.254.170.2, and pinning the one famous address misses its neighbours.
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return `URL is a link-local address (${host}), where cloud metadata services answer`
  }
  if (embeddedIpv4Candidates(host).some(([a, b]) => a === 169 && b === 254)) {
    return `URL is a link-local address written as IPv6 (${host}), where cloud metadata services answer`
  }
  return null
}

/**
 * The IPv4 address an IPv6 literal carries, or `null` when it carries none.
 *
 * Covers the three encodings that put a routable IPv4 address inside an IPv6 one: IPv4-mapped
 * (`::ffff:0:0/96`), IPv4-compatible (`::/96`), and the NAT64 well-known prefix `64:ff9b::/96`,
 * whose low 32 bits a NAT64 gateway translates straight back out. Each spells the same destination
 * differently, so each has to be decoded before the address is judged rather than after.
 */
/**
 * Every IPv4 address an IPv6 address could be carrying, as four-byte tuples.
 *
 * The first version of this named three encodings -- IPv4-mapped, IPv4-compatible and the
 * well-known NAT64 prefix -- and a review pointed out that naming encodings is the same mistake in a
 * smaller box. `::ffff:0:a9fe:a9fe` is the translated form from RFC 2765, `64:ff9b:1::` is the
 * local-use NAT64 prefix from RFC 8215, and `2002::` is 6to4, which puts the IPv4 address somewhere
 * else entirely. Each would have needed its own clause, and the next one would have needed the one
 * after that.
 *
 * So this reads positions rather than prefixes. The last two groups are where all the
 * prefix-and-suffix encodings put the address, whatever the prefix is, and 6to4 puts it in the two
 * groups after the first. Both are returned and the caller checks both.
 *
 * The cost of reading a position rather than matching a prefix is that an ordinary IPv6 address
 * whose last four bytes happen to spell 169.254.x.x is refused too. That address is
 * `something::a9fe:xxxx`, it is not a shape anything allocates, and refusing it costs a fetch that
 * was never going to happen. The alternative cost -- one more encoding nobody enumerated reaching
 * the credential endpoint -- is the one this exists to prevent.
 */
function embeddedIpv4Candidates(host: string): [number, number, number, number][] {
  const groups = parseIpv6Groups(host.replace(/^\[/, '').replace(/\]$/, ''))
  if (groups === null) return []

  const split = (hi: number, lo: number): [number, number, number, number] => [
    hi >> 8,
    hi & 0xff,
    lo >> 8,
    lo & 0xff,
  ]
  const out: [number, number, number, number][] = [split(groups[6] ?? 0, groups[7] ?? 0)]
  // 6to4: the IPv4 address sits in the two groups directly after the 2002 prefix.
  if (groups[0] === 0x2002) out.push(split(groups[1] ?? 0, groups[2] ?? 0))
  return out
}
