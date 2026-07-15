import { existsSync, readdirSync, unlinkSync } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { isIPv4, isIPv6 } from 'net';
import { resolve, join } from 'path';
import { URL } from 'url';
import { promisify } from 'util';
import { lookup as dnsLookup, type LookupOptions } from 'dns';
import { dataDir } from './constants.js';

const dnsLookupAsync = promisify(dnsLookup);

const MAX_URL_IN_ERROR = 200;
const ALLOW_UNRESOLVED = (process.env['TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED'] ?? '').toLowerCase() === 'true';

function webCacheDir(): string {
  return join(dataDir(), 'web_cache');
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  '169.254.169.254',
]);

function truncateUrl(url: string, maxLen: number = MAX_URL_IN_ERROR): string {
  const sanitized = url.replace(/[\r\n]/g, '');
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) + '…' : sanitized;
}

type SsrfResolution =
  | { kind: 'safe'; address: string; family: number; addresses: Array<{ address: string; family: number }> }
  | { kind: 'blocked' }
  | { kind: 'unresolved' };

/**
 * Resolve `hostname` and validate every returned address is not private —
 * the single source of truth for "is this host safe to connect to". Used as
 * the resolver plugged into every real socket connection (see
 * ssrfPinnedLookup below), so the address that gets validated is always the
 * exact address that gets connected to — closing the DNS-rebinding TOCTOU
 * gap between a separate check and fetch.
 */
async function resolveSsrfSafeAddress(hostname: string): Promise<SsrfResolution> {
  const hostnameLower = hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostnameLower)) return { kind: 'blocked' };

  let results: Array<{ address: string; family: number }>;
  try {
    const r = await dnsLookupAsync(hostnameLower, { all: true });
    if (!Array.isArray(r) || r.length === 0) return { kind: 'unresolved' };
    results = r;
  } catch {
    return { kind: 'unresolved' };
  }

  for (const addr of results) {
    const ip = addr.address || '';
    const isPrivate = isIPv4(ip) ? isPrivateIPv4(ip) : isIPv6(ip) ? isPrivateIPv6(ip) : true;
    if (isPrivate) return { kind: 'blocked' };
  }

  const first = results[0];
  if (!first) return { kind: 'unresolved' };
  return { kind: 'safe', address: first.address, family: first.family, addresses: results };
}

/**
 * dns.lookup-compatible resolver passed as the `lookup` option on every real
 * HTTP(S) request this module makes (initial request and every redirect
 * hop). Resolving here — rather than trusting a hostname string handed to
 * http(s).request — means the address used to open the TCP/TLS socket is
 * the exact address resolveSsrfSafeAddress just validated, with no gap for
 * a second, independent DNS lookup (and thus DNS rebinding) to slip in.
 *
 * Node's own dual-stack (Happy Eyeballs / autoSelectFamily, default-on since
 * Node 20) connection logic sets `options.all` when it wants every resolved
 * address back to race connections across, and requires the array-callback
 * shape (`callback(err, addresses[])`) in that case -- not the single
 * `callback(err, address, family)` shape used otherwise. Always returning
 * the single-address shape regardless of `options.all` made Node's net
 * internals throw "Invalid IP address: undefined" for any real, non-literal
 * hostname (verified against raw.githubusercontent.com fetch-image dogfood
 * run on Node 24) -- every fetch of a real URL was broken, not just SSRF
 * targets. Both branches below now answer in whichever shape `options.all`
 * asked for.
 */
export function ssrfPinnedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | Array<{ address: string; family: number }>,
    family?: number,
  ) => void,
): void {
  resolveSsrfSafeAddress(hostname)
    .then((result) => {
      if (result.kind === 'safe') {
        if (options.all) {
          callback(null, result.addresses);
        } else {
          callback(null, result.address, result.family);
        }
        return;
      }
      if (result.kind === 'unresolved' && ALLOW_UNRESOLVED) {
        // Even though the pinned (all:true) lookup didn't resolve, whatever
        // address this raw fallback lookup DOES come back with must still be
        // validated before it's handed to the socket — otherwise a hostname
        // engineered to fail the pinned lookup but resolve here (a DNS
        // rebinding technique) would bypass private-IP blocking entirely.
        dnsLookup(hostname, { ...options, all: false }, (err, address, family) => {
          if (err) {
            callback(err, options.all ? [] : '', family);
            return;
          }
          const addr = typeof address === 'string' ? address : '';
          const isPrivate = isIPv4(addr) ? isPrivateIPv4(addr) : isIPv6(addr) ? isPrivateIPv6(addr) : true;
          if (isPrivate) {
            callback(
              new Error(`URL blocked by SSRF safety check: ${truncateUrl(hostname)}`) as NodeJS.ErrnoException,
              options.all ? [] : '',
            );
            return;
          }
          if (options.all) {
            callback(null, [{ address: addr, family: family ?? 0 }]);
          } else {
            callback(null, addr, family);
          }
        });
        return;
      }
      callback(
        new Error(`URL blocked by SSRF safety check: ${truncateUrl(hostname)}`) as NodeJS.ErrnoException,
        options.all ? [] : '',
      );
    })
    .catch((err: unknown) => {
      callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err)), options.all ? [] : '');
    });
}

