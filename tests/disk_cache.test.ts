import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { storeBlob, loadBlob, pruneBlobs, tokenGoatHome } from '../src/disk_cache.js'

let tmpHome: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env['TOKEN_GOAT_HOME']
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-blob-'))
  process.env['TOKEN_GOAT_HOME'] = tmpHome
})

afterEach(() => {
  if (prevHome === undefined) delete process.env['TOKEN_GOAT_HOME']
  else process.env['TOKEN_GOAT_HOME'] = prevHome
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe('tokenGoatHome', () => {
  it('honors the TOKEN_GOAT_HOME override', () => {
    expect(tokenGoatHome()).toBe(tmpHome)
  })

  it('falls back to ~/.token-goat when the override is unset', () => {
    delete process.env['TOKEN_GOAT_HOME']
    expect(tokenGoatHome()).toBe(path.join(os.homedir(), '.token-goat'))
  })

  it('treats an empty override as unset', () => {
    process.env['TOKEN_GOAT_HOME'] = ''
    expect(tokenGoatHome()).toBe(path.join(os.homedir(), '.token-goat'))
  })
})

describe('storeBlob / loadBlob', () => {
  it('round-trips a value through disk', () => {
    expect(storeBlob('sub', 'abc123', { hello: 'world', n: 7 })).toBe(true)
    expect(loadBlob('sub', 'abc123')).toEqual({ hello: 'world', n: 7 })
  })

  it('writes under <home>/<subdir>/<id>.json', () => {
    storeBlob('bash_outputs', 'deadbeef', { x: 1 })
    expect(fs.existsSync(path.join(tmpHome, 'bash_outputs', 'deadbeef.json'))).toBe(true)
  })

  it('returns null for a missing id', () => {
    expect(loadBlob('sub', 'nope')).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    const dir = path.join(tmpHome, 'sub')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8')
    expect(loadBlob('sub', 'broken')).toBeNull()
  })

  it('rejects ids that sanitize to empty (no write, no path escape)', () => {
    expect(storeBlob('sub', '', { x: 1 })).toBe(false)
    expect(storeBlob('sub', '///', { x: 1 })).toBe(true) // sanitizes to "___", a safe stem
    expect(loadBlob('sub', '///')).toEqual({ x: 1 })
  })

  it('does not let a traversal id escape the subdir', () => {
    // '..' sanitizes to '__' so it cannot climb out; the file lands inside sub.
    storeBlob('sub', '../evil', { x: 1 })
    expect(fs.existsSync(path.join(path.dirname(tmpHome), 'evil.json'))).toBe(false)
  })
})

describe('pruneBlobs', () => {
  it('drops blobs older than maxAgeMs', () => {
    // Store both first (each store's own prune sees them as fresh), then backdate
    // 'old' so the explicit prune is what evicts it.
    storeBlob('sub', 'old', { x: 1 })
    storeBlob('sub', 'fresh', { x: 2 })
    const oldPath = path.join(tmpHome, 'sub', 'old.json')
    const past = Date.now() - 48 * 3600 * 1000
    fs.utimesSync(oldPath, new Date(past), new Date(past))
    const removed = pruneBlobs('sub', 200, 24 * 3600 * 1000)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(fs.existsSync(oldPath)).toBe(false)
    expect(loadBlob('sub', 'fresh')).toEqual({ x: 2 })
  })

  it('evicts the oldest beyond maxCount', () => {
    // Stamp distinct mtimes so eviction order is deterministic.
    for (let i = 0; i < 5; i++) {
      storeBlob('sub', `id${i}`, { i }, { maxCount: 1000 })
      const p = path.join(tmpHome, 'sub', `id${i}.json`)
      const t = new Date(Date.now() - (5 - i) * 60_000)
      fs.utimesSync(p, t, t)
    }
    pruneBlobs('sub', 2, 24 * 3600 * 1000)
    const remaining = fs.readdirSync(path.join(tmpHome, 'sub')).filter((f) => f.endsWith('.json'))
    expect(remaining).toHaveLength(2)
    // The two newest (id3, id4) survive.
    expect(remaining.sort()).toEqual(['id3.json', 'id4.json'])
  })

  it('returns 0 for a missing subdir', () => {
    expect(pruneBlobs('never', 10, 1000)).toBe(0)
  })
})
