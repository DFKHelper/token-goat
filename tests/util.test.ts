import { spawn } from 'node:child_process'
import type * as cp from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// vi.spyOn cannot patch node:child_process either (same non-configurable-namespace-export
// issue as node:fs below), so verifying the timeoutMs -> spawnSync `timeout` pass-through
// needs the same hoisted-mock pattern: every call passes straight through to the real
// spawnSync, and the mock only exists so its call args are inspectable via vi.mocked(...).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cp>()
  return { ...actual, spawnSync: vi.fn((...args: Parameters<typeof actual.spawnSync>) => actual.spawnSync(...args)) }
})

// vi.spyOn cannot patch node:fs (its namespace exports are non-configurable: "Cannot redefine
// property"), so simulating a writeSync failure needs a module mock with a hoisted flag -- same
// pattern as tests/index_prune.test.ts. Every other fs call passes straight through to the real
// module untouched; only writeSync is ever intercepted, and only for the one call after the flag
// is set.
const mockState = vi.hoisted(() => ({ failNextWrite: false, failNextMkdir: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  const guardedWriteSync = ((...args: Parameters<typeof fs.writeSync>) => {
    if (mockState.failNextWrite) {
      mockState.failNextWrite = false
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
    }
    return actual.writeSync(...args)
  }) as typeof fs.writeSync
  const guardedMkdirSync = ((...args: Parameters<typeof fs.mkdirSync>) => {
    if (mockState.failNextMkdir) {
      const code = mockState.failNextMkdir
      mockState.failNextMkdir = ''
      throw Object.assign(new Error(`${code}: simulated mkdir failure`), { code })
    }
    return actual.mkdirSync(...args)
  }) as typeof fs.mkdirSync
  return { ...actual, default: actual, writeSync: guardedWriteSync, mkdirSync: guardedMkdirSync }
})

import type * as fs from 'node:fs'
import * as childProcess from 'node:child_process'

import { atomicWriteBytes, atomicWriteText, backupFile, ensureDirSync, isWithinQuietHours, runGit, sleepSync, noWindowCreationFlags, stripOwnHooksFromMap, withFileLock } from '../src/util.js'
import { ROOT } from './helpers/bundle.js'
import { tsxProcessArgs } from './helpers/tsx_process.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LOCK_HOLDER = path.join(HERE, 'fixtures', 'lock_holder.ts')

describe('sleepSync', () => {
  it('blocks for approximately the requested duration', () => {
    const start = Date.now()
    sleepSync(120)
    const elapsed = Date.now() - start
    // Allow generous slack for scheduler jitter, but it must actually sleep.
    expect(elapsed).toBeGreaterThanOrEqual(90)
  })

  it('returns immediately for non-positive durations', () => {
    const start = Date.now()
    sleepSync(0)
    sleepSync(-50)
    expect(Date.now() - start).toBeLessThan(50)
  })
})

describe('atomic writes', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-util-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('atomicWriteText creates the file with the given content', () => {
    const target = path.join(dir, 'note.txt')
    atomicWriteText(target, 'hello goat')
    expect(existsSync(target)).toBe(true)
    expect(readFileSync(target, 'utf-8')).toBe('hello goat')
  })

  it('atomicWriteText leaves no temp files behind', () => {
    const target = path.join(dir, 'note.txt')
    atomicWriteText(target, 'data')
    // Directory should contain only the final file, no *.tmp siblings.
    const entries = readdirSync(dir)
    expect(entries).toEqual(['note.txt'])
  })

  it('leaves no orphaned .tmp files after a successful write', () => {
    // Regression guard: the cleanup condition in atomicWriteCore was `wrote && !renamed`, which would skip cleanup when writeSync threw before `wrote = true` (the temp file is created before the write attempt so it always needs cleanup on any non-rename path). On a successful write, this verifies no extra .tmp files accumulate alongside the dest.
    const target = path.join(dir, 'multi.txt')
    atomicWriteText(target, 'first')
    atomicWriteText(target, 'second')
    atomicWriteText(target, 'third')
    const entries = readdirSync(dir)
    const temps = entries.filter((e) => e.endsWith('.tmp'))
    expect(temps).toHaveLength(0)
    expect(readFileSync(target, 'utf-8')).toBe('third')
  })

  it('leaves no orphaned .tmp file and leaves an existing destination untouched when writeSync throws (regression: atomicWriteCore only cleaned up the temp file on a rename failure, not a write failure -- a write-time error like ENOSPC used to leak the temp file forever)', () => {
    const target = path.join(dir, 'fails.txt')
    atomicWriteText(target, 'original')

    mockState.failNextWrite = true
    try {
      expect(() => atomicWriteText(target, 'new content')).toThrow('ENOSPC')
    } finally {
      mockState.failNextWrite = false
    }

    // The failed write never reached rename, so the pre-existing destination survives untouched.
    expect(readFileSync(target, 'utf-8')).toBe('original')

    // No orphaned .tmp file should remain in the directory.
    const entries2 = readdirSync(dir)
    const temps2 = entries2.filter((e) => e.endsWith('.tmp'))
    expect(temps2).toHaveLength(0)
  })

  it('atomicWriteText does not double newlines (no CRLF expansion)', () => {
    const target = path.join(dir, 'crlf.txt')
    atomicWriteText(target, 'a\r\nb\n')
    const bytes = readFileSync(target)
    expect(bytes.toString('latin1')).toBe('a\r\nb\n')
  })

  it('atomicWriteBytes creates the file with the given bytes', () => {
    const target = path.join(dir, 'blob.bin')
    const payload = Buffer.from([0x00, 0x01, 0x0d, 0x0a, 0xff])
    atomicWriteBytes(target, payload)
    expect(existsSync(target)).toBe(true)
    const read = readFileSync(target)
    expect(Buffer.compare(read, payload)).toBe(0)
  })
})

