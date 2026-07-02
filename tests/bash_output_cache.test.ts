import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
  computeBashFingerprints,
  isBashEntryStale,
  type BashOutputEntry,
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
  it('clearModuleCaches drops in-memory entries; getBashOutput reads through to the persisted blob', async () => {
    const id = await storeBashOutput('echo gone', 'gone', 0)
    clearModuleCaches()
    // The in-memory map was cleared, but the content is intentionally persisted so a later (separate) process can recall it — getBashOutput reads through.
    expect(getBashOutput(id)?.output).toBe('gone')
    expect(getBashOutputByCommandHash(id)?.output).toBe('gone')
    // A never-stored id stays null (no lingering state after the reset).
    expect(getBashOutput('ffffffffffffffff')).toBeNull()
  })
})

describe('extractLsTarget cwd resolution (m32 regression)', () => {
  it('resolves the ls target against the command cwd, not process.cwd()', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lstarget-'))
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    try {
      const hash1 = await commandHash('ls sub', tmpDir)

      // Bump the subdirectory's mtime. This is only observable in the hash if
      // the dir-state fingerprint is computed against `resolve(tmpDir, 'sub')`
      // (the command's own cwd) -- resolving against `process.cwd()` instead
      // (the test runner's real cwd, which has no 'sub' dir) would fingerprint
      // as null both times and the hash would stay identical regardless of
      // what happens to `subDir`.
      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(subDir, future, future)

      const hash2 = await commandHash('ls sub', tmpDir)
      expect(hash2).not.toBe(hash1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('normalizeCommandForCacheKey — quote-aware normalization (M41 regression)', () => {
  it('does not collapse whitespace runs inside a double-quoted argument', () => {
    const a = normalizeCommandForCacheKey('echo "a   b"')
    const b = normalizeCommandForCacheKey('echo "a b"')
    // Two genuinely different commands (different quoted content) must not
    // collapse to the same normalized cache key.
    expect(a).not.toBe(b)
    expect(a).toBe('echo "a   b"')
    expect(b).toBe('echo "a b"')
  })

  it('does not collapse whitespace runs inside a single-quoted argument', () => {
    const a = normalizeCommandForCacheKey("echo 'a   b'")
    const b = normalizeCommandForCacheKey("echo 'a b'")
    expect(a).not.toBe(b)
  })

  it('does not rewrite a backslash to a forward slash inside a quoted argument', () => {
    const input = 'grep "a\\.b" file.txt'
    expect(normalizeCommandForCacheKey(input)).toBe(input)
  })

  it('still collapses whitespace and converts backslashes outside quotes', () => {
    expect(normalizeCommandForCacheKey('cat   C:\\foo\\bar')).toBe('cat C:/foo/bar')
  })

  it('still strips a leading ./ and trailing / from unquoted path tokens', () => {
    expect(normalizeCommandForCacheKey('cat ./file')).toBe('cat file')
    expect(normalizeCommandForCacheKey('ls src/')).toBe('ls src')
  })
})

describe('computeBashFingerprints / isBashEntryStale (M44 regression)', () => {
  it('never flags an entry with no stored fingerprints as stale', () => {
    const entry: BashOutputEntry = {
      id: 'x',
      command: 'echo hi',
      output: 'hi',
      exitCode: 0,
      storedAt: Date.now(),
      sizeBytes: 2,
    }
    expect(isBashEntryStale(entry, 'echo hi', null)).toBe(false)
  })

  it('detects a stale dir-listing entry once the target directory changes', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-dir-'))
    const subDir = path.join(tmpDir, 'sub')
    fs.mkdirSync(subDir)
    try {
      const fingerprints = computeBashFingerprints('ls sub', tmpDir)
      expect(fingerprints?.dir).toBeDefined()

      const entry: BashOutputEntry = {
        id: 'x',
        command: 'ls sub',
        output: 'file1\n',
        exitCode: 0,
        storedAt: Date.now(),
        sizeBytes: 6,
        fingerprints,
      }
      expect(isBashEntryStale(entry, 'ls sub', tmpDir)).toBe(false)

      const future = new Date(Date.now() + 60_000)
      fs.utimesSync(subDir, future, future)

      expect(isBashEntryStale(entry, 'ls sub', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects a stale dep-list entry once the lockfile content changes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-lock-'))
    try {
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'requests==2.0.0\n')
      const id = await storeBashOutput('pip freeze', 'requests==2.0.0\n', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.lockfile).toBeDefined()
      expect(isBashEntryStale(entry!, 'pip freeze', tmpDir)).toBe(false)

      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'requests==3.0.0\n')
      expect(isBashEntryStale(entry!, 'pip freeze', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
