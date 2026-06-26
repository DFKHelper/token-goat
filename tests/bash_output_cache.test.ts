import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  getBashOutput,
  getBashOutputByCommandHash,
  hashCommand,
  storeBashOutput,
  isGitMutableCommand,
  isGitImmutableCommand,
  isDirListingCommand,
  isEnvProbeCommand,
  isDepListCommand,
  isNpxCommand,
  isUnscopedGitDiff,
  normalizeCommandForCacheKey,
  globHash,
  storeGlobResult,
  getBashGlobResult,
  commandHash,
  depLockfileFingerprint,
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

describe('isGitMutableCommand', () => {
  it('detects git diff/status', () => {
    expect(isGitMutableCommand('git diff')).toBe(true)
    expect(isGitMutableCommand('git status')).toBe(true)
  })

  it('rejects immutable commands', () => {
    expect(isGitMutableCommand('git show abc123')).toBe(false)
  })
})

describe('isGitImmutableCommand', () => {
  it('detects git show with full SHA', () => {
    expect(isGitImmutableCommand('git show 0123456789abcdef0123456789abcdef01234567')).toBe(true)
  })

  it('rejects partial SHAs', () => {
    expect(isGitImmutableCommand('git show abc123')).toBe(false)
  })
})

describe('isDirListingCommand', () => {
  it('detects ls variants', () => {
    expect(isDirListingCommand('ls')).toBe(true)
    expect(isDirListingCommand('eza --long')).toBe(true)
    expect(isDirListingCommand('dir')).toBe(true)
  })
})

describe('isEnvProbeCommand', () => {
  it('detects version checks', () => {
    expect(isEnvProbeCommand('node --version')).toBe(true)
    expect(isEnvProbeCommand('python -V')).toBe(true)
    expect(isEnvProbeCommand('which node')).toBe(true)
  })
})

describe('isNpxCommand', () => {
  it('detects npx version checks', () => {
    expect(isNpxCommand('npx --version')).toBe(true)
    expect(isNpxCommand('npx tsc --version')).toBe(true)
    expect(isNpxCommand('npx eslint --version')).toBe(true)
  })

  it('detects npx with optional --yes flag', () => {
    expect(isNpxCommand('npx --yes tsc --version')).toBe(true)
    expect(isNpxCommand('npx -y prettier --check src/')).toBe(true)
  })

  it('detects npx command executions', () => {
    expect(isNpxCommand('npx prettier --check src/')).toBe(true)
    expect(isNpxCommand('npx eslint src/')).toBe(true)
  })

  it('rejects mutable npx commands', () => {
    expect(isNpxCommand('npx npm install')).toBe(false)
    expect(isNpxCommand('npx something install')).toBe(false)
    expect(isNpxCommand('npx package add')).toBe(false)
    expect(isNpxCommand('npx dep remove')).toBe(false)
    expect(isNpxCommand('npx pkg update')).toBe(false)
  })
})

describe('isDepListCommand', () => {
  it('detects dependency commands', () => {
    expect(isDepListCommand('npm list')).toBe(true)
    expect(isDepListCommand('pip freeze')).toBe(true)
  })

  it('rejects install/add variants', () => {
    expect(isDepListCommand('npm install')).toBe(false)
  })
})

describe('isUnscopedGitDiff', () => {
  it('detects unscoped diffs', () => {
    expect(isUnscopedGitDiff('git diff')).toBe(true)
  })

  it('rejects scoped diffs', () => {
    expect(isUnscopedGitDiff('git diff -- file.txt')).toBe(false)
  })
})

describe('normalizeCommandForCacheKey', () => {
  it('strips whitespace', () => {
    expect(normalizeCommandForCacheKey('  cat file  ')).toBe('cat file')
  })

  it('normalizes path separators', () => {
    expect(normalizeCommandForCacheKey('cat C:\\foo\\bar')).toBe('cat C:/foo/bar')
  })

  it('strips ./ prefix', () => {
    expect(normalizeCommandForCacheKey('cat ./file')).toBe('cat file')
  })

  it('strips trailing /', () => {
    expect(normalizeCommandForCacheKey('ls src/')).toBe('ls src')
  })
})

describe('commandHash', () => {
  it('returns 16-char hex', async () => {
    const hash = await commandHash('ls', null)
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('produces consistent hashes', async () => {
    const hash1 = await commandHash('ls', null)
    const hash2 = await commandHash('ls', null)
    expect(hash1).toBe(hash2)
  })
})

describe('globHash', () => {
  it('returns 16-char hex', () => {
    const hash = globHash('**/*.ts', '/src')
    expect(hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it('treats null path as empty string', () => {
    const hash1 = globHash('**/*.ts', null)
    const hash2 = globHash('**/*.ts', '')
    expect(hash1).toBe(hash2)
  })
})

describe('glob result caching', () => {
  it('stores and retrieves', () => {
    storeGlobResult('session1', '**/*.ts', '/src', 'file1\nfile2\n')
    const result = getBashGlobResult('session1', '**/*.ts', '/src')
    expect(result).toBe('file1\nfile2\n')
  })

  it('returns null for missing', () => {
    const result = getBashGlobResult('nonexistent', 'pattern', '/path')
    expect(result).toBeNull()
  })
})

describe('storeBashOutput', () => {
  it('returns an id equal to the command hash', async () => {
    const id = await storeBashOutput('echo hi', 'hi\n', 0)
    expect(id).toBe(await commandHash('echo hi', null))
  })
})

describe('retrieval', () => {
  it('getBashOutput retrieves the full entry by id', async () => {
    const id = await storeBashOutput('pytest', 'all passed', 0)
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

  it('getBashOutputByCommandHash retrieves by command hash', async () => {
    const id = await storeBashOutput('git status', 'clean', 0)
    const entry = getBashOutputByCommandHash(id)
    expect(entry?.output).toBe('clean')
  })

  it('getBashOutputByCommandHash returns null for an unknown hash', () => {
    expect(getBashOutputByCommandHash('ffffffffffffffff')).toBeNull()
  })

  it('captures a non-zero exit code', async () => {
    const id = await storeBashOutput('false', '', 1)
    expect(getBashOutput(id)?.exitCode).toBe(1)
  })
})

describe('depLockfileFingerprint', () => {
  it('returns null when cwd is null', async () => {
    const result = await depLockfileFingerprint('npm ls', null)
    expect(result).toBeNull()
  })

  it('returns null when command has no leading token', async () => {
    const result = await depLockfileFingerprint('', '/path/to/project')
    expect(result).toBeNull()
  })

  it('returns null when first token is just whitespace', async () => {
    const result = await depLockfileFingerprint('   ', '/path/to/project')
    expect(result).toBeNull()
  })

  it('returns null when no matching lockfile found', async () => {
    const result = await depLockfileFingerprint('npm ls', '/nonexistent/path')
    expect(result).toBeNull()
  })
})

describe('reset', () => {
  it('clearModuleCaches removes all entries', async () => {
    const id = await storeBashOutput('echo gone', 'gone', 0)
    clearModuleCaches()
    expect(getBashOutput(id)).toBeNull()
    expect(getBashOutputByCommandHash(id)).toBeNull()
  })
})
