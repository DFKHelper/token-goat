import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync, mkdirSync } from 'fs';
import * as http from 'http';
import * as https from 'https';
import { isIPv4, isIPv6 } from 'net';
import { isAbsolute, relative, resolve, join, sep } from 'path';
import { URL } from 'url';
import { promisify } from 'util';
import { lookup as dnsLookup, type LookupOptions } from 'dns';
import { atomicWriteBytes, atomicWriteText, extractErrorMessage } from './util.js';
import { dataDir } from './constants.js';
import { shrinkImage } from './image_shrink.js';

const dnsLookupAsync = promisify(dnsLookup);

const MAX_URL_LEN = 8192;
const MAX_URL_IN_ERROR = 200;
const ALLOW_UNRESOLVED = (process.env['TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED'] ?? '').toLowerCase() === 'true';

function webCacheDir(): string {
  return join(dataDir(), 'web_cache');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      // Ignore errors
    }
  }
}

const IMAGE_URL_EXTS: readonly string[] = ['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp', '.tiff', '.tif'];
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
};

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  '169.254.169.254',
]);

function webfetchTimeout(): number {
  const raw = (process.env['TOKEN_GOAT_WEBFETCH_TIMEOUT_SECS'] ?? '').trim();
  if (!raw) return 30;
  try {
    const val = parseFloat(raw);
    return val > 0 ? val : 30;
  } catch {
    return 30;
  }
}

export function isImageUrl(url: string): boolean {
  if (url.length > MAX_URL_LEN) return false;
  try {
    const parsed = new URL(url);
    if (!['http', 'https'].includes(parsed.protocol.slice(0, -1))) return false;
    const path = (parsed.pathname || '').toLowerCase();
    return IMAGE_URL_EXTS.some((ext) => path.endsWith(ext));
  } catch {
    return false;
  }
}

export function isImageContentType(contentType: string): boolean {
  return contentType.toLowerCase().startsWith('image/');
}

function truncateUrl(url: string, maxLen: number = MAX_URL_IN_ERROR): string {
  const sanitized = url.replace(/[\r\n]/g, '');
  return sanitized.length > maxLen ? sanitized.slice(0, maxLen) + '…' : sanitized;
}

type SsrfResolution =
  | { kind: 'safe'; address: string; family: number }
  | { kind: 'blocked' }
  | { kind: 'unresolved' };

/**
 * Resolve `hostname` and validate every returned address is not private —
 * the single source of truth for "is this host safe to connect to". Used
 * both as the upfront isSsrfSafe() gate and as the resolver plugged into
 * every real socket connection (see ssrfPinnedLookup below), so the address
 * that gets validated is always the exact address that gets connected to —
 * closing the DNS-rebinding TOCTOU gap between a separate check and fetch.
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
  return { kind: 'safe', address: first.address, family: first.family };
}

async function isSsrfSafe(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (!['http', 'https'].includes(parsed.protocol.slice(0, -1))) return false;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    const result = await resolveSsrfSafeAddress(hostname);
    if (result.kind === 'safe') return true;
    if (result.kind === 'unresolved') return ALLOW_UNRESOLVED;
    return false;
  } catch {
    return false;
  }
}

/**
 * dns.lookup-compatible resolver passed as the `lookup` option on every real
 * HTTP(S) request this module makes (initial request and every redirect
 * hop). Resolving here — rather than trusting a hostname string handed to
 * http(s).request — means the address used to open the TCP/TLS socket is
 * the exact address resolveSsrfSafeAddress just validated, with no gap for
 * a second, independent DNS lookup (and thus DNS rebinding) to slip in.
 */
export function ssrfPinnedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string, family?: number) => void,
): void {
  resolveSsrfSafeAddress(hostname)
    .then((result) => {
      if (result.kind === 'safe') {
        callback(null, result.address, result.family);
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
            callback(err, '', family);
            return;
          }
          const addr = typeof address === 'string' ? address : '';
          const isPrivate = isIPv4(addr) ? isPrivateIPv4(addr) : isIPv6(addr) ? isPrivateIPv6(addr) : true;
          if (isPrivate) {
            callback(
              new Error(`URL blocked by SSRF safety check: ${truncateUrl(hostname)}`) as NodeJS.ErrnoException,
              '',
            );
            return;
          }
          callback(null, addr, family);
        });
        return;
      }
      callback(new Error(`URL blocked by SSRF safety check: ${truncateUrl(hostname)}`) as NodeJS.ErrnoException, '');
    })
    .catch((err: unknown) => {
      callback(err instanceof Error ? (err as NodeJS.ErrnoException) : new Error(String(err)), '');
    });
}

