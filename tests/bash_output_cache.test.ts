import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  getBashOutput,
  storeBashOutput,
  isGitMutableCommand,
  isGitImmutableCommand,
  isDirListingCommand,
  isEnvProbeCommand,
  isDepListCommand,
  isNpxCommand,
  isScopedGitStatusOrDiffStatCommand,
  isGitPushCommand,
  isTestRunnerCommand,
  isLintCommand,
  isNpmRunScriptCommand,
  isCatCommand,
  normalizeCommandForCacheKey,
  commandHash,
  depLockfileFingerprint,
  computeBashFingerprints,
  isBashEntryStale,
  summarizeOutputDelta,
  type BashOutputEntry,
} from '../src/bash_output_cache.js'
import { clearModuleCaches } from '../src/reset.js'
import { DEFAULT_MAX_AGE_MS, tokenGoatHome } from '../src/disk_cache.js'
import { likeSearchForTesting } from '../src/recall_index.js'

beforeEach(() => {
  clearModuleCaches()
})

afterEach(() => {
  clearModuleCaches()
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

describe('isScopedGitStatusOrDiffStatCommand (Bug D regression)', () => {
  it('accepts a scoped git status', () => {
    expect(isScopedGitStatusOrDiffStatCommand('git status --porcelain -- a.txt')).toBe(true)
    expect(isScopedGitStatusOrDiffStatCommand('git status -- src/foo.ts')).toBe(true)
  })

  it('accepts a scoped git diff --stat', () => {
    expect(isScopedGitStatusOrDiffStatCommand('git diff --stat -- a.txt')).toBe(true)
    expect(isScopedGitStatusOrDiffStatCommand('git diff --stat HEAD -- a.txt')).toBe(true)
  })

  it('rejects an unscoped git status (no `-- <path>`)', () => {
    expect(isScopedGitStatusOrDiffStatCommand('git status')).toBe(false)
    expect(isScopedGitStatusOrDiffStatCommand('git status --porcelain')).toBe(false)
  })

  it('rejects a scoped git diff without --stat (full diff, not the compact summary)', () => {
    expect(isScopedGitStatusOrDiffStatCommand('git diff -- a.txt')).toBe(false)
    expect(isScopedGitStatusOrDiffStatCommand('git diff HEAD -- a.txt')).toBe(false)
  })

  it('rejects unrelated git subcommands', () => {
    expect(isScopedGitStatusOrDiffStatCommand('git log -- a.txt')).toBe(false)
    expect(isScopedGitStatusOrDiffStatCommand('git show HEAD -- a.txt')).toBe(false)
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

describe('storeBashOutput', () => {
  it('returns an id equal to the command hash', async () => {
    const id = await storeBashOutput('echo hi', 'hi\n', 0)
    expect(id).toBe(await commandHash('echo hi', null))
  })

  // Regression (secret-redaction bypass): storeBashOutput indexed the raw, pre-redaction
  // output into both the in-memory _byId cache and the cache_recall table even though
  // storeBlob() redacted the same text before writing it to disk -- a same-process
  // getBashOutput() read, or `token-goat recall`/FTS search, could surface a secret the
  // blob-store redaction was specifically built to strip.
  it('never surfaces a raw secret via in-memory getBashOutput or the recall table', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const id = await storeBashOutput('deploy', `before ${secret} after`, 0)
    expect(getBashOutput(id)?.output).not.toContain(secret)
    const hits = likeSearchForTesting(secret, 'bash')
    expect(hits).toHaveLength(0)
  })

  // Regression: the command line itself can carry a secret too (e.g. a curl -H
  // "Authorization: Bearer sk-ant-..." header), not just its output. storeBlob()'s
  // whole-JSON redaction strips it from the on-disk blob, but entry.command (in-memory)
  // and the recall index's label/content both bypassed that pass entirely for the
  // command text specifically -- only the output half of this fix was ever applied.
  it('never surfaces a raw secret embedded in the command itself', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE'
    const id = await storeBashOutput(`curl -H "Authorization: Bearer ${secret}" https://example.com`, 'ok', 0)
    expect(getBashOutput(id)?.command).not.toContain(secret)
    const hits = likeSearchForTesting(secret, 'bash')
    expect(hits).toHaveLength(0)
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

  it('captures a non-zero exit code', async () => {
    const id = await storeBashOutput('false', '', 1)
    expect(getBashOutput(id)?.exitCode).toBe(1)
  })
})

describe('TTL expiry (regression: getBashOutput had no read-time staleness check, unlike getWebOutput)', () => {
  it('getBashOutput returns null for stale disk entries beyond DEFAULT_MAX_AGE_MS', async () => {
    const id = await storeBashOutput('echo stale-check', 'stale-content', 0)

    const blobPath = path.join(tokenGoatHome(), 'bash_outputs', `${id}.json`)
    const expiredTime = (Date.now() - DEFAULT_MAX_AGE_MS - 1000) / 1000
    fs.utimesSync(blobPath, expiredTime, expiredTime)

    // Clear the in-memory cache so the next read must hit disk and re-check age.
    clearModuleCaches()

    expect(getBashOutput(id)).toBeNull()
  })
})

describe('coerceBashEntry disk-blob validation (mutation-testing gap)', () => {
  // Regression: loadBlob's own docstring says "the caller validates the parsed
  // shape" -- coerceBashEntry is that validator, gating every field the disk
  // blob must carry (id/command/output/exitCode/storedAt/sizeBytes) behind a
  // typeof check before trusting it. No test exercised a blob missing one of
  // those required fields (e.g. written by a stale on-disk format, or hand-
  // corrupted), so a mutation dropping one field's check from the guard still
  // passed the full suite. A blob missing a required field must be rejected
  // (getBashOutput -> null), not silently coerced with an undefined field.
  it('getBashOutput returns null when the persisted blob is missing a required field', async () => {
    const id = await storeBashOutput('echo placeholder', 'placeholder', 0)
    const blobPath = path.join(tokenGoatHome(), 'bash_outputs', `${id}.json`)
    const malformed = JSON.parse(fs.readFileSync(blobPath, 'utf8')) as Record<string, unknown>
    delete malformed['sizeBytes']
    fs.writeFileSync(blobPath, JSON.stringify(malformed))

    clearModuleCaches()

    expect(getBashOutput(id)).toBeNull()
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

  // Regression (mutation-testing gap): DEP_LOCKFILES['npm'] lists two candidate
  // lockfiles (package-lock.json, then yarn.lock as a fallback). No test exercised
  // the fallback itself -- a mutation that returned null on the first missing
  // candidate instead of trying the next one still passed the full suite.
  it('falls back to the next candidate lockfile when the first is absent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-lockfile-fallback-'))
    try {
      // No package-lock.json here -- only the fallback candidate.
      fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), '# yarn lockfile v1\n')
      const result = await depLockfileFingerprint('npm ls', tmpDir)
      expect(result).not.toBeNull()
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('reset', () => {
  it('clearModuleCaches drops in-memory entries; getBashOutput reads through to the persisted blob', async () => {
    const id = await storeBashOutput('echo gone', 'gone', 0)
    clearModuleCaches()
    // The in-memory map was cleared, but the content is intentionally persisted so a later (separate) process can recall it — getBashOutput reads through.
    expect(getBashOutput(id)?.output).toBe('gone')
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

      // Add a file to the subdirectory. This is only observable in the hash if
      // the dir-state fingerprint is computed against `resolve(tmpDir, 'sub')`
      // (the command's own cwd) -- resolving against `process.cwd()` instead
      // (the test runner's real cwd, which has no 'sub' dir) would fingerprint
      // as null both times and the hash would stay identical regardless of
      // what happens to `subDir`.
      fs.writeFileSync(path.join(subDir, 'new-file.txt'), 'new\n')

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

  // Regression (mutation-testing gap): computeBashFingerprints must return undefined,
  // not an empty object, when no fingerprint kind matched. `{}` is truthy in JS, so
  // storeBashOutput's `...(fingerprints ? { fingerprints } : {})` spread would still
  // attach an empty `fingerprints: {}` to every entry -- a shape change no prior test
  // caught because isBashEntryStale behaves identically for `{}` and `undefined`.
  it('returns undefined (not an empty object) for a command that matches no fingerprint kind', () => {
    expect(computeBashFingerprints('echo hi', null)).toBeUndefined()
    expect(computeBashFingerprints('echo hi', '/some/cwd')).toBeUndefined()
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

      fs.writeFileSync(path.join(subDir, 'new-file.txt'), 'new\n')

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

  // Regression: isNpmAuditCommand/isNpmOutdatedCommand (bash_output_cache.ts) had a purpose-built
  // regex pattern and classifier each, but zero call sites anywhere -- npm audit/outdated results
  // never got a lockfile fingerprint, so a cached `npm audit` run before `npm install` added a
  // vulnerable package would be served as fresh forever after, with no invalidation signal.
  it.each(['npm audit', 'npm outdated'])(
    'detects a stale `%s` entry once package-lock.json changes',
    async (cmd) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-npmaudit-'))
      try {
        fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion": 1}\n')
        const id = await storeBashOutput(cmd, 'no issues found', 0, tmpDir)
        const entry = getBashOutput(id)
        expect(entry?.fingerprints?.lockfile).toBeDefined()
        expect(isBashEntryStale(entry!, cmd, tmpDir)).toBe(false)

        fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{"lockfileVersion": 2}\n')
        expect(isBashEntryStale(entry!, cmd, tmpDir)).toBe(true)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )
})

/** Init a git repo with one committed file at `<repo>/a.txt`, returning the repo dir. */
function initGitRepoWithFile(prefix: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'one\n')
  const git = (args: string[]): void => {
    execFileSync('git', args, { cwd: tmpDir, stdio: 'ignore' })
  }
  git(['init'])
  git(['-c', 'core.hooksPath=/dev/null', 'add', '.'])
  git(['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'init'])
  return tmpDir
}

describe('gitStateFingerprintSync — uncommitted working-tree changes (M45 regression)', () => {
  it('flags a cached git-diff entry as stale once a tracked file is edited without staging', async () => {
    const tmpDir = initGitRepoWithFile('tg-fp-gitwt-')
    try {
      const id = await storeBashOutput('git diff', '', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.git).toBeDefined()
      expect(isBashEntryStale(entry!, 'git diff', tmpDir)).toBe(false)

      // Edit a tracked file WITHOUT staging or committing -- HEAD sha and
      // .git/index mtime are both untouched by this, so a fingerprint based
      // only on those two never changes and the stale check misses the edit.
      fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'two\n')

      expect(isBashEntryStale(entry!, 'git diff', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('flags a cached git-status entry as stale once a new untracked file appears', async () => {
    const tmpDir = initGitRepoWithFile('tg-fp-gitwt-untracked-')
    try {
      const id = await storeBashOutput('git status', 'clean', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(isBashEntryStale(entry!, 'git status', tmpDir)).toBe(false)

      fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'new\n')

      expect(isBashEntryStale(entry!, 'git status', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})

describe('computeBashFingerprints coverage for common monitored commands (M46 regression)', () => {
  it.each(['pytest', 'vitest run', 'jest', 'go test ./...', 'eslint src', 'ruff check', 'npm run build', 'git push origin main', 'tsc', 'npx tsc', 'make', 'cargo build', 'dotnet build', 'mvn package', 'vite build'])(
    'computes a git fingerprint for %s and flags it stale once a tracked file is edited',
    async (cmd) => {
      const tmpDir = initGitRepoWithFile('tg-fp-cov-')
      try {
        const id = await storeBashOutput(cmd, 'output', 0, tmpDir)
        const entry = getBashOutput(id)
        expect(entry?.fingerprints?.git).toBeDefined()
        expect(isBashEntryStale(entry!, cmd, tmpDir)).toBe(false)

        fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'two\n')

        expect(isBashEntryStale(entry!, cmd, tmpDir)).toBe(true)
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  it('computes a file fingerprint for `cat <file>` and flags it stale once the file changes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-cat-'))
    try {
      const target = path.join(tmpDir, 'notes.txt')
      fs.writeFileSync(target, 'v1\n')
      const id = await storeBashOutput('cat notes.txt', 'v1\n', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.file).toBeDefined()
      expect(isBashEntryStale(entry!, 'cat notes.txt', tmpDir)).toBe(false)

      fs.writeFileSync(target, 'v2\n')

      expect(isBashEntryStale(entry!, 'cat notes.txt', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Regression: extractCatTarget/extractLsTarget naively split on whitespace, so a quoted
  // path with a space (e.g. `cat "release notes.txt"`) resolved to the literal token
  // `"release` -- a nonexistent path. Fingerprinting that bogus path fails silently, leaving
  // the entry with NO file fingerprint at all, and isBashEntryStale treats a fingerprint-less
  // entry as unconditionally fresh -- so the stale pre-edit content would be served forever.
  it('computes a file fingerprint for `cat "<quoted path with a space>"` and flags it stale once the file changes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-cat-quoted-'))
    try {
      const target = path.join(tmpDir, 'release notes.txt')
      fs.writeFileSync(target, 'v1\n')
      const id = await storeBashOutput('cat "release notes.txt"', 'v1\n', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.file).toBeDefined()
      expect(isBashEntryStale(entry!, 'cat "release notes.txt"', tmpDir)).toBe(false)

      fs.writeFileSync(target, 'v2\n')

      expect(isBashEntryStale(entry!, 'cat "release notes.txt"', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // Regression (mutation-testing gap): tokenizeShellArgs handles both `"` and `'` as quote
  // delimiters, but every existing quoted-path test here used double quotes only, so a
  // mutation that dropped single-quote handling entirely still passed the full suite. A
  // single-quoted path (a common POSIX-shell quoting style, e.g. `cat 'release notes.txt'`)
  // must resolve identically to the double-quoted case.
  it('computes a file fingerprint for `cat \'<single-quoted path with a space>\'` and flags it stale once the file changes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-cat-squoted-'))
    try {
      const target = path.join(tmpDir, 'release notes.txt')
      fs.writeFileSync(target, 'v1\n')
      const id = await storeBashOutput("cat 'release notes.txt'", 'v1\n', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.file).toBeDefined()
      expect(isBashEntryStale(entry!, "cat 'release notes.txt'", tmpDir)).toBe(false)

      fs.writeFileSync(target, 'v2\n')

      expect(isBashEntryStale(entry!, "cat 'release notes.txt'", tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('computes a dir fingerprint for `ls "<quoted dir with a space>"` and flags it stale once the dir changes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-ls-quoted-'))
    try {
      const target = path.join(tmpDir, 'my stuff')
      fs.mkdirSync(target)
      const id = await storeBashOutput('ls "my stuff"', '', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.dir).toBeDefined()
      expect(isBashEntryStale(entry!, 'ls "my stuff"', tmpDir)).toBe(false)

      fs.writeFileSync(path.join(target, 'new-file.txt'), 'new\n')

      expect(isBashEntryStale(entry!, 'ls "my stuff"', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('flags a dir stale for a new entry landing at the same mtime tick as the original listing (regression: the old mtime-only dir fingerprint silently kept serving the stale listing once two writes shared a dir mtime)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-fp-ls-samemtime-'))
    try {
      const target = path.join(tmpDir, 'watched')
      fs.mkdirSync(target)
      const pinnedMtime = new Date('2026-01-01T00:00:00.000Z')
      fs.utimesSync(target, pinnedMtime, pinnedMtime)

      const id = await storeBashOutput('ls watched', '', 0, tmpDir)
      const entry = getBashOutput(id)
      expect(entry?.fingerprints?.dir).toBeDefined()
      expect(isBashEntryStale(entry!, 'ls watched', tmpDir)).toBe(false)

      fs.writeFileSync(path.join(target, 'new-file.txt'), 'new\n')
      fs.utimesSync(target, pinnedMtime, pinnedMtime)

      expect(isBashEntryStale(entry!, 'ls watched', tmpDir)).toBe(true)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('detects the new command classes', () => {
    expect(isTestRunnerCommand('pytest')).toBe(true)
    expect(isTestRunnerCommand('vitest run')).toBe(true)
    expect(isTestRunnerCommand('jest')).toBe(true)
    expect(isTestRunnerCommand('go test ./...')).toBe(true)
    expect(isTestRunnerCommand('cat file')).toBe(false)

    expect(isLintCommand('eslint src')).toBe(true)
    expect(isLintCommand('ruff check')).toBe(true)
    expect(isLintCommand('cat file')).toBe(false)

    expect(isNpmRunScriptCommand('npm run build')).toBe(true)
    expect(isNpmRunScriptCommand('npm install')).toBe(false)

    expect(isGitPushCommand('git push origin main')).toBe(true)
    expect(isGitPushCommand('git pull')).toBe(false)

    expect(isCatCommand('cat file.txt')).toBe(true)
    expect(isCatCommand('catalog')).toBe(false)
  })
})

describe('summarizeOutputDelta', () => {
  it('returns null when the outputs are byte-identical', () => {
    expect(summarizeOutputDelta('all good\n', 'all good\n')).toBeNull()
  })

  it('reports resolved/remaining counts when the prior output had issue lines', () => {
    const oldOutput = ['running suite', 'error: foo.ts:10 unexpected token', 'error: bar.ts:5 missing semicolon', ''].join('\n')
    const newOutput = ['running suite', 'error: bar.ts:5 missing semicolon', ''].join('\n')
    const delta = summarizeOutputDelta(oldOutput, newOutput)
    expect(delta).toBe('[token-goat: delta] 1 of 2 prior issues resolved; remaining: 1')
  })

  it('reports zero resolved when every issue line persists verbatim', () => {
    const oldOutput = ['error: still broken', ''].join('\n')
    const newOutput = ['error: still broken', 'an extra unrelated line', ''].join('\n')
    const delta = summarizeOutputDelta(oldOutput, newOutput)
    expect(delta).toBe('[token-goat: delta] 0 of 1 prior issues resolved; remaining: 1')
  })

  it('reports all resolved with zero remaining when every issue line is gone', () => {
    const oldOutput = ['warning: deprecated call', 'FAILED test_foo', ''].join('\n')
    const newOutput = ['all clean', ''].join('\n')
    const delta = summarizeOutputDelta(oldOutput, newOutput)
    expect(delta).toBe('[token-goat: delta] 2 of 2 prior issues resolved; remaining: 0')
  })

  it('falls back to a line-count delta when the prior output has no issue-shaped lines', () => {
    const oldOutput = ['build complete', 'line2', ''].join('\n')
    const newOutput = ['build complete', 'line2', 'line3', ''].join('\n')
    const delta = summarizeOutputDelta(oldOutput, newOutput)
    expect(delta).toBe('[token-goat: delta] output changed: 3 -> 4 lines')
  })
})
