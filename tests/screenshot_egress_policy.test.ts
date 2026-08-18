/**
 * Security regression: `webfetch.allow`/`webfetch.deny` is the operator's egress policy, and the
 * headless browser was the one outbound channel it never reached. The policy was enforced in the
 * WebFetch pre-hook and (since the previous fix) in performHttpFetch, but `token-goat screenshot`
 * launches Chromium and navigates on its own, so an install configured to deny everything still
 * rendered any URL it was handed and wrote the result to disk.
 *
 * The check lives in screenshotUrlRefusal rather than at the command entry point because the
 * request-interception hook in takeScreenshot re-applies that same function to every redirect hop
 * and every sub-resource, so an allowed page cannot pull an image, script, or iframe from a denied
 * host either. The sub-resource tests below assert that reuse directly.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { screenshotUrlRefusal, validateScreenshotUrl } from '../src/screenshot.js'
import { invalidateConfigCache } from '../src/config.js'

afterEach(() => {
  delete process.env['TOKEN_GOAT_WEBFETCH_DENY']
  delete process.env['TOKEN_GOAT_WEBFETCH_ALLOW']
  invalidateConfigCache()
})

function withPolicy(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  invalidateConfigCache()
}

describe('screenshot honours the webfetch egress policy', () => {
  it('permits any target when no policy is configured', () => {
    expect(screenshotUrlRefusal('https://example.com/page')).toBeNull()
  })

  it('refuses a target matching a deny pattern, naming the policy', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_DENY: '*' })

    expect(validateScreenshotUrl).toBeTypeOf('function')
    expect(screenshotUrlRefusal('https://example.com/page')).toMatch(/webfetch\.deny/)
    expect(() => validateScreenshotUrl('https://example.com/page')).toThrow(/webfetch\.deny/)
  })

  it('refuses a target outside a non-empty allow list', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_ALLOW: '*.corp.example*' })

    expect(screenshotUrlRefusal('https://example.com/page')).toMatch(/webfetch\.allow/)
    expect(screenshotUrlRefusal('https://intranet.corp.example/dash')).toBeNull()
  })

  it('lets a deny pattern win over an allow pattern that also matches', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_ALLOW: '*example.com*', TOKEN_GOAT_WEBFETCH_DENY: '*example.com*' })

    expect(screenshotUrlRefusal('https://example.com/page')).toMatch(/webfetch\.deny/)
  })

  // The interception hook calls this same function for every sub-resource, so a denied host is
  // unreachable as an <img>/<script>/<iframe> source too, not just as the navigation target.
  it('refuses a denied sub-resource host while permitting the allowed page', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_DENY: '*tracker.example*' })

    expect(screenshotUrlRefusal('https://good.example/page')).toBeNull()
    expect(screenshotUrlRefusal('https://tracker.example/pixel.gif')).toMatch(/webfetch\.deny/)
  })

  // The refusal text is fed back into the model's context, so a signed screenshot URL must not
  // leak its token there -- the same reason the scheme and private-IP refusals show origin+path.
  it('does not echo the query string of a denied URL', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_DENY: '*' })

    const reason = screenshotUrlRefusal('https://example.com/doc?sig=SECRETTOKEN') ?? ''

    expect(reason).toMatch(/webfetch\.deny/)
    expect(reason).not.toContain('SECRETTOKEN')
  })

  // Ordering: a scheme that was already refused must stay refused for that reason, not be
  // reclassified as a policy denial (and vice versa a policy denial must not need a valid scheme).
  it('still refuses a bad scheme first, with the scheme reason', () => {
    withPolicy({ TOKEN_GOAT_WEBFETCH_DENY: '*' })

    expect(screenshotUrlRefusal('file:///etc/passwd')).toMatch(/scheme/i)
  })
})
