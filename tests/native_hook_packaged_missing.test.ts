import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { nativeHookBinary } from '../src/native_hook.js'

// Mirrors NATIVE_TARGETS in src/native_hook.ts (not exported): the platforms that ship a packaged binary.
const PACKAGED_TARGETS = ['win32-x64', 'win32-arm64', 'linux-x64', 'linux-arm64']
const supported = PACKAGED_TARGETS.includes(`${process.platform}-${process.arch}`)
let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-missing-'))
  vi.stubEnv('TOKEN_GOAT_NATIVE_HOOKS', '1')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  fs.rmSync(TMP, { recursive: true, force: true })
})

function bundleIn(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  const entry = path.join(dir, 'token-goat.mjs')
  fs.writeFileSync(entry, '')
  return entry
}

describe('nativeHookBinary with no packaged binary beside the bundle', () => {
  it.skipIf(!supported)('names the missing packaged path and the build command on stderr, and answers undefined', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const entry = bundleIn(path.join(TMP, 'dist'))
    expect(nativeHookBinary(entry, { sync: true })).toBeUndefined()
    const text = write.mock.calls.map((call) => String(call[0])).join('')
    expect(text).toContain(path.join(path.dirname(entry), 'native', `${process.platform}-${process.arch}`))
    expect(text).toContain('npm run build:native')
  })

  it.skipIf(!supported)('stays silent for the read-only doctor probe (sync false)', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const entry = bundleIn(path.join(TMP, 'probe'))
    expect(nativeHookBinary(entry, { sync: false })).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })

  it.skipIf(supported)('stays silent on a platform that ships no packaged binary', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const entry = bundleIn(path.join(TMP, 'unsupported'))
    expect(nativeHookBinary(entry, { sync: true })).toBeUndefined()
    expect(write).not.toHaveBeenCalled()
  })
})
