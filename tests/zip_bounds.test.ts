import { describe, it, expect } from 'vitest'
import { zipSync, strToU8, unzipSync, Unzip, UnzipInflate } from 'fflate'

import { unzipBounded, ZipOutputTooLargeError, type ZipStreamModule } from '../src/zip_bounds.js'
import { buildLyingSizeZip, zeroPayload } from './helpers/zip_bomb_fixture.js'

const fflateModule: ZipStreamModule = { Unzip, UnzipInflate, unzipSync }

describe('unzipBounded', () => {
  it('extracts a normal small archive correctly (no false positive)', () => {
    const zip = zipSync({
      'a.txt': strToU8('hello world\n'),
      'b.txt': strToU8('goodbye\n'),
    })

    const result = unzipBounded(fflateModule, zip, { limitBytes: 10 * 1024 * 1024, shouldExtract: () => true })

    expect(Buffer.from(result['a.txt']).toString('utf-8')).toBe('hello world\n')
    expect(Buffer.from(result['b.txt']).toString('utf-8')).toBe('goodbye\n')
  })

  it('skips entries shouldExtract rejects, decompressing only the selected one', () => {
    const zip = zipSync({
      'a.txt': strToU8('hello\n'),
      'b.txt': strToU8('goodbye\n'),
    })

    const result = unzipBounded(fflateModule, zip, { limitBytes: 10 * 1024 * 1024, shouldExtract: (name) => name === 'a.txt' })

    expect(Object.keys(result)).toEqual(['a.txt'])
  })

  it('rejects an entry whose declared size alone already exceeds the limit, via the fast declared-size check, without decompressing it', () => {
    // A real, honestly-labeled bomb: 40MB of zeros, declared size matches reality. Small enough
    // to build fast, but big enough that if the fast path did not fire and the entry were fully
    // decompressed, it would take measurably longer than the assertion below allows.
    const zip = zipSync({ 'bomb.bin': zeroPayload(40) }, { level: 1 })

    const t0 = Date.now()
    expect(() => unzipBounded(fflateModule, zip, { limitBytes: 1024 * 1024, shouldExtract: () => true })).toThrow(ZipOutputTooLargeError)
    const elapsedMs = Date.now() - t0

    // The fast declared-size check rejects before any streaming decompression begins, so this
    // should complete near-instantly (walking the central directory only). A generous bound
    // catches a regression to "decompress first, check after" without being flaky under load.
    expect(elapsedMs).toBeLessThan(200)
  })

  it('reports the limit and the declared size in the fast-path error message', () => {
    const zip = zipSync({ 'bomb.bin': zeroPayload(40) }, { level: 1 })
    let caught: Error | undefined
    try {
      unzipBounded(fflateModule, zip, { limitBytes: 1024 * 1024, shouldExtract: () => true })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).toBeInstanceOf(ZipOutputTooLargeError)
    expect(caught?.message).toMatch(/bomb\.bin.*over the 1MB decompressed-size limit/)
  })

  it('rejects an entry that LIES about its declared size, via the real-time running-total check, catching it long before the real payload is fully decompressed', () => {
    // The declared size (100 bytes) is comfortably under the limit, so the fast declared-size
    // check alone would wave this straight through -- exactly the "theatre" failure mode. The
    // real decompressed content is 60MB of zeros. If unzipBounded only checked the declared
    // field, this would fully decompress (or attempt to allocate) 60MB; it must instead be
    // caught by the running total as the real bytes stream out.
    const realPayload = zeroPayload(60)
    const zip = buildLyingSizeZip('lying.bin', realPayload, 100)

    let caught: Error | undefined
    try {
      unzipBounded(fflateModule, zip, { limitBytes: 1024 * 1024, shouldExtract: () => true })
    } catch (err) {
      caught = err as Error
    }

    expect(caught).toBeInstanceOf(ZipOutputTooLargeError)
    // Proves early abort, not full materialization: the running total at the moment of the throw
    // is a small multiple of the 1MB limit (bounded by one stream chunk's worst-case expansion),
    // nowhere close to the real 60MB payload. A bound gated only on the declared 100-byte field
    // would never have thrown at all.
    const match = /over (\d+)MB decompressed so far/.exec((caught as Error).message)
    expect(match).not.toBeNull()
    const decompressedSoFarMB = Number(match?.[1])
    expect(decompressedSoFarMB).toBeGreaterThanOrEqual(1)
    expect(decompressedSoFarMB).toBeLessThan(30) // real payload is 60MB; this proves it never got close
  })

  it('rejects a malformed/corrupt zip, same as unzipSync', () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    expect(() => unzipBounded(fflateModule, garbage, { limitBytes: 1024, shouldExtract: () => true })).toThrow()
  })
})