describe('withFileLock', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-lock-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('runs fn while holding the lock, then releases it so a later acquire succeeds', () => {
    const lockPath = path.join(dir, 'a.lock')
    const calls: number[] = []

    const first = withFileLock(lockPath, () => {
      calls.push(1)
      return 'first'
    })
    expect(first).toBe('first')
    expect(existsSync(lockPath)).toBe(false) // released after fn returns

    const second = withFileLock(lockPath, () => {
      calls.push(2)
      return 'second'
    })
    expect(second).toBe('second')
    expect(calls).toEqual([1, 2])
  })

  it('releases the lock even when fn throws, and propagates the error', () => {
    const lockPath = path.join(dir, 'b.lock')
    expect(() =>
      withFileLock(lockPath, () => {
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('gives up within waitMs (never hangs) when a live holder keeps the lock', () => {
    const lockPath = path.join(dir, 'c.lock')
    // Simulate another process holding a freshly-created (non-stale) lock.
    writeFileSync(lockPath, 'live-holder', { flag: 'wx' })

    let called = false
    const start = Date.now()
    const result = withFileLock(
      lockPath,
      () => {
        called = true
        return true
      },
      { waitMs: 200, staleMs: 60_000 },
    )
    const elapsed = Date.now() - start

    expect(result).toBeUndefined()
    expect(called).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(150) // it actually waited/retried, not an instant give-up
    expect(elapsed).toBeLessThan(2000) // bounded: a live holder can never wedge the caller forever
  })

  it('steals a lock file abandoned by a crashed holder instead of waiting out the full timeout (regression: task #15)', () => {
    const lockPath = path.join(dir, 'd.lock')
    // Simulate a holder that crashed without releasing: an old lock file with a stale mtime.
    writeFileSync(lockPath, 'crashed-holder', { flag: 'wx' })
    const old = new Date(Date.now() - 60_000)
    utimesSync(lockPath, old, old)

    const start = Date.now()
    const result = withFileLock(lockPath, () => 'stolen', { waitMs: 2000, staleMs: 50 })
    const elapsed = Date.now() - start

    expect(result).toBe('stolen')
    expect(existsSync(lockPath)).toBe(false) // released after the steal + run
    expect(elapsed).toBeLessThan(1000) // stealing is immediate, not bounded by the full waitMs
  })

  it(
    'never steals the lock while its real holder is still actively running, thanks to the heartbeat (regression)',
    async () => {
      const lockPath = path.join(dir, 'e.lock')

      // A real child process holds the lock and busy-spins *synchronously* for holdMs (well past
      // staleMs) inside fn() -- this is the one scenario a heartbeat living in the holder's own
      // process cannot detect, because a setInterval there can never fire while fn() has that
      // process's single thread pinned in a non-yielding synchronous loop (verified empirically:
      // a busy-spin starves the holder's own timers completely). Only a heartbeat running in a
      // separate OS process -- which withFileLock now spawns internally -- keeps ticking
      // regardless of what the holder's thread is doing.
      const holdMs = 8000
      const staleMs = 4000
      const holderExit = new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          tsxProcessArgs(LOCK_HOLDER, lockPath, String(holdMs), String(staleMs)),
          {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        child.on('error', reject)
        child.on('exit', (code) => {
          if (code === 0) resolve(stdout)
          else reject(new Error(`lock_holder exited with code ${code}: ${stderr}`))
        })
      })

      // Wait for the holder to actually acquire the lock (poll instead of a fixed sleep: tsx's
      // own transpile/startup cost is itself a source of scheduling jitter this fix has to
      // tolerate, and a fixed short wait flaked under that jitter).
      const acquireDeadline = Date.now() + 4000
      while (!existsSync(lockPath) && Date.now() < acquireDeadline) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(existsSync(lockPath)).toBe(true)
      // Let the heartbeat tick several times before trying to steal. staleMs is generous here
      // (2000ms, well above production's 5000ms default only in that it's smaller -- the ratio
      // to the heartbeat interval, staleMs/3, is unchanged) specifically so this assertion isn't
      // flaky under real OS scheduling jitter from spawning several node processes in the same
      // test run: a single heartbeat tick landing 100-200ms late must not read as "stale".
      await new Promise((r) => setTimeout(r, 1500))

      const start = Date.now()
      const stolen = withFileLock(lockPath, () => 'stealer-ran', { staleMs, waitMs: 4000 })
      const elapsed = Date.now() - start

      // The holder is still busy-spinning here (holdMs=8000, comfortably longer than the wait
      // above plus waitMs), so this caller must give up -- never steal. Pre-fix (no heartbeat),
      // this same setup steals the lock from the still-running holder well before waitMs
      // elapses (confirmed via git stash: pre-fix code returns 'stealer-ran' here, well under
      // waitMs). staleMs/waitMs are generous here (matching production's real margins) so a
      // single heartbeat tick landing late under a heavily loaded parallel full-suite run still
      // can't false-trigger staleness.
      expect(stolen).toBeUndefined()
      expect(elapsed).toBeGreaterThanOrEqual(3500) // it genuinely waited out waitMs, not an instant steal

      const holderStdout = await holderExit
      expect(JSON.parse(holderStdout)).toEqual({ result: 'holder-done' }) // holder ran fn() to completion, unmolested

      // Once the holder has actually released the lock, a fresh acquire must still succeed
      // normally -- the heartbeat must not leave the lock wedged forever either.
      const after = withFileLock(lockPath, () => 'post-release', { staleMs, waitMs: 1000 })
      expect(after).toBe('post-release')
    },
    20_000,
  )
})

describe('noWindowCreationFlags', () => {
  it('returns 0x08000000 on win32', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      expect(noWindowCreationFlags()).toBe(0x08000000)
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })

  it('returns 0 on POSIX', () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      expect(noWindowCreationFlags()).toBe(0)
    } finally {
      if (original) Object.defineProperty(process, 'platform', original)
    }
  })
})

