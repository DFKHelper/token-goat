/**
 * Security regression: allow/deny patterns were matched against the URL string exactly as
 * written, so several rewrites of the same request slipped past a deny pattern by naming the
 * denied resource in a way the literal text does not.
 *
 * All of these were permitted against `deny = ['https://example.com/private/*']` while reaching
 * exactly the resource it was written to block: a trailing dot on the host (which DNS resolves
 * identically), `/a/../private/x` and `/./private/x` (dot segments the parser collapses before
 * the request goes out), the scheme's default port written out, and `%70rivate` (which origins
 * serve as `/private`). The failure landed on precisely the careful, narrow patterns: a loose
 * `*example.com*` still matched, so the more specific the policy, the easier it was to step
 * around.
 *
 * Separately, the parser drops a default port from `URL.host`, so a pattern whose authority
 * spelled that port out matched no host at all: an allow list written that way refused every URL
 * and a deny list written that way silently stopped widening to the host.
 */
import { describe, expect, it } from 'vitest'

import { matchesAllowPattern, matchesDenyPattern, urlPolicyDenialReason } from '../src/url_policy.js'

const PRIVATE_DENY = ['https://example.com/private/*']

describe('deny matching is not defeated by an equivalent URL spelling', () => {
  it.each([
    ['the plain form', 'https://example.com/private/x'],
    ['a trailing dot on the host', 'https://example.com./private/x'],
    ['a parent dot segment', 'https://example.com/a/../private/x'],
    ['a current-directory dot segment', 'https://example.com/./private/x'],
    ['a percent-encoded path character', 'https://example.com/%70rivate/x'],
    ["the scheme's default port spelled out", 'https://example.com:443/private/x'],
    ['several of those combined', 'https://example.com.:443/a/../private/x'],
  ])('denies %s', (_name, url) => {
    expect(matchesDenyPattern(url, [...PRIVATE_DENY])).toBe(true)
    expect(urlPolicyDenialReason(url, { allow: [], deny: PRIVATE_DENY })).toMatch(/webfetch\.deny/)
  })

  // The point of the pattern being path-scoped: widening it to the whole host would block URLs
  // the operator deliberately left out, so normalisation must not turn it into a host block.
  it.each([
    ['a sibling path', 'https://example.com/public/x'],
    ['a different host', 'https://other.example/private/x'],
  ])('still permits %s', (_name, url) => {
    expect(matchesDenyPattern(url, [...PRIVATE_DENY])).toBe(false)
  })

  // A URL whose text names the denied path but which resolves past it is still denied: the raw
  // spelling stays in the match set, and for a deny list over-blocking is the safe error. Pinned
  // so the asymmetry is a decision on record rather than an accident of the matching order.
  it('denies a URL that names the denied path and then escapes it', () => {
    expect(matchesDenyPattern('https://example.com/private/../public/x', [...PRIVATE_DENY])).toBe(true)
  })
})

describe('a default port is interchangeable with omitting it', () => {
  it.each([
    ['pattern names the port, URL does not', 'https://example.com:443/*', 'https://example.com/x'],
    ['URL names the port, pattern does not', 'https://example.com/*', 'https://example.com:443/x'],
    ['both name the port', 'https://example.com:443/*', 'https://example.com:443/x'],
    ['http on port 80', 'http://example.com:80/*', 'http://example.com/x'],
  ])('allows when %s', (_name, pattern, url) => {
    expect(matchesAllowPattern(url, [pattern])).toBe(true)
  })

  it('denies when the deny pattern names the default port', () => {
    expect(matchesDenyPattern('https://example.com/secret', ['https://example.com:443/*'])).toBe(true)
  })

  // A non-default port is a real distinction and must not be normalised away.
  it('does not treat a non-default port as interchangeable', () => {
    expect(matchesAllowPattern('https://example.com:8443/x', ['https://example.com/*'])).toBe(false)
    expect(matchesAllowPattern('https://example.com/x', ['https://example.com:8443/*'])).toBe(false)
  })
})

