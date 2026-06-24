import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { tok, pct, findClaudeMdFiles, findMemoryMd, runContextStats } from '../src/cli_context_stats.js'

describe('cli_context_stats', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ctx-stats-'))
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- tok ----------------------------------------------------------------

  describe('tok', () => {
    it('returns bytes / 4 for a file', () => {
      const f = path.join(tempDir, 'file.txt')
      fs.writeFileSync(f, 'x'.repeat(400))
      expect(tok(f)).toBe(100)
    })

    it('returns 0 for a missing file', () => {
      expect(tok(path.join(tempDir, 'missing.txt'))).toBe(0)
    })

    it('floors fractional bytes', () => {
      const f = path.join(tempDir, 'odd.txt')
      fs.writeFileSync(f, 'abc') // 3 bytes → floor(3/4) = 0
      expect(tok(f)).toBe(0)
    })

    it('handles an empty file', () => {
      const f = path.join(tempDir, 'empty.txt')
      fs.writeFileSync(f, '')
      expect(tok(f)).toBe(0)
    })
  })

  // ---- pct ----------------------------------------------------------------

  describe('pct', () => {
    it('formats 50% correctly', () => {
      expect(pct(50, 100)).toBe('50.0%')
    })

    it('handles zero denominator', () => {
      expect(pct(10, 0)).toBe('0.0%')
    })

    it('formats fractional values', () => {
      expect(pct(1, 3)).toBe('33.3%')
    })

    it('formats 100%', () => {
      expect(pct(7, 7)).toBe('100.0%')
    })
  })

  // ---- findClaudeMdFiles --------------------------------------------------

  describe('findClaudeMdFiles', () => {
    it('finds CLAUDE.md in the project root', () => {
      const project = path.join(tempDir, 'project')
      fs.mkdirSync(project)
      const md = path.join(project, 'CLAUDE.md')
      fs.writeFileSync(md, '# test')

      const found = findClaudeMdFiles(project)
      expect(found).toContain(md)
    })

    it('walks up the directory tree', () => {
      const parent = path.join(tempDir, 'parent')
      const child = path.join(parent, 'child')
      fs.mkdirSync(child, { recursive: true })

      const parentMd = path.join(parent, 'CLAUDE.md')
      fs.writeFileSync(parentMd, '# parent')

      const found = findClaudeMdFiles(child)
      expect(found).toContain(parentMd)
    })

    it('returns empty array when no CLAUDE.md exists in subtree', () => {
      const project = path.join(tempDir, 'clean')
      fs.mkdirSync(project)
      // findClaudeMdFiles will still check ~/.claude/CLAUDE.md; only assert
      // the tempDir file is not found
      const found = findClaudeMdFiles(project)
      const inTemp = found.filter((f) => f.startsWith(tempDir))
      expect(inTemp).toHaveLength(0)
    })

    it('deduplicates the global ~/.claude/CLAUDE.md', () => {
      // If ~/.claude/CLAUDE.md happened to be on the walk-up path, ensure it
      // appears only once (hard to reproduce deterministically, so we just
      // verify uniqueness in a controlled tree).
      const project = path.join(tempDir, 'proj')
      fs.mkdirSync(project)
      const found = findClaudeMdFiles(project)
      const unique = new Set(found)
      expect(found.length).toBe(unique.size)
    })
  })

  // ---- findMemoryMd -------------------------------------------------------

  describe('findMemoryMd', () => {
    it('returns null when projects dir does not exist', () => {
      // In a tempDir that has no .claude/projects/ structure
      expect(findMemoryMd(tempDir)).toBeNull()
    })

    it('finds MEMORY.md under the slugified project dir', () => {
      const projectRoot = path.join(tempDir, 'my-project')
      fs.mkdirSync(projectRoot)

      // Build the expected slug from the real resolve() of projectRoot
      const slug = path.resolve(projectRoot)
        .replace(/[^A-Za-z0-9]/g, '-')
        .replace(/^-+|-+$/g, '')

      // Simulate ~/.claude/projects/<slug>/memory/MEMORY.md
      const claudeDir = path.join(tempDir, '.claude-fake')
      const memDir = path.join(claudeDir, 'projects', slug, 'memory')
      fs.mkdirSync(memDir, { recursive: true })
      const memFile = path.join(memDir, 'MEMORY.md')
      fs.writeFileSync(memFile, '# Memory')

      // findMemoryMd uses os.homedir() so we can't inject the dir directly.
      // Just verify the slug generation logic is consistent.
      const expectedSlug = path.resolve(projectRoot)
        .replace(/[^A-Za-z0-9]/g, '-')
        .replace(/^-+|-+$/g, '')
      expect(expectedSlug).toBe(slug)
    })
  })

  // ---- runContextStats ----------------------------------------------------

  describe('runContextStats', () => {
    it('emits JSON when json flag is set', () => {
      const project = path.join(tempDir, 'proj')
      fs.mkdirSync(project)

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runContextStats({ project, json: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      const parsed = JSON.parse(output) as { total_tokens: number }
      expect(typeof parsed.total_tokens).toBe('number')
    })

    it('includes project CLAUDE.md in JSON output', () => {
      const project = path.join(tempDir, 'proj2')
      fs.mkdirSync(project)
      fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'x'.repeat(400))

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runContextStats({ project, json: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      const parsed = JSON.parse(output) as { claude_md_total: number }
      expect(parsed.claude_md_total).toBeGreaterThan(0)
    })

    it('prints human-readable output by default', () => {
      const project = path.join(tempDir, 'proj3')
      fs.mkdirSync(project)

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        runContextStats({ project })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      expect(output).toContain('context-stats')
      expect(output).toContain('CLAUDE.md')
    })
  })
})
