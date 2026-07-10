import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../src/reset.js'
import { storeBashOutput, getBashOutput } from '../src/bash_output_cache.js'
import { storeWebOutput, getWebOutput, getWebOutputByUrl, getWebOutputByUrlFromDisk } from '../src/web_cache.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-content-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
  clearModuleCaches()
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('bash-output disk read-through (simulated cross-process)', () => {
  it('resolves a stored entry after the in-memory map is cleared', async () => {
    const id = await storeBashOutput('npm run build', 'BUILD OK\n', 0, tmpHome)
    expect(fs.existsSync(path.join(tmpHome, 'bash_outputs', `${id}.json`))).toBe(true)

    // Simulate a fresh hook process: drop every in-memory cache.
    clearModuleCaches()

    const entry = getBashOutput(id)
    expect(entry).not.toBeNull()
    expect(entry?.output).toBe('BUILD OK\n')
    expect(entry?.command).toBe('npm run build')
    expect(entry?.exitCode).toBe(0)
  })

  it('returns null for an unknown id with nothing on disk', () => {
    expect(getBashOutput('0000000000000000')).toBeNull()
  })
})

describe('web-output disk read-through (simulated cross-process)', () => {
  it('resolves a stored body after the in-memory map is cleared', () => {
    const cacheId = storeWebOutput('https://example.com/doc', '# Title\nbody')
    expect(fs.existsSync(path.join(tmpHome, 'web_outputs', `${cacheId}.json`))).toBe(true)

    clearModuleCaches()

    expect(getWebOutput(cacheId)).toBe('# Title\nbody')
    // The disk hit re-populates the URL index so URL lookups resolve too.
    expect(getWebOutputByUrl('https://example.com/doc')).toEqual({
      cacheId,
      content: '# Title\nbody',
    })
  })

  it('returns null for an unknown cacheId with nothing on disk', () => {
    expect(getWebOutput('0000000000000000')).toBeNull()
  })
})

describe('getWebOutputByUrlFromDisk cross-process URL lookup (m33 regression)', () => {
  // gdrive.ts's fetchDoc only ever has a URL (never a previously-known cache
  // id) and each CLI invocation is a fresh process with empty in-memory
  // maps, so it needs a URL-keyed lookup that reads through to disk.
  // getWebOutputByUrl cannot do this (see the "clearModuleCaches clears the
  // in-memory maps" test in web_cache.test.ts -- it's deliberately
  // memory-only), which is why gdrive-sections used to always re-fetch from
  // the network on every fresh CLI invocation even when the doc was already
  // cached on disk from an earlier run.
  it('resolves a URL cached by an earlier process, reading through to disk', () => {
    const url = 'https://docs.google.com/document/d/abc123/export?format=txt'
    const cacheId = storeWebOutput(url, '# Title\nbody')

    clearModuleCaches()

    expect(getWebOutputByUrlFromDisk(url)).toEqual({ cacheId, content: '# Title\nbody' })
  })

  it('returns null for a URL that was never fetched, with nothing on disk', () => {
    expect(getWebOutputByUrlFromDisk('https://docs.google.com/document/d/never-fetched/export?format=txt')).toBeNull()
  })
})