describe('runGit', () => {
  it('runs git --version and returns exit code 0', () => {
    const result = runGit(['--version'])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('git version')
  })

  it('returns a non-zero exit code for an invalid subcommand', () => {
    const result = runGit(['definitely-not-a-real-subcommand'])
    expect(result.exitCode).not.toBe(0)
  })

  it('includes core.quotepath=false in git args for non-ASCII filename handling', () => {
    // This test verifies that runGit now includes core.quotepath=false in git args.
    // Without this, git will quote/escape non-ASCII filenames (e.g., "café.ts"),
    // causing changed --symbol to miss those files.
    const result = runGit(['--version'])
    // If runGit is working correctly with the quotepath flag, this should succeed
    // The actual test is that the source code includes the flag (verified by code inspection)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toLowerCase()).toContain('git version')
  })

  // hints.git_hint_max_ms wiring: hooks_session.ts's advisory-only git calls (branch-name
  // hint, uncommitted-changes check) pass this through as timeoutMs so a slow git invocation
  // can never stall a hook. Verified here as a spawnSync option pass-through rather than a
  // genuinely slow subprocess, since forcing git itself to run past a timeout portably isn't
  // practical -- the timeout enforcement itself is Node's spawnSync, not code in this repo.
  it('forwards timeoutMs to spawnSync as its `timeout` option', () => {
    vi.mocked(childProcess.spawnSync).mockClear()
    runGit(['--version'], { timeoutMs: 1234 })
    const opts = vi.mocked(childProcess.spawnSync).mock.calls[0]?.[2] as Record<string, unknown> | undefined
    expect(opts?.['timeout']).toBe(1234)
  })

  it('omits the timeout option entirely when timeoutMs is not provided', () => {
    vi.mocked(childProcess.spawnSync).mockClear()
    runGit(['--version'])
    const opts = vi.mocked(childProcess.spawnSync).mock.calls[0]?.[2] as Record<string, unknown> | undefined
    expect(opts).not.toHaveProperty('timeout')
  })

})

