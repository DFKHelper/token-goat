/** suggestPaths (src/path_suggest.ts) where the index and the disk spell one file differently, and where the input is refused outright. The world is a fake case-insensitive volume, so the cases run on any platform. Every expectation is HAND-DERIVED: the fake tree below is the whole world, and the expected suggestion is the one file in it. */
import * as path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ files: new Set<string>(), indexed: [] as string[], fold: (p: string): string => p.toLowerCase().split(String.fromCharCode(92)).join('/') }))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  const nodePath = await import('node:path')
  const key = (p: unknown): string => String(nodePath.resolve(String(p))).toLowerCase().split(String.fromCharCode(92)).join('/')
  const existsSync = (p: unknown): boolean => {
    const want = key(p)
    return [...fake.files].some((file) => key(file) === want || key(file).startsWith(`${want}/`))
  }
  const readdirSync = (p: unknown): string[] => {
    const want = key(p)
    const names = new Set<string>()
    for (const file of fake.files) {
      const parts = nodePath.resolve(file).split(/[\\/]/)
      for (let i = 1; i < parts.length; i++) if (key(parts.slice(0, i).join('/') || '/') === want || key(parts.slice(0, i).join('/')) === want) names.add(parts[i] as string)
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

vi.mock('../src/path_containment.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), foldPath: fake.fold, isInsideRoot: () => true }))
vi.mock('../src/project.js', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), findProject: (dir: string) => ({ root: dir, hash: 'fake', marker: '.git' }) }))
vi.mock('../src/fingerprint.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fileIsAbsent: (p: string) => ![...fake.files].some((file) => fake.fold(file) === fake.fold(String(p))),
}))
vi.mock('../src/indexed_file_names.js', () => ({ indexedFileList: () => fake.indexed.map((filePath) => ({ filePath, base: filePath.toLowerCase() })), filesNamed: () => fake.indexed }))

import { suggestPaths } from '../src/path_suggest.js'

const CWD = path.resolve('/FakeProj')
const put = (rel: string): void => {
  fake.files.add(path.resolve(CWD, rel))
}

describe('one file spelled two ways', () => {
  it('is offered once when the index and the disk differ only in case', () => {
    fake.files.clear()
    put('src/config.ts')
    fake.indexed = ['src/config.ts']
    expect(suggestPaths('src/confg.ts', CWD, path.resolve('/fakeproj'))).toEqual(['src/config.ts'])
  })
})

describe('input that is refused', () => {
  const world = (): void => {
    fake.files.clear()
    put('config.ts')
    fake.indexed = []
  }

  it('answers a path ending in a line break like any other', () => {
    world()
    expect(suggestPaths('confg.ts', CWD, null)).toEqual(['config.ts'])
    expect(suggestPaths('confg.ts\n', CWD, null)).toEqual([])
  })

  it('refuses a path holding a NUL', () => {
    world()
    expect(suggestPaths('confg.ts\0', CWD, null)).toEqual([])
  })

  it('refuses a path longer than the cap', () => {
    world()
    expect(suggestPaths(`confg.ts${' '.repeat(2000)}`, CWD, null)).toEqual([])
  })
})
