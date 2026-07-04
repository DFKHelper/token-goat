import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { store, load, load_kind, cleanup_session, snapshot_path } from '../src/snapshots.js'

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-snap-'))
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('snapshot_path', () => {
  it('returns null for empty session id', () => {
    const p = snapshot_path('', '/file.ts')
    expect(p).toBeNull()
  })

  it('returns a path for valid inputs', () => {
    const p = snapshot_path('sess1', 'file.ts')
    expect(p).not.toBeNull()
    expect(typeof p).toBe('string')
  })

  it('hashes long paths to short filenames', () => {
    const longPath = 'src/very/long/nested/path/to/some/file/that/is/extremely/long.ts'
    const p = snapshot_path('sess', longPath)
    expect(p).not.toBeNull()
    if (p) {
      const filename = path.basename(p)
      expect(filename.length).toBeLessThan(40)
    }
  })
})

describe('pathKey case folding (case-insensitive FS)', () => {
  const prevCaseEnv = process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
  afterEach(() => {
    if (prevCaseEnv === undefined) delete process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS
    else process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = prevCaseEnv
  })

  // Regression: pathKey() hashed the raw filePath string. normalizePath only lowercases the
  // drive letter (project convention), so a file read under two different literal casings in
  // one session (e.g. "Worker.ts" vs "worker.ts") on a case-insensitive filesystem resolved to
  // two DIFFERENT snapshot files on disk -- defeating change-detection (load()
  // would silently fail to find the prior snapshot under the new casing).
  it('produces the same snapshot path for two case variants of the same file', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '1'
    const p1 = snapshot_path('sess', 'src/Worker.ts')
    const p2 = snapshot_path('sess', 'src/worker.ts')
    expect(p1).toBe(p2)
  })

  it('control: case-sensitive FS mode still produces different snapshot paths for case variants', () => {
    process.env.TOKEN_GOAT_CASE_INSENSITIVE_FS = '0'
    const p1 = snapshot_path('sess', 'src/Worker.ts')
    const p2 = snapshot_path('sess', 'src/worker.ts')
    expect(p1).not.toBe(p2)
  })
})

describe('store and load', () => {
  it('stores and retrieves snapshot content', () => {
    const content = Buffer.from('function foo() { return 42 }')
    const result = store('sess', 'file.ts', content)
    expect(result).not.toBeNull()
    if (result) {
      const loaded = load('sess', 'file.ts', { expected_sha: result.content_sha })
      expect(loaded).not.toBeNull()
      expect(loaded?.toString()).toBe(content.toString())
    }
  })

  it('returns null for oversized files', () => {
    const huge = Buffer.alloc(300 * 1024, 'x')
    const result = store('sess', 'huge.bin', huge)
    expect(result).toBeNull()
  })

  it('truncates large files within bounds', () => {
    const large = Buffer.alloc(100 * 1024, 'x')
    const result = store('sess', 'large.bin', large)
    expect(result).not.toBeNull()
    if (result) {
      expect(result.size_bytes).toBeLessThan(large.length)
    }
  })

  it('returns null for missing snapshot', () => {
    const loaded = load('sess', 'nonexistent.ts')
    expect(loaded).toBeNull()
  })
})

describe('load_kind', () => {
  it('stores and retrieves snapshot kind', () => {
    const content = Buffer.from('code')
    store('sess', 'file.ts', content)
    const kind = load_kind('sess', 'file.ts')
    expect(kind).toBe('read')
  })

  it('defaults to read kind', () => {
    const content = Buffer.from('code')
    store('sess', 'file.ts', content)
    const kind = load_kind('sess', 'file.ts')
    expect(kind).toBe('read')
  })

  it('returns null for missing snapshot', () => {
    const kind = load_kind('sess', 'nonexistent.ts')
    expect(kind).toBeNull()
  })
})

describe('cleanup_session', () => {
  it('removes all snapshots for a session', () => {
    store('sess1', 'file1.ts', Buffer.from('code1'))
    store('sess1', 'file2.ts', Buffer.from('code2'))
    const removed = cleanup_session('sess1')
    expect(removed).toBeGreaterThanOrEqual(2)
    const loaded1 = load('sess1', 'file1.ts')
    const loaded2 = load('sess1', 'file2.ts')
    expect(loaded1).toBeNull()
    expect(loaded2).toBeNull()
  })

  it('returns 0 for missing session', () => {
    const removed = cleanup_session('nonexistent')
    expect(removed).toBe(0)
  })
})
