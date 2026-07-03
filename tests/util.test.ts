import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

import { atomicWriteBytes, atomicWriteText, ensureDirSync, runGit, sleepSync, noWindowCreationFlags, withFileLock } from '../src/util.js'

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
