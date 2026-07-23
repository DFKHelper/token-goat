import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import type * as NodeOs from 'node:os'

// vi.mock is hoisted -- wrap homedir (still delegating to the real implementation by default) so the leading-dash-stripping regression test below can force a controlled homedir without touching Node's non-configurable os module properties directly (vi.spyOn on a builtin fails).
vi.mock('node:os', async (importOriginal) => {
  const original = await importOriginal<typeof NodeOs>()
  return {
    ...original,
    homedir: vi.fn((...args: Parameters<typeof original.homedir>) => original.homedir(...args)),
  }
})

import { tok, findClaudeMdFiles, findMemoryMd, runContextStats } from '../src/cli_context_stats.js'
import { canonicalize } from '../src/project.js'

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
      // findClaudeMdFiles will still check ~/.claude/CLAUDE.md; only assert the tempDir file is not found
      const found = findClaudeMdFiles(project)
      const inTemp = found.filter((f) => f.startsWith(tempDir))
      expect(inTemp).toHaveLength(0)
    })

    it('deduplicates the global ~/.claude/CLAUDE.md', () => {
      // If ~/.claude/CLAUDE.md happened to be on the walk-up path, ensure it appears only once (hard to reproduce deterministically, so we just verify uniqueness in a controlled tree).
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
      const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
      homedirMock.mockReturnValueOnce(tempDir)

      const projectRoot = path.join(tempDir, 'my-project')
      fs.mkdirSync(projectRoot)

      // Real Claude Code convention: every non-alphanumeric char becomes '-', no trim.
      const slug = path.resolve(projectRoot).replace(/[^A-Za-z0-9]/g, '-')
      const memDir = path.join(tempDir, '.claude', 'projects', slug, 'memory')
      fs.mkdirSync(memDir, { recursive: true })
      const memFile = path.join(memDir, 'MEMORY.md')
      fs.writeFileSync(memFile, '# Memory')

      expect(findMemoryMd(projectRoot)).toBe(memFile)
    })

    it('does not strip a leading dash that is genuinely part of the slug (fail-on-buggy: leading-dash trim mismatches the real Claude Code project-dir naming convention)', () => {
      const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
      homedirMock.mockReturnValueOnce(tempDir)

      // A UNC-style root resolves to a path starting with two backslashes on Windows, which
      // become two leading dashes once slugified -- exactly the case the old leading/trailing
      // dash trim silently mangled.
      const projectRoot = '\\\\server\\share\\myproject'
      const resolvedRoot = path.resolve(projectRoot)
      const slug = resolvedRoot.replace(/[^A-Za-z0-9]/g, '-')
      expect(slug.startsWith('-')).toBe(true)

      const memDir = path.join(tempDir, '.claude', 'projects', slug, 'memory')
      fs.mkdirSync(memDir, { recursive: true })
      const memFile = path.join(memDir, 'MEMORY.md')
      fs.writeFileSync(memFile, '# Memory')

      expect(findMemoryMd(projectRoot)).toBe(memFile)
    })

    it('does not fall back to other projects memory files', () => {
      // This tests the fix for dead code in the fallback loop. findMemoryMd should NOT return memory files from other projects. If the exact slug match doesn't exist, it should return null.
      const projectRoot = path.join(tempDir, 'no-memory-project')
      fs.mkdirSync(projectRoot)
      expect(findMemoryMd(projectRoot)).toBeNull()
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
      expect(parsed.claude_md_total).toBe(2530)
    })

    it('--fix actually prunes MEMORY.md via memory_prune (not a no-op)', async () => {
      // runContextStats calls os.homedir() twice (findClaudeMdFiles, then findMemoryMd),
      // so it needs two queued mock returns.
      const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
      homedirMock.mockReturnValueOnce(tempDir).mockReturnValueOnce(tempDir)

      const projectRoot = path.join(tempDir, 'fix-project')
      fs.mkdirSync(projectRoot)

      // runContextStats routes projectRoot through resolveProjectRoot() (src/project.ts),
      // which canonicalizes it -- including 8.3 short-name expansion on a Windows machine
      // whose %TEMP% is pinned to short form (e.g. CI's RUNNER~1) -- before findMemoryMd
      // ever sees it. The expected slug here must be derived the same way, not via a raw
      // path.resolve() of the un-canonicalized projectRoot.
      const slug = path.resolve(canonicalize(projectRoot)).replace(/[^A-Za-z0-9]/g, '-')
      const memDir = path.join(tempDir, '.claude', 'projects', slug, 'memory')
      fs.mkdirSync(memDir, { recursive: true })
      const memFile = path.join(memDir, 'MEMORY.md')
      // A dead-link entry (target file does not exist) that pruneIndex should drop.
      fs.writeFileSync(memFile, '- [Stale entry](missing-target.md)\n')

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        await runContextStats({ project: projectRoot, fix: true, yes: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      // The bug: --fix used to print a hardcoded "not yet implemented" message and never
      // touched MEMORY.md. Assert it actually delegated to memory_prune and rewrote the file.
      expect(output).not.toContain('not yet implemented')
      expect(output).toContain('[--fix] Pruned MEMORY.md')
      expect(output).toContain('removed 1 dead-link entries')
      const rewritten = fs.readFileSync(memFile, 'utf-8')
      expect(rewritten).not.toContain('Stale entry')
    })

    it('--fix without --yes on a non-TTY stdin is a dry run: reports and does not write', async () => {
      const homedirMock = os.homedir as unknown as ReturnType<typeof vi.fn>
      homedirMock.mockReturnValueOnce(tempDir).mockReturnValueOnce(tempDir)

      const projectRoot = path.join(tempDir, 'fix-dryrun-project')
      fs.mkdirSync(projectRoot)

      const slug = path.resolve(canonicalize(projectRoot)).replace(/[^A-Za-z0-9]/g, '-')
      const memDir = path.join(tempDir, '.claude', 'projects', slug, 'memory')
      fs.mkdirSync(memDir, { recursive: true })
      const memFile = path.join(memDir, 'MEMORY.md')
      const original = '- [Stale entry](missing-target.md)\n'
      fs.writeFileSync(memFile, original)

      const origIsTTY = process.stdin.isTTY
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, configurable: true })

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        await runContextStats({ project: projectRoot, fix: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
        Object.defineProperty(process.stdin, 'isTTY', { value: origIsTTY, configurable: true })
      }

      expect(output).not.toContain('[--fix] Pruned MEMORY.md')
      expect(output).toMatch(/Dry run|Skipped/)
      expect(fs.readFileSync(memFile, 'utf-8')).toBe(original)
    })

    it('--fix reports nothing to prune when no MEMORY.md exists', async () => {
      const project = path.join(tempDir, 'fix-no-memory')
      fs.mkdirSync(project)

      let output = ''
      const orig = process.stdout.write.bind(process.stdout)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(process.stdout as any).write = (s: string) => { output += s; return true }
      try {
        await runContextStats({ project, fix: true })
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(process.stdout as any).write = orig
      }

      expect(output).not.toContain('not yet implemented')
      expect(output).toContain('[--fix] No MEMORY.md found; nothing to prune.')
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
