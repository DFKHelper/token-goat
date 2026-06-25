import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { fingerprintContent, fingerprintFile } from '../src/fingerprint.js'

const tmpFiles: string[] = []

function makeTmpFile(content: string): string {
  const p = path.join(os.tmpdir(), `tg-fp-${process.pid}-${Math.random().toString(36).slice(2)}.txt`)
  fs.writeFileSync(p, content)
  tmpFiles.push(p)
  return p
}

afterEach(() => {
  while (tmpFiles.length > 0) {
    const p = tmpFiles.pop()
    if (p === undefined) continue
    try {
      fs.unlinkSync(p)
    } catch {
      // best-effort cleanup
    }
  }
})

describe('fingerprintContent', () => {
  it('returns a consistent 64-char hex SHA-256 for a string', () => {
    const a = fingerprintContent('hello world')
    const b = fingerprintContent('hello world')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the reference SHA-256 of the UTF-8 bytes', () => {
    const expected = createHash('sha256').update(Buffer.from('hello world', 'utf-8')).digest('hex')
    expect(fingerprintContent('hello world')).toBe(expected)
  })

  it('returns different hashes for different content', () => {
    expect(fingerprintContent('alpha')).not.toBe(fingerprintContent('beta'))
  })

  it('hashes a Buffer identically to the equivalent UTF-8 string', () => {
    const str = 'café ☕'
    expect(fingerprintContent(Buffer.from(str, 'utf-8'))).toBe(fingerprintContent(str))
  })
})

describe('fingerprintFile', () => {
  it('returns null for a non-existent file', () => {
    const missing = path.join(os.tmpdir(), `tg-fp-missing-${Math.random().toString(36).slice(2)}`)
    expect(fingerprintFile(missing)).toBeNull()
  })

  it('returns null for a directory', () => {
    expect(fingerprintFile(os.tmpdir())).toBeNull()
  })

  it('returns the correct hash for a temp file', () => {
    const content = 'the quick brown fox'
    const p = makeTmpFile(content)
    expect(fingerprintFile(p)).toBe(fingerprintContent(content))
  })
})
