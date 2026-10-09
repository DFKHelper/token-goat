/** The shared System32 lookup (src/windows_system32.ts) that the registry policy read and the PowerShell launcher both use. */
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { windowsSystem32Exe } from '../src/windows_system32.js'

const saved = { SystemRoot: process.env['SystemRoot'], windir: process.env['windir'] }
const roots: string[] = []

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

// HAND-DERIVED: a throwaway Windows folder that does or does not hold System32/reg.exe; the attack is a relative SystemRoot or windir (for example ".") that would resolve a bare or cwd-relative executable.
const fakeWindows = (withExe: boolean): string => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-sys32-'))
  roots.push(root)
  fs.mkdirSync(path.join(root, 'System32'), { recursive: true })
  if (withExe) fs.writeFileSync(path.join(root, 'System32', 'reg.exe'), '')
  return root
}

describe('windowsSystem32Exe', () => {
  it('names the file under SystemRoot when it holds it', () => {
    const root = fakeWindows(true)
    process.env['SystemRoot'] = root
    expect(windowsSystem32Exe('reg.exe')).toBe(path.join(root, 'System32', 'reg.exe'))
  })

  it('passes over a SystemRoot that does not hold the file to windir', () => {
    const empty = fakeWindows(false)
    const full = fakeWindows(true)
    process.env['SystemRoot'] = empty
    process.env['windir'] = full
    expect(windowsSystem32Exe('reg.exe')).toBe(path.join(full, 'System32', 'reg.exe'))
  })

  it('ignores a relative SystemRoot and windir even when a planted file sits where they point', () => {
    const planted = fakeWindows(true)
    const here = process.cwd()
    try {
      process.chdir(planted)
      process.env['SystemRoot'] = '.'
      process.env['windir'] = ''
      const got = windowsSystem32Exe('reg.exe')
      expect(path.win32.isAbsolute(got), 'a relative answer resolves against the working directory').toBe(true)
      expect(got.startsWith(planted)).toBe(false)
    } finally {
      process.chdir(here)
    }
  })

  it('answers an absolute C:\\Windows path, never a bare name, when no folder holds the file', () => {
    process.env['SystemRoot'] = fakeWindows(false)
    delete process.env['windir']
    const got = windowsSystem32Exe('nosuch.exe')
    expect(path.win32.isAbsolute(got)).toBe(true)
    expect(got).toBe(path.join('C:\\Windows', 'System32', 'nosuch.exe'))
  })

  // HAND-DERIVED: spawning a path that holds no file reports ENOENT with a null status, which the registry read treats as unreadable (fail closed) instead of finding another reg on PATH.
  it('names a file a spawn fails on when none exists, rather than one PATH or the working directory could supply', () => {
    process.env['SystemRoot'] = fakeWindows(false)
    delete process.env['windir']
    const res = spawnSync(windowsSystem32Exe('nosuch.exe'), [], { encoding: 'utf8', windowsHide: true })
    expect(res.status).toBeNull()
    expect((res.error as NodeJS.ErrnoException).code).toBe('ENOENT')
  })
})