/**
 * True when `candidate`'s real, symlink-resolved location lives inside
 * `rootReal` (itself already symlink-resolved) — same containment pattern
 * as pack.ts's isRealPathWithinRoot. A cached `.meta` sidecar is
 * attacker-writable data (whoever can write to the cache dir can plant a
 * `shrunk_path` pointing anywhere), so it must be validated before being
 * read back out. Takes the resolved root as a parameter (rather than always
 * resolving webCacheDir() internally) so it is independently unit-testable.
 */
export function isRealPathWithinCacheDir(rootReal: string, candidate: string): boolean {
  let candidateReal: string;
  try {
    candidateReal = realpathSync(candidate);
  } catch {
    return false;
  }
  const rel = relative(rootReal, candidateReal);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
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
 * IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-translated (`::ffff:0:a.b.c.d`)
 * address whose embedded IPv4 address is private — a private IPv4 address
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
  if (isIPv4Mapped || isIPv4Translated) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIPv4(embedded);
  }

  if (matchesIPv6Prefix(groups, FC00_PREFIX, 7)) return true; // fc00::/7
  if (matchesIPv6Prefix(groups, FE80_PREFIX, 10)) return true; // fe80::/10
  return false;
}

function cachePathFor(url: string, suffix: string): string {
  const h = createHash('sha256').update(url).digest('hex');
  ensureDir(webCacheDir());
  return resolve(webCacheDir(), `${h}${suffix}`);
}

function suffixFor(url: string, contentType: string = ''): string {
  try {
    const parsed = new URL(url);
    const path = (parsed.pathname || '').toLowerCase();
    for (const ext of IMAGE_URL_EXTS) {
      if (path.endsWith(ext)) return ext;
    }
  } catch {
    // ignore parse errors
  }
  const ct = (contentType.toLowerCase().split(';')[0] ?? '').trim();
  return CONTENT_TYPE_EXT[ct] || '.bin';
}

function sidecarPath(cachePath: string): string {
  return cachePath + '.meta';
}

function sanitizeHeaderValue(value: string, maxLen: number = 512): string {
  const sanitized = value.replace(/[\r\n]/g, '');
  return sanitized.slice(0, maxLen);
}

function readCacheMeta(cachePath: string): Record<string, string> {
  const sidecar = sidecarPath(cachePath);
  if (!existsSync(sidecar)) return {};

  try {
    const stat = statSync(sidecar);
    if (stat.size > 4096) return {};

    const raw = readFileSync(sidecar, 'utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || !parsed) return {};

    const result: Record<string, string> = {};
    const ALLOWED_KEYS = ['etag', 'last_modified', 'content_sha256', 'shrunk_path'];
    for (const [k, v] of Object.entries(parsed)) {
      if (!ALLOWED_KEYS.includes(k) || typeof v !== 'string') continue;
      const cap = k === 'shrunk_path' ? 4096 : 512;
      result[k] = sanitizeHeaderValue(v, cap);
    }
    return result;
  } catch {
    return {};
  }
}

function writeCacheMeta(cachePath: string, headers: Record<string, string>, extra?: Record<string, string>): void {
  const meta: Record<string, string> = {};
  const ALLOWED_KEYS = ['etag', 'last_modified', 'content_sha256', 'shrunk_path'];

  if (headers['etag']) meta['etag'] = sanitizeHeaderValue(headers['etag'], 512);
  if (headers['last-modified']) meta['last_modified'] = sanitizeHeaderValue(headers['last-modified'], 512);

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (!ALLOWED_KEYS.includes(k) || typeof v !== 'string') continue;
      const cap = k === 'shrunk_path' ? 4096 : 512;
      meta[k] = sanitizeHeaderValue(v, cap);
    }
  }

  if (Object.keys(meta).length === 0) return;

  try {
    atomicWriteText(sidecarPath(cachePath), JSON.stringify(meta));
  } catch {
    // Silently ignore write failures for metadata
  }
}

