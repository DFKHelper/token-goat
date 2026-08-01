/**
 * Policy tests for the non-git walk-index fallback (`token-goat index --walk`).
 *
 * Covers the three guards that replace what `git ls-files` gives for free:
 * over-broad-root refusal, the file-count ceiling, and .env / generated-file
 * exclusion. The end-to-end "a symbol resolves after --walk" path is exercised
 * against the built bundle in worker_index_e2e.test.ts.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { assertWalkableRoot, collectWalkIndexFiles } from '../src/walk_index.js'
import { walkProject } from '../src/baseline.js'

afterEach(() => {
  vi.doUnmock('../src/baseline.js')
  vi.resetModules()
})

describe('assertWalkableRoot', () => {
  it('refuses a filesystem root', () => {
    const fsRoot = path.parse(process.cwd()).root
    expect(() => assertWalkableRoot(fsRoot)).toThrow(/filesystem root/)
  })

  it('refuses the home directory', () => {
    expect(() => assertWalkableRoot(os.homedir())).toThrow(/home directory/)
  })

  it('refuses an ancestor of the home directory', () => {
    const ancestor = path.dirname(os.homedir())
    expect(() => assertWalkableRoot(ancestor)).toThrow()
  })

  it('allows an ordinary project directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-ok-'))
    try {
      expect(() => assertWalkableRoot(dir)).not.toThrow()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Windows/macOS only: C:\Users and C:\USERS are the same directory on a case-insensitive filesystem, so a case variant of home's ancestor must still be refused (regression for the drive-letter-only fold in normalizePath).
  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'rejects a case variant of an ancestor path on case-insensitive filesystems',
    () => {
      const ancestor = path.dirname(os.homedir())
      expect(() => assertWalkableRoot(ancestor.toUpperCase())).toThrow(/contains the home directory/)
    },
  )
})

describe('walkProject maxFiles', () => {
  it('stops at an explicit maxFiles ceiling', () => {
    // Pins the real walker, not a mock. walkProject has two separate ceiling checks -- the outer
    // `while` and an inner per-entry `break` -- and missing either one silently caps --force-walk
    // back at the default, which would look exactly like the flag working until the file count
    // came back suspiciously round.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-max-'))
    try {
      for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `f${i}.ts`), 'export const x = 1\n')
      expect(walkProject(root, { maxFiles: 3 }).files).toHaveLength(3)
      expect(walkProject(root).files).toHaveLength(8)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('collectWalkIndexFiles', () => {
  it('returns source files but excludes .env, .d.ts, and skipped dirs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-tree-'))
    try {
      fs.mkdirSync(path.join(root, 'sub'))
      fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true })
      fs.writeFileSync(path.join(root, 'sub', 'a.ts'), 'export const a = 1\n')
      fs.writeFileSync(path.join(root, '.env'), 'SECRET=nope\n')
      fs.writeFileSync(path.join(root, 'types.d.ts'), 'export declare const x: number\n')
      fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.ts'), 'export const b = 2\n')

      const files = collectWalkIndexFiles(root).map((f) => f.replace(/\\/g, '/'))

      expect(files.some((f) => f.endsWith('/sub/a.ts'))).toBe(true)
      expect(files.some((f) => f.endsWith('.env'))).toBe(false)
      expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false)
      expect(files.some((f) => f.includes('/node_modules/'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('excludes installed dependencies under site-packages even when the venv dir has a non-standard name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-sp-'))
    try {
      const sp = path.join(root, 'tmptg-venv', 'Lib', 'site-packages', 'dep')
      fs.mkdirSync(sp, { recursive: true })
      fs.mkdirSync(path.join(root, 'src'))
      fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const a = 1\n')
      fs.writeFileSync(path.join(sp, 'mod.py'), 'def helper():\n    pass\n')

      const files = collectWalkIndexFiles(root).map((f) => f.replace(/\\/g, '/'))

      expect(files.some((f) => f.endsWith('/src/app.ts'))).toBe(true)
      expect(files.some((f) => f.includes('/site-packages/'))).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws when the tree exceeds the file-count ceiling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-cap-'))
    try {
      vi.doMock('../src/baseline.js', async () => {
        const actual = (await vi.importActual('../src/baseline.js')) as Record<string, unknown>
        const max = actual.MAX_FILES_SCANNED as number
        const huge = Array.from({ length: max }, (_, i) => `${root}/f${i}.ts`)
        return { ...actual, walkProject: () => ({ files: huge, languages: {} }) }
      })
      vi.resetModules()
      const { collectWalkIndexFiles: collect } = await import('../src/walk_index.js')

      expect(() => collect(root)).toThrow(/too many source files/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('raises the ceiling under force, and still refuses past the forced ceiling', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-walk-force-'))
    try {
      // Honour maxFiles the way the real walkProject does -- a mock that ignored it would let
      // this test pass against a --force-walk that never actually reached the walker.
      vi.doMock('../src/baseline.js', async () => {
        const actual = (await vi.importActual('../src/baseline.js')) as Record<string, unknown>
        return {
          ...actual,
          walkProject: (_r: string, o: { maxFiles?: number } = {}) => {
            const want = Math.min(o.maxFiles ?? Infinity, 25_000)
            return { files: Array.from({ length: want }, (_, i) => `${root}/f${i}.ts`), languages: {} }
          },
        }
      })
      vi.resetModules()
      const { collectWalkIndexFiles: collect } = await import('../src/walk_index.js')

      // 25k files: over the default 20k ceiling, under the forced one.
      expect(() => collect(root)).toThrow(/too many source files/)
      expect(collect(root, { force: true })).toHaveLength(25_000)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('still refuses an over-broad root even under force', async () => {
    // The load-bearing half of the force contract. --force-walk is the user accepting a *volume*
    // cost for a folder they meant to index; it is never a licence to walk a filesystem root or
    // the home directory, which is not what anyone means at any file count. If this ever passes,
    // a typo'd root becomes a whole-drive scan.
    vi.resetModules()
    const { collectWalkIndexFiles: collect } = await import('../src/walk_index.js')
    expect(() => collect(os.homedir(), { force: true })).toThrow()
    expect(() => collect(path.parse(os.homedir()).root, { force: true })).toThrow()
  })
})
