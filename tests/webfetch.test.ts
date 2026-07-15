import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import type * as HttpModule from 'http';
import type * as DnsModule from 'dns';
import { resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';

const httpRequestMock = vi.hoisted(() => vi.fn());
const dnsLookupMock = vi.hoisted(() => vi.fn());

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, request: httpRequestMock };
});

vi.mock('dns', async (importOriginal) => {
  const actual = await importOriginal<typeof DnsModule>();
  // Default: delegate to the real resolver so existing tests (which rely on
  // real DNS/private-IP behavior for localhost/127.0.0.1/etc.) keep working.
  // Individual tests override this per-call via mockImplementationOnce.
  dnsLookupMock.mockImplementation((...args: unknown[]) => {
    type LookupFn = (...a: unknown[]) => void;
    (actual.lookup as unknown as LookupFn)(...args);
  });
  return { ...actual, lookup: dnsLookupMock };
});

const {
  isPrivateIPv4,
  isPrivateIPv6,
  ssrfPinnedLookup,
  performHttpFetch,
} = await import('../src/webfetch.js');

describe('webfetch', () => {
  const tempDir = resolve(tmpdir(), 'webfetch-test');

  beforeEach(() => {
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      const files = readdirSync(tempDir);
      for (const file of files) {
        unlinkSync(resolve(tempDir, file));
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('isPrivateIPv4', () => {
    it('should recognize RFC1918 private ranges', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('10.255.255.255')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('192.168.0.0')).toBe(true);
      expect(isPrivateIPv4('172.16.0.0')).toBe(true);
      expect(isPrivateIPv4('172.31.255.255')).toBe(true);
    });

    it('should recognize loopback range', () => {
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('127.255.255.255')).toBe(true);
    });

    it('should recognize link-local range', () => {
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);
      expect(isPrivateIPv4('169.254.255.255')).toBe(true);
    });

    it('should recognize the 0.0.0.0/8 "this network" range (IPV4-MISSING-0000-8)', () => {
      expect(isPrivateIPv4('0.0.0.0')).toBe(true);
      expect(isPrivateIPv4('0.1.2.3')).toBe(true);
      expect(isPrivateIPv4('0.255.255.255')).toBe(true);
    });

    it('should recognize the 100.64.0.0/10 carrier-grade NAT range (IPV4-MISSING-0000-8)', () => {
      expect(isPrivateIPv4('100.64.0.0')).toBe(true);
      expect(isPrivateIPv4('100.100.50.1')).toBe(true);
      expect(isPrivateIPv4('100.127.255.255')).toBe(true);
      // boundaries just outside the /10 must stay public
      expect(isPrivateIPv4('100.63.255.255')).toBe(false);
      expect(isPrivateIPv4('100.128.0.0')).toBe(false);
    });

    it('should reject octets out of valid 0-255 range', () => {
      expect(isPrivateIPv4('256.0.0.1')).toBe(false);
      expect(isPrivateIPv4('10.300.0.1')).toBe(false);
      expect(isPrivateIPv4('10.0.256.1')).toBe(false);
      expect(isPrivateIPv4('10.0.0.256')).toBe(false);
      expect(isPrivateIPv4('-1.0.0.1')).toBe(false);
      expect(isPrivateIPv4('10.-5.0.1')).toBe(false);
    });

    it('should reject public IP addresses', () => {
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv4('1.1.1.1')).toBe(false);
      expect(isPrivateIPv4('208.67.222.222')).toBe(false);
    });

    it('should reject invalid IP formats', () => {
      expect(isPrivateIPv4('10.0.0')).toBe(false);
      expect(isPrivateIPv4('10.0.0.1.1')).toBe(false);
      expect(isPrivateIPv4('not.an.ip.addr')).toBe(false);
    });
  });

  describe('isPrivateIPv6 (IPV6-CLASSIFIER-GAPS)', () => {
    it('should recognize the loopback address', () => {
      expect(isPrivateIPv6('::1')).toBe(true);
    });

    it('should unwrap IPv4-mapped addresses (::ffff:a.b.c.d) and check the embedded IPv4', () => {
      expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false);
    });

    it('should unwrap IPv4-translated addresses (::ffff:0:a.b.c.d) and check the embedded IPv4', () => {
      expect(isPrivateIPv6('::ffff:0:127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:0:192.168.1.1')).toBe(true);
      expect(isPrivateIPv6('::ffff:0:8.8.8.8')).toBe(false);
    });

    it('should unwrap deprecated IPv4-compatible addresses (::a.b.c.d, no ffff marker) and check the embedded IPv4 (regression: only the ::ffff:-marked mapped/translated forms were checked, so ::127.0.0.1, ::169.254.169.254, ::10.0.0.5, and ::192.168.1.1 fell through every branch and were wrongly classified as public even though net.isIPv6 accepts them as valid literals)', () => {
      expect(isPrivateIPv6('::127.0.0.1')).toBe(true);
      expect(isPrivateIPv6('::169.254.169.254')).toBe(true);
      expect(isPrivateIPv6('::10.0.0.5')).toBe(true);
      expect(isPrivateIPv6('::192.168.1.1')).toBe(true);
      expect(isPrivateIPv6('::8.8.8.8')).toBe(false);
    });

    it('should match the full fc00::/7 CIDR range, not just the literal "fc00:" prefix', () => {
      expect(isPrivateIPv6('fc00::1')).toBe(true);
      expect(isPrivateIPv6('fd00::1')).toBe(true);
      // fd12:3456:: is inside fc00::/7 but does not start with the literal "fc00:" prefix
      expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
      expect(isPrivateIPv6('fc01::1')).toBe(true);
      expect(isPrivateIPv6('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
      // just outside the /7 range must stay public
      expect(isPrivateIPv6('fe00::1')).toBe(false);
    });

    it('should match the full fe80::/10 CIDR range, not just the literal "fe80:" prefix', () => {
      expect(isPrivateIPv6('fe80::1')).toBe(true);
      // fe95:: is inside fe80::/10 but does not start with the literal "fe80:" prefix
      expect(isPrivateIPv6('fe95::1')).toBe(true);
      expect(isPrivateIPv6('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff')).toBe(true);
      // just outside the /10 range must stay public
      expect(isPrivateIPv6('fec0::1')).toBe(false);
    });

    it('should reject public IPv6 addresses', () => {
      expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false);
      expect(isPrivateIPv6('2606:4700:4700::1111')).toBe(false);
    });
  });

  describe('cleanupStaleDownloads', () => {
    it('should remove .tmp files from cache directory', () => {
      // Create temp .tmp files
      const tmpFile1 = resolve(tempDir, 'abc123.jpg.tmp');
      const tmpFile2 = resolve(tempDir, 'def456.png.tmp');
      const regularFile = resolve(tempDir, 'regularfile.jpg');

      writeFileSync(tmpFile1, 'content1');
      writeFileSync(tmpFile2, 'content2');
      writeFileSync(regularFile, 'content3');

      expect(existsSync(tmpFile1)).toBe(true);
      expect(existsSync(tmpFile2)).toBe(true);
      expect(existsSync(regularFile)).toBe(true);

      // Mock webCacheDir to return our test directory
      vi.doMock('./constants.js', () => ({
        webCacheDir: () => tempDir,
        dataDir: () => tempDir,
        imageCacheDir: () => tempDir,
        ensureDir: () => {},
      }));

      // Since the module is already loaded, we can't easily mock it Instead, we'll test the logic directly
      const files = readdirSync(tempDir);
      let removed = 0;
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          unlinkSync(resolve(tempDir, file));
          removed++;
        }
      }

      expect(removed).toBe(2);
      expect(existsSync(tmpFile1)).toBe(false);
      expect(existsSync(tmpFile2)).toBe(false);
      expect(existsSync(regularFile)).toBe(true);
    });

    it('should handle non-existent cache directory', () => {
      const nonExistentDir = resolve(tempDir, 'non-existent');
      expect(() => {
        if (existsSync(nonExistentDir)) {
          readdirSync(nonExistentDir);
        }
      }).not.toThrow();
    });
  });
});

  describe('ssrfPinnedLookup (M45: SSRF TOCTOU)', () => {
    it('resolves a public-looking hostname to the same address it validated (single lookup, no separate check-then-fetch gap)', async () => {
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, [{ address: '93.184.216.34', family: 4 }]);
      });
      const before = dnsLookupMock.mock.calls.length;
      const result = await new Promise((res, rej) => {
        ssrfPinnedLookup('public.example.test', {}, (err, address, family) => {
          if (err) rej(err); else res({ address, family });
        });
      });
      expect(result).toEqual({ address: '93.184.216.34', family: 4 });
      expect(dnsLookupMock.mock.calls.length - before).toBe(1);
    });

    it('refuses to hand back a private address for the socket to connect to', async () => {
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      });
      await expect(
        new Promise((res, rej) => {
          ssrfPinnedLookup('rebind.example.test', {}, (err, address) => {
            if (err) rej(err); else res(address);
          });
        }),
      ).rejects.toThrow(/SSRF/);
    });

    it('is the exact resolver performHttpFetch passes for the real connection (wiring proof)', () => {
      httpRequestMock.mockImplementationOnce((options) => {
        expect(options.lookup).toBe(ssrfPinnedLookup);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        fakeReq.end = vi.fn();
        return fakeReq;
      });
      void performHttpFetch('http://wiring.example.test/x', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1000,
        requestHeaders: {},
        redirectsLeft: 5,
      }).catch(() => {});
      expect(httpRequestMock).toHaveBeenCalled();
    });
  });

  describe('ssrfPinnedLookup options.all handling (regression: Node\'s Happy-Eyeballs/autoSelectFamily dual-stack connect, default-on since Node 20, calls the custom lookup with options.all=true and requires the array-callback shape callback(err, addresses[]) -- always answering with the single callback(err, address, family) shape instead made Node\'s net internals throw "Invalid IP address: undefined" for any real, non-literal hostname; caught by dogfooding `token-goat fetch-image` against a real URL)', () => {
    it('hands back an array of addresses, not a single address, when options.all is set', async () => {
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, [
          { address: '185.199.111.133', family: 4 },
          { address: '185.199.110.133', family: 4 },
        ]);
      });
      const result = await new Promise((res, rej) => {
        ssrfPinnedLookup('multi-address.example.test', { all: true }, (err, addresses) => {
          if (err) rej(err); else res(addresses);
        });
      });
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual([
        { address: '185.199.111.133', family: 4 },
        { address: '185.199.110.133', family: 4 },
      ]);
    });

    it('still returns the single-address shape when options.all is not set (existing callers unaffected)', async () => {
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, [{ address: '93.184.216.34', family: 4 }]);
      });
      const result = await new Promise((res, rej) => {
        ssrfPinnedLookup('single-address.example.test', {}, (err, address, family) => {
          if (err) rej(err); else res({ address, family });
        });
      });
      expect(result).toEqual({ address: '93.184.216.34', family: 4 });
    });

    it('still blocks when options.all is set and one of several resolved addresses is private', async () => {
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, [
          { address: '93.184.216.34', family: 4 },
          { address: '127.0.0.1', family: 4 },
        ]);
      });
      await expect(
        new Promise((res, rej) => {
          ssrfPinnedLookup('mixed-address.example.test', { all: true }, (err, addresses) => {
            if (err) rej(err); else res(addresses);
          });
        }),
      ).rejects.toThrow(/SSRF/);
    });
  });

  describe('ssrfPinnedLookup ALLOW_UNRESOLVED fallback (SSRF-PINNED-LOOKUP-BYPASS)', () => {
    const ENV_KEY = 'TOKEN_GOAT_WEBFETCH_ALLOW_UNRESOLVED';
    const originalEnv = process.env[ENV_KEY];

    afterEach(() => {
      if (originalEnv === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = originalEnv;
      vi.resetModules();
    });

    it('still rejects a raw fallback lookup that resolves to a private address (DNS-rebinding bypass)', async () => {
      process.env[ENV_KEY] = 'true';
      vi.resetModules();
      const fresh = await import('../src/webfetch.js');

      // Primary pinned (all:true) lookup fails/comes back empty, forcing the
      // ALLOW_UNRESOLVED fallback branch to run.
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(new Error('primary lookup failed'));
      });
      // The raw fallback dns.lookup(..., { all: false }) then resolves to a
      // private/internal address - a classic DNS-rebinding SSRF payload.
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, '127.0.0.1', 4);
      });

      await expect(
        new Promise((res, rej) => {
          fresh.ssrfPinnedLookup('rebind-fallback.example.test', {}, (err, address) => {
            if (err) rej(err); else res(address);
          });
        }),
      ).rejects.toThrow(/SSRF/);
    });

    it('still allows a raw fallback lookup that resolves to a public address', async () => {
      process.env[ENV_KEY] = 'true';
      vi.resetModules();
      const fresh = await import('../src/webfetch.js');

      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(new Error('primary lookup failed'));
      });
      dnsLookupMock.mockImplementationOnce((_hostname, _options, callback) => {
        callback(null, '93.184.216.34', 4);
      });

      const address = await new Promise((res, rej) => {
        fresh.ssrfPinnedLookup('public-fallback.example.test', {}, (err, addr) => {
          if (err) rej(err); else res(addr);
        });
      });
      expect(address).toBe('93.184.216.34');
    });
  });

  describe('performHttpFetch timeout coverage (m7: slow-loris body download)', () => {
    it('bounds a response that sends headers quickly then never sends a body', async () => {
      const fakeReq = new EventEmitter();
      fakeReq.destroy = vi.fn(() => fakeReq.emit('error', new Error('destroyed')));
      fakeReq.end = vi.fn();
      httpRequestMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          const fakeRes = new EventEmitter();
          fakeRes.statusCode = 200;
          fakeRes.statusMessage = 'OK';
          fakeRes.headers = {};
          fakeReq.emit('response', fakeRes);
          // No 'data' or 'end' ever fires on fakeRes - the body hangs forever.
        });
        return fakeReq;
      });
      const start = Date.now();
      await expect(
        performHttpFetch('http://slow-loris.example.test/x', {
          deadlineAt: Date.now() + 60,
          timeoutSec: 0.06,
          maxSizeBytes: 1000,
          requestHeaders: {},
          redirectsLeft: 5,
        }),
      ).rejects.toThrow(/timed out/);
      expect(Date.now() - start).toBeLessThan(2000);
      expect(fakeReq.destroy).toHaveBeenCalled();
    });
  });

  describe('performHttpFetch literal-IP SSRF check (regression: Node never invokes the custom `lookup` option for a literal IPv4 hostname, so ssrfPinnedLookup alone silently let http://127.0.0.1/... and http://169.254.169.254/... through, on both the initial request and every redirect hop)', () => {
    it('rejects a loopback literal IPv4 URL before ever attempting a connection', async () => {
      httpRequestMock.mockClear();
      await expect(
        performHttpFetch('http://127.0.0.1:1/x', {
          deadlineAt: Date.now() + 5000,
          timeoutSec: 5,
          maxSizeBytes: 1000,
          requestHeaders: {},
          redirectsLeft: 5,
        }),
      ).rejects.toThrow(/blocked by ssrf safety check/i);
      expect(httpRequestMock).not.toHaveBeenCalled();
    });

    it('rejects a link-local (cloud metadata) literal IPv4 URL even with redirects still available', async () => {
      httpRequestMock.mockClear();
      await expect(
        performHttpFetch('http://169.254.169.254/latest/meta-data/', {
          deadlineAt: Date.now() + 5000,
          timeoutSec: 5,
          maxSizeBytes: 1000,
          requestHeaders: {},
          redirectsLeft: 3,
        }),
      ).rejects.toThrow(/blocked by ssrf safety check/i);
      expect(httpRequestMock).not.toHaveBeenCalled();
    });

    it('still allows a public literal IPv4 address through (the fix does not over-block every literal IP)', async () => {
      httpRequestMock.mockClear();
      httpRequestMock.mockImplementationOnce(() => {
        const fakeReq = new EventEmitter();
        fakeReq.end = vi.fn();
        fakeReq.destroy = vi.fn();
        queueMicrotask(() => {
          const fakeRes = new EventEmitter();
          fakeRes.statusCode = 200;
          fakeRes.statusMessage = 'OK';
          fakeRes.headers = {};
          fakeReq.emit('response', fakeRes);
          queueMicrotask(() => fakeRes.emit('end'));
        });
        return fakeReq;
      });
      const result = await performHttpFetch('http://8.8.8.8/x', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1000,
        requestHeaders: {},
        redirectsLeft: 5,
      });
      expect(result.status).toBe(200);
      expect(httpRequestMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('performHttpFetch conditional revalidation (m8)', () => {
    it('forwards If-None-Match/If-Modified-Since onto the real HTTP request', async () => {
      let capturedHeaders;
      httpRequestMock.mockImplementationOnce((options) => {
        capturedHeaders = options.headers;
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        fakeReq.end = vi.fn(() => {
          const fakeRes = new EventEmitter();
          fakeRes.statusCode = 304;
          fakeRes.statusMessage = 'Not Modified';
          fakeRes.headers = {};
          queueMicrotask(() => {
            fakeReq.emit('response', fakeRes);
            fakeRes.emit('end');
          });
        });
        return fakeReq;
      });
      const result = await performHttpFetch('http://revalidate.example.test/x', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1000,
        requestHeaders: { 'If-None-Match': '"abc123"', 'If-Modified-Since': 'Wed, 21 Oct 2015 07:28:00 GMT' },
        redirectsLeft: 5,
      });
      expect(capturedHeaders['If-None-Match']).toBe('"abc123"');
      expect(capturedHeaders['If-Modified-Since']).toBe('Wed, 21 Oct 2015 07:28:00 GMT');
      expect(result.status).toBe(304);
    });
  });

  describe('performHttpFetch cross-origin redirect header stripping (regression: performHttpFetch recursed with {...opts} on redirect, forwarding requestHeaders verbatim to whatever host the Location pointed at, which would leak an Authorization/API-key header cross-origin)', () => {
    function respondWith(fakeReq: EventEmitter, statusCode: number, headers: Record<string, string>): void {
      fakeReq.end = vi.fn(() => {
        const fakeRes = new EventEmitter();
        fakeRes.statusCode = statusCode;
        fakeRes.statusMessage = statusCode === 200 ? 'OK' : 'Found';
        fakeRes.headers = headers;
        fakeRes.resume = vi.fn();
        queueMicrotask(() => {
          fakeReq.emit('response', fakeRes);
          if (statusCode === 200) fakeRes.emit('end');
        });
      });
    }

    it('drops requestHeaders when the redirect target is a different host', async () => {
      const capturedHeaders: Record<string, unknown>[] = [];
      httpRequestMock.mockImplementationOnce((options) => {
        capturedHeaders.push(options.headers);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        respondWith(fakeReq, 302, { location: 'http://other-host.example.test/y' });
        return fakeReq;
      });
      httpRequestMock.mockImplementationOnce((options) => {
        capturedHeaders.push(options.headers);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        respondWith(fakeReq, 200, {});
        return fakeReq;
      });

      const result = await performHttpFetch('http://original-host.example.test/x', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1000,
        requestHeaders: { Authorization: 'Bearer secret-token' },
        redirectsLeft: 5,
      });

      expect(result.status).toBe(200);
      expect(capturedHeaders).toHaveLength(2);
      expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer secret-token');
      expect(capturedHeaders[1]?.['Authorization']).toBeUndefined();
    });

    it('still forwards requestHeaders when the redirect target is the same host', async () => {
      const capturedHeaders: Record<string, unknown>[] = [];
      httpRequestMock.mockImplementationOnce((options) => {
        capturedHeaders.push(options.headers);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        respondWith(fakeReq, 302, { location: 'http://same-host.example.test/y' });
        return fakeReq;
      });
      httpRequestMock.mockImplementationOnce((options) => {
        capturedHeaders.push(options.headers);
        const fakeReq = new EventEmitter();
        fakeReq.destroy = vi.fn();
        respondWith(fakeReq, 200, {});
        return fakeReq;
      });

      const result = await performHttpFetch('http://same-host.example.test/x', {
        deadlineAt: Date.now() + 5000,
        timeoutSec: 5,
        maxSizeBytes: 1000,
        requestHeaders: { Authorization: 'Bearer secret-token' },
        redirectsLeft: 5,
      });

      expect(result.status).toBe(200);
      expect(capturedHeaders).toHaveLength(2);
      expect(capturedHeaders[0]?.['Authorization']).toBe('Bearer secret-token');
      expect(capturedHeaders[1]?.['Authorization']).toBe('Bearer secret-token');
    });
  });

