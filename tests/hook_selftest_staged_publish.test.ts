// Fixture provenance: HAND-DERIVED; config texts are built here, the guard prefix follows hook_guard.ts.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildGuardedCommand } from '../src/hook_guard.js'
import { HookSelftestError, setHookSelftestRunnerForTesting, verifiedInstall } from '../src/hook_selftest.js'
import { writeConfigText, writeIfDifferent } from '../src/util.js'

let dir: string
let file: string

const config = (command: string): string => JSON.stringify({ hooks: [command] }, null, 2) + '\n'
const CURRENT = buildGuardedCommand({
  shell: 'sh', native: ['/x/tg-hook', 'hook'], safe: '{}', marker: '/x/marker',
})

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-selftest-staged-'))
  file = path.join(dir, 'config.json')
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(() => {
  vi.restoreAllMocks()
  setHookSelftestRunnerForTesting(undefined)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('verifiedInstall probes the commands before it publishes them', () => {
  it('holds the old bytes on disk while the probe runs, and keeps them when it fails', () => {
    const before = config('echo foreign')
    fs.writeFileSync(file, before)
    const seen: string[] = []
    setHookSelftestRunnerForTesting(() => {
      seen.push(fs.readFileSync(file, 'utf8'))
      return { status: 3, stdout: '', stderr: 'boom' }
    })
    expect(() => verifiedInstall([file], () => writeConfigText(file, config(CURRENT))))
      .toThrow(HookSelftestError)
    expect(seen.length, 'the probe never ran').toBeGreaterThan(0)
    expect(seen.every((s) => s === before), 'the config was published before it was probed').toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('never creates the file when the probe of a new config fails', () => {
    setHookSelftestRunnerForTesting(() => {
      expect(fs.existsSync(file), 'the new config was published before it was probed').toBe(false)
      return { status: 3, stdout: '', stderr: 'boom' }
    })
    expect(() => verifiedInstall([file], () => writeIfDifferent(file, config(CURRENT))))
      .toThrow(HookSelftestError)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('leaves a second writer\'s bytes when the probe fails after it changed the config', () => {
    fs.writeFileSync(file, config('echo foreign'))
    const other = config('echo second install')
    setHookSelftestRunnerForTesting(() => {
      fs.writeFileSync(file, other)
      return { status: 3, stdout: '', stderr: 'boom' }
    })
    expect(() => verifiedInstall([file], () => writeConfigText(file, config(CURRENT))))
      .toThrow(HookSelftestError)
    expect(fs.readFileSync(file, 'utf8')).toBe(other)
  })

  it('does not roll back over a second writer when a directly written config fails its probe', () => {
    fs.writeFileSync(file, config('echo foreign'))
    const other = config('echo second install')
    setHookSelftestRunnerForTesting(() => {
      fs.writeFileSync(file, other)
      return { status: 3, stdout: '', stderr: 'boom' }
    })
    // A plain fs write is not held back, so the rollback path is the one under test.
    expect(() => verifiedInstall([file], () => fs.writeFileSync(file, config(CURRENT))))
      .toThrow(HookSelftestError)
    expect(fs.readFileSync(file, 'utf8'), 'the rollback overwrote the second writer').toBe(other)
  })

  it('restores the old bytes when a directly written config fails its probe and nobody else wrote', () => {
    const before = config('echo foreign')
    fs.writeFileSync(file, before)
    setHookSelftestRunnerForTesting(() => ({ status: 3, stdout: '', stderr: 'boom' }))
    expect(() => verifiedInstall([file], () => fs.writeFileSync(file, config(CURRENT))))
      .toThrow(HookSelftestError)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  // Adds this install's command to whatever hooks the file holds right now, the way a real installer merges.
  const mergeInstall = (): void => {
    const cur: { hooks: string[] } = fs.existsSync(file)
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: string[] })
      : { hooks: [] }
    if (!cur.hooks.includes(CURRENT)) cur.hooks.push(CURRENT)
    writeConfigText(file, JSON.stringify(cur, null, 2) + '\n')
  }
  const hooksOf = (): string[] => (JSON.parse(fs.readFileSync(file, 'utf8')) as { hooks: string[] }).hooks

  it('keeps a second writer\'s change made during a passing probe and still installs its own hooks', () => {
    fs.writeFileSync(file, config('echo foreign'))
    let probes = 0
    setHookSelftestRunnerForTesting(() => {
      probes += 1
      const second = JSON.stringify({ hooks: ['echo foreign', 'echo second'] }) + '\n'
      if (probes === 1) fs.writeFileSync(file, second)
      return { status: 0, stdout: '{}\n', stderr: '' }
    })
    verifiedInstall([file], mergeInstall)
    expect(probes, 'the install was not probed again against the changed config').toBeGreaterThan(1)
    expect(hooksOf(), 'the second writer\'s content or this install\'s hooks are missing')
      .toEqual(['echo foreign', 'echo second', CURRENT])
  })

  it('refuses after three rounds when the config changes during every probe, and writes nothing', () => {
    fs.writeFileSync(file, config('echo foreign'))
    let probes = 0
    let last = ''
    setHookSelftestRunnerForTesting(() => {
      probes += 1
      last = JSON.stringify({ hooks: ['echo foreign', `echo writer ${String(probes)}`] }, null, 2) + '\n'
      fs.writeFileSync(file, last)
      return { status: 0, stdout: '{}\n', stderr: '' }
    })
    expect(() => verifiedInstall([file], mergeInstall)).toThrow(new RegExp(`${path.basename(file)}.*changed`))
    expect(fs.readFileSync(file, 'utf8'), 'the install overwrote the last writer').toBe(last)
  })

  it('publishes the staged bytes once the probe passes', () => {
    fs.writeFileSync(file, config('echo foreign'))
    const next = config(CURRENT)
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}\n', stderr: '' }))
    verifiedInstall([file], () => writeConfigText(file, next))
    expect(fs.readFileSync(file, 'utf8')).toBe(next)
  })
})
