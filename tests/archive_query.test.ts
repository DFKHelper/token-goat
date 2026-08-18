import { describe, it, expect, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

import {
  listZipEntries,
  extractZipEntry,
  formatZipList,
  ArchiveDependencyMissingError,
  type ZipEntry,
} from '../src/archive_query.js'

function makeZip(files: Record<string, string>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    zippable[name] = strToU8(content)
  }
  return zipSync(zippable)
}

describe('listZipEntries', () => {
  it('lists every entry path and size, sorted by path', async () => {
    const zip = makeZip({
      'src/index.ts': 'export const x = 1\n',
      'README.md': '# hello\n',
      'src/util.ts': 'export const y = 2\n',
    })

    const entries = await listZipEntries(zip)
    const paths = entries.map((e) => e.path)
    expect(paths).toEqual(['README.md', 'src/index.ts', 'src/util.ts'])

    const readme = entries.find((e) => e.path === 'README.md') as ZipEntry
    expect(readme.size).toBe(strToU8('# hello\n').length)
    expect(readme.isDirectory).toBe(false)
  })

  it('sorts by ordinal path comparison without calling localeCompare (deterministic across locales/ICU builds)', async () => {
    const spy = vi.spyOn(String.prototype, 'localeCompare')
    const zip = makeZip({
      'src/zzz.ts': 'z\n',
      'src/aaa.ts': 'a\n',
      'README.md': '# hello\n',
    })

    const entries = await listZipEntries(zip)
    expect(entries.map((e) => e.path)).toEqual(['README.md', 'src/aaa.ts', 'src/zzz.ts'])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns an empty array for an empty archive', async () => {
    const zip = zipSync({})
    expect(await listZipEntries(zip)).toEqual([])
  })

  it('throws on a malformed/corrupt zip', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    await expect(listZipEntries(garbage)).rejects.toThrow()
  })
})

describe('formatZipList', () => {
  it('renders a "(no entries found)" placeholder for an empty list', () => {
    expect(formatZipList([])).toBe('(no entries found)')
  })

  it('renders one right-aligned-size line per entry', () => {
    const entries: ZipEntry[] = [
      { path: 'a.txt', size: 5, compressedSize: 5, isDirectory: false },
      { path: 'b.txt', size: 12, compressedSize: 10, isDirectory: false },
    ]
    const text = formatZipList(entries)
    expect(text.split('\n')).toEqual([
      `${'5'.padStart(10)}  a.txt`,
      `${'12'.padStart(10)}  b.txt`,
    ])
  })
})

describe('extractZipEntry', () => {
  it('extracts exactly the requested entry\'s decompressed bytes', async () => {
    const zip = makeZip({
      'a.txt': 'hello world\n',
      'b.txt': 'goodbye\n',
    })

    const content = await extractZipEntry(zip, 'a.txt')
    expect(content).toBeDefined()
    expect(Buffer.from(content as Uint8Array).toString('utf-8')).toBe('hello world\n')
  })

  it('returns undefined for a missing entry', async () => {
    const zip = makeZip({ 'a.txt': 'hello\n' })
    expect(await extractZipEntry(zip, 'does-not-exist.txt')).toBeUndefined()
  })

  it('extracts binary member content byte-for-byte', async () => {
    const binary = new Uint8Array([0x00, 0xff, 0x10, 0x8f, 0x01])
    const zip = zipSync({ 'blob.bin': binary })
    const content = await extractZipEntry(zip, 'blob.bin')
    expect(content).toEqual(binary)
  })

  it('throws on a malformed/corrupt zip', async () => {
    const garbage = new Uint8Array([9, 8, 7, 6, 5])
    await expect(extractZipEntry(garbage, 'a.txt')).rejects.toThrow()
  })
})

// fflate is an optional dependency. When it is absent the two zip commands must say so, because
// the message they used to give -- "not a valid zip-format file" -- sent the reader to inspect an
// archive that was fine. The error type is what read_commands.ts branches on.
describe('ArchiveDependencyMissingError', () => {
  it('names the package and the command it enables, not the archive', () => {
    const err = new ArchiveDependencyMissingError()

    expect(err.message).toContain('fflate is not installed')
    expect(err.message).toContain('zip-list/zip-read')
    expect(err.message).not.toContain('not a valid zip')
  })

  it('is an Error subclass an instanceof check can branch on across the module boundary', () => {
    expect(new ArchiveDependencyMissingError()).toBeInstanceOf(Error)
    expect(new ArchiveDependencyMissingError().name).toBe('ArchiveDependencyMissingError')
  })
})
