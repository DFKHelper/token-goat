/** The data-directory copy of tg-hook is never left absent or half-made by a failed sync, and reclaiming spares another install's files. PROVENANCE: HAND-DERIVED from the contract (the failing session was a `uv_spawn ENOENT` on an empty hash directory); the EACCES shape follows tests/worker_unwritable_data_dir.test.ts. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as FsModule from 'node:fs'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  failWrite: null as ((p: string) => boolean) | null,
  failRename: null as ((from: string, to: string) => boolean) | null,
  failCopy: false,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  const refuse = (op: string, p: string): never => {
    throw Object.assign(new Error(`EACCES: permission denied, ${op} '${p}'`), { code: 'EACCES', errno: -13, syscall: op, path: p })
  }
  const writeFileSync = (...args: Parameters<typeof actual.writeFileSync>): void => {
    if (state.failWrite?.(String(args[0])) === true) refuse('open', String(args[0]))
    actual.writeFileSync(...args)
  }
  const renameSync = (from: FsModule.PathLike, to: FsModule.PathLike): void => {
    if (state.failRename?.(String(from), String(to)) === true) refuse('rename', String(to))
    actual.renameSync(from, to)
  }
  const copyFileSync = (...args: Parameters<typeof actual.copyFileSync>): void => {
    if (state.failCopy) refuse('copyfile', String(args[1]))
    actual.copyFileSync(...args)
  }
  const patched = { ...actual, writeFileSync, renameSync, copyFileSync }
  return { ...patched, default: patched }
})

import { syncNativeCopy } from '../src/native_hook.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-never-absent-'))
  state.failWrite = null
  state.failRename = null
  state.failCopy = false
})

afterEach(() => {
  state.failWrite = null
  state.failRename = null
  state.failCopy = false
  fs.rmSync(root, { recursive: true, force: true })
})

function source(bytes: string): string {
  const src = path.join(root, `src-${bytes}.exe`)
  fs.writeFileSync(src, bytes)
  return src
}

/** A tag in the shape a sync writes: a pid as 8 hex digits, then 12 random ones. */
function tagFor(pid: number): string {
  return `${pid.toString(16).padStart(8, '0')}abcdef012345`
}

function aged(file: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs)
  fs.utimesSync(file, when, when)
}

describe('a failed sync never leaves the copy absent', () => {
  it('leaves no hash directory when the staged write fails', () => {
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    state.failWrite = (p) => p.includes('tg-hook.exe')
    expect(syncNativeCopy(source('new'), dest)).toBe(false)
    expect(fs.existsSync(path.dirname(dest))).toBe(false)
  })

  it('leaves the previous copy in place when the staged write fails', () => {
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'old')
    state.failWrite = (p) => p.includes('tg-hook.exe')
    expect(syncNativeCopy(source('new'), dest)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('old')
  })

  it('puts the previous copy back when the swap and the rename restore both fail', () => {
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'old')
    // Renaming into dest fails every time, as over a running image, and so does the restore rename.
    state.failRename = (_from, to) => to === dest
    expect(syncNativeCopy(source('new'), dest)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('old')
  })

  it('says so when even the copy restore fails, and leaves no partial file at dest', () => {
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'old')
    state.failRename = (_from, to) => to === dest
    state.failCopy = true
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(syncNativeCopy(source('new'), dest)).toBe(false)
      expect(err.mock.calls.map((c) => String(c[0])).join('')).toContain('could not put the previous native hook client back')
    } finally {
      err.mockRestore()
    }
    expect(fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : 'old').toBe('old')
  })
})

describe('reclaiming leftovers', () => {
  function setup(): { dest: string; dir: string } {
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, 'old')
    return { dest, dir: path.dirname(dest) }
  }

  it('spares the files of a live pid and young files, and removes an old file of a dead pid', () => {
    const { dest, dir } = setup()
    const live = path.join(dir, `tg-hook.exe.${tagFor(900001)}.new`)
    const young = path.join(dir, `tg-hook.exe.${tagFor(900002)}.old`)
    const dead = path.join(dir, `tg-hook.exe.${tagFor(900003)}.old`)
    for (const f of [live, young, dead]) fs.writeFileSync(f, 'x')
    aged(live, 3_600_000)
    aged(dead, 3_600_000)
    const now = Date.now()
    const isAlive = (pid: number): boolean => pid === 900001
    expect(syncNativeCopy(source('new'), dest, { isAlive, now: () => now })).toBe(true)
    expect(fs.existsSync(live)).toBe(true)
    expect(fs.existsSync(young)).toBe(true)
    expect(fs.existsSync(dead)).toBe(false)
  })

  it('spares a young file of a dead pid until it is older than ten minutes', () => {
    const { dest, dir } = setup()
    const file = path.join(dir, `tg-hook.exe.${tagFor(900004)}.new`)
    fs.writeFileSync(file, 'x')
    const mtime = fs.statSync(file).mtimeMs
    expect(syncNativeCopy(source('one'), dest, { isAlive: () => false, now: () => mtime + 9 * 60_000 })).toBe(true)
    expect(fs.existsSync(file)).toBe(true)
    fs.writeFileSync(dest, 'old')
    expect(syncNativeCopy(source('two'), dest, { isAlive: () => false, now: () => mtime + 11 * 60_000 })).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })
})
