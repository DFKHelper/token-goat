// Provenance: HAND-DERIVED. Made-up stat values held fixed; the expectations follow from the racy rule.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { setCopilotHostConfigClockForTesting, skillDirectories } from '../src/copilot_host_config.js'
import { clearModuleCaches } from '../src/reset.js'

const FILE_TIME = 1_000_000
let userRoot: string
let settingsPath: string

function write(name: string): void {
  fs.writeFileSync(settingsPath, JSON.stringify({ skillDirectories: [name] }), 'utf8')
}

/** A stat whose five cache fields are held fixed, whatever the file really holds; `bump` moves mtime. */
function fixedStat(bump = 0): fs.Stats {
  const fields = { mtimeMs: FILE_TIME + bump, ctimeMs: FILE_TIME, ino: 7, dev: 9, size: 40 }
  return { isFile: () => true, ...fields } as fs.Stats
}

function settingsReads(read: { mock: { calls: unknown[][] } }): number {
  return read.mock.calls.filter((c) => String(c[0]) === settingsPath).length
}

beforeEach(() => {
  userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-copilot-cache-'))
  settingsPath = path.join(userRoot, 'settings.json')
  clearModuleCaches()
})

afterEach(() => {
  vi.restoreAllMocks()
  setCopilotHostConfigClockForTesting(null)
  fs.rmSync(userRoot, { recursive: true, force: true })
})

describe('the Copilot settings cache and the racy-timestamp rule', () => {
  it('re-reads a same-size rewrite whose file time equals the clock, with every stat field held equal', () => {
    write('same-size-a')
    vi.spyOn(fs, 'statSync').mockImplementation(() => fixedStat())
    setCopilotHostConfigClockForTesting(() => FILE_TIME)
    expect(skillDirectories(userRoot)).toEqual(['same-size-a'])
    write('same-size-b')
    expect(skillDirectories(userRoot)).toEqual(['same-size-b'])
  })

  it('serves an old unchanged file from the cache with one stat and no read', () => {
    write('steady')
    setCopilotHostConfigClockForTesting(() => FILE_TIME + 1_000_000)
    const stat = vi.spyOn(fs, 'statSync').mockImplementation(() => fixedStat())
    const read = vi.spyOn(fs, 'readFileSync')
    expect(skillDirectories(userRoot)).toEqual(['steady'])
    expect(settingsReads(read)).toBe(1)
    const statsBefore = stat.mock.calls.length
    expect(skillDirectories(userRoot)).toEqual(['steady'])
    expect(settingsReads(read), 'the second call reads nothing').toBe(1)
    expect(stat.mock.calls.length - statsBefore, 'the second call costs one stat').toBe(1)
  })

  it('does not cache a result when the file changed between the stat and the read', () => {
    write('first')
    setCopilotHostConfigClockForTesting(() => FILE_TIME + 1_000_000)
    let calls = 0
    vi.spyOn(fs, 'statSync').mockImplementation(() => fixedStat(calls++ === 1 ? 1 : 0))
    const read = vi.spyOn(fs, 'readFileSync')
    expect(skillDirectories(userRoot)).toEqual(['first'])
    write('second')
    expect(skillDirectories(userRoot)).toEqual(['second'])
    expect(settingsReads(read)).toBe(2)
  })

  it('answers a missing file and an unreadable file with no directories', () => {
    expect(skillDirectories(userRoot)).toEqual([])
    fs.writeFileSync(settingsPath, '{ not json', 'utf8')
    expect(skillDirectories(userRoot)).toEqual([])
  })
})