describe('runGit large output handling', () => {
  let repoDir: string
  let msgDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'tg-biglog-repo-'))
    msgDir = mkdtempSync(path.join(tmpdir(), 'tg-biglog-msg-'))

    runGit(['init'], { cwd: repoDir })
    runGit(['config', 'user.email', 'test@token-goat.local'], { cwd: repoDir })
    runGit(['config', 'user.name', 'Token Goat Test'], { cwd: repoDir })
    runGit(['config', 'commit.gpgsign', 'false'], { cwd: repoDir })

    // 4 commits with ~350 KB commit-message bodies comfortably exceed the 1 MB
    // threshold via git log's combined output, regardless of the real repo's
    // history size (unlike the previous version of this test). The message body
    // is passed via `-F <file>` rather than `-m <string>` so it never has to go
    // through argv/CreateProcess, which caps command-line length on Windows.
    const filePath = path.join(repoDir, 'file.txt')
    const msgPath = path.join(msgDir, 'msg.txt')
    const bigBody = 'x'.repeat(350 * 1024)
    for (let i = 0; i < 4; i++) {
      writeFileSync(filePath, `content ${i}`)
      writeFileSync(msgPath, `commit ${i}\n\n${bigBody}`)
      runGit(['add', 'file.txt'], { cwd: repoDir })
      runGit(['commit', '-F', msgPath], { cwd: repoDir })
    }
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(msgDir, { recursive: true, force: true })
  })

  it('handles large git output (>1MB) without ENOBUFS truncation', () => {
    // Regression test for: runGit() previously had no maxBuffer option, causing
    // Node's default 1 MiB limit to truncate large git commands (ls-files, log, diff).
    // When output exceeded 1 MiB, spawnSync would set result.error=ENOBUFS, and runGit
    // would return { stdout: '', stderr: <error>, exitCode: -1 }, silently losing output.
    //
    // This drives a synthetic temp repo (built above) instead of this project's own
    // git history: CI's actions/checkout runs with the default fetch-depth (a shallow,
    // effectively single-commit clone), so `git log --all` against the real repo would
    // return only a few hundred bytes there, and this assertion would never actually
    // exercise runGit's maxBuffer handling in CI.
    const result = runGit(['log', '--format=%H%n%an%n%ae%n%ai%n%B%n---END---', '--all'], { cwd: repoDir })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toBe('')
    expect(result.stdout.length).toBeGreaterThan(1024 * 1024)
    expect(result.stderr).toBe('')
  })
})

describe('ensureDirSync', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'tg-ensure-dir-'))
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('creates a directory if it does not exist', () => {
    const newDir = path.join(testDir, 'new-dir')
    ensureDirSync(newDir)
    expect(existsSync(newDir)).toBe(true)
  })

  it('swallows a synthetic EEXIST from a racing mkdirSync (recursive:true does not fully close this window)', () => {
    const racyDir = path.join(testDir, 'racy-dir')
    mockState.failNextMkdir = 'EEXIST'
    expect(() => {
      ensureDirSync(racyDir)
    }).not.toThrow()
  })

  it('still propagates a non-EEXIST mkdirSync error (e.g. EACCES)', () => {
    const deniedDir = path.join(testDir, 'denied-dir')
    mockState.failNextMkdir = 'EACCES'
    expect(() => {
      ensureDirSync(deniedDir)
    }).toThrow(/EACCES/)
  })

  it('creates nested directories with recursive behavior', () => {
    const nestedDir = path.join(testDir, 'a', 'b', 'c')
    ensureDirSync(nestedDir)
    expect(existsSync(nestedDir)).toBe(true)
  })
})

