/** decodeSource must decode a large UTF-32 buffer; spreading every code point into String.fromCodePoint overflowed the call stack. */
import { describe, it, expect } from 'vitest'

import { decodeSource } from '../src/encoding.js'

describe('decodeSource with a UTF-32LE byte-order mark', () => {
  it('decodes 300,000 code points without a RangeError', () => {
    // Provenance: HAND-DERIVED UTF-32LE BOM (FF FE 00 00) followed by 300,000 little-endian code points of the letter a, plus a trailing U+1F600.
    const count = 300_000
    const buf = Buffer.alloc(4 + (count + 1) * 4)
    buf[0] = 0xff
    buf[1] = 0xfe
    buf[2] = 0
    buf[3] = 0
    for (let i = 0; i < count; i++) buf.writeUInt32LE(0x61, 4 + i * 4)
    buf.writeUInt32LE(0x1f600, 4 + count * 4)
    const text = decodeSource(buf)
    expect(text.startsWith('aaa')).toBe(true)
    expect(text.endsWith('a\u{1F600}')).toBe(true)
    expect(text.length).toBe(count + 2)
  })
})
