import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizePath, safeJoin } from '../src/paths.js'

describe('safeJoin', () => {
  it('joins normally when no part contains a colon', () => {
    const result = safeJoin('base', 'sub', 'file.txt')
    expect(result).toBe(path.join('base', 'sub', 'file.txt'))
  })

  it('throws when any part contains a colon (drive-letter escape)', () => {
    expect(() => safeJoin('base', 'C:/evil')).toThrow(/colon/)
  })

  it('throws when a colon appears in a later part', () => {
    expect(() => safeJoin('base', 'ok', 'bad:stream')).toThrow(/colon/)
  })

  it('throws on an NTFS-stream-style colon fragment', () => {
    expect(() => safeJoin('base', 'file.txt:zone.identifier')).toThrow(/colon/)
  })

  it('works with zero extra parts', () => {
    expect(safeJoin('base')).toBe(path.join('base'))
  })
})

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('foo\\bar\\baz')).toBe('foo/bar/baz')
  })

  it('lowercases an uppercase drive-letter prefix', () => {
    expect(normalizePath('C:\\foo\\bar')).toBe('c:/foo/bar')
  })

  it('leaves an already-lowercase forward-slash path unchanged', () => {
    expect(normalizePath('c:/foo/bar')).toBe('c:/foo/bar')
  })

  it('converts a WSL /mnt path to Windows drive form', () => {
    expect(normalizePath('/mnt/c/foo/bar')).toBe('c:/foo/bar')
  })

  it('lowercases the WSL drive letter and collapses leading slashes', () => {
    expect(normalizePath('/mnt/C///bar')).toBe('c:/bar')
  })

  it('leaves a plain POSIX path unchanged', () => {
    expect(normalizePath('/home/user/project')).toBe('/home/user/project')
  })

  it('normalizes mixed-separator WSL paths fully', () => {
    expect(normalizePath('/mnt/c/foo\\bar')).toBe('c:/foo/bar')
  })
})
