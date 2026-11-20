// Fixture provenance: HAND-DERIVED; link and target are written here, the owner is faked via getuid.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { atomicWriteBytes } from '../src/util.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-foreign-link-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(TMP, { recursive: true, force: true })
})

// getuid is POSIX only; root-owned links are followed by design, so a root account cannot fake a stranger.
const canFake = process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

describe('atomicWriteBytes over a link another user owns', () => {
  it.skipIf(!canFake)('refuses before any write, leaving link, target and directory (posix only)', () => {
    const target = path.join(TMP, 'target.txt')
    const link = path.join(TMP, 'link.txt')
    fs.writeFileSync(target, 'earlier')
    fs.symlinkSync(target, link)
    const before = fs.readdirSync(TMP).sort()
    const mine = process.getuid!()
    vi.spyOn(process, 'getuid').mockReturnValue(mine + 1)
    expect(() => atomicWriteBytes(link, Buffer.from('new'))).toThrow(/refusing to write .*another user/)
    expect(fs.lstatSync(link).isSymbolicLink(), 'the link was replaced by a file').toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('earlier')
    expect(fs.readdirSync(TMP).sort(), 'a temp file or other entry was left').toEqual(before)
  })

  it.skipIf(!canFake)('still follows a link its own user owns (posix only)', () => {
    const target = path.join(TMP, 'target.txt')
    const link = path.join(TMP, 'link.txt')
    fs.writeFileSync(target, 'earlier')
    fs.symlinkSync(target, link)
    atomicWriteBytes(link, Buffer.from('new'))
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
  })
})
