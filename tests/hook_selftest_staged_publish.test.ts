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

  it('publishes the staged bytes once the probe passes', () => {
    fs.writeFileSync(file, config('echo foreign'))
    const next = config(CURRENT)
    setHookSelftestRunnerForTesting(() => ({ status: 0, stdout: '{}\n', stderr: '' }))
    verifiedInstall([file], () => writeConfigText(file, next))
    expect(fs.readFileSync(file, 'utf8')).toBe(next)
  })
})
