import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { clearModuleCaches } from '../src/reset.js'
import { storeBashOutput, getBashOutput, getBashOutputByCommandHash } from '../src/bash_output_cache.js'
import { storeWebOutput, getWebOutput, getWebOutputByUrl } from '../src/web_cache.js'

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

  it('getBashOutputByCommandHash also reads through to disk', async () => {
    const id = await storeBashOutput('echo hi', 'hi\n', 0, tmpHome)
    clearModuleCaches()
    expect(getBashOutputByCommandHash(id)?.output).toBe('hi\n')
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
