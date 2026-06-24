import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getBashOutput,
  getBashOutputByCommandHash,
  hashCommand,
  storeBashOutput,
} from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
})

describe('hashCommand', () => {
  it('returns a 16-char hex hash', () => {
    expect(hashCommand('ls -la')).toMatch(/^[0-9a-f]{16}$/)
  })

  it('ignores surrounding whitespace', () => {
    expect(hashCommand('  npm test  ')).toBe(hashCommand('npm test'))
  })

  it('differs for different commands', () => {
    expect(hashCommand('a')).not.toBe(hashCommand('b'))
  })
})

describe('storeBashOutput', () => {
  it('returns an id equal to the command hash', () => {
    const id = storeBashOutput('echo hi', 'hi\n', 0)
    expect(id).toBe(hashCommand('echo hi'))
  })
})

describe('retrieval', () => {
  it('getBashOutput retrieves the full entry by id', () => {
    const id = storeBashOutput('pytest', 'all passed', 0)
    const entry = getBashOutput(id)
    expect(entry).not.toBeNull()
    expect(entry?.command).toBe('pytest')
    expect(entry?.output).toBe('all passed')
    expect(entry?.exitCode).toBe(0)
    expect(entry?.sizeBytes).toBe(Buffer.byteLength('all passed', 'utf-8'))
    expect(entry?.storedAt).toBeGreaterThan(0)
  })

  it('getBashOutput returns null for an unknown id', () => {
    expect(getBashOutput('0000000000000000')).toBeNull()
  })

  it('getBashOutputByCommandHash retrieves by command hash', () => {
    storeBashOutput('git status', 'clean', 0)
    const entry = getBashOutputByCommandHash(hashCommand('git status'))
    expect(entry?.output).toBe('clean')
  })

  it('getBashOutputByCommandHash returns null for an unknown hash', () => {
    expect(getBashOutputByCommandHash('ffffffffffffffff')).toBeNull()
  })

  it('captures a non-zero exit code', () => {
    const id = storeBashOutput('false', '', 1)
    expect(getBashOutput(id)?.exitCode).toBe(1)
  })
})

describe('reset', () => {
  it('clearModuleCaches removes all entries', () => {
    const id = storeBashOutput('echo gone', 'gone', 0)
    clearModuleCaches()
    expect(getBashOutput(id)).toBeNull()
    expect(getBashOutputByCommandHash(hashCommand('echo gone'))).toBeNull()
  })
})
