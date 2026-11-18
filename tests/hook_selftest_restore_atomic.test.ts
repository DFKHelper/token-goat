// Fixture provenance: HAND-DERIVED; config texts are built here, the guard prefix follows hook_guard.ts.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const writes: string[] = []
const failing = { on: false }

vi.mock('../src/util.js', async (importOriginal) => {
  const real: Record<string, unknown> & { atomicWriteBytes: (f: string, c: Buffer | Uint8Array) => void } =
    await importOriginal()
  return {
    ...real,
    atomicWriteBytes: (file: string, content: Buffer | Uint8Array): void => {
      writes.push(file)
      // A write dying part-way: the real one fills a temp file, then renames, so the target is untouched.
      if (failing.on) throw new Error('disk full')
      real.atomicWriteBytes(file, content)
    },
  }
})

import { buildGuardedCommand } from '../src/hook_guard.js'
import { HookSelftestError, setHookSelftestRunnerForTesting, verifiedInstall } from '../src/hook_selftest.js'

let dir: string
let file: string

const config = (command: string): string => JSON.stringify({ hooks: [command] }, null, 2) + '\n'
/** A guarded command of this build's version that the stubbed runner can refuse. */
const CURRENT = buildGuardedCommand({
  shell: 'sh',
  native: ['/x/tg-hook', 'hook'],
  safe: '{}',
  marker: '/x/marker',
})
/** A guarded command a newer build wrote. */
const NEWER = ': tg-guard-v2; true'

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-restore-'))
  file = path.join(dir, 'settings.json')
  writes.length = 0
  failing.on = false
})

afterEach(() => {
  setHookSelftestRunnerForTesting(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('verifiedInstall restores the file it rolls back with an atomic write', () => {
  it('restores a refused install through atomicWriteBytes and leaves the old bytes', () => {
    const before = config('echo foreign')
    fs.writeFileSync(file, before)
    setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
    const refused = (): void => verifiedInstall([file], () => fs.writeFileSync(file, config(CURRENT)))
    expect(refused).toThrow(HookSelftestError)
    expect(writes).toEqual([file])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(fs.readdirSync(dir)).toEqual(['settings.json'])
  })

  it('a restore that fails part-way after a refused install leaves the file as it was, not truncated', () => {
    const before = config('echo foreign')
    const written = config(CURRENT)
    fs.writeFileSync(file, before)
    setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
    failing.on = true
    expect(() => verifiedInstall([file], () => fs.writeFileSync(file, written))).toThrow('disk full')
    expect(writes, 'the restore did not go through atomicWriteBytes').toEqual([file])
    expect(fs.readFileSync(file, 'utf8')).toBe(written)
  })

  it('puts back what a newer build wrote through atomicWriteBytes', () => {
    const newer = config(NEWER)
    fs.writeFileSync(file, newer)
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      verifiedInstall([file], () => fs.writeFileSync(file, config('echo changed')))
    } finally {
      vi.restoreAllMocks()
    }
    expect(writes).toEqual([file])
    expect(fs.readFileSync(file, 'utf8')).toBe(newer)
  })

  it('a newer-guard restore that fails part-way leaves the file as the install wrote it', () => {
    fs.writeFileSync(file, config(NEWER))
    const changed = config('echo changed')
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    failing.on = true
    try {
      expect(() => verifiedInstall([file], () => fs.writeFileSync(file, changed))).toThrow('disk full')
    } finally {
      vi.restoreAllMocks()
    }
    expect(writes, 'the restore did not go through atomicWriteBytes').toEqual([file])
    expect(fs.readFileSync(file, 'utf8')).toBe(changed)
  })
})