describe('normalisation does not weaken the allow list', () => {
  // The exfiltration case the authority check exists for: the allowed host appears in the URL
  // text but the request goes elsewhere. Adding spellings must not reopen it.
  it.each([
    ['the allowed host sits in the query string', 'https://evil.com/steal?u=https://example.com/'],
    ['the allowed host sits in the query with a default port', 'https://evil.com/steal?u=https://example.com:443/'],
    ['the allowed host sits in userinfo', 'https://example.com@evil.com/steal'],
    ['the allowed host sits in the path', 'https://evil.com/https://example.com/x'],
  ])('refuses a URL where %s', (_name, url) => {
    expect(matchesAllowPattern(url, ['https://example.com/*'])).toBe(false)
    expect(urlPolicyDenialReason(url, { allow: ['https://example.com/*'], deny: [] })).toMatch(/webfetch\.allow/)
  })

  it('still admits the genuine host', () => {
    expect(urlPolicyDenialReason('https://example.com/x', { allow: ['https://example.com/*'], deny: [] })).toBeNull()
  })
})

describe('malformed input', () => {
  it('does not throw on an unparseable URL and refuses it under an allow list', () => {
    expect(() => matchesDenyPattern('not a url', ['*'])).not.toThrow()
    expect(matchesAllowPattern('not a url', ['*'])).toBe(false)
  })

  it('does not throw on a malformed percent-escape', () => {
    expect(() => matchesDenyPattern('https://example.com/%ZZ', ['https://example.com/*'])).not.toThrow()
    expect(matchesDenyPattern('https://example.com/%ZZ', ['https://example.com/*'])).toBe(true)
  })
})


/**
 * The parser stores an internationalised host punycode-encoded, because that is what DNS is asked
 * for. Nothing turned it back, so an allow pattern written in the spelling an operator actually
 * types matched no host at all and the policy refused every URL to that host, silently. Same shape
 * as the default-port case above, and the same fix: make the two spellings interchangeable.
 *
 * The widening decodes that exact hostname, so it can only ever add the same host under its other
 * name. The negative cases below are what prove it: a look-alike built from a different codepoint
 * is a different host and stays refused.
 */
describe('an internationalised host is interchangeable with its punycode form', () => {
  const UNICODE_PATTERN = 'https://exämple.com/*'
  const PUNYCODE_PATTERN = 'https://xn--exmple-cua.com/*'

  it.each([
    ['pattern and URL both in Unicode', 'https://exämple.com/private/x', UNICODE_PATTERN],
    ['a Unicode pattern against the punycode URL', 'https://xn--exmple-cua.com/private/x', UNICODE_PATTERN],
    ['a punycode pattern against the Unicode URL', 'https://exämple.com/private/x', PUNYCODE_PATTERN],
  ])('allows %s', (_label, url, pattern) => {
    expect(matchesAllowPattern(url, [pattern])).toBe(true)
  })

  it('denies the punycode spelling under a Unicode pattern', () => {
    expect(matchesDenyPattern('https://xn--exmple-cua.com/private/x', [UNICODE_PATTERN])).toBe(true)
  })

  it.each([
    ['a look-alike host built from a different codepoint', 'https://exаmple.com/x'],
    ['another host carrying the allowed one in its query', 'https://evil.com/steal?x=exämple.com/'],
    ['another host carrying the allowed one as userinfo', 'https://exämple.com@evil.com/x'],
    ['a subdomain of another host', 'https://xn--exmple-cua.com.evil.com/x'],
  ])('still refuses %s', (_label, url) => {
    expect(matchesAllowPattern(url, [UNICODE_PATTERN])).toBe(false)
  })

  it('leaves an ASCII host alone', () => {
    expect(matchesAllowPattern('https://example.com/x', ['https://example.com/*'])).toBe(true)
    expect(matchesAllowPattern('https://evil.com/x', ['https://example.com/*'])).toBe(false)
  })
})
