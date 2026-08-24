/**
 * The session-state file is written directly rather than through storeBlob, which is where every
 * other cache gets its defense-in-depth redaction pass. Two of its fields are urls: the curl `-o`
 * download map and the WebFetch map. A download or fetch url routinely carries a credential -- an
 * `api_key=` query parameter, a signed link's `X-Amz-Signature` -- and both were serialized
 * verbatim, so a live key landed in plain text on disk. web_cache.ts already redacts a url before
 * indexing it for exactly this reason; these two paths did not.
 *
 * The two are keyed differently on purpose, and these tests pin both halves. The curl map's only
 * consumer is an exact-match lookup that DENIES a repeat download, so it is keyed by digest: a
 * redaction would make two urls differing only inside the redacted span collide and block a
 * legitimate fetch of a different resource. The WebFetch map's keys are displayed in the
 * compaction manifest, so they stay readable and are redacted instead.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  clearCurlDownload,
  exportSessionState,
  getCurlDownloadPath,
  getWebFetchCacheId,
  recordCurlDownload,
  recordWebFetch,
} from '../src/session.js'
import { clearModuleCaches } from '../src/reset.js'

const API_KEY = 'sk-' + 'live-AbCdEf0123456789AbCdEf0123456789'
const SIGNED = `https://api.example.com/v1/export?api_key=${API_KEY}`

beforeEach(() => {
  clearModuleCaches()
})

describe('curl -o download urls in session state', () => {
  it('never writes the url or its credential into the serialized state', () => {
    recordCurlDownload(SIGNED, '/tmp/out.json')

    const serialized = JSON.stringify(exportSessionState())
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).not.toContain('api.example.com')
    // The saved path is not a secret and is what the recall hint points at.
    expect(serialized).toContain('/tmp/out.json')
  })

  it('still resolves the saved path for the same url', () => {
    recordCurlDownload(SIGNED, '/tmp/out.json')

    expect(getCurlDownloadPath(SIGNED)).toBe('/tmp/out.json')
  })

  it('does not confuse two urls that differ only inside the credential, which a redaction key would', () => {
    recordCurlDownload(SIGNED, '/tmp/first.json')

    const other = 'https://api.example.com/v1/export?api_key=sk-live-9999999999999999ZzZzZzZzZzZzZzZz'
    expect(getCurlDownloadPath(other)).toBeNull()
  })

  it('still clears the record for the same url', () => {
    recordCurlDownload(SIGNED, '/tmp/out.json')
    clearCurlDownload(SIGNED)

    expect(getCurlDownloadPath(SIGNED)).toBeNull()
  })
})

describe('WebFetch urls in session state', () => {
  it('redacts the credential but keeps the url readable for the compaction manifest', () => {
    recordWebFetch(SIGNED, 'summarize', 'cache-1')

    const serialized = JSON.stringify(exportSessionState())
    expect(serialized).not.toContain(API_KEY)
    expect(serialized).toContain('REDACTED')
    // The host and path survive: the manifest lists what was fetched this session.
    expect(serialized).toContain('api.example.com/v1/export')
  })

  it('still resolves the cache id for the same url and prompt', () => {
    recordWebFetch(SIGNED, 'summarize', 'cache-1')

    expect(getWebFetchCacheId(SIGNED, 'summarize')).toBe('cache-1')
  })

  it('keeps two different prompts for the same url apart', () => {
    recordWebFetch(SIGNED, 'summarize', 'cache-1')
    recordWebFetch(SIGNED, 'extract', 'cache-2')

    expect(getWebFetchCacheId(SIGNED, 'summarize')).toBe('cache-1')
    expect(getWebFetchCacheId(SIGNED, 'extract')).toBe('cache-2')
  })
})
