import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, mkdirSync } from 'fs';
import { isIPv4, isIPv6 } from 'net';
import { resolve, join } from 'path';
import { URL } from 'url';
import { promisify } from 'util';
import { lookup as dnsLookup } from 'dns';
import { atomicWriteBytes, atomicWriteText } from './util.js';
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

async function isSsrfSafe(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url);
    if (!['http', 'https'].includes(parsed.protocol.slice(0, -1))) return false;

    const hostname = parsed.hostname;
    if (!hostname) return false;

    const hostnameLower = hostname.toLowerCase().replace(/\.$/, '');
    if (BLOCKED_HOSTNAMES.has(hostnameLower)) return false;

    try {
      const results = await dnsLookupAsync(hostnameLower, { all: true });
      if (!Array.isArray(results)) return ALLOW_UNRESOLVED;

      for (const addr of results) {
        const ip = addr.address || '';
        const isPrivate = isIPv4(ip) ? isPrivateIPv4(ip) : isIPv6(ip) ? isPrivateIPv6(ip) : false;
        if (isPrivate) return false;
      }
      return true;
    } catch {
      return ALLOW_UNRESOLVED;
    }
  } catch {
    return false;
  }
}

function isPrivateIPv4(ip: string): boolean {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some(o => !Number.isFinite(o))) return false;
  const a = octets[0] as number;
  const b = octets[1] as number;
  return (
    a === 127 || // 127.x.x.x
    a === 10 || // 10.x.x.x
    (a === 172 && b >= 16 && b <= 31) || // 172.16-31.x.x
    (a === 192 && b === 168) || // 192.168.x.x
    (a === 169 && b === 254) // 169.254.x.x
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1') return true; // loopback
  if (lower.startsWith('fc00:') || lower.startsWith('fd00:')) return true; // fc00::/7
  if (lower.startsWith('fe80:')) return true; // fe80::/10
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

export async function fetchUrl(
  url: string,
  opts?: {
    shrinkIfImage?: boolean;
    timeoutSec?: number;
    maxSizeBytes?: number;
  },
): Promise<string> {
  const shrinkIfImage = opts?.shrinkIfImage !== false;
  const timeoutSec = opts?.timeoutSec ?? webfetchTimeout();
  const maxSizeBytes = opts?.maxSizeBytes ?? 50 * 1024 * 1024;

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

  if (cachedPathExists) {
    const meta = readCacheMeta(cachePath);
    if (shrinkIfImage && meta['shrunk_path']) {
      const shrunkPath = meta['shrunk_path'];
      if (existsSync(shrunkPath)) {
        return shrunkPath;
      }
    }
    return cachePath;
  }

  const responseHeaders: Record<string, string> = {};
  let contentSha: string | null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutSec * 1000);

    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} fetching ${truncateUrl(url)}: ${response.statusText}`,
      );
    }

    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    ensureDir(webCacheDir());

    const buffer = await response.arrayBuffer();
    const content = new Uint8Array(buffer);

    if (content.length > maxSizeBytes) {
      throw new Error(
        `File too large: ${content.length} bytes > ${maxSizeBytes}`,
      );
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
      if (err.message.includes('abort')) {
        throw new Error(`Request timed out after ${timeoutSec}s fetching ${truncateUrl(url)}`, { cause: err });
      }
      if (
        err.message.includes('URL too long') ||
        err.message.includes('File too large') ||
        err.message.includes('HTTP ') ||
        err.message.includes('blocked')
      ) {
        throw err;
      }
    }
    throw new Error(
      `Network error fetching ${truncateUrl(url)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
}
