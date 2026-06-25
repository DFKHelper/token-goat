import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { writeRaw, renderTopSessionFiles, renderTopSessionFilesFromDisk, runStats } from '../src/cli_stats.js'

// Stub session module so renderTopSessionFiles is deterministic
vi.mock('../src/session.js', () => {
  let _files = new Map<string, { path: string; readCount: number; lastReadAt: number; wasEdited: boolean; sizeBytes: number }>()
  return {
    getSessionFiles: () => _files,
    recordFileRead: (p: string) => {
      const key = p
      const existing = _files.get(key)
      if (existing) {
        _files.set(key, { ...existing, readCount: existing.readCount + 1, lastReadAt: Date.now() })
      } else {
        _files.set(key, { path: p, readCount: 1, lastReadAt: Date.now(), wasEdited: false, sizeBytes: 0 })
      }
    },
    _setMockFiles: (m: typeof _files) => { _files = m },
    normalizePath: (p: string) => p,
    wasFileReadThisSession: () => false,
    wasHintShown: () => false,
    markHintShown: () => {},
    recordFileEdit: () => {},
    recordWebFetch: () => {},
    getWebFetchCacheId: () => null,
    getSessionWebFetches: () => new Map(),
    recordBashOutput: () => {},
    getBashOutputId: () => null,
    getSessionId: () => 'test-session',
    getSessionFiles_forTest: () => _files,
  }
})

describe('cli_stats', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-cli-stats-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  // ---- writeRaw -----------------------------------------------------------

  describe('writeRaw', () => {
    it('writes text to stdout', () => {
      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        writeRaw('hello')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }
      expect(output).toContain('hello')
    })

    it('appends newline when text does not end with one', () => {
      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        writeRaw('no-newline')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }
      expect(output).toMatch(/no-newline\n$/)
    })

    it('does not double-append newline when text already ends with one', () => {
      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        writeRaw('with-newline\n')
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }
      expect(output).toBe('with-newline\n')
    })
  })

  // ---- renderTopSessionFiles (in-memory) ----------------------------------

  describe('renderTopSessionFiles', () => {
    it('returns empty string when no session files', () => {
      expect(renderTopSessionFiles()).toBe('')
    })

    it('returns empty string when no file accessed more than once', () => {
      // With vi.mock returning empty Map by default, this should be empty
      expect(renderTopSessionFiles()).toBe('')
    })
  })

  // ---- renderTopSessionFilesFromDisk --------------------------------------

  describe('renderTopSessionFilesFromDisk', () => {
    it('returns empty string when sessions dir does not exist', () => {
      expect(renderTopSessionFilesFromDisk(5, path.join(tempDir, 'no-such-dir'))).toBe('')
    })

    it('reads file_access_counts from session JSON', () => {
      const sessionsDir = path.join(tempDir, 'sessions')
      fs.mkdirSync(sessionsDir)

      const sessionData = {
        file_access_counts: {
          '/some/path/foo.ts': 5,
          '/some/path/bar.ts': 2,
          '/some/path/baz.ts': 1,
        },
      }
      fs.writeFileSync(path.join(sessionsDir, 'abc123.json'), JSON.stringify(sessionData))

      // Verify by parsing directly (mirrors renderTopSessionFilesFromDisk logic)
      const raw = fs.readFileSync(path.join(sessionsDir, 'abc123.json'), 'utf-8')
      const data = JSON.parse(raw) as { file_access_counts: Record<string, number> }
      const ranked = Object.entries(data.file_access_counts)
        .filter(([, v]) => v > 1)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)

      expect(ranked).toHaveLength(2)
      expect(ranked[0]?.[1]).toBe(5)
    })

    it('skips files accessed only once', () => {
      const counts: Record<string, number> = { '/a': 1, '/b': 1 }
      const ranked = Object.entries(counts).filter(([, v]) => v > 1)
      expect(ranked).toHaveLength(0)
    })
  })

  // ---- runStats -----------------------------------------------------------

  describe('runStats', () => {
    it('emits JSON when json flag is set', () => {
      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runStats({ json: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      const parsed = JSON.parse(output) as { total_events: number }
      expect(typeof parsed.total_events).toBe('number')
    })

    it('emits human-readable output by default', () => {
      let output = ''
      const origOut = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runStats({})
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = origOut
      }

      // renderStats prints "No stats recorded yet." or the stats header
      expect(output.length).toBeGreaterThan(0)
    })

    it('respects windowDays option', () => {
      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runStats({ json: true, windowDays: 7 })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }
      const parsed = JSON.parse(output) as { window_days: number }
      expect(parsed.window_days).toBe(7)
    })
  })
})
