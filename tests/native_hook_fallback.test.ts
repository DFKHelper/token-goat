/** What an install does when the native hook client cannot be put in place or fails to answer its self-test once: it tries again before settling for the Node form, and when it does settle it says why on stderr. The function under test is nativeHookBinary, the one decision every installer (Claude Code, Codex, Grok, Kimi, Copilot CLI) calls. Fixtures: the lock failure is a thrown EPERM on a rename of a staged file, which is the errno a Windows scanner hold produces (FORMAT-DERIVED, node fs error codes, https://nodejs.org/api/errors.html#common-system-errors); the self-test outcome is the shape spawnSync returns for a child that did not answer in time (FORMAT-DERIVED, https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options: error.code ETIMEDOUT, status null) and for one that exited 1 (HAND-DERIVED). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeFs from 'node:fs'
import type * as NodeChildProcess from 'node:child_process'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({ renames: 0, selftests: [] as Array<'timeout' | 'exit1' | 'ok'>, calls: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  const renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    if (faults.renames > 0 && String(from).endsWith('.new')) {
      faults.renames--
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM' })
    }
    original.renameSync(from, to)
  }
  return { ...original, renameSync, default: { ...original, renameSync } }
})

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof NodeChildProcess>()
  const spawnSync = ((cmd: string, args: readonly string[], opts: object) => {
    if (args[0] !== '--selftest') return original.spawnSync(cmd, args, opts)
    faults.calls++
    const next = faults.selftests.shift() ?? 'ok'
    if (next === 'timeout') return { status: null, signal: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: '', stderr: '' }
    return { status: next === 'ok' ? 0 : 1, signal: null, stdout: '', stderr: '' }
  }) as typeof original.spawnSync
  return { ...original, spawnSync, default: { ...original, spawnSync } }
})

import { nativeHookBinary } from '../src/native_hook.js'
import { clearModuleCaches } from '../src/reset.js'

const TARGET = `${process.platform}-${process.arch}`
const NATIVE = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64'].includes(TARGET)
const WIN = process.platform === 'win32'

let root: string
let entry: string
let stderr: string[]

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-fallback-'))
  entry = path.join(root, 'dist', 'token-goat.mjs')
  const bin = path.join(root, 'dist', 'native', TARGET, WIN ? 'tg-hook.exe' : 'tg-hook')
  fs.mkdirSync(path.dirname(bin), { recursive: true })
  fs.writeFileSync(bin, 'binary-v1')
  fs.writeFileSync(entry, '')
  vi.stubEnv('TOKEN_GOAT_NATIVE_HOOKS', '1')
  faults.renames = 0
  faults.selftests = []
  faults.calls = 0
  stderr = []
  clearModuleCaches()
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr.push(String(chunk))
    return true
  }) as typeof process.stderr.write)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  clearModuleCaches()
  fs.rmSync(root, { recursive: true, force: true })
})

describe.runIf(NATIVE)('nativeHookBinary when the first attempt fails for a transient reason', () => {
  it('wires the native client when the first self-test gets no answer and the second does', () => {
    faults.selftests = ['timeout', 'ok']
    expect(nativeHookBinary(entry)).toBeDefined()
    expect(faults.calls).toBe(2)
    expect(stderr.join('')).toBe('')
  })

  it('writes the Node form and says why on stderr when the self-test gets no answer twice', () => {
    faults.selftests = ['timeout', 'timeout']
    expect(nativeHookBinary(entry)).toBeUndefined()
    expect(faults.calls).toBe(2)
    const note = stderr.join('')
    expect(note).toContain('wrote the Node form of the hooks')
    expect(note).toContain('no answer within')
    expect(note).toContain('token-goat doctor --repair')
  })

  it('does not run a binary again that ran and failed', () => {
    faults.selftests = ['exit1', 'ok']
    expect(nativeHookBinary(entry)).toBeUndefined()
    expect(faults.calls).toBe(1)
    expect(stderr.join('')).toContain('exit code 1')
  })

  it('stays quiet for a build that ships no native client', () => {
    fs.rmSync(path.join(root, 'dist', 'native'), { recursive: true })
    expect(nativeHookBinary(entry)).toBeUndefined()
    expect(stderr.join('')).toBe('')
  })

  it('does not write to stderr when doctor asks without syncing', () => {
    faults.selftests = ['timeout', 'timeout']
    expect(nativeHookBinary(entry, { sync: false })).toBeUndefined()
    expect(stderr.join('')).toBe('')
  })

  it.runIf(WIN)('puts the copy in place on a second attempt when a scanner held the first past the lock retries', () => {
    faults.renames = 6
    expect(nativeHookBinary(entry)).toBeDefined()
    expect(faults.renames).toBe(0)
    expect(stderr.join('')).toBe('')
  })

  it.runIf(WIN)('writes the Node form and names the held copy when the lock outlasts both attempts', () => {
    faults.renames = 1000
    expect(nativeHookBinary(entry)).toBeUndefined()
    const note = stderr.join('')
    expect(note).toContain('could not be put in place')
    expect(note).toContain('token-goat doctor --repair')
  })
})