export function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map((s) => {
    const n = Number(s);
    return s.length > 0 && Number.isFinite(n) && n >= 0 && n <= 255 ? n : NaN;
  });
  if (octets.length !== 4 || octets.some((o) => !Number.isFinite(o))) return false;
  const a = octets[0] as number;
  const b = octets[1] as number;
  return (
    a === 0 || // 0.0.0.0/8 ("this network" / unspecified-source range)
    a === 127 || // 127.x.x.x
    a === 10 || // 10.x.x.x
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (carrier-grade NAT, RFC 6598)
    (a === 172 && b >= 16 && b <= 31) || // 172.16-31.x.x
    (a === 192 && b === 168) || // 192.168.x.x
    (a === 169 && b === 254) // 169.254.x.x
  );
}

/**
 * Parse a syntactically valid IPv6 literal (per net.isIPv6) into its 8
 * 16-bit groups, expanding "::" zero-compression and any embedded
 * dotted-decimal IPv4 suffix (the IPv4-mapped/IPv4-translated forms, e.g.
 * `::ffff:1.2.3.4` or `::ffff:0:1.2.3.4`). Returns null only if `ip` fails
 * net.isIPv6 or otherwise can't be decoded.
 */
function parseIPv6Groups(ip: string): number[] | null {
  if (!isIPv6(ip)) return null;

  const withoutZone = ip.split('%')[0] ?? ip; // strip a zone/scope id, e.g. "fe80::1%eth0"
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const tokens = side.split(':');
    const groups: number[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i] as string;
      if (tok.includes('.')) {
        if (i !== tokens.length - 1 || !isIPv4(tok)) return null; // embedded IPv4 must be the final token
        const octets = tok.split('.').map(Number);
        groups.push(((octets[0] as number) << 8) | (octets[1] as number));
        groups.push(((octets[2] as number) << 8) | (octets[3] as number));
      } else {
        const val = parseInt(tok, 16);
        if (!Number.isFinite(val) || val < 0 || val > 0xffff) return null;
        groups.push(val);
      }
    }
    return groups;
  };

  if (halves.length === 1) {
    const groups = parseSide(halves[0] ?? '');
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSide(halves[0] ?? '');
  const right = parseSide(halves[1] ?? '');
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...new Array(missing).fill(0), ...right];
}

/** True when the leading `prefixBits` bits of `groups` match `prefixGroups`. */
function matchesIPv6Prefix(groups: number[], prefixGroups: number[], prefixBits: number): boolean {
  let bitsLeft = prefixBits;
  for (let i = 0; i < 8 && bitsLeft > 0; i++) {
    const take = Math.min(16, bitsLeft);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    if (((groups[i] ?? 0) & mask) !== ((prefixGroups[i] ?? 0) & mask)) return false;
    bitsLeft -= take;
  }
  return true;
}

const FC00_PREFIX = [0xfc00, 0, 0, 0, 0, 0, 0, 0]; // fc00::/7 (unique local addresses)
const FE80_PREFIX = [0xfe80, 0, 0, 0, 0, 0, 0, 0]; // fe80::/10 (link-local addresses)

