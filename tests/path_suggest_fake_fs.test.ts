/** The NFD and case-only rungs of suggestPaths (src/path_suggest.ts) against a fake filesystem that tells the spellings apart, so they run on any platform: a real Windows or macOS volume folds the two spellings and the rung has nothing to repair there. Every expectation is HAND-DERIVED: the fake tree below is the whole world, and the expected suggestion is the one path in it. */
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ files: new Set<string>() }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const nodePath = await import('node:path')
  const dirsOf = (): Set<string> => {
    const dirs = new Set<string>()
    for (const file of fake.files) {
      for (let dir = nodePath.dirname(file); !dirs.has(dir); dir = nodePath.dirname(dir)) {
        dirs.add(dir)
        if (nodePath.dirname(dir) === dir) break
      }
    }
    return dirs
  }
  const existsSync = (p: unknown): boolean => {
    const abs = nodePath.resolve(String(p))
    return fake.files.has(abs) || dirsOf().has(abs)
  }
  const readdirSync = (p: unknown): string[] => {
    const abs = nodePath.resolve(String(p))
    const names = new Set<string>()
    for (const file of fake.files) {
      let child = file
      while (nodePath.dirname(child) !== child) {
        if (nodePath.dirname(child) === abs) names.add(nodePath.basename(child))
        child = nodePath.dirname(child)
      }
    }
    return [...names]
  }
  const opendirSync = (p: unknown): { readSync: () => { name: string } | null; closeSync: () => void } => {
    const names = readdirSync(p)
    let next = 0
    return { readSync: () => (next < names.length ? { name: names[next++] as string } : null), closeSync: () => undefined }
  }
  return { ...real, default: { ...real, existsSync, readdirSync, opendirSync }, existsSync, readdirSync, opendirSync }
})

// The fake volume is case-sensitive, so paths compare as written, as foldPath does on Linux.
vi.mock('../src/path_containment.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), foldPath: (p: string) => p }))

import { suggestPaths } from '../src/path_suggest.js'

const CWD = path.resolve('/fakeproj')
const put = (rel: string): void => {
  fake.files.add(path.resolve(CWD, rel))
}

describe('rung 1 where the filesystem keeps the normalization forms apart', () => {
  it('maps a decomposed (NFD) spelling to the composed one on disk', () => {
    fake.files.clear()
    put('names/café.txt')
    expect(suggestPaths('names/café.txt', CWD, null)).toEqual(['names/café.txt'])
  })

  it('maps a composed spelling to the decomposed one on disk', () => {
    fake.files.clear()
    put('names/café.txt')
    expect(suggestPaths('names/café.txt', CWD, null)).toEqual(['names/café.txt'])
  })
})

describe('rung 4 where the filesystem is case-sensitive', () => {
  it('corrects a file name that differs only in case', () => {
    fake.files.clear()
    put('Case/Sensitive_Name.txt')
    expect(suggestPaths('Case/sensitive_name.txt', CWD, null)).toEqual(['Case/Sensitive_Name.txt'])
  })

  it('corrects a directory segment and the file name together', () => {
    fake.files.clear()
    put('Docs/Guide.md')
    expect(suggestPaths('docs/guide.md', CWD, null)).toEqual(['Docs/Guide.md'])
  })

  it('offers nothing when two entries differ from the segment only in case', () => {
    fake.files.clear()
    put('dir/Name.txt')
    put('dir/NAME.txt')
    expect(suggestPaths('dir/name.txt', CWD, null).filter((p) => p.toLowerCase() === 'dir/name.txt')).toEqual([])
  })

  it('offers nothing when the path already exists', () => {
    fake.files.clear()
    put('dir/name.txt')
    expect(suggestPaths('dir/name.txt', CWD, null)).toEqual([])
  })
})
