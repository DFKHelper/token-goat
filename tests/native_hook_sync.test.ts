/** syncNativeCopy hash dir: 0700; a failed sync removes only a dir it made. HAND-DERIVED from finish(). */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeFs from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { syncNativeCopy } from '../src/native_hook.js'

const WIN = process.platform === 'win32'
const failRename = vi.hoisted(() => ({ on: false }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>()
  const renameSync = ((...args: Parameters<typeof real.renameSync>) => {
    if (failRename.on) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
    return real.renameSync(...args)
  }) as typeof real.renameSync
  return { ...real, renameSync }
})

let root: string
let src: string
let dir: string
let dest: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-sync-'))
  src = path.join(root, 'tg-hook')
  fs.writeFileSync(src, 'plain bytes standing in for the native client')
  dir = path.join(root, 'native', 'abc')
  dest = path.join(dir, 'tg-hook')
})

afterEach(() => {
  failRename.on = false
  fs.rmSync(root, { recursive: true, force: true })
})

describe('syncNativeCopy hash directory', () => {
  it('copies into a new hash directory and reports success', () => {
    expect(syncNativeCopy(src, dest)).toBe(true)
    expect(fs.readFileSync(dest).equals(fs.readFileSync(src))).toBe(true)
  })

  it.skipIf(WIN)('creates the new hash directory owner-only (POSIX mode 0700)', () => {
    expect(syncNativeCopy(src, dest)).toBe(true)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })

  it('a failed sync removes the hash directory it created', () => {
    failRename.on = true
    expect(syncNativeCopy(src, dest)).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('a failed sync keeps a hash directory that already existed', () => {
    fs.mkdirSync(dir, { recursive: true })
    failRename.on = true
    expect(syncNativeCopy(src, dest)).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
  })
})
