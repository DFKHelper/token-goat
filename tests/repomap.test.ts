/**
 * Tests for repomap module.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as path from 'path'
import type { RepoEntry } from '../src/repomap.js'
import {
  getTrackedFiles,
  buildMap,
  buildCompactMap,
  formatMap,
} from '../src/repomap.js'
import * as util from '../src/util.js'
import * as indexReader from '../src/index_reader.js'
import * as compact from '../src/compact.js'
import * as parserTypes from '../src/parser_types.js'
import * as paths from '../src/paths.js'
import { loadConfig } from '../src/config.js'

vi.mock('../src/util.js')
vi.mock('../src/index_reader.js')
vi.mock('../src/compact.js')
vi.mock('../src/parser_types.js')
vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))
// Default to an identity pass-through so existing tests (which compare raw paths) are unaffected;
// individual tests override the implementation to assert normalization actually happens.
vi.mock('../src/paths.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>()
  return { ...original, resolveIndexPath: vi.fn((p: string) => p) }
})

describe('repomap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Permissive default so tests that don't care about exclude_tests aren't affected;
    // individual tests override as needed.
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  describe('getTrackedFiles', () => {
    it('parses git ls-files output into paths', () => {
      const mockResult = {
        exitCode: 0,
        stdout: 'src/a.ts\nsrc/b.ts\ntests/c.ts',
        stderr: '',
      }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const cwd = '/project'
      const files = getTrackedFiles(cwd)

      expect(util.runGit).toHaveBeenCalledWith(['ls-files'], { cwd })
      expect(files).toHaveLength(3)
      expect(files[0]).toBe(path.join(cwd, 'src/a.ts'))
      expect(files[1]).toBe(path.join(cwd, 'src/b.ts'))
      expect(files[2]).toBe(path.join(cwd, 'tests/c.ts'))
    })

    it('returns empty array on git error', () => {
      const mockResult = { exitCode: 128, stdout: '', stderr: 'not a git repo' }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const files = getTrackedFiles('/project')

      expect(files).toEqual([])
    })

    it('skips empty lines', () => {
      const mockResult = {
        exitCode: 0,
        stdout: 'src/a.ts\n\nsrc/b.ts\n',
        stderr: '',
      }
      vi.mocked(util.runGit).mockReturnValue(mockResult)

      const files = getTrackedFiles('/project')

      expect(files).toHaveLength(2)
    })

    it('handles exception gracefully', () => {
      vi.mocked(util.runGit).mockImplementation(() => {
        throw new Error('test error')
      })

      const files = getTrackedFiles('/project')

      expect(files).toEqual([])
    })
  })

  describe('buildMap', () => {
    it('normalizes file paths via resolveIndexPath before querying symbols', () => {
      const cwd = '/project'
      const rawFile = path.join(cwd, 'src/main.ts')

      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'src/main.ts',
        stderr: '',
      })
      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')
      vi.mocked(indexReader.querySymbols).mockReturnValue([])

      // Distinguishable transform so a call with the raw (unnormalized) path is unmistakably wrong.
      vi.mocked(paths.resolveIndexPath).mockImplementation((p: string) => `${p}::normalized`)

      buildMap(cwd)

      expect(paths.resolveIndexPath).toHaveBeenCalledWith(rawFile)
      expect(indexReader.querySymbols).toHaveBeenCalledWith({
        filePath: `${rawFile}::normalized`,
        limit: 8,
      })
    })

    it('filters out noise paths', () => {
      const cwd = '/project'
      const mockFiles = [
        path.join(cwd, 'src/main.ts'),
        path.join(cwd, 'node_modules/foo/index.ts'),
        path.join(cwd, 'src/utils.ts'),
      ]
      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'src/main.ts\nnode_modules/foo/index.ts\nsrc/utils.ts',
        stderr: '',
      })

      vi.mocked(parserTypes.detectLanguage).mockImplementation((filePath) => {
        if (filePath.includes('node_modules')) return 'unknown'
        return filePath.endsWith('.ts') ? 'typescript' : 'unknown'
      })

      vi.mocked(compact.isNoisePath).mockImplementation((filePath) => {
        return filePath.includes('node_modules')
      })

      vi.mocked(indexReader.querySymbols).mockReturnValue([
        {
          filePath: mockFiles[0],
          name: 'main',
          kind: 'function',
          lineStart: 1,
          lineEnd: 10,
          body: 'code',
          docstring: '',
        },
      ])

      vi.mocked(indexReader.getFileEntry).mockReturnValue(null)

      const entries = buildMap(cwd)

      expect(compact.isNoisePath).toHaveBeenCalled()
      expect(entries.length).toBeLessThan(3)
      expect(entries.every((e) => !e.filePath.includes('node_modules'))).toBe(true)
    })

    it('returns RepoEntry with correct structure', () => {
      const cwd = '/project'
      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'src/main.ts',
        stderr: '',
      })

      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')

      const mockSymbol = {
        filePath: path.join(cwd, 'src/main.ts'),
        name: 'getValue',
        kind: 'function',
        lineStart: 5,
        lineEnd: 15,
        body: 'code',
        docstring: 'Gets a value',
      }

      vi.mocked(indexReader.querySymbols).mockReturnValue([mockSymbol])
      vi.mocked(indexReader.getFileEntry).mockReturnValue({
        file_path: path.join(cwd, 'src/main.ts'),
        language: 'typescript',
        symbol_count: 1,
        mtime: 0,
        size: 200,
      })

      const entries = buildMap(cwd)

      expect(entries).toHaveLength(1)
      const entry = entries[0]
      expect(entry).toMatchObject({
        language: 'typescript',
        symbolCount: 1,
      })
      expect(entry.topSymbols).toEqual([{ kind: 'function', name: 'getValue' }])
    })

    it('sorts entries by symbol count descending', () => {
      const cwd = '/project'
      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'a.ts\nb.ts\nc.ts',
        stderr: '',
      })

      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')

      const symbolsByFile: Record<string, { name: string; kind: string }[]> = {
        '/project/a.ts': [{ name: 'f1', kind: 'function' }],
        '/project/b.ts': [{ name: 'f1', kind: 'function' }, { name: 'f2', kind: 'function' }],
        '/project/c.ts': [],
      }

      vi.mocked(indexReader.querySymbols).mockImplementation(({ filePath }) => {
        return symbolsByFile[filePath] ?? []
      })

      vi.mocked(indexReader.getFileEntry).mockReturnValue(null)

      const entries = buildMap(cwd)

      expect(entries.length).toBeGreaterThan(0)
      for (let i = 0; i < entries.length - 1; i++) {
        expect(entries[i].symbolCount).toBeGreaterThanOrEqual(entries[i + 1].symbolCount)
      }
    })

    // Regression: repomap.exclude_tests was validated from TOML and reported by `token-goat
    // ignores`/`doctor`, but buildMap never consulted it -- test files always showed up in
    // `token-goat map` regardless of the setting.
    it('excludes test files when repomap.exclude_tests is true', () => {
      const cwd = '/project'
      vi.mocked(loadConfig).mockReturnValue({
        repomap: { exclude_tests: true },
      } as unknown as ReturnType<typeof loadConfig>)

      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'src/main.ts\ntests/main.test.ts',
        stderr: '',
      })
      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')
      vi.mocked(util.isTestFile).mockImplementation((p: string) => p.includes('tests'))
      vi.mocked(indexReader.querySymbols).mockReturnValue([])
      vi.mocked(indexReader.getFileEntry).mockReturnValue(null)

      const entries = buildMap(cwd)

      expect(entries.some((e) => e.filePath.includes('main.ts') && !e.filePath.includes('tests'))).toBe(true)
      expect(entries.every((e) => !e.filePath.includes('tests'))).toBe(true)
    })

    it('includes test files when repomap.exclude_tests is false', () => {
      const cwd = '/project'
      vi.mocked(loadConfig).mockReturnValue({
        repomap: { exclude_tests: false },
      } as unknown as ReturnType<typeof loadConfig>)

      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'src/main.ts\ntests/main.test.ts',
        stderr: '',
      })
      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')
      vi.mocked(util.isTestFile).mockImplementation((p: string) => p.includes('tests'))
      vi.mocked(indexReader.querySymbols).mockReturnValue([])
      vi.mocked(indexReader.getFileEntry).mockReturnValue(null)

      const entries = buildMap(cwd)

      expect(entries.some((e) => e.filePath.includes('tests'))).toBe(true)
    })
  })

  describe('buildCompactMap', () => {
    it('respects maxTokens budget', () => {
      const cwd = '/project'
      const maxTokens = 500

      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: 'a.ts\nb.ts\nc.ts\nd.ts',
        stderr: '',
      })

      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')
      vi.mocked(indexReader.querySymbols).mockReturnValue([
        { name: 'test', kind: 'function', filePath: '', lineStart: 0, lineEnd: 0, body: '', docstring: '' },
      ])

      const mockEstimate = vi.fn((_text: string) => {
        return 150
      })
      vi.mocked(compact.estimateTokens).mockImplementation(mockEstimate)

      const entries = buildCompactMap(maxTokens, cwd)

      expect(mockEstimate).toHaveBeenCalled()
      entries.forEach((entry) => {
        const tokens = mockEstimate(JSON.stringify(entry))
        expect(tokens).toBeLessThanOrEqual(maxTokens)
      })
    })

    it('returns empty array for empty buildMap', () => {
      const cwd = '/project'
      vi.mocked(util.runGit).mockReturnValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
      })

      const entries = buildCompactMap(1000, cwd)

      expect(entries).toEqual([])
    })

    it('prunes files when approaching budget', () => {
      const cwd = '/project'
      const maxTokens = 100

      vi.mocked(util.runGit).mockReturnValue({
        code: 0,
        stdout: 'file1.ts\nfile2.ts\nfile3.ts',
        stderr: '',
      })

      vi.mocked(compact.isNoisePath).mockReturnValue(false)
      vi.mocked(parserTypes.detectLanguage).mockReturnValue('typescript')
      vi.mocked(indexReader.querySymbols).mockReturnValue([])

      vi.mocked(indexReader.getFileEntry).mockReturnValue(null)

      vi.mocked(compact.estimateTokens).mockReturnValue(80)

      const entries = buildCompactMap(maxTokens, cwd)

      expect(entries.length).toBeLessThanOrEqual(1)
    })
  })

  describe('formatMap', () => {
    it('returns header with file count for non-empty entries', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/project/src/main.ts',
          language: 'typescript',
          symbolCount: 5,
          topSymbols: [{ name: 'main', kind: 'function' }],
        },
      ]

      const result = formatMap(entries)

      expect(result).toContain('# Repo map (1 file)')
      expect(result).toContain('typescript 1')
      expect(result).toContain('## Files')
    })

    it('returns empty message for empty entries', () => {
      const result = formatMap([])

      expect(result).toContain('# Repo map')
      expect(result).toContain('(no tracked files)')
    })

    it('compact mode omits symbol details', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/project/src/main.ts',
          language: 'typescript',
          symbolCount: 2,
          topSymbols: [
            { name: 'func1', kind: 'function' },
            { name: 'func2', kind: 'function' },
          ],
        },
      ]

      const result = formatMap(entries, { compact: true })

      expect(result).toContain('(typescript)')
      expect(result).not.toContain('func1')
    })

    it('full mode includes symbol list', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/project/src/main.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [{ name: 'getValue', kind: 'function' }],
        },
      ]

      const result = formatMap(entries, { compact: false })

      expect(result).toContain('getValue')
      expect(result).toContain('function')
    })

    it('respects maxEntries option', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/project/a.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
        {
          filePath: '/project/b.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
        {
          filePath: '/project/c.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
      ]

      const result = formatMap(entries, { maxEntries: 2 })

      expect(result).toContain('a.ts')
      expect(result).toContain('b.ts')
      expect(result).not.toContain('c.ts')
    })

    it('tallies language counts', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/project/a.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
        {
          filePath: '/project/b.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
        {
          filePath: '/project/c.py',
          language: 'python',
          symbolCount: 1,
          topSymbols: [],
        },
      ]

      const result = formatMap(entries)

      expect(result).toContain('typescript 2')
      expect(result).toContain('python 1')
    })

    it('uses cwd option instead of process.cwd() for relative paths', () => {
      const entries: RepoEntry[] = [
        {
          filePath: '/custom/base/src/index.ts',
          language: 'typescript',
          symbolCount: 1,
          topSymbols: [],
        },
      ]

      const result = formatMap(entries, { cwd: '/custom/base' })

      // path.relative('/custom/base', '/custom/base/src/index.ts') = 'src/index.ts'
      expect(result).toContain('src')
      expect(result).toContain('index.ts')
      // Should not show an absolute path when cwd matches the entry base
      expect(result).not.toContain('/custom/base/src/index.ts')
    })
  })
})
