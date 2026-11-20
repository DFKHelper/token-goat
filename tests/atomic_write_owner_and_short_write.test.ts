import { chownSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { atomicWriteText } from '../src/util.js'

const isRoot = process.platform !== 'win32' && process.getuid?.() === 0

// PROVENANCE: HAND-DERIVED. Only root may give a file to another uid, so the real chown path runs only there.
describe('atomicWriteText keeps the destination owner', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-owner-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!isRoot)('replaces a file owned by another uid without changing its owner (needs root)', () => {
    const target = path.join(dir, 'other.txt')
    writeFileSync(target, 'old')
    chownSync(target, 54321, 54322)
    atomicWriteText(target, 'new')
    const st = statSync(target)
    expect([st.uid, st.gid]).toEqual([54321, 54322])
    expect(readFileSync(target, 'utf-8')).toBe('new')
  })
})
