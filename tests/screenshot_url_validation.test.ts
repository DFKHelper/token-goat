/**
 * Security regression: takeScreenshot passed `url` straight to page.goto() with zero
 * validation. Injected content could aim the headless browser at cloud metadata
 * (http://169.254.169.254/) or a localhost-only service, and with image_shrink.ocr_enabled
 * on, the rendered page gets transcribed back into the model's context -- a capability
 * token-goat adds. validateScreenshotUrl rejects non-http(s) schemes and literal
 * loopback/link-local/RFC1918 hosts, behind a screenshot.block_private_targets opt-out.
 *
 * Scope: this is a synchronous literal-IP check only. A hostname that resolves to a private
 * IP (DNS rebinding) is NOT covered -- see the comment on isBlockedLiteralIp in screenshot.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { validateScreenshotUrl } from '../src/screenshot.js'
import { invalidateConfigCache } from '../src/config.js'

afterEach(() => {
  delete process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS']
  invalidateConfigCache()
})

describe('validateScreenshotUrl', () => {
  it('allows a normal https URL', () => {
    expect(() => validateScreenshotUrl('https://example.com/page')).not.toThrow()
  })

  it('rejects a file: scheme', () => {
    expect(() => validateScreenshotUrl('file:///etc/passwd')).toThrow(/scheme/i)
  })

  it('rejects a javascript: scheme', () => {
    expect(() => validateScreenshotUrl('javascript:alert(1)')).toThrow(/scheme/i)
  })

  it('rejects the cloud metadata link-local IP', () => {
    expect(() => validateScreenshotUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /169\.254\.169\.254/,
    )
  })

  it('rejects loopback 127.0.0.1', () => {
    expect(() => validateScreenshotUrl('http://127.0.0.1:8080/')).toThrow(/127\.0\.0\.1/)
  })

  it('rejects localhost', () => {
    expect(() => validateScreenshotUrl('http://localhost:9000/')).toThrow(/localhost/)
  })

  it('rejects RFC1918 private ranges', () => {
    expect(() => validateScreenshotUrl('http://10.0.0.5/')).toThrow()
    expect(() => validateScreenshotUrl('http://172.16.0.1/')).toThrow()
    expect(() => validateScreenshotUrl('http://192.168.1.1/')).toThrow()
  })

  // Regression: isBlockedLiteralIp only did exact `::1` / `^fe80:` / `^f[cd]..:` string tests,
  // so every IPv4-mapped spelling slipped through. `new URL` normalizes [::ffff:127.0.0.1] to
  // [::ffff:7f00:1], which matches none of those patterns -- and Chrome then connects to
  // 127.0.0.1. There was no IPv6 case in this file at all before these.
  it('rejects IPv4-mapped loopback in IPv6 form', () => {
    expect(() => validateScreenshotUrl('http://[::ffff:127.0.0.1]/')).toThrow(
      /loopback\/link-local\/private IP/,
    )
  })

  it('rejects IPv4-mapped loopback written in already-normalized hex form', () => {
    expect(() => validateScreenshotUrl('http://[::ffff:7f00:1]/')).toThrow(
      /loopback\/link-local\/private IP/,
    )
  })

  it('rejects IPv4-mapped cloud metadata in IPv6 form', () => {
    expect(() => validateScreenshotUrl('http://[::ffff:169.254.169.254]/latest/meta-data/')).toThrow(
      /loopback\/link-local\/private IP/,
    )
  })

  it('rejects IPv4-mapped RFC1918 ranges in IPv6 form', () => {
    expect(() => validateScreenshotUrl('http://[::ffff:10.0.0.5]/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://[::ffff:172.16.0.1]/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://[::ffff:192.168.1.1]/')).toThrow(/private IP/)
  })

  it('rejects the unspecified address [::], which reaches localhost', () => {
    expect(() => validateScreenshotUrl('http://[::]/')).toThrow(/loopback\/link-local\/private IP/)
  })

  it('still rejects plain ::1, fe80:: link-local and fc00:: unique-local', () => {
    expect(() => validateScreenshotUrl('http://[::1]:8080/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://[fe80::1]/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://[fd00::1]/')).toThrow(/private IP/)
  })

  it('still allows a public IPv6 literal', () => {
    expect(() => validateScreenshotUrl('http://[2606:4700:4700::1111]/')).not.toThrow()
  })

  // Regression: the webfetch.ts SSRF classifier (isPrivateIPv4/isPrivateIPv6) and this file's
  // literal-IP classifier were two independently maintained range tables. webfetch.ts additionally
  // blocked carrier-grade NAT (100.64.0.0/10, RFC 6598), IETF protocol assignments (192.0.0.0/24,
  // RFC 6890), benchmarking (198.18.0.0/15, RFC 2544), multicast (224.0.0.0/4) and reserved space
  // (240.0.0.0/4), none of which this screenshot policy rejected -- so a page redirect or
  // sub-resource aimed at an internal service on any of those ranges (e.g. a cloud VPC routing
  // internal traffic over CGNAT) reached the headless browser and had its rendered output OCR'd
  // back into the model's context, a class of internal target the fetch channel already refused.
  // FORMAT-DERIVED: ranges cited from RFC 6598 (100.64.0.0/10), RFC 6890 (192.0.0.0/24),
  // RFC 2544 (198.18.0.0/15), RFC 1112 (224.0.0.0/4 multicast) and RFC 1112 (240.0.0.0/4 reserved).
  it('rejects carrier-grade NAT, IETF protocol assignment, benchmarking, multicast and reserved ranges', () => {
    expect(() => validateScreenshotUrl('http://100.64.0.1/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://192.0.0.170/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://198.18.0.1/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://224.0.0.1/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://240.0.0.1/')).toThrow(/private IP/)
  })

  it('rejects carrier-grade NAT and multicast written as IPv4-mapped IPv6', () => {
    expect(() => validateScreenshotUrl('http://[::ffff:100.64.0.1]/')).toThrow(/private IP/)
    expect(() => validateScreenshotUrl('http://[::ffff:224.0.0.1]/')).toThrow(/private IP/)
  })

  it('still allows the opt-out for a newly-covered range (screenshot.block_private_targets=false)', () => {
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    invalidateConfigCache()
    expect(() => validateScreenshotUrl('http://100.64.0.1/')).not.toThrow()
  })

  // Regression: error text interpolated the full `url`, so a signed screenshot URL rejected
  // for its scheme printed its own access token into stderr and from there model context.
  it('never echoes the query string when rejecting a scheme', () => {
    const secret = 'sig=SECRET_SCREENSHOT_TOKEN_98765'
    try {
      validateScreenshotUrl(`ftp://example.com/capture?${secret}`)
      expect.fail('expected validateScreenshotUrl to throw')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).toMatch(/Rejected screenshot URL scheme/)
      expect(message).not.toContain(secret)
      expect(message).not.toContain('?')
    }
  })

  it('never echoes the query string when the URL is unparseable', () => {
    const secret = 'sig=SECRET_SCREENSHOT_TOKEN_98765'
    try {
      validateScreenshotUrl(`ht!tp://[bad?${secret}`)
      expect.fail('expected validateScreenshotUrl to throw')
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      expect(message).toMatch(/Invalid screenshot URL/)
      expect(message).not.toContain(secret)
      expect(message).not.toContain('?')
    }
  })

  it('allows a private target when block_private_targets is opted out via env', () => {
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    invalidateConfigCache()
    expect(() => validateScreenshotUrl('http://169.254.169.254/')).not.toThrow()
  })
})