function hashFileSha256(filePath: string): string | null {
  try {
    const content = readFileSync(filePath);
    return createHash('sha256').update(content).digest('hex');
  } catch {
    return null;
  }
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

const MAX_REDIRECTS = 5;

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
        try {
          nextUrl = new URL(location, targetUrl).toString();
        } catch {
          rejectPromise(new Error(`Invalid redirect location fetching ${truncateUrl(targetUrl)}`));
          return;
        }
        performHttpFetch(nextUrl, { ...opts, redirectsLeft: opts.redirectsLeft - 1 }).then(resolvePromise, rejectPromise);
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

/**
 * Build conditional-request headers (If-None-Match / If-Modified-Since) from
 * a cache entry's stored etag/last-modified, so a still-fresh cache can be
 * revalidated against the origin (a 304 short-circuits back to the cache)
 * instead of being served forever unconditionally or blindly re-downloaded
 * in full on every revalidation.
 */
export function buildConditionalHeaders(meta: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  const etag = meta['etag'];
  const lastModified = meta['last_modified'];
  if (etag) headers['If-None-Match'] = etag;
  if (lastModified) headers['If-Modified-Since'] = lastModified;
  return headers;
}

export async function fetchUrl(
  url: string,
  opts?: {
    shrinkIfImage?: boolean;
    timeoutSec?: number;
    maxSizeBytes?: number;
    forceRevalidate?: boolean;
  },
): Promise<string> {
  const shrinkIfImage = opts?.shrinkIfImage !== false;
  const timeoutSec = opts?.timeoutSec ?? webfetchTimeout();
  const maxSizeBytes = opts?.maxSizeBytes ?? 50 * 1024 * 1024;
  const forceRevalidate = opts?.forceRevalidate === true;

  if (url.length > MAX_URL_LEN) {
    throw new Error(`URL too long (${url.length} chars, max ${MAX_URL_LEN})`);
  }

  const safe = await isSsrfSafe(url);
  if (!safe) {
    throw new Error(`URL blocked by SSRF safety check: ${truncateUrl(url)}`);
  }

  const urlSuffix = suffixFor(url);
  const cachePath = cachePathFor(url, urlSuffix);
  const cachedPathExists = existsSync(cachePath);
  const cachedMeta = cachedPathExists ? readCacheMeta(cachePath) : {};

  const serveCached = (): string => {
    const shrunkPath = cachedMeta['shrunk_path'];
    if (shrinkIfImage && shrunkPath && existsSync(shrunkPath)) {
      try {
        const cacheDirReal = realpathSync(webCacheDir());
        if (isRealPathWithinCacheDir(cacheDirReal, shrunkPath)) {
          return shrunkPath;
        }
      } catch {
        // Cache dir itself unreadable; fall through to the unshrunk cachePath.
      }
    }
    return cachePath;
  };

  if (cachedPathExists && !forceRevalidate) {
    return serveCached();
  }

  const requestHeaders: Record<string, string> =
    cachedPathExists && forceRevalidate ? buildConditionalHeaders(cachedMeta) : {};

  const responseHeaders: Record<string, string> = {};
  let contentSha: string | null;

  try {
    const result = await performHttpFetch(url, {
      deadlineAt: Date.now() + timeoutSec * 1000,
      timeoutSec,
      maxSizeBytes,
      requestHeaders,
      redirectsLeft: MAX_REDIRECTS,
    });

    if (result.status === 304 && cachedPathExists) {
      return serveCached();
    }

    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HTTP ${result.status} fetching ${truncateUrl(url)}: ${result.statusText}`);
    }

    for (const [key, value] of Object.entries(result.headers)) {
      responseHeaders[key] = value;
    }

    ensureDir(webCacheDir());

    const content = result.body;

    if (content.length > maxSizeBytes) {
      throw new Error(`File too large: ${content.length} bytes > ${maxSizeBytes}`);
    }

    atomicWriteBytes(cachePath, content);

    contentSha = hashFileSha256(cachePath);
    const extraMeta: Record<string, string> = {};
    if (contentSha) {
      extraMeta['content_sha256'] = contentSha;
    }

    let finalPath = cachePath;
    if (shrinkIfImage) {
      const imageBuffer = readFileSync(cachePath);
      const shrinkResult = await shrinkImage(imageBuffer);
      if (shrinkResult) {
        const ext = shrinkResult.format === 'webp' ? '.webp' : '.jpg';
        const shrunkPath = cachePath.replace(/\.[^.]+$/, `.shrunk${ext}`);
        atomicWriteBytes(shrunkPath, shrinkResult.data);
        finalPath = shrunkPath;
        if (finalPath !== cachePath) {
          extraMeta['shrunk_path'] = finalPath;
        }
      }
    }

    writeCacheMeta(cachePath, responseHeaders, extraMeta);

    return finalPath;
  } catch (err) {
    if (err instanceof Error) {
      if (
        err.message.includes('URL too long') ||
        err.message.includes('File too large') ||
        err.message.includes('HTTP ') ||
        err.message.includes('blocked') ||
        err.message.includes('timed out') ||
        err.message.includes('Too many redirects') ||
        err.message.includes('Invalid redirect location') ||
        err.message.includes('Invalid URL')
      ) {
        throw err;
      }
    }
    throw new Error(
      `Network error fetching ${truncateUrl(url)}: ${extractErrorMessage(err)}`,
      { cause: err },
    );
  }
}
