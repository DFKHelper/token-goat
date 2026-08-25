import { describe, it, expect, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

import {
  listZipEntries,
  extractZipEntry,
  formatZipList,
  ArchiveDependencyMissingError,
  type ZipEntry,
} from '../src/archive_query.js'
import { ZipOutputTooLargeError } from '../src/zip_bounds.js'
import { buildLyingSizeZip, zeroPayload } from './helpers/zip_bomb_fixture.js'

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

  // Gap 2: extractZipEntry used to call fflate's unzipSync with no size bound of any kind, so a
  // requested entry's *declared* uncompressed size sized fflate's own allocation with nothing
  // stopping it from being huge.
  it('rejects an entry over the decompressed-size limit by its declared size, without decompressing it', async () => {
    // 520MB of zeros, honestly declared, compresses to a few MB in well under a second.
    const zip = zipSync({ 'bomb.bin': zeroPayload(520) }, { level: 1 })

    const t0 = Date.now()
    const err = await extractZipEntry(zip, 'bomb.bin').then(
      () => null,
      (e: unknown) => e as Error,
    )
    const elapsedMs = Date.now() - t0

    expect(err).toBeInstanceOf(ZipOutputTooLargeError)
    expect(err?.message).toMatch(/over the 500MB decompressed-size limit/)
    // Proves the declared-size fast path fired instead of decompressing first: fully
    // materializing 520MB would take measurably longer than this.
    expect(elapsedMs).toBeLessThan(1000)
  })

  // The declared size field is attacker-controlled and can understate the truth. A check gated
  // only on it is theatre; this proves the real-time running-total check -- not the declared-size
  // fast path -- is what actually catches an entry that lies.
  it('rejects an entry that lies about its declared size, catching it long before the real 600MB payload is fully decompressed', async () => {
    const realPayload = zeroPayload(600)
    const zip = buildLyingSizeZip('lying.bin', realPayload, 1024) // declares only 1KB

    const err = await extractZipEntry(zip, 'lying.bin').then(
      () => null,
      (e: unknown) => e as Error,
    )

    expect(err).toBeInstanceOf(ZipOutputTooLargeError)
    const match = /over (\d+)MB decompressed so far/.exec(err?.message ?? '')
    expect(match).not.toBeNull()
    const decompressedSoFarMB = Number(match?.[1])
    // Real payload is 600MB; a running total anywhere near the 500MB limit (not the 600MB real
    // size) proves extraction was aborted mid-stream, not after full decompression.
    expect(decompressedSoFarMB).toBeGreaterThanOrEqual(500)
    expect(decompressedSoFarMB).toBeLessThan(550)
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
