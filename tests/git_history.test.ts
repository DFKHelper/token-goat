import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as gitHistory from '../src/git_history.js'
import * as util from '../src/util.js'

vi.mock('../src/util.js', () => ({
  runGit: vi.fn(),
}))

describe('git_history', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getRecentCommits', () => {
    it('should parse git log output correctly', () => {
      const mockOutput = `abc123def456
fix: improve performance
1687000000
def789abc012
feat: add caching
1686900000
ghi345jkl678
docs: update README
1686800000`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const commits = gitHistory.getRecentCommits(3)

      expect(commits).toHaveLength(3)
      expect(commits[0]).toEqual({
        commitShort: 'abc123def456',
        summary: 'fix: improve performance',
        authorTs: 1687000000,
      })
      expect(commits[1]).toEqual({
        commitShort: 'def789abc012',
        summary: 'feat: add caching',
        authorTs: 1686900000,
      })
      expect(commits[2]).toEqual({
        commitShort: 'ghi345jkl678',
        summary: 'docs: update README',
        authorTs: 1686800000,
      })
    })

    it('should return empty array on git error', () => {
      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: 'fatal: not a git repository',
        exitCode: 128,
      })

      const commits = gitHistory.getRecentCommits(3)

      expect(commits).toEqual([])
    })

    it('should filter out short summaries', () => {
      const mockOutput = `abc123def456
fix
1687000000
def789abc012
feat: long summary here
1686900000`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const commits = gitHistory.getRecentCommits(2)

      expect(commits).toHaveLength(1)
      expect(commits[0].summary).toBe('feat: long summary here')
    })

    it('should filter out commits with invalid timestamps (NaN protection)', () => {
      const mockOutput = `abc123def456
fix: improve performance
invalid-ts
def789abc012
feat: add caching
1686900000`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const commits = gitHistory.getRecentCommits(2)

      expect(commits).toHaveLength(1)
      expect(commits[0].summary).toBe('feat: add caching')
      expect(commits[0].authorTs).toBe(1686900000)
    })
  })

  describe('getChangedFilesSince', () => {
    it('should return string array from diff output', () => {
      const mockOutput = `src/foo.ts
src/bar.ts
tests/baz.test.ts`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const files = gitHistory.getChangedFilesSince('HEAD~5')

      expect(files).toEqual(['src/foo.ts', 'src/bar.ts', 'tests/baz.test.ts'])
    })

    it('should handle empty diff', () => {
      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
      })

      const files = gitHistory.getChangedFilesSince('HEAD~5')

      expect(files).toEqual([])
    })

    it('should trim whitespace', () => {
      const mockOutput = `src/foo.ts
src/bar.ts
  `

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const files = gitHistory.getChangedFilesSince('HEAD~5')

      expect(files).toEqual(['src/foo.ts', 'src/bar.ts'])
    })
  })

  describe('getBlame', () => {
    it('should parse porcelain format correctly', () => {
      const mockOutput = `abc123def456abc123def456abc123def456abc1 1 1
author Alice
author-time 1687000000
summary fix: improve performance
abc123def456abc123def456abc123def456abc1 2 2
author Alice
author-time 1687000000
summary fix: improve performance
def789abc012def789abc012def789abc012def7 3 3
author Bob
author-time 1686900000
summary feat: add caching
\tconst x = 42
\tconst y = 'hello'
\tfunction foo() {`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const entries = gitHistory.getBlame('src/foo.ts', 1, 3)

      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0]).toMatchObject({
        lineNo: expect.any(Number),
        commitHash: expect.stringMatching(/^[a-f0-9]{40}$/),
        author: expect.any(String),
        date: expect.any(String),
        content: expect.any(String),
      })
    })

    it('should return empty array on git error', () => {
      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: 'fatal: not a git repository',
        exitCode: 128,
      })

      const entries = gitHistory.getBlame('src/foo.ts', 1, 10)

      expect(entries).toEqual([])
    })

    it('increments line numbers for consecutive lines from same commit', () => {
      const mockOutput = `abc123def456abc123def456abc123def456abc1 1 10
author Alice
author-time 1687000000
\tfirst line
\tsecond line
\tthird line
def789abc012def789abc012def789abc012def7 4 13
author Bob
author-time 1686900000
\tdifferent author`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const entries = gitHistory.getBlame('src/foo.ts', 10, 13)

      expect(entries).toHaveLength(4)
      expect(entries[0].lineNo).toBe(10)
      expect(entries[0].content).toBe('first line')
      expect(entries[1].lineNo).toBe(11)
      expect(entries[1].content).toBe('second line')
      expect(entries[2].lineNo).toBe(12)
      expect(entries[2].content).toBe('third line')
      expect(entries[3].lineNo).toBe(13)
      expect(entries[3].content).toBe('different author')
    })
  })

  describe('formatHistory', () => {
    it('should return non-empty string for non-empty entries', () => {
      const now = Math.floor(Date.now() / 1000)
      const entries = [
        {
          commitShort: 'abc123def456',
          summary: 'fix: improve performance in the loop',
          authorTs: now - 86400,
        },
        {
          commitShort: 'def789abc012',
          summary: 'feat: add caching layer',
          authorTs: now,
        },
      ]

      const formatted = gitHistory.formatHistory(entries)

      expect(formatted).toContain('Recent commits:')
      expect(formatted).toContain('abc123de')
      expect(formatted).toContain('fix: improve performance in the loop')
      expect(formatted).toContain('1d')
      expect(formatted).toContain('def789ab')
      expect(formatted).toContain('today')
    })

    it('should return fallback text for empty entries', () => {
      const formatted = gitHistory.formatHistory([])

      expect(formatted).toBe('(no commits)')
    })
  })

  describe('formatBlame', () => {
    it('should format blame entries with line numbers', () => {
      const entries = [
        {
          lineNo: 10,
          commitHash: 'abc123def456abc123def456abc123def456abc1',
          author: 'Alice',
          date: '2023-06-18',
          content: 'const x = 42',
        },
        {
          lineNo: 11,
          commitHash: 'abc123def456abc123def456abc123def456abc1',
          author: 'Alice',
          date: '2023-06-18',
          content: 'const y = hello',
        },
      ]

      const formatted = gitHistory.formatBlame(entries)

      expect(formatted).toContain('10')
      expect(formatted).toContain('const x = 42')
      expect(formatted).toContain('Alice')
      expect(formatted).toContain('2023-06-18')
    })

    it('should return fallback text for empty entries', () => {
      const formatted = gitHistory.formatBlame([])

      expect(formatted).toBe('(no blame info)')
    })
  })

  describe('getChangedSymbols', () => {
    it('should extract symbols from diff hunk context', () => {
      const mockOutput = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@ function parseSymbol(context: string) {
@@ -25,2 +26,3 @@ export function getBlame(filePath: string) {
@@ -40,1 +41,2 @@ class Analyzer {`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const symbols = gitHistory.getChangedSymbols('/repo', 'HEAD~5', 50)

      expect(symbols.length).toBeGreaterThan(0)
      expect(symbols[0]).toMatchObject({
        file: expect.any(String),
        symbol: expect.any(String),
        linesAdded: expect.any(Number),
        linesRemoved: expect.any(Number),
      })
    })

    it('should count actual line additions/removals, not hunk header totals (regression test for hunk-count bug)', () => {
      const mockOutput = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,5 +10,7 @@ function myFunc() {
-removed line 1
-removed line 2
 context line
+added line 1
+added line 2
+added line 3`

      vi.mocked(util.runGit).mockReturnValue({
        stdout: mockOutput,
        stderr: '',
        exitCode: 0,
      })

      const symbols = gitHistory.getChangedSymbols('/repo', 'HEAD~5', 50)

      expect(symbols).toHaveLength(1)
      expect(symbols[0]).toEqual({
        file: 'src/foo.ts',
        symbol: 'myFunc',
        linesAdded: 3,
        linesRemoved: 2,
      })
    })

    it('should return empty array on error', () => {
      vi.mocked(util.runGit).mockReturnValue({
        stdout: '',
        stderr: 'fatal: not a git repository',
        exitCode: 128,
      })

      const symbols = gitHistory.getChangedSymbols('/repo', 'HEAD~5')

      expect(symbols).toEqual([])
    })
  })
})
