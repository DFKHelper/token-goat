import fs from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_MAX_AGE_MS, tokenGoatHome } from '../src/disk_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { likeSearchForTesting } from '../src/recall_index.js'
import {
  getWebOutput,
  getWebOutputByUrl,
  storeWebOutput,
  wasUrlFetchedThisSession,
} from '../src/web_cache.js'

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
})

describe('storeWebOutput', () => {
  it('returns a non-empty cache id', () => {
    const id = storeWebOutput('https://example.com', '<html>hi</html>')
    // The id is a deterministic function of the URL (shortFingerprint = first 16 hex chars of
    // its SHA-256), not the content -- pin the exact value so a change to the id derivation
    // (e.g. hashing content instead of URL, or a different slice length) is caught here rather
    // than passing this loose a length-only check.
    expect(id).toBe('100680ad546ce6a5')
  })

  it('returns the same id for the same URL', () => {
    const a = storeWebOutput('https://example.com', 'one')
    const b = storeWebOutput('https://example.com', 'two')
    expect(a).toBe(b)
  })

  // Regression (secret-redaction bypass): storeWebOutput indexed the raw, pre-redaction
  // content into both the in-memory _byId cache and the cache_recall table even though
  // storeBlob() redacted the same text before writing it to disk -- a same-process
  // getWebOutput() read, or `token-goat recall`/FTS search, could surface a secret the
  // blob-store redaction was specifically built to strip.
  it('never surfaces a raw secret via in-memory getWebOutput or the recall table', () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const id = storeWebOutput('https://example.com/secret-leak', `before ${secret} after`)
    expect(getWebOutput(id)).not.toContain(secret)
    const hits = likeSearchForTesting(secret, 'web')
    expect(hits).toHaveLength(0)
  })
})

describe('retrieval', () => {
  it('getWebOutput retrieves by id', () => {
    const id = storeWebOutput('https://example.com/a', 'body-a')
    expect(getWebOutput(id)).toBe('body-a')
  })

  it('getWebOutput returns null for an unknown id', () => {
    expect(getWebOutput('deadbeef')).toBeNull()
  })

  it('getWebOutputByUrl retrieves by URL', () => {
    const id = storeWebOutput('https://example.com/b', 'body-b')
    expect(getWebOutputByUrl('https://example.com/b')).toEqual({ cacheId: id, content: 'body-b' })
  })

  it('getWebOutputByUrl returns null for an unfetched URL', () => {
    expect(getWebOutputByUrl('https://nope.example')).toBeNull()
  })

  it('re-storing a URL returns the latest content', () => {
    storeWebOutput('https://example.com/c', 'first')
    storeWebOutput('https://example.com/c', 'second')
    expect(getWebOutputByUrl('https://example.com/c')?.content).toBe('second')
  })
})

describe('wasUrlFetchedThisSession', () => {
  it('returns false before and true after storing', () => {
    expect(wasUrlFetchedThisSession('https://example.com/d')).toBe(false)
    storeWebOutput('https://example.com/d', 'x')
    expect(wasUrlFetchedThisSession('https://example.com/d')).toBe(true)
  })
})

describe('TTL expiry', () => {
  it('getWebOutput returns null for stale disk entries beyond DEFAULT_MAX_AGE_MS', () => {
    // Store a web output
    const url = 'https://example.com/stale-check'
    const cacheId = storeWebOutput(url, 'stale-content')

    // Get the file path and set its mtime to be old (beyond TTL)
    const blobDir = path.join(tokenGoatHome(), 'web_outputs')
    const blobPath = path.join(blobDir, `${cacheId}.json`)

    // Set mtime to now minus (DEFAULT_MAX_AGE_MS + 1 second) to ensure it's expired
    const now = Date.now()
    const expiredTime = now - DEFAULT_MAX_AGE_MS - 1000
    fs.utimesSync(blobPath, expiredTime / 1000, expiredTime / 1000)

    // Clear the in-memory cache so the next read must hit disk
    clearModuleCaches()

    // Reading the stale entry from disk should return null (cache miss), not the old content
    expect(getWebOutput(cacheId)).toBeNull()
  })
})

describe('reset', () => {
  it('clearModuleCaches clears the in-memory maps', () => {
    storeWebOutput('https://example.com/e', 'gone')
    clearModuleCaches()
    // In-memory-only views are cleared: the URL index no longer knows the URL, and the session no longer counts it as fetched. (getWebOutput intentionally reads through to the persisted blob — covered in content_cache_disk.test.ts.)
    expect(getWebOutputByUrl('https://example.com/e')).toBeNull()
    expect(wasUrlFetchedThisSession('https://example.com/e')).toBe(false)
  })
})
