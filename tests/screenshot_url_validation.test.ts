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

  it('allows a private target when block_private_targets is opted out via env', () => {
    process.env['TOKEN_GOAT_SCREENSHOT_BLOCK_PRIVATE_TARGETS'] = 'false'
    invalidateConfigCache()
    expect(() => validateScreenshotUrl('http://169.254.169.254/')).not.toThrow()
  })
})