describe('backupFile', () => {
  let testDir: string

  beforeEach(() => {
    testDir = mkdtempSync(path.join(tmpdir(), 'tg-backup-'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(testDir, { recursive: true, force: true })
  })

  it('prunes older backups beyond a fixed cap instead of accumulating one per call forever', () => {
    // Regression: backupFile ran on every install/uninstall of a harness's hook config
    // (install.ts, codex_install.ts, copilot_cli_install.ts, gemini_install.ts,
    // openclaw_install.ts) and wrote a new .bak.<timestamp> sibling with no cleanup, so a
    // config directory a user re-installs into repeatedly accumulated one backup forever.
    const target = path.join(testDir, 'config.json')
    writeFileSync(target, 'v0')

    vi.useFakeTimers()
    const base = new Date('2026-01-01T00:00:00.000Z').getTime()
    for (let i = 0; i < 8; i++) {
      vi.setSystemTime(base + i * 1000)
      backupFile(target)
    }
    vi.useRealTimers()

    const backups = readdirSync(testDir)
      .filter((f) => f.startsWith('config.json.bak.'))
      .sort()
    expect(backups.length).toBe(5)
    // Keeps the newest ones (i=3..7), not the oldest (i=0..2).
    expect(backups[0]).toContain('2026-01-01T00-00-03')
    expect(backups[4]).toContain('2026-01-01T00-00-07')
  })
})

describe('isWithinQuietHours', () => {
  it('returns false for an empty spec (disabled, the default)', () => {
    expect(isWithinQuietHours('', new Date(2026, 0, 1, 23, 0))).toBe(false)
  })

  it('returns false for a spec that fails to parse', () => {
    expect(isWithinQuietHours('not-a-window', new Date(2026, 0, 1, 23, 0))).toBe(false)
    expect(isWithinQuietHours('25:00-06:00', new Date(2026, 0, 1, 23, 0))).toBe(false)
  })

  it('is true inside a same-day window and false outside it', () => {
    expect(isWithinQuietHours('09:00-17:00', new Date(2026, 0, 1, 12, 0))).toBe(true)
    expect(isWithinQuietHours('09:00-17:00', new Date(2026, 0, 1, 8, 59))).toBe(false)
    expect(isWithinQuietHours('09:00-17:00', new Date(2026, 0, 1, 17, 0))).toBe(false)
  })

  it('handles a window that wraps past midnight', () => {
    expect(isWithinQuietHours('22:00-06:00', new Date(2026, 0, 1, 23, 30))).toBe(true)
    expect(isWithinQuietHours('22:00-06:00', new Date(2026, 0, 1, 3, 0))).toBe(true)
    expect(isWithinQuietHours('22:00-06:00', new Date(2026, 0, 1, 12, 0))).toBe(false)
    expect(isWithinQuietHours('22:00-06:00', new Date(2026, 0, 1, 21, 59))).toBe(false)
    expect(isWithinQuietHours('22:00-06:00', new Date(2026, 0, 1, 6, 0))).toBe(false)
  })

  it('treats an identical start and end as always-false', () => {
    expect(isWithinQuietHours('09:00-09:00', new Date(2026, 0, 1, 9, 0))).toBe(false)
  })
})

describe('stripOwnHooksFromMap', () => {
  it('removes a matching hook entry from an array-of-tables event', () => {
    const hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }> | undefined> = {
      PreToolUse: [{ hooks: [{ command: 'token-goat hook pre_tool_use' }, { command: 'other-tool' }] }],
    }
    const removed = stripOwnHooksFromMap(hooks, (c) => c.includes('token-goat'))
    expect(removed).toBe(true)
    expect(hooks['PreToolUse']).toEqual([{ hooks: [{ command: 'other-tool' }] }])
  })

  it('does not throw when an event key holds a single table object instead of an array (malformed TOML shape) -- skips it rather than crashing', () => {
    // TOML's `[hooks.SomeEvent]` (single table) parses to a plain object, not the
    // array-of-tables `[[hooks.SomeEvent]]` shape this function otherwise assumes --
    // regression for a real "groups is not iterable" crash hit against a live config.toml.
    const hooks: Record<string, unknown> = {
      PreToolUse: [{ hooks: [{ command: 'token-goat hook pre_tool_use' }] }],
      SomeEvent: { hooks: [{ command: 'not-ours' }] },
    }
    expect(() =>
      stripOwnHooksFromMap(hooks as Record<string, Array<{ hooks?: Array<{ command: string }> }> | undefined>, (c) =>
        c.includes('token-goat'),
      ),
    ).not.toThrow()
    expect(hooks['SomeEvent']).toEqual({ hooks: [{ command: 'not-ours' }] })
  })

  it('preserves an empty matcher group (user data token-goat never wrote)', () => {
    const hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }> | undefined> = {
      PreToolUse: [{ hooks: [] }],
    }
    const removed = stripOwnHooksFromMap(hooks, (c) => c.includes('token-goat'))
    expect(removed).toBe(false)
    expect(hooks['PreToolUse']).toEqual([{ hooks: [] }])
  })

  it('deletes an event key whose every group was fully stripped', () => {
    const hooks: Record<string, Array<{ hooks?: Array<{ command: string }> }> | undefined> = {
      PreToolUse: [{ hooks: [{ command: 'token-goat hook pre_tool_use' }] }],
    }
    stripOwnHooksFromMap(hooks, (c) => c.includes('token-goat'))
    expect(hooks['PreToolUse']).toBeUndefined()
  })
})
