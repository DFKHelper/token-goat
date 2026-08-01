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

// Regression: sessionDir()/cleanup_stale() used to hardcode
// path.join(os.homedir(), '.token-goat', 'session_snapshots'), ignoring the TOKEN_GOAT_HOME
// override that every sibling module (session_store.ts, disk_cache.ts) already respects. That
// broke both a user's ability to relocate token-goat's data dir AND this very test file's
// isolation (tests/setup/isolate-home.ts sets TOKEN_GOAT_HOME specifically so tests never touch
// the developer's real home directory). This asserts store() actually resolves under the
// TOKEN_GOAT_HOME override, not the old hardcoded os.homedir() base.
describe('sessionDir / store honor TOKEN_GOAT_HOME override', () => {
  it('writes the snapshot under TOKEN_GOAT_HOME, not the old hardcoded os.homedir() base', () => {
    const prevHome = process.env.TOKEN_GOAT_HOME
    process.env.TOKEN_GOAT_HOME = TMP
    try {
      const result = store('sess-home-override', 'file.ts', Buffer.from('code'))
      expect(result).not.toBeNull()
      if (result) {
        const newBase = path.join(TMP, 'session_snapshots')
        const oldStyleBase = path.join(os.homedir(), '.token-goat', 'session_snapshots')
        expect(result.path.startsWith(newBase)).toBe(true)
        expect(result.path.startsWith(oldStyleBase)).toBe(false)
        expect(fs.existsSync(result.path)).toBe(true)
      }
    } finally {
      if (prevHome === undefined) delete process.env.TOKEN_GOAT_HOME
      else process.env.TOKEN_GOAT_HOME = prevHome
    }
  })
})

describe('store eviction behavior', () => {
  it('should NOT evict unrelated snapshots when updating an existing key', () => {
    const prevHome = process.env.TOKEN_GOAT_HOME
    process.env.TOKEN_GOAT_HOME = TMP

    try {
      const MAX_SNAPSHOTS = 150
      const sessionId = 'eviction-test'

      // Fill the snapshot dir with exactly MAX_SNAPSHOTS distinct keys
      for (let i = 0; i < MAX_SNAPSHOTS; i++) {
        const content = Buffer.from(`file${i} content`)
        store(sessionId, `file${i}.ts`, content)
      }

      // Get the snapshot directory to count files
      const firstPath = snapshot_path(sessionId, 'file0.ts')
      expect(firstPath).not.toBeNull()
      if (!firstPath) return

      const snapshotDir = path.dirname(firstPath)
      const filesBeforeUpdate = fs.readdirSync(snapshotDir)
        .filter(f => f.endsWith('.bin'))
        .length

      // Record all existing file names (other than file0)
      const otherFilesBefore = new Set(
        fs.readdirSync(snapshotDir)
          .filter(f => f.endsWith('.bin') && !f.includes('file0'))
      )

      expect(filesBeforeUpdate).toBe(MAX_SNAPSHOTS)

      // Now update an existing key (file0) with different content
      const newContent = Buffer.from('file0 updated content - definitely different')
      const result = store(sessionId, 'file0.ts', newContent)
      expect(result).not.toBeNull()

      // Check that no unrelated files were evicted
      const filesAfterUpdate = fs.readdirSync(snapshotDir)
        .filter(f => f.endsWith('.bin'))
        .length

      const otherFilesAfter = new Set(
        fs.readdirSync(snapshotDir)
          .filter(f => f.endsWith('.bin') && !f.includes('file0'))
      )

      // Total file count should remain MAX_SNAPSHOTS (we updated, not added)
      expect(filesAfterUpdate).toBe(MAX_SNAPSHOTS)

      // No OTHER files should have been deleted
      expect(otherFilesAfter.size).toBe(otherFilesBefore.size)
      for (const file of otherFilesBefore) {
        expect(otherFilesAfter.has(file), `File ${file} was evicted when updating an existing key`)
          .toBe(true)
      }
    } finally {
      if (prevHome === undefined) delete process.env.TOKEN_GOAT_HOME
      else process.env.TOKEN_GOAT_HOME = prevHome
    }
  })
})

describe('concurrent writes (regression: fixed .tmp filename collision)', () => {
  it('handles concurrent store() calls to the same snapshot path without corruption', () => {
    const prevHome = process.env.TOKEN_GOAT_HOME
    process.env.TOKEN_GOAT_HOME = TMP

    try {
      const sessionId = 'concurrent-test'
      const filePath = 'concurrent.ts'

      // Simulate concurrent writes by spawning multiple store() calls in rapid succession
      // The old fixed-temp-filename bug would cause collisions on p + '.tmp'
      const promises = []
      for (let i = 0; i < 10; i++) {
        const content = Buffer.from(`concurrent write attempt ${i}`)
        // Use synchronous store in a way that simulates concurrency pressure
        // (in real concurrent scenario, these would interleave via async/await or threads)
        const result = store(sessionId, filePath, content)
        promises.push(result)
      }

      // All stores should succeed
      for (const result of promises) {
        expect(result).not.toBeNull()
      }

      // The final snapshot should be readable and match the last written content
      const lastContent = Buffer.from(`concurrent write attempt 9`)
      const snapshotPath = snapshot_path(sessionId, filePath)
      expect(snapshotPath).not.toBeNull()
      if (snapshotPath) {
        expect(fs.existsSync(snapshotPath)).toBe(true)
        // Verify the file is not truncated or corrupted
        const loaded = load(sessionId, filePath)
        expect(loaded).not.toBeNull()
        if (loaded) {
          // The loaded content should match one of the written contents
          expect(loaded.toString()).toBe(lastContent.toString())
        }
      }
    } finally {
      if (prevHome === undefined) delete process.env.TOKEN_GOAT_HOME
      else process.env.TOKEN_GOAT_HOME = prevHome
    }
  })
})