/**
 * True when `ip` is an IPv6 loopback/unique-local/link-local address, or an
 * IPv4-mapped (`::ffff:a.b.c.d`), IPv4-translated (`::ffff:0:a.b.c.d`), or the
 * deprecated IPv4-compatible (`::a.b.c.d`) address whose embedded IPv4
 * address is private — a private IPv4 address
 * wrapped in IPv6 notation must not slip past this check just because the
 * string "looks like" IPv6. fc00::/7 and fe80::/10 are matched as true CIDR
 * ranges (not literal string prefixes), so e.g. fd12:3456:: — which is
 * inside fc00::/7 but does not start with the literal "fc00:" — is still
 * caught.
 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback

  const groups = parseIPv6Groups(lower);
  if (!groups) return true; // couldn't decode a claimed-valid IPv6 address — fail closed

  const isIPv4Mapped =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff;
  const isIPv4Translated =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0xffff && groups[5] === 0;
  // Deprecated IPv4-compatible form (::a.b.c.d): all-zero prefix with no 0xffff marker at all,
  // still a syntactically valid IPv6 literal that net.isIPv6 accepts, so it must not silently
  // fall through as "not private" just because it lacks the modern ::ffff: marker.
  const isIPv4Compatible =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0;
  if (isIPv4Mapped || isIPv4Translated || isIPv4Compatible) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(embedded);
  }

  if (matchesIPv6Prefix(groups, FC00_PREFIX, 7)) return true; // fc00::/7
  if (matchesIPv6Prefix(groups, FE80_PREFIX, 10)) return true; // fe80::/10
  return false;
}

export function cleanupStaleDownloads(): number {
  const cacheDir = webCacheDir();
  if (!existsSync(cacheDir)) return 0;

  let removed = 0;
  try {
    const files = readdirSync(cacheDir);
    for (const file of files) {
      if (file.endsWith('.tmp')) {
        try {
          unlinkSync(resolve(cacheDir, file));
          removed++;
        } catch {
          // Ignore removal errors
        }
      }
    }
  } catch {
    // Ignore directory read errors
  }
  return removed;
}

export interface HttpFetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface HttpFetchOpts {
  deadlineAt: number;
  timeoutSec: number;
  maxSizeBytes: number;
  requestHeaders: Record<string, string>;
  redirectsLeft: number;
}

export function performHttpFetch(targetUrl: string, opts: HttpFetchOpts): Promise<HttpFetchResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      rejectPromise(new Error(`Invalid URL: ${truncateUrl(targetUrl)}`));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      rejectPromise(new Error(`URL blocked by SSRF safety check: ${truncateUrl(targetUrl)}`));
      return;
    }

    // Node's http/https `lookup` option (ssrfPinnedLookup, passed to mod.request below) is
    // only invoked when the hostname actually needs DNS resolution. For a literal IPv4 address
    // Node connects directly and never calls the custom lookup function at all, silently
    // bypassing SSRF protection for URLs like http://127.0.0.1/... or http://169.254.169.254/...
    // (cloud metadata) -- on both the initial request and every redirect hop, since this
    // function recurses into itself for redirects. Check literal IPs explicitly up front;
    // there is no DNS to pin for them in the first place.
    const literalIp = parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;
    const isLiteralPrivate = isIPv4(literalIp) ? isPrivateIPv4(literalIp)
      : isIPv6(literalIp) ? isPrivateIPv6(literalIp)
      : false;
    if (isLiteralPrivate) {
      rejectPromise(new Error(`URL blocked by SSRF safety check: ${truncateUrl(targetUrl)}`));
      return;
    }

    const remainingMs = opts.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      rejectPromise(new Error(`Request timed out after ${opts.timeoutSec}s fetching ${truncateUrl(targetUrl)}`));
      return;
    }

    const mod = parsed.protocol === 'https:' ? https : http;
    let settled = false;

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port === '' ? undefined : Number(parsed.port),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      lookup: ssrfPinnedLookup,
      headers: { Host: parsed.host, ...opts.requestHeaders },
    });

    const deadlineTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      rejectPromise(new Error(`Request timed out after ${opts.timeoutSec}s fetching ${truncateUrl(targetUrl)}`));
    }, remainingMs);

    req.on('response', (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        const location = res.headers.location;
        res.resume();
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (opts.redirectsLeft <= 0) {
          rejectPromise(new Error(`Too many redirects fetching ${truncateUrl(targetUrl)}`));
          return;
        }
        let nextUrl: string;
        let nextParsed: URL;
        try {
          nextParsed = new URL(location, targetUrl);
          nextUrl = nextParsed.toString();
        } catch {
          rejectPromise(new Error(`Invalid redirect location fetching ${truncateUrl(targetUrl)}`));
          return;
        }
        // Only forward requestHeaders to the redirect target when the host is unchanged --
        // otherwise a caller-supplied Authorization/API-key header would silently leak to
        // whatever cross-origin host the server redirects to.
        const sameOrigin = nextParsed.host === parsed.host;
        const nextOpts: HttpFetchOpts = {
          ...opts,
          redirectsLeft: opts.redirectsLeft - 1,
          requestHeaders: sameOrigin ? opts.requestHeaders : {},
        };
        performHttpFetch(nextUrl, nextOpts).then(resolvePromise, rejectPromise);
        return;
      }

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (typeof v === 'string') headers[k.toLowerCase()] = v;
        else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(', ');
      }

      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > opts.maxSizeBytes) {
          settled = true;
          clearTimeout(deadlineTimer);
          req.destroy();
          rejectPromise(new Error(`File too large: ${total} bytes > ${opts.maxSizeBytes}`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        resolvePromise({ status, statusText: res.statusMessage ?? '', headers, body: Buffer.concat(chunks) });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        rejectPromise(err);
      });
    });

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      rejectPromise(err);
    });

    req.end();
  });
}
