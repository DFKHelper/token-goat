// Provenance: HAND-DERIVED for the rule that a git ended by a signal reads as unknown (exit -1), never as exit 1; the rule is the repo's empty-evidence-is-unknown rule in src/types.ts GitResult. The signal shape is FORMAT-DERIVED from Node's child_process contract (a child ended by a signal has a null status and a signal name), read from memory and NOT verified this run: unverified here. Measured this run on win32 (node 24.22.1, Windows 11): a child that sent itself SIGKILL reported status 1 and signal null, so the win32 row supplies the signal-ended shape at the spawnSync boundary while the real git still runs, and the POSIX rows (skipped on win32) use a real git stand-in that kills itself with SIGKILL. The POSIX rows have not been run on a POSIX host by this change: unverified until CI's Linux and macOS legs run them.
import type * as ChildProcessModule from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readScopeDir } from '../src/inline_grep_scan.js'
import { runGitAsync } from '../src/git_async.js'
import { runGit } from '../src/util.js'

const killing = vi.hoisted(() => ({ signal: null as string | null }))

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof ChildProcessModule>()
  const passThrough = real.spawnSync as (...args: unknown[]) => ReturnType<typeof real.spawnSync>
  const spawnSync = ((file: string, ...rest: unknown[]) => {
    const result = passThrough(file, ...rest)
    if (killing.signal === null || !/(^|[\\/])git(\.exe)?$/i.test(file)) return result
    const signal = killing.signal
    killing.signal = null
    return { ...result, status: null, signal }
  }) as typeof real.spawnSync
  return { ...real, spawnSync }
})

let repo = ''
let stand = ''
const savedPath = process.env['PATH']

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'tg-signal-killed-'))
  stand = mkdtempSync(path.join(os.tmpdir(), 'tg-signal-stand-'))
  expect(runGit(['init', '-q'], { cwd: repo }).exitCode).toBe(0)
})

afterEach(() => {
  try {
    killing.signal = null
    process.env['PATH'] = savedPath
  } finally {
    rmSync(repo, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
    rmSync(stand, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

/** Puts a `git` first on PATH that sends itself SIGKILL, so the real spawn of git ends by a signal. Only POSIX reaches a signal-ended child. */
function gitThatKillsItself(): void {
  const file = path.join(stand, 'git')
  writeFileSync(file, '#!/bin/sh\nkill -KILL $$\n')
  chmodSync(file, 0o755)
  process.env['PATH'] = `${stand}${path.delimiter}${savedPath ?? ''}`
}

describe('runGit with a git that is killed by a signal', () => {
  it('reads the killed git as unknown, exit -1, never as exit 1', () => {
    killing.signal = 'SIGKILL'
    const result = runGit(['rev-parse', '--git-dir'], { cwd: repo })
    expect(result.exitCode, JSON.stringify(result)).toBe(-1)
    expect(result.signal).toBe('SIGKILL')
    expect(result.stdout).toBe('')
    expect(result.timedOut).toBeUndefined()
  })

  it('returns a git that finishes unchanged, with its exit code and output and no signal', () => {
    const result = runGit(['rev-parse', '--git-dir'], { cwd: repo })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe('.git')
    expect(result.signal).toBeUndefined()
  })
})

describe('readScopeDir with a check-ignore that is killed by a signal', () => {
  it('gives a passReason and never a listing when check-ignore is killed', () => {
    writeFileSync(path.join(repo, 'mod.py'), 'x = 1\n')
    killing.signal = 'SIGKILL'
    const read = readScopeDir(repo, repo, { git: runGit })
    expect(read).toEqual({ passReason: 'the scope is ignored or not in a git work tree' })
  })
})

describe.skipIf(process.platform === 'win32')('a real git that ends by SIGKILL on POSIX', () => {
  it('runGit reads it as unknown, exit -1, with the signal named', () => {
    gitThatKillsItself()
    const result = runGit(['status'], { cwd: repo })
    expect(result.exitCode, JSON.stringify(result)).toBe(-1)
    expect(result.signal).toBe('SIGKILL')
  })

  it('runGitAsync reads it as unknown, exit -1, with the signal named', async () => {
    gitThatKillsItself()
    const result = await runGitAsync(['status'], { cwd: repo })
    expect(result.exitCode, JSON.stringify(result)).toBe(-1)
    expect(result.signal).toBe('SIGKILL')
    expect(result.timedOut).toBeUndefined()
  })
})
