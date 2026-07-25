import { describe, expect, it } from 'vitest'

import { extractCleanText, looksLikeHtml } from '../src/web_extract.js'

describe('looksLikeHtml', () => {
  it('detects a doctype declaration', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html><body>hi</body></html>')).toBe(true)
  })

  it('detects an <html> tag without a doctype', () => {
    expect(looksLikeHtml('<html><body>hi</body></html>')).toBe(true)
  })

  it('detects a bare <body> fragment with no <html>/<!doctype> wrapper', () => {
    expect(looksLikeHtml('<body class="x">hi</body>')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(looksLikeHtml('<!DOCTYPE HTML><HTML><BODY>hi</BODY></HTML>')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(looksLikeHtml('just some plain text response')).toBe(false)
  })

  it('returns false for JSON', () => {
    expect(looksLikeHtml('{"key": "value", "nested": {"a": 1}}')).toBe(false)
  })

  it('returns false for a bare word containing "html" that is not a real tag (mutation-testing gap: the regex requires a tag boundary, not just the substring "html")', () => {
    expect(looksLikeHtml('this document discusses html and css')).toBe(false)
  })

  it('only sniffs the first 512 bytes and misses a marker further in (mutation-testing gap: the sniff window is load-bearing, not the whole body)', () => {
    const body = 'x'.repeat(600) + '<html><body>hi</body></html>'
    expect(looksLikeHtml(body)).toBe(false)
  })

  it('detects a marker within the first 512 bytes even near the boundary', () => {
    const body = 'x'.repeat(500) + '<html>'
    expect(looksLikeHtml(body)).toBe(true)
  })
})

describe('extractCleanText', () => {
  it('strips script and style content entirely', () => {
    const html = '<html><head><style>body{color:red}</style><script>evil()</script></head><body><p>Real text</p></body></html>'
    const result = extractCleanText(html)
    expect(result).toContain('Real text')
    expect(result).not.toContain('evil()')
    expect(result).not.toContain('color:red')
  })

  it('drops images entirely instead of rendering alt text as a placeholder', () => {
    const html = '<body><p>Before</p><img src="x.png" alt="a photo"><p>After</p></body>'
    const result = extractCleanText(html)
    expect(result).toContain('Before')
    expect(result).toContain('After')
    expect(result).not.toContain('a photo')
  })

  it('keeps link text but drops the href URL', () => {
    const html = '<body><a href="https://example.com/very-long-tracking-url">Click here</a></body>'
    const result = extractCleanText(html)
    expect(result).toContain('Click here')
    expect(result).not.toContain('https://example.com')
  })

  it('trims leading and trailing whitespace from the result', () => {
    const html = '<body>   <p>content</p>   </body>'
    const result = extractCleanText(html)
    expect(result).toBe(result.trim())
    expect(result).toBe('content')
  })
})
