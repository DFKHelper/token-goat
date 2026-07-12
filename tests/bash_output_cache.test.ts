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
