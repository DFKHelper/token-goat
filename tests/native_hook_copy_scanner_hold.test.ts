/** Writing the data-dir copy of tg-hook while a scanner still holds the file just written. On Windows an antivirus or search-indexer handle opened without delete sharing makes the rename out of the staged `.new` file fail with EPERM for a moment; when no copy existed yet there was nothing to move aside, so the fallback's own rename failed with ENOENT, syncNativeCopy answered false, and install quietly wrote the Node form (seen once as a doctor 'warn' in the full suite after the copy was moved away and reinstalled). Provenance: HAND-DERIVED from the errno Node maps a Windows sharing violation on rename to (EPERM, the set util.ts withRetryOnLock retries) and from syncNativeCopy's own sequence; the hold is simulated because a scanner's timing cannot be produced on demand. */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type * as NodeFs from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'

const holds = vi.hoisted(() => ({ remaining: 0, denyDelete: false, deny: undefined as ((from: string, to: string) => boolean) | undefined, watch: undefined as string | undefined, seen: [] as boolean[] }))

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof NodeFs>()
  const renameSync = (from: fs.PathLike, to: fs.PathLike): void => {
    const held = holds.remaining > 0 && String(from).endsWith('.new')
    if (held || holds.deny?.(String(from), String(to)) === true) {
      if (held) holds.remaining--
      if (holds.watch !== undefined) holds.seen.push(original.existsSync(holds.watch))
      throw Object.assign(new Error(`EPERM: operation not permitted, rename '${String(from)}' -> '${String(to)}'`), { code: 'EPERM' })
    }
    original.renameSync(from, to)
  }
  const rmSync = (target: fs.PathLike, opts?: fs.RmOptions): void => {
    if (holds.denyDelete && String(target).endsWith('.new')) throw Object.assign(new Error(`EPERM: operation not permitted, unlink '${String(target)}'`), { code: 'EPERM' })
    original.rmSync(target, opts)
  }
  return { ...original, renameSync, rmSync, default: { ...original, renameSync, rmSync } }
})

import { syncNativeCopy } from '../src/native_hook.js'

let root: string | undefined

afterEach(() => {
  holds.remaining = 0
  holds.denyDelete = false
  holds.deny = undefined
  holds.watch = undefined
  holds.seen = []
  if (root !== undefined) fs.rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('syncNativeCopy under a scanner hold on the staged file', () => {
  it('outwaits the hold when no copy exists yet, instead of reporting the copy unusable', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    holds.remaining = 2
    expect(syncNativeCopy(src, dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary-v1')
    expect(holds.remaining).toBe(0)
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['tg-hook.exe'])
  })

  it('outwaits the hold when an older copy is in place', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    expect(syncNativeCopy(src, dest)).toBe(true)
    fs.writeFileSync(src, 'binary-v2')
    holds.remaining = 2
    expect(syncNativeCopy(src, dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary-v2')
  })

  it('leaves the older copy in place for as long as the hold lasts', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    expect(syncNativeCopy(src, dest)).toBe(true)
    fs.writeFileSync(src, 'binary-v2')
    holds.remaining = 4
    holds.watch = dest
    expect(syncNativeCopy(src, dest)).toBe(true)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary-v2')
    expect(holds.seen).toEqual([true, true, true, true])
  })
})

// A hold that outlasts every retry, with the scanner also refusing the delete of the staged file (EPERM from rmSync, which `force` does not suppress): install must fall back to the Node command, not throw out of nativeHookBinary, and must not leave hooks naming a copy that was moved aside.
describe('syncNativeCopy when the scanner hold outlasts the retries', () => {
  it('answers false instead of throwing when no copy exists yet', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    holds.remaining = 100
    holds.denyDelete = true
    expect(syncNativeCopy(src, dest)).toBe(false)
    expect(fs.existsSync(dest)).toBe(false)
  })

  it('leaves the older copy where hooks already name it when the new copy cannot be readied', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    expect(syncNativeCopy(src, dest)).toBe(true)
    fs.writeFileSync(src, 'binary-v2')
    holds.remaining = 100
    holds.denyDelete = true
    expect(syncNativeCopy(src, dest)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary-v1')
    expect(fs.readdirSync(path.dirname(dest)).filter((n) => n.endsWith('.old'))).toEqual([])
  })

  it('puts the older copy back even when the first attempts to restore it are refused', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-native-hold-'))
    const src = path.join(root, 'tg-hook.exe')
    const dest = path.join(root, 'native', 'abc', 'tg-hook.exe')
    fs.writeFileSync(src, 'binary-v1')
    expect(syncNativeCopy(src, dest)).toBe(true)
    fs.writeFileSync(src, 'binary-v2')
    let restoreRefusals = 2
    holds.deny = (from, to) => to === dest && (from.endsWith('.new') || (from.endsWith('.old') && restoreRefusals-- > 0))
    expect(syncNativeCopy(src, dest)).toBe(false)
    expect(fs.readFileSync(dest, 'utf8')).toBe('binary-v1')
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['tg-hook.exe'])
  })
})
