// Regression: webfetch.allow/webfetch.deny gated only the harness's own WebFetch tool, through the
// pre-hook. token-goat's own outbound commands -- fetch-image and gdrive-sections -- call
// performHttpFetch directly and ignored the policy entirely, so an operator who had denied
// everything still had two commands that reached the network. Verified against the built binary
// before the fix: `gdrive-sections <id>` reached docs.google.com and `fetch-image` downloaded a
// file, both under deny = ["*"]. Enforcing at performHttpFetch covers every present and future
// caller, including each redirect hop, since that function recurses into itself for redirects.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HttpsModule from 'https'

import { clearModuleCaches } from '../src/reset.js'
import { performHttpFetch } from '../src/webfetch.js'
import { urlPolicyDenialReason } from '../src/url_policy.js'

const httpsRequestMock = vi.hoisted(() => vi.fn())
vi.mock('https', async (importOriginal) => {
  const actual = await importOriginal<typeof HttpsModule>()
  return { ...actual, default: { ...actual, request: httpsRequestMock }, request: httpsRequestMock }
})

function fetchOpts() {
  return { deadlineAt: Date.now() + 30_000, timeoutSec: 30, maxSizeBytes: 1024, requestHeaders: {}, redirectsLeft: 3 }
}

beforeEach(() => {
  clearModuleCaches()
  httpsRequestMock.mockReset()
  delete process.env['TOKEN_GOAT_WEBFETCH_DENY']
  delete process.env['TOKEN_GOAT_WEBFETCH_ALLOW']
})

describe('performHttpFetch honours the configured URL policy', () => {
  it('refuses a denied URL without opening a socket', async () => {
    process.env['TOKEN_GOAT_WEBFETCH_DENY'] = 'https://docs.google.com/*'

    await expect(performHttpFetch('https://docs.google.com/document/d/abc/export', fetchOpts())).rejects.toThrow(
      /webfetch\.deny/,
    )
    expect(httpsRequestMock).not.toHaveBeenCalled()
  })

  it('refuses a URL outside a non-empty allow list without opening a socket', async () => {
    process.env['TOKEN_GOAT_WEBFETCH_ALLOW'] = 'https://intra.example.com/*'

    await expect(performHttpFetch('https://www.google.com/logo.png', fetchOpts())).rejects.toThrow(/webfetch\.allow/)
    expect(httpsRequestMock).not.toHaveBeenCalled()
  })

  it('opens a socket for a URL the allow list names', async () => {
    process.env['TOKEN_GOAT_WEBFETCH_ALLOW'] = 'https://intra.example.com/*'
    httpsRequestMock.mockImplementation(() => {
      throw new Error('socket attempted')
    })

    await expect(performHttpFetch('https://intra.example.com/doc', fetchOpts())).rejects.toThrow('socket attempted')
    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
  })

  it('leaves an unconfigured install reaching the network as before', async () => {
    httpsRequestMock.mockImplementation(() => {
      throw new Error('socket attempted')
    })

    await expect(performHttpFetch('https://anywhere.example.com/x', fetchOpts())).rejects.toThrow('socket attempted')
    expect(httpsRequestMock).toHaveBeenCalledTimes(1)
  })
})

describe('urlPolicyDenialReason', () => {
  it('lets deny win over allow for a URL both lists name', () => {
    const reason = urlPolicyDenialReason('https://docs.google.com/d/x', {
      allow: ['https://docs.google.com/*'],
      deny: ['https://docs.google.com/*'],
    })
    expect(reason).toContain('webfetch.deny')
  })

  it('permits everything when both lists are empty', () => {
    expect(urlPolicyDenialReason('https://anything.example.com/x', { allow: [], deny: [] })).toBeNull()
  })

  it('refuses a URL that only mentions an allowed host in its query, not as its host', () => {
    const reason = urlPolicyDenialReason('https://evil.example.net/steal?x=intra.example.com/', {
      allow: ['https://*.example.com/*'],
      deny: [],
    })
    expect(reason).toContain('webfetch.allow')
  })
})
