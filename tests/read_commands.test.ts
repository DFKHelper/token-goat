import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Stub the DB-layer imports so tests don't need a real SQLite DB
vi.mock('../src/index_reader.js', () => ({
  querySymbols: vi.fn(() => []),
  queryRefs: vi.fn(() => []),
  getFileEntry: vi.fn(() => null),
  queryRefCounts: vi.fn(() => new Map()),
}))

vi.mock('../src/section_reader.js', () => ({
  readSection: vi.fn(() => null),
  listSections: vi.fn(() => []),
  listAllSections: vi.fn(() => []),
  extractSection: vi.fn(() => null),
  findContainingSection: vi.fn(() => null),
}))

vi.mock('../src/graph_commands.js', () => ({
  resolveCallers: vi.fn(() => []),
}))

vi.mock('../src/parser.js', () => ({
  indexFileSync: vi.fn(),
}))

vi.mock('../src/hooks_index.js', () => ({
  appendDirtyPath: vi.fn(),
}))

vi.mock('../src/constants.js', () => ({
  globalDbPath: vi.fn(() => ':memory:'),
}))

// Partial-mock util so runGit is controllable while ensureNewline (used by emit) keeps its real behavior.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, runGit: vi.fn() }
})

// Stub config so overflow-guard tests can set a small max_tokens without writing a real
// config.toml; other tests get a permissive default (enabled, 25000) from beforeEach below.
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

import {
  runSymbol,
  runRead,
  runSection,
  runSkeleton,
  runOutline,
  runFind,
  runListSections,
  runGrep,
  runConfigGet,
  runCsvProfile,
  runCsvQuery,

  runExports,
  runChanged,
  runRefs,
  runBrief,
  extractImports,
  extractExportNames,
  extractTranscriptText,
  parseDiffHunks,
} from '../src/read_commands.js'
import { querySymbols, queryRefs, queryRefCounts, getFileEntry } from '../src/index_reader.js'
import { runGit } from '../src/util.js'
import { resolveIndexPath } from '../src/paths.js'
import { readSection, listSections, listAllSections, findContainingSection } from '../src/section_reader.js'
import { loadConfig } from '../src/config.js'
import { indexFileSync } from '../src/parser.js'
import { resolveCallers } from '../src/graph_commands.js'
import { resolveProjectRoot } from '../src/project.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { appendDirtyPath } from '../src/hooks_index.js'

const mockQuerySymbols = vi.mocked(querySymbols)
const mockAppendDirtyPath = vi.mocked(appendDirtyPath)
const mockQueryRefCounts = vi.mocked(queryRefCounts)
const mockGetFileEntry = vi.mocked(getFileEntry)
const mockFindContainingSection = vi.mocked(findContainingSection)
const mockResolveCallers = vi.mocked(resolveCallers)
const mockQueryRefs = vi.mocked(queryRefs)
const mockReadSection = vi.mocked(readSection)
const mockListSections = vi.mocked(listSections)
const mockListAllSections = vi.mocked(listAllSections)
const mockIndexFileSync = vi.mocked(indexFileSync)
const mockLoadConfig = vi.mocked(loadConfig)

/** Capture stdout/stderr for a function call. */
function capture(fn: () => void): { stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stdout as any).write = (s: string) => { stdout += s; return true }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(process.stderr as any).write = (s: string) => { stderr += s; return true }
  try {
    fn()
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stdout as any).write = origOut
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(process.stderr as any).write = origErr
  }
  return { stdout, stderr }
}

type MockSymbol = {
  name: string
  kind: string
  filePath: string
  lineStart: number
  lineEnd: number
  body: string
  docstring: string
}

describe('read_commands', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-read-cmds-'))
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
    // resolveProjectRoot (project.ts, not mocked here) calls runGit internally to find the repo
    // top-level; default to "not a git repo" so it falls through to its findProject/cwd fallback
    // instead of exploding on the bare vi.fn() this file's util.js mock otherwise leaves runGit
    // as. Individual tests below (e.g. runChanged) override this per-test as needed.
    vi.mocked(runGit).mockReturnValue({ exitCode: 1, stdout: '', stderr: 'not a git repo' })
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- runSymbol ----------------------------------------------------------

  describe('runSymbol', () => {
    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text: stderr } = runSymbol({ name: 'missing' })
      expect(stderr).toContain('missing')
    })

    it('returns 0 and prints symbols when found', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'src/foo.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      mockQuerySymbols.mockReturnValue([sym as Parameters<typeof mockQuerySymbols>[0] extends infer _O ? never : never] as unknown as ReturnType<typeof mockQuerySymbols>)
      const { text: stdout } = runSymbol({ name: 'myFunc' })
      expect(stdout).toContain('myFunc')
    })

    it('emits JSON when json flag is set', () => {
      const sym: MockSymbol = { name: 'fn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'function fn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text: stdout } = runSymbol({ name: 'fn', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(Array.isArray(parsed.items)).toBe(true)
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(1)
    })

    it('caps --json output at overflow_guard.max_tokens, wrapping with items/truncated/totalCount instead of emitting an unbounded array (regression: JSON mode had no overflow guard at all, unlike the text branch\'s guardText)', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 60 },
      } as unknown as ReturnType<typeof loadConfig>)
      const syms: MockSymbol[] = Array.from({ length: 50 }, (_, i) => ({
        name: `fn${i}`,
        kind: 'function',
        filePath: 'a.ts',
        lineStart: i * 10 + 1,
        lineEnd: i * 10 + 5,
        body: 'x'.repeat(50),
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSymbol({ name: 'fn', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.truncated).toBe(true)
      expect(parsed.totalCount).toBe(50)
      expect(parsed.items.length).toBeLessThan(50)
    })

    it('uses the same items/truncated/totalCount envelope even when overflow_guard is disabled and nothing was truncated (uniform --json shape regardless of truncation)', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: false, max_tokens: 60 },
      } as unknown as ReturnType<typeof loadConfig>)
      const syms: MockSymbol[] = Array.from({ length: 50 }, (_, i) => ({
        name: `fn${i}`,
        kind: 'function',
        filePath: 'a.ts',
        lineStart: i * 10 + 1,
        lineEnd: i * 10 + 5,
        body: 'x'.repeat(50),
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSymbol({ name: 'fn', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(50)
      expect(parsed.items.length).toBe(50)
    })

    it('reconstructs an empty indexed body from its source span for the preview', () => {
      const filePath = path.join(tempDir, 'Example.profile-meta.xml')
      fs.writeFileSync(filePath, '<Profile>\n  <label>Example</label>\n</Profile>\n')
      const sym: MockSymbol = {
        name: 'Example',
        kind: 'sf_profile',
        filePath,
        lineStart: 1,
        lineEnd: 3,
        body: '',
        docstring: '',
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])

      const { text: stdout } = runSymbol({ name: 'Example' })

      expect(stdout).toContain('<Profile>')
      expect(stdout).toContain('<label>Example</label>')
    })

    it('resolves the filePath filter to the index key before querying', () => {
      mockQuerySymbols.mockReturnValue([])
      runSymbol({ name: 'x', file: 'src/bar.ts' })
      // The index is keyed by normalizePath(absolute); a raw relative path would never match an exact `file_path = ?` lookup, so the command must resolve.
      expect(mockQuerySymbols).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: resolveIndexPath('src/bar.ts') }),
      )
      const arg = mockQuerySymbols.mock.calls[0]?.[0] as { filePath?: string }
      expect(arg.filePath).not.toBe('src/bar.ts')
      expect(path.isAbsolute(arg.filePath ?? '')).toBe(true)
    })

    it('prepends a stale-index warning when a file-scoped query targets an index row whose sha is stale (#1)', () => {
      const content = 'export function foo() {}\n'
      const f = path.join(tempDir, 'stale-symbol.ts')
      fs.writeFileSync(f, content)
      const sym: MockSymbol = { name: 'foo', kind: 'function', filePath: f, lineStart: 1, lineEnd: 1, body: content, docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockGetFileEntry.mockReturnValueOnce({
        filePath: f, sha: 'not-the-real-sha256-of-this-file', mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
      } as never)
      const { text: stdout } = runSymbol({ name: 'foo', file: f })
      expect(stdout).toContain('STALE')
      expect(stdout).toContain('foo')
    })

    it('does not warn on a broad (file-less) symbol query, since there is no single file to stale-check', () => {
      const content = 'export function foo() {}\n'
      const f = path.join(tempDir, 'broad-symbol.ts')
      fs.writeFileSync(f, content)
      const sym: MockSymbol = { name: 'foo', kind: 'function', filePath: f, lineStart: 1, lineEnd: 1, body: content, docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text: stdout } = runSymbol({ name: 'foo' })
      expect(stdout).not.toContain('STALE')
      expect(mockGetFileEntry).not.toHaveBeenCalled()
    })

    // `LIMIT 0` in SQL always returns zero rows, so a symbol that genuinely exists would
    // otherwise be reported as "no matches" -- a wrong answer, not just a permissive input.
    // limit: 0 (or negative) must be rejected up front instead of reaching querySymbols.
    it('rejects limit: 0 as an explicit invalid-argument error instead of querying with it', () => {
      const sym: MockSymbol = { name: 'loadGrammar', kind: 'function', filePath: 'src/parser.ts', lineStart: 1, lineEnd: 2, body: 'function loadGrammar() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text, code } = runSymbol({ name: 'loadGrammar', limit: 0 })
      expect(code).toBe(1)
      expect(text).not.toContain('No matches')
      expect(text.toLowerCase()).toContain('limit')
      expect(mockQuerySymbols).not.toHaveBeenCalled()
    })

    it('rejects a negative limit as an explicit invalid-argument error', () => {
      const { text, code } = runSymbol({ name: 'x', limit: -1 })
      expect(code).toBe(1)
      expect(text.toLowerCase()).toContain('limit')
      expect(mockQuerySymbols).not.toHaveBeenCalled()
    })
  })

  // ---- runRead ------------------------------------------------------------

  describe('runRead', () => {
    it('reads a plain file when no :: separator', () => {
      const f = path.join(tempDir, 'plain.txt')
      fs.writeFileSync(f, 'hello world')
      const { text: stdout } = runRead({ spec: f })
      expect(stdout).toContain('hello world')
    })

    it('caps an oversized plain-file dump per config.overflow_guard.max_tokens (#52)', () => {
      // Regression: checkOverflow/trimToBudget had zero production callers, so tuning
      // config.overflow_guard.max_tokens did nothing. Fails on pre-fix code (full content
      // passes through untouched, no marker) and passes once runRead's whole-file emit
      // routes through emitGuarded.
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 50 },
      } as unknown as ReturnType<typeof loadConfig>)
      const f = path.join(tempDir, 'huge.txt')
      fs.writeFileSync(f, 'x'.repeat(2000))
      const { text: stdout } = runRead({ spec: f })
      expect(stdout).toContain('output capped at ~50 tokens')
      expect(stdout).not.toContain('x'.repeat(2000))
    })

    it('does not cap the plain-file dump when overflow_guard is disabled (real no-op)', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: false, max_tokens: 50 },
      } as unknown as ReturnType<typeof loadConfig>)
      const f = path.join(tempDir, 'huge2.txt')
      const body = 'x'.repeat(2000)
      fs.writeFileSync(f, body)
      const { text: stdout } = runRead({ spec: f })
      expect(stdout).toContain(body)
      expect(stdout).not.toContain('output capped at')
    })

    it('returns 1 when file does not exist', () => {
      const { code } = runRead({ spec: path.join(tempDir, 'nope.txt') })
      expect(code).toBe(1)
    })

    it('returns 1 when symbol not found', () => {
      mockQuerySymbols.mockReturnValue([])
      const { code } = runRead({ spec: 'src/foo.ts::missing' })
      expect(code).toBe(1)
    })

    it('prints body when symbol found', () => {
      const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn' })
      expect(stdout).toContain('myFn')
    })

    it('reconstructs an empty indexed body from its source span', () => {
      const filePath = path.join(tempDir, 'Example.profile-meta.xml')
      fs.writeFileSync(filePath, '<Profile>\n  <label>Example</label>\n</Profile>\n')
      const sym: MockSymbol = {
        name: 'Example',
        kind: 'sf_profile',
        filePath,
        lineStart: 1,
        lineEnd: 3,
        body: '',
        docstring: '',
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])

      const { text: stdout } = runRead({ spec: `${filePath}::Example` })

      expect(stdout).toContain('<Profile>')
      expect(stdout).toContain('<label>Example</label>')
      expect(stdout).toContain('</Profile>')
    })

    it('caps an oversized symbol body and tags the truncation hint for "symbol" (#52)', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 50 },
      } as unknown as ReturnType<typeof loadConfig>)
      const sym: MockSymbol = { name: 'hugeFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 500, body: 'x'.repeat(2000), docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text: stdout } = runRead({ spec: 'src/foo.ts::hugeFn' })
      expect(stdout).toContain('output capped at ~50 tokens')
      expect(stdout).toContain('Request a specific method (file.py::Class.method) or use --json for structured access.')
      expect(stdout).not.toContain('x'.repeat(2000))
    })

    it('prints correct line count in header (inclusive both ends)', () => {
      // lineStart=5, lineEnd=10 spans 6 lines, not 5
      const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 5, lineEnd: 10, body: 'function myFn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn' })
      expect(stdout).toContain('# 6 lines')
    })

    it('looks up the leaf segment for a two-part dotted symbol', () => {
      mockQuerySymbols.mockReturnValue([])
      runRead({ spec: 'src/foo.ts::Session.refresh' })
      expect(mockQuerySymbols).toHaveBeenCalledWith(expect.objectContaining({ name: 'refresh' }))
    })

    it('looks up the LAST segment (not the middle) for a 3+ part dotted symbol', () => {
      // Methods are indexed by bare leaf name; "Outer.Inner.refresh" must resolve to the method `refresh`, never the middle class `Inner`.
      mockQuerySymbols.mockReturnValue([])
      runRead({ spec: 'src/foo.ts::Outer.Inner.refresh' })
      expect(mockQuerySymbols).toHaveBeenCalledWith(expect.objectContaining({ name: 'refresh' }))
      expect(mockQuerySymbols).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Inner' }))
    })

    it('resolves a literal dotted symbol name via exact match before falling back to Class.method splitting (e.g. a TOML section)', () => {
      const tomlSection: MockSymbol = { name: 'tool.poetry', kind: 'section', filePath: 'pyproject.toml', lineStart: 4, lineEnd: 4, body: '[tool.poetry]', docstring: '' }
      mockQuerySymbols.mockImplementation((opts: { name?: string }) => {
        if (opts.name === 'tool.poetry') return [tomlSection] as unknown as ReturnType<typeof mockQuerySymbols>
        return []
      })
      const { text: stdout } = runRead({ spec: 'pyproject.toml::tool.poetry' })
      expect(stdout).toContain('[tool.poetry]')
    })

    it('does not let a bare filename match an indexed path with a different prefix in the partial-path fallback (M34)', () => {
      // 'src/myutils.ts'.endsWith('utils.ts') is true, but requesting `utils.ts` must not
      // resolve to a completely different file that merely happens to share a suffix.
      const wrongMatch: MockSymbol = { name: 'helper', kind: 'function', filePath: 'src/myutils.ts', lineStart: 1, lineEnd: 3, body: 'function helper() {}', docstring: '' }
      mockQuerySymbols.mockImplementation((opts: { filePath?: string }) => {
        if (opts.filePath !== undefined) return []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return [wrongMatch as any]
      })
      const { code } = runRead({ spec: 'utils.ts::helper' })
      expect(code).toBe(1)
    })

    it('does match a real path-segment boundary in the partial-path fallback (M34)', () => {
      const rightMatch: MockSymbol = { name: 'helper', kind: 'function', filePath: 'src/utils.ts', lineStart: 1, lineEnd: 3, body: 'function helper() {}', docstring: '' }
      mockQuerySymbols.mockImplementation((opts: { filePath?: string }) => {
        if (opts.filePath !== undefined) return []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return [rightMatch as any]
      })
      const { text: stdout } = runRead({ spec: 'utils.ts::helper' })
      expect(stdout).toContain('helper')
    })

    it('disambiguates a dotted symbol by its class qualifier when two classes share a method name (M35)', () => {
      // ClassA and ClassB both define `render`; `ClassB.render` must resolve to ClassB's copy,
      // not silently fall through to whichever same-named method the index happens to list first.
      const classB: MockSymbol = { name: 'ClassB', kind: 'class', filePath: 'src/comp.ts', lineStart: 20, lineEnd: 30, body: 'class ClassB {}', docstring: '' }
      const renderInA: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 3, lineEnd: 5, body: 'ClassA.render body', docstring: '' }
      const renderInB: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 22, lineEnd: 24, body: 'ClassB.render body', docstring: '' }
      mockQuerySymbols.mockImplementation((opts: { name?: string }) => {
        if (opts.name === 'render') return [renderInA, renderInB] as unknown as ReturnType<typeof mockQuerySymbols>
        if (opts.name === 'ClassB') return [classB] as unknown as ReturnType<typeof mockQuerySymbols>
        return []
      })
      const { text: stdout } = runRead({ spec: 'src/comp.ts::ClassB.render' })
      expect(stdout).toContain('ClassB.render body')
      expect(stdout).not.toContain('ClassA.render body')
    })

    it('disambiguates a dotted symbol by docstring parent when the class symbol is a single-line span (regex adapters, M35b)', () => {
      // Regex-parsed languages (php.ts, csharp.ts, kotlin.ts, powershell_idx.ts) store a
      // class symbol at lineStart === lineEnd (the header line only, not the full body), so
      // the line-containment check the M35 test above exercises always misses for them. These
      // adapters instead record the parent class name in the method symbol's own docstring
      // field. B.foo must resolve to B's copy via that docstring match, not silently fall
      // through to whichever same-named method the index lists first.
      const classA: MockSymbol = { name: 'A', kind: 'class', filePath: 'src/widget.php', lineStart: 1, lineEnd: 1, body: 'class A {', docstring: '' }
      const classB: MockSymbol = { name: 'B', kind: 'class', filePath: 'src/widget.php', lineStart: 10, lineEnd: 10, body: 'class B {', docstring: '' }
      const fooInA: MockSymbol = { name: 'foo', kind: 'method', filePath: 'src/widget.php', lineStart: 3, lineEnd: 5, body: 'A.foo body', docstring: 'A' }
      const fooInB: MockSymbol = { name: 'foo', kind: 'method', filePath: 'src/widget.php', lineStart: 12, lineEnd: 14, body: 'B.foo body', docstring: 'B' }
      mockQuerySymbols.mockImplementation((opts: { name?: string }) => {
        if (opts.name === 'foo') return [fooInA, fooInB] as unknown as ReturnType<typeof mockQuerySymbols>
        if (opts.name === 'B') return [classB] as unknown as ReturnType<typeof mockQuerySymbols>
        if (opts.name === 'A') return [classA] as unknown as ReturnType<typeof mockQuerySymbols>
        return []
      })
      const { text: stdout } = runRead({ spec: 'src/widget.php::B.foo' })
      expect(stdout).toContain('B.foo body')
      expect(stdout).not.toContain('A.foo body')
    })

    describe('ambiguous resolution (formatAmbiguity)', () => {
      // Generic pool-filter mock: matches real querySymbols' AND-of-provided-fields semantics
      // (unlike other tests in this file, which special-case each expected call by hand) so a
      // spec resolved through the ambiguity path and then fed back in via a suggested retry
      // both go through the exact same filtering logic.
      function poolMock(pool: MockSymbol[]): void {
        mockQuerySymbols.mockImplementation((opts: { name?: string; filePath?: string }) => {
          let rows = pool
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })
      }

      it('same-file ambiguity: labels stay unprefixed by file, retry re-targets the original file spec (M35 regression, format unchanged)', () => {
        const classA: MockSymbol = { name: 'ClassA', kind: 'class', filePath: 'src/comp.ts', lineStart: 1, lineEnd: 10, body: 'class ClassA {}', docstring: '' }
        const classB: MockSymbol = { name: 'ClassB', kind: 'class', filePath: 'src/comp.ts', lineStart: 20, lineEnd: 30, body: 'class ClassB {}', docstring: '' }
        const renderInA: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 3, lineEnd: 5, body: 'ClassA.render body', docstring: '' }
        const renderInB: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 22, lineEnd: 24, body: 'ClassB.render body', docstring: '' }
        poolMock([classA, classB, renderInA, renderInB])

        const { text: stdout, code } = runRead({ spec: 'src/comp.ts::render' })
        expect(code).toBe(1)
        expect(stdout).toContain("Ambiguous symbol 'render'")
        expect(stdout).toContain('  - ClassA.render (line 3)')
        expect(stdout).toContain('  - ClassB.render (line 22)')
        // Same-file candidates: the label itself (before the arrow) carries no file-path prefix.
        expect(stdout).not.toContain('src/comp.ts::ClassA.render (line')
        expect(stdout).not.toContain('src/comp.ts::ClassB.render (line')
        // Retry re-targets the original (already-unambiguous-per-file) spec, byte-for-byte
        // unchanged from the pre-fix same-file suggestion.
        expect(stdout).toContain('token-goat read "src/comp.ts::ClassA.render"')
        expect(stdout).toContain('token-goat read "src/comp.ts::ClassB.render"')

        // The suggested retries must actually resolve, unambiguously, to the right body.
        const a = runRead({ spec: 'src/comp.ts::ClassA.render' })
        expect(a.text).toContain('ClassA.render body')
        expect(a.text).not.toContain('ClassB.render body')
        const b = runRead({ spec: 'src/comp.ts::ClassB.render' })
        expect(b.text).toContain('ClassB.render body')
        expect(b.text).not.toContain('ClassA.render body')
      })

      it('cross-file ambiguity: two different files each defining a same-named top-level symbol get distinguishable labels and per-file working retries', () => {
        // findParentName has no cross-file concept of "parent" -- both candidates are genuine
        // top-level definitions in different files, so it returns null for both. Before the
        // fix both rendered as the identical "- helper (line N)" with no file shown.
        const fileA = resolveIndexPath('src/utils.ts')
        const fileB = resolveIndexPath('lib/utils.ts')
        const helperInA: MockSymbol = { name: 'helper', kind: 'function', filePath: fileA, lineStart: 3, lineEnd: 5, body: 'function helper() { return 1 }', docstring: '' }
        const helperInB: MockSymbol = { name: 'helper', kind: 'function', filePath: fileB, lineStart: 7, lineEnd: 9, body: 'function helper() { return 2 }', docstring: '' }
        poolMock([helperInA, helperInB])

        const { text: stdout, code } = runRead({ spec: 'utils.ts::helper' })
        expect(code).toBe(1)
        expect(stdout).toContain("Ambiguous symbol 'helper'")
        // Distinguishable: each label carries its own file path, not an identical bare "helper (line N)".
        expect(stdout).toContain(`  - ${fileA}::helper (line 3)`)
        expect(stdout).toContain(`  - ${fileB}::helper (line 7)`)
        // Each retry targets that candidate's own file -- not the original ambiguous "utils.ts" spec,
        // which would just re-enter this same ambiguous resolution path.
        expect(stdout).toContain(`token-goat read "${fileA}::helper"`)
        expect(stdout).toContain(`token-goat read "${fileB}::helper"`)
        expect(stdout).not.toMatch(/token-goat read "utils\.ts::/)

        // Feed the exact printed retry specs back in and confirm each resolves to exactly one,
        // correct, distinct candidate -- not just that the text looks right.
        const retries = [...stdout.matchAll(/token-goat read "([^"]+)"/g)].map((m) => m[1] ?? '')
        expect(retries).toHaveLength(2)
        const a = runRead({ spec: retries[0]! })
        expect(a.code).toBe(0)
        expect(a.text).toContain('return 1')
        expect(a.text).not.toContain('return 2')
        const b = runRead({ spec: retries[1]! })
        expect(b.code).toBe(0)
        expect(b.text).toContain('return 2')
        expect(b.text).not.toContain('return 1')
      })

      it('mixed ambiguity: same-file-with-parent and cross-file-without-parent candidates in one list all get distinct, working retries', () => {
        const fileA = resolveIndexPath('src/compress.ts')
        const fileB = resolveIndexPath('lib/compress.ts')
        const classA: MockSymbol = { name: 'ClassA', kind: 'class', filePath: fileA, lineStart: 1, lineEnd: 10, body: '', docstring: '' }
        const classB: MockSymbol = { name: 'ClassB', kind: 'class', filePath: fileA, lineStart: 20, lineEnd: 30, body: '', docstring: '' }
        const compressInA: MockSymbol = { name: 'compress', kind: 'method', filePath: fileA, lineStart: 3, lineEnd: 5, body: 'A:compress', docstring: '' }
        const compressInB: MockSymbol = { name: 'compress', kind: 'method', filePath: fileA, lineStart: 22, lineEnd: 24, body: 'B:compress', docstring: '' }
        const compressTop: MockSymbol = { name: 'compress', kind: 'function', filePath: fileB, lineStart: 7, lineEnd: 9, body: 'top:compress', docstring: '' }
        poolMock([classA, classB, compressInA, compressInB, compressTop])

        const { text: stdout, code } = runRead({ spec: 'compress.ts::compress' })
        expect(code).toBe(1)
        expect(stdout).toContain("Ambiguous symbol 'compress'")
        // Cross-file span -> every label is file-prefixed, even the ones with a same-file parent.
        expect(stdout).toContain(`  - ${fileA}::ClassA.compress (line 3)`)
        expect(stdout).toContain(`  - ${fileA}::ClassB.compress (line 22)`)
        expect(stdout).toContain(`  - ${fileB}::compress (line 7)`)

        const retries = [...stdout.matchAll(/token-goat read "([^"]+)"/g)].map((m) => m[1] ?? '')
        expect(retries).toHaveLength(3)
        const results = retries.map((spec) => runRead({ spec }))
        for (const r of results) expect(r.code).toBe(0)
        expect(results.map((r) => r.text.includes('A:compress'))).toContain(true)
        expect(results.map((r) => r.text.includes('B:compress'))).toContain(true)
        expect(results.map((r) => r.text.includes('top:compress'))).toContain(true)
        // Each retry must resolve to exactly its own candidate, not leak a sibling's body.
        expect(results[0]!.text).not.toContain('B:compress')
        expect(results[0]!.text).not.toContain('top:compress')
        expect(results[1]!.text).not.toContain('A:compress')
        expect(results[1]!.text).not.toContain('top:compress')
        expect(results[2]!.text).not.toContain('A:compress')
        expect(results[2]!.text).not.toContain('B:compress')
      })
    })

    it('splits on the LAST :: so a file path containing a literal :: still resolves the correct symbol (#m2)', () => {
      mockQuerySymbols.mockReturnValue([])
      runRead({ spec: 'a::b::mySymbol' })
      expect(mockQuerySymbols).toHaveBeenCalledWith(expect.objectContaining({ name: 'mySymbol' }))
    })

    // ---- line-range reads (file@N-M) --------------------------------------
    // These exercise the @N-M syntax the Python build had and the TS port dropped. Each asserts on sliced content, so it fails on pre-feature code (where `file@2-4` fell through to symbol resolution and errored "Could not read") and passes once the range path exists.
    describe('line-range reads (file@N-M)', () => {
      function rangeFile(): string {
        const f = path.join(tempDir, 'lines.txt')
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive\n')
        return f
      }

      it('reads an inclusive N-M range', () => {
        const { text: stdout } = runRead({ spec: `${rangeFile()}@2-4` })
        expect(stdout).toContain('two\nthree\nfour')
        expect(stdout).not.toContain('one')
        expect(stdout).not.toContain('five')
      })

      it('reads a single line with @N', () => {
        const { text: stdout } = runRead({ spec: `${rangeFile()}@3` })
        expect(stdout).toContain('three')
        expect(stdout).not.toContain('two')
        expect(stdout).not.toContain('four')
      })

      it('does not count a trailing newline as an extra line', () => {
        const { text: stdout } = runRead({ spec: `${rangeFile()}@1-99` })
        expect(stdout).toContain('# lines 1-5 of 5')
        expect(stdout.trimEnd().endsWith('five')).toBe(true)
      })

      it('clamps an end past EOF to the last line', () => {
        const { text: stdout } = runRead({ spec: `${rangeFile()}@4-100` })
        expect(stdout).toContain('four\nfive')
        expect(stdout).toContain('# lines 4-5 of 5')
      })

      it('errors when start > end', () => {
        const { text: stderr, code } = runRead({ spec: `${rangeFile()}@5-2` })
        expect(code).toBe(1)
        expect(stderr).toContain('before start')
      })

      it('errors when start < 1', () => {
        // Assert the range-specific message, not just the exit code: a plain file-not-found also returns 1, so a code-only check would pass even with the range path disabled.
        const { text: stderr, code } = runRead({ spec: `${rangeFile()}@0-3` })
        expect(code).toBe(1)
        expect(stderr).toContain('start must be >= 1')
      })

      it('errors when start is past EOF', () => {
        const { text: stderr, code } = runRead({ spec: `${rangeFile()}@99` })
        expect(code).toBe(1)
        expect(stderr).toContain('past end of file')
      })

      it('reads an out-of-project path without consulting the index', () => {
        // Line-range reads must not require an indexed project (closes the out-of-project read gap). The symbol index is never queried.
        const { text: stdout } = runRead({ spec: `${rangeFile()}@2-3` })
        expect(stdout).toContain('two\nthree')
        expect(mockQuerySymbols).not.toHaveBeenCalled()
      })

      it('emits structured JSON with the json flag', () => {
        const { text: stdout } = runRead({ spec: `${rangeFile()}@2-3`, json: true })
        const parsed = JSON.parse(stdout) as { start: number; end: number; lines: string[] }
        expect(parsed.start).toBe(2)
        expect(parsed.end).toBe(3)
        expect(parsed.lines).toEqual(['two', 'three'])
      })

      it('still resolves :: as a symbol, not a range', () => {
        mockQuerySymbols.mockReturnValue([])
        runRead({ spec: 'src/foo.ts::myFn' })
        expect(mockQuerySymbols).toHaveBeenCalled()
      })

      it('caps an oversized line-range slice and tags the truncation hint for "lines" (#52)', () => {
        mockLoadConfig.mockReturnValue({
          overflow_guard: { enabled: true, max_tokens: 50 },
        } as unknown as ReturnType<typeof loadConfig>)
        const f = path.join(tempDir, 'biglines.txt')
        const bigLines = Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(10)).join('\n')
        fs.writeFileSync(f, bigLines)
        const { text: stdout } = runRead({ spec: `${f}@1-200` })
        expect(stdout).toContain('output capped at ~50 tokens')
        expect(stdout).toContain("Request a smaller line range, e.g. 'file.py@100-150'.")
      })

      it('uses stale index by default when file is modified externally', () => {
        const oldContent = 'export function oldSymbol() {\n  return 1\n}'
        const f = path.join(tempDir, 'stale.ts')
        fs.writeFileSync(f, oldContent)
        mockQuerySymbols.mockReturnValue([
          {
            name: 'oldSymbol',
            filePath: f,
            lineStart: 1,
            lineEnd: 3,
            body: oldContent,
          } as never,
        ])
        const newContent = 'export function newSymbol() {\n  return 2\n}'
        fs.writeFileSync(f, newContent)
        const { text: stdout } = runRead({ spec: `${f}::oldSymbol` })
        expect(stdout).toContain('oldSymbol')
      })

      it('prepends a stale-index warning when the indexed sha differs from the on-disk file sha (#1)', () => {
        const content = 'export function foo() {\n  return 1\n}'
        const f = path.join(tempDir, 'stale-sha-read.ts')
        fs.writeFileSync(f, content)
        mockQuerySymbols.mockReturnValue([
          { name: 'foo', filePath: f, lineStart: 1, lineEnd: 3, body: content } as never,
        ])
        mockGetFileEntry.mockReturnValueOnce({
          filePath: f, sha: 'not-the-real-sha256-of-this-file', mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
        } as never)
        const { text: stdout } = runRead({ spec: `${f}::foo` })
        expect(stdout).toContain('STALE')
        expect(stdout).toContain('foo')
      })

      it('does not warn when the indexed sha matches the current on-disk file', () => {
        const content = 'export function foo() {\n  return 1\n}'
        const f = path.join(tempDir, 'fresh-sha-read.ts')
        fs.writeFileSync(f, content)
        mockQuerySymbols.mockReturnValue([
          { name: 'foo', filePath: f, lineStart: 1, lineEnd: 3, body: content } as never,
        ])
        mockGetFileEntry.mockReturnValueOnce({
          filePath: f, sha: fingerprintContent(content), mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
        } as never)
        const { text: stdout } = runRead({ spec: `${f}::foo` })
        expect(stdout).not.toContain('STALE')
      })

      it('refreshes stale index when --force-refresh is set', () => {
        const f = path.join(tempDir, 'refresh.ts')
        const oldContent = 'export function oldSymbol() {\n  return 1\n}'
        fs.writeFileSync(f, oldContent)
        mockQuerySymbols.mockReturnValue([
          {
            name: 'newSymbol',
            filePath: f,
            lineStart: 1,
            lineEnd: 3,
            body: 'export function newSymbol() {\n  return 2\n}',
          } as never,
        ])
        runRead({ spec: `${f}::newSymbol`, forceRefresh: true })
        expect(mockIndexFileSync).toHaveBeenCalled()
        // Regression: a --force-refresh reindexFileSync call wipes files.embed_sha (writeParseResult
        // deletes and reinserts the files row without one) but, before this fix, never enqueued the
        // file for the worker to re-embed -- token-goat semantic would then serve stale embedded
        // content (or match nothing) for this file indefinitely. Mirrors cmdReplace's (cli.ts)
        // enqueueDirtyPathSafe call after its own write.
        expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath(f))
      })

      it('does not enqueue the dirty queue when --force-refresh is not set', () => {
        const f = path.join(tempDir, 'no-refresh.ts')
        fs.writeFileSync(f, 'export function foo() {\n  return 1\n}')
        mockQuerySymbols.mockReturnValue([
          { name: 'foo', filePath: f, lineStart: 1, lineEnd: 3, body: 'export function foo() {}' } as never,
        ])
        runRead({ spec: `${f}::foo` })
        expect(mockAppendDirtyPath).not.toHaveBeenCalled()
      })

      it('prefers reading a real file named "notes@2024" over treating it as a line-range spec', () => {
        const f = path.join(tempDir, 'notes@2024')
        const content = 'file content with @ in name'
        fs.writeFileSync(f, content)
        const { text: stdout } = runRead({ spec: f })
        expect(stdout).toContain('file content with @ in name')
      })

      it('still correctly reads a line range when the stripped base file does not exist (file@N-M with no file)', () => {
        const f = path.join(tempDir, 'nonexistent.txt')
        // The file does NOT exist, so @2-4 should try to be a range read and fail with "file not found" or similar
        const { text: stderr, code } = runRead({ spec: `${f}@2-4` })
        expect(code).toBe(1)
        // Should complain about file not existing, not about line range parsing
        expect(stderr).toContain('nonexistent.txt')
      })
    })
  })

  // ---- runSection ---------------------------------------------------------

  describe('runSection', () => {
    it('returns 1 for invalid spec without ::', () => {
      const { code } = runSection({ spec: 'no-separator' })
      expect(code).toBe(1)
    })

    it('splits on the LAST :: so a file path containing a literal :: still resolves the correct heading (#m2)', () => {
      mockReadSection.mockReturnValue(null)
      mockListAllSections.mockReturnValue([])
      runSection({ spec: 'a::b::Heading' })
      expect(mockReadSection).toHaveBeenCalledWith('a::b', 'Heading')
    })

    it('returns 1 when section not found', () => {
      mockReadSection.mockReturnValue(null)
      mockListAllSections.mockReturnValue(['Other'])
      const { text: stderr } = runSection({ spec: 'README.md::Install' })
      expect(stderr).toContain('Install')
    })

    it('caps the heading list on section miss at DIDYOUMEAN_LIMIT (5), matching runRead\'s "did you mean" cap, instead of dumping every heading (regression: unbounded "Available sections" dump)', () => {
      mockReadSection.mockReturnValue(null)
      mockListAllSections.mockReturnValue([
        'Title', 'Introduction', 'Installation', 'Usage', 'API Reference', 'Contributing', 'License',
      ])
      const { text: stderr } = runSection({ spec: 'README.md::Nonexistent' })
      expect(stderr).toContain('Did you mean')
      expect(stderr).toContain('Title')
      expect(stderr).toContain('Introduction')
      expect(stderr).toContain('Installation')
      expect(stderr).toContain('Usage')
      expect(stderr).toContain('API Reference')
      // Only the first 5 candidates are shown — 'Contributing' and 'License' are suppressed.
      expect(stderr).not.toContain('Contributing')
      expect(stderr).not.toContain('License')
    })

    it('prints section content when found', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '## Install\nrun npm install', heading: 'Install', startLine: 5, endLine: 10 } as any)
      const { text: stdout } = runSection({ spec: 'README.md::Install' })
      expect(stdout).toContain('npm install')
    })

    it('annotates the header with a redirect note when a prefix redirect resolved it (#92)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Business / logic\nbody', heading: 'Business / logic', lineStart: 1, lineEnd: 2, redirectedFrom: 'Business' } as any)
      const { text: stdout } = runSection({ spec: 'doc.md::Business' })
      expect(stdout).toContain("redirected from: 'Business'")
      expect(stdout).toContain('Business / logic')
    })

    it('omits the redirect note on an exact match (#92)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Setup\nbody', heading: 'Setup', lineStart: 1, lineEnd: 2 } as any)
      const { text: stdout } = runSection({ spec: 'doc.md::Setup' })
      expect(stdout).not.toContain('redirected from')
    })

    it('emits JSON when json flag is set', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Hello', heading: 'Hello', startLine: 1, endLine: 2 } as any)
      const { text: stdout } = runSection({ spec: 'doc.md::Hello', json: true })
      const parsed = JSON.parse(stdout) as { heading: string }
      expect(parsed.heading).toBe('Hello')
    })

    it('caps an oversized section body and tags the truncation hint for "heading" (#52)', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 50 },
      } as unknown as ReturnType<typeof loadConfig>)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: 'x'.repeat(2000), heading: 'Install', lineStart: 1, lineEnd: 400 } as any)
      const { text: stdout } = runSection({ spec: 'README.md::Install' })
      expect(stdout).toContain('output capped at ~50 tokens')
      expect(stdout).toContain("Request a narrower sub-heading, e.g. 'doc.md::Section#2'.")
      expect(stdout).not.toContain('x'.repeat(2000))
    })
  })

  // ---- runSkeleton --------------------------------------------------------

  describe('runSkeleton', () => {
    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const { code } = runSkeleton({ file: 'missing.ts' })
      expect(code).toBe(1)
    })

    it('distinguishes a recognized-but-unsupported language from a plain empty index (regression: Swift/Scala/Lua/etc. are indistinguishable from an empty file)', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runSkeleton({ file: 'missing.swift' })
      expect(code).toBe(1)
      expect(text).toContain('Swift')
      expect(text).toContain('no symbol extractor yet')
    })

    it('does not claim an unsupported language for a plain empty result on a supported extension', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text } = runSkeleton({ file: 'missing.ts' })
      expect(text).not.toContain('no symbol extractor yet')
    })

    it('prints skeleton header with symbol count', () => {
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: 'a.ts', lineStart: 5, lineEnd: 15, body: 'function foo() {}', docstring: '' },
        { name: 'bar', kind: 'class', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: 'class bar {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSkeleton({ file: 'a.ts' })
      expect(stdout).toContain('Skeleton')
      expect(stdout).toContain('2 symbols')
    })

    it('enqueues the dirty queue for a --force-refresh reindex (regression: embed_sha silently wiped)', () => {
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: 'a.ts', lineStart: 5, lineEnd: 15, body: 'function foo() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      runSkeleton({ file: 'a.ts', forceRefresh: true })
      expect(mockIndexFileSync).toHaveBeenCalled()
      expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath('a.ts', process.cwd()))
    })

    it('does not enqueue the dirty queue without --force-refresh', () => {
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: 'a.ts', lineStart: 5, lineEnd: 15, body: 'function foo() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      runSkeleton({ file: 'a.ts' })
      expect(mockAppendDirtyPath).not.toHaveBeenCalled()
    })

    it('reports correct total lines when filtering by minLines', () => {
      const syms: MockSymbol[] = [
        { name: 'tiny', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
        { name: 'large', kind: 'class', filePath: 'a.ts', lineStart: 10, lineEnd: 30, body: 'class {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSkeleton({ file: 'a.ts', minLines: 10 })
      expect(stdout).toContain('1 symbols')
      expect(stdout).toContain('30 lines')
    })

    it('applies minLines to JSON output too, not just the text branch (item1)', () => {
      const syms: MockSymbol[] = [
        { name: 'tiny', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
        { name: 'large', kind: 'class', filePath: 'a.ts', lineStart: 10, lineEnd: 30, body: 'class {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSkeleton({ file: 'a.ts', minLines: 10, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string }> }
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0]?.name).toBe('large')
    })

    it('caps --json output at overflow_guard.max_tokens, wrapping with items/truncated/totalCount instead of emitting an unbounded array', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 60 },
      } as unknown as ReturnType<typeof loadConfig>)
      const syms: MockSymbol[] = Array.from({ length: 50 }, (_, i) => ({
        name: `fn${i}`,
        kind: 'function',
        filePath: 'a.ts',
        lineStart: i * 10 + 1,
        lineEnd: i * 10 + 5,
        body: 'x'.repeat(50),
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSkeleton({ file: 'a.ts', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.truncated).toBe(true)
      expect(parsed.totalCount).toBe(50)
      expect(parsed.items.length).toBeLessThan(50)
    })

    it('reports the true max lineEnd across all symbols, not the last-by-lineStart symbol (nested-symbol regression)', () => {
      // querySymbols orders rows by (file_path, line_start), so the last element
      // by array order is the symbol with the greatest lineStart, not the
      // greatest lineEnd. Here the nested method starts after the class but
      // ends well before it, so a naive `filtered.at(-1)?.lineEnd` undercounts.
      const syms: MockSymbol[] = [
        { name: 'Foo', kind: 'class', filePath: 'a.ts', lineStart: 5, lineEnd: 100, body: 'class Foo {}', docstring: '' },
        { name: 'bar', kind: 'method', filePath: 'a.ts', lineStart: 50, lineEnd: 60, body: 'bar() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runSkeleton({ file: 'a.ts' })
      expect(stdout).toContain('2 symbols')
      expect(stdout).toContain('100 lines')
    })

    it('prepends a stale-index warning when the on-disk file sha differs from the indexed row (#1)', () => {
      const f = path.join(tempDir, 'stale-skeleton.ts')
      fs.writeFileSync(f, 'export function foo() {}\n')
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: f, lineStart: 1, lineEnd: 1, body: 'export function foo() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockGetFileEntry.mockReturnValueOnce({
        filePath: f, sha: 'not-the-real-sha256-of-this-file', mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
      } as never)
      const { text: stdout } = runSkeleton({ file: f })
      expect(stdout).toContain('STALE')
      expect(stdout).toContain('worker')
    })

    it('does not warn when the indexed sha matches the on-disk file', () => {
      const f = path.join(tempDir, 'fresh-skeleton.ts')
      const content = 'export function foo() {}\n'
      fs.writeFileSync(f, content)
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: f, lineStart: 1, lineEnd: 1, body: content, docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const realSha = fingerprintContent(content)
      mockGetFileEntry.mockReturnValueOnce({
        filePath: f, sha: realSha, mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
      } as never)
      const { text: stdout } = runSkeleton({ file: f })
      expect(stdout).not.toContain('STALE')
    })
  })

  // ---- runOutline ---------------------------------------------------------

  describe('runOutline', () => {
    it('distinguishes a recognized-but-unsupported language from a plain empty index (regression: Swift/Scala/Lua/etc. are indistinguishable from an empty file)', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runOutline({ file: 'empty.dart' })
      expect(code).toBe(1)
      expect(text).toContain('Dart')
      expect(text).toContain('no symbol extractor yet')
    })

    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const { code } = runOutline({ file: 'empty.ts' })
      expect(code).toBe(1)
    })

    it('enqueues the dirty queue for a --force-refresh reindex (regression: embed_sha silently wiped)', () => {
      const syms: MockSymbol[] = [
        { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 30, body: 'function myFunc() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      runOutline({ file: 'f.ts', forceRefresh: true })
      expect(mockIndexFileSync).toHaveBeenCalled()
      expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath('f.ts', process.cwd()))
    })

    it('does not enqueue the dirty queue without --force-refresh', () => {
      const syms: MockSymbol[] = [
        { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 30, body: 'function myFunc() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      runOutline({ file: 'f.ts' })
      expect(mockAppendDirtyPath).not.toHaveBeenCalled()
    })

    it('prints outline with line ranges', () => {
      const syms: MockSymbol[] = [
        { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 30, body: 'function myFunc() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runOutline({ file: 'f.ts' })
      expect(stdout).toContain('10')
      expect(stdout).toContain('myFunc')
    })

    it('applies minLines to JSON output too, not just the text branch (item1)', () => {
      const syms: MockSymbol[] = [
        { name: 'tiny', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
        { name: 'large', kind: 'class', filePath: 'f.ts', lineStart: 10, lineEnd: 30, body: 'class {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runOutline({ file: 'f.ts', minLines: 10, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string }> }
      expect(parsed.items).toHaveLength(1)
      expect(parsed.items[0]?.name).toBe('large')
    })

    it('caps --json output at overflow_guard.max_tokens, wrapping with items/truncated/totalCount instead of emitting an unbounded array', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 60 },
      } as unknown as ReturnType<typeof loadConfig>)
      const syms: MockSymbol[] = Array.from({ length: 50 }, (_, i) => ({
        name: `fn${i}`,
        kind: 'function',
        filePath: 'f.ts',
        lineStart: i * 10 + 1,
        lineEnd: i * 10 + 5,
        body: 'x'.repeat(50),
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runOutline({ file: 'f.ts', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.truncated).toBe(true)
      expect(parsed.totalCount).toBe(50)
      expect(parsed.items.length).toBeLessThan(50)
    })

    it('prepends a stale-index warning when the on-disk file sha differs from the indexed row (#1)', () => {
      const f = path.join(tempDir, 'stale-outline.ts')
      fs.writeFileSync(f, 'export function foo() {}\n')
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: f, lineStart: 1, lineEnd: 1, body: 'export function foo() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockGetFileEntry.mockReturnValueOnce({
        filePath: f, sha: 'not-the-real-sha256-of-this-file', mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
      } as never)
      const { text: stdout } = runOutline({ file: f })
      expect(stdout).toContain('STALE')
      expect(stdout).toContain('foo')
    })
  })

  describe('outline/skeleton --stats', () => {
    it('runOutline adds refCount and hasDoc per symbol in JSON mode', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'does a thing' },
        { name: 'unused', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 15, body: 'y', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map([['used', 2]]))
      const { text: stdout } = runOutline({ file: 'f.ts', stats: true, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string; refCount?: number; hasDoc?: boolean }> }
      const used = parsed.items.find((p) => p.name === 'used')
      const unused = parsed.items.find((p) => p.name === 'unused')
      expect(used?.refCount).toBe(2)
      expect(used?.hasDoc).toBe(true)
      expect(unused?.refCount).toBe(0)
      expect(unused?.hasDoc).toBe(false)
    })

    it('runSkeleton adds refCount and hasDoc per symbol in JSON mode', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'does a thing' },
        { name: 'unused', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 15, body: 'y', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map([['used', 2]]))
      const { text: stdout } = runSkeleton({ file: 'f.ts', stats: true, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string; refCount?: number; hasDoc?: boolean }> }
      const used = parsed.items.find((p) => p.name === 'used')
      const unused = parsed.items.find((p) => p.name === 'unused')
      expect(used?.refCount).toBe(2)
      expect(used?.hasDoc).toBe(true)
      expect(unused?.refCount).toBe(0)
      expect(unused?.hasDoc).toBe(false)
    })

    it('runOutline plain-text output shows ref count and doc status per symbol', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'does a thing' },
        { name: 'unused', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 15, body: 'y', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map([['used', 2]]))
      const { text: stdout } = runOutline({ file: 'f.ts', stats: true })
      expect(stdout).toContain('2 refs')
      expect(stdout).toContain('documented')
      expect(stdout).toContain('0 refs')
      expect(stdout).toContain('undocumented')
    })

    it('does not query ref counts when --stats is not passed', () => {
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      runOutline({ file: 'f.ts' })
      expect(mockQueryRefCounts).not.toHaveBeenCalled()
    })

    // Regression: global.db is a single machine-wide index shared across every project ever
    // indexed (constants.ts). runOutline/runSkeleton used to call queryRefCounts with no
    // project-root argument, so --stats ref counts summed references across every project
    // sharing a symbol name.
    it('runOutline --stats scopes queryRefCounts to the current project root', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      runOutline({ file: 'f.ts', stats: true })
      expect(mockQueryRefCounts.mock.calls[0]?.[2]).toBe(resolveProjectRoot({ project: process.cwd() }))
    })

    it('runSkeleton --stats scopes queryRefCounts to the current project root', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      runSkeleton({ file: 'f.ts', stats: true })
      expect(mockQueryRefCounts.mock.calls[0]?.[2]).toBe(resolveProjectRoot({ project: process.cwd() }))
    })

    // Regression: runOutline/runSkeleton used to pass a raw `process.cwd()` as the rootDir, so
    // invoking the command from a subdirectory of the project silently shrank the ref-count scope
    // to that subtree instead of the whole project.
    it('runOutline --stats scopes queryRefCounts to the whole project root, not the subdirectory cwd', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      const subdir = path.join(process.cwd(), 'src')
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subdir)
      try {
        runOutline({ file: 'f.ts', stats: true })
      } finally {
        cwdSpy.mockRestore()
      }
      const rootDirArg = mockQueryRefCounts.mock.calls[0]?.[2]
      expect(rootDirArg).not.toBe(subdir)
      expect(rootDirArg).toBe(resolveProjectRoot({ project: subdir }))
    })

    it('runSkeleton --stats scopes queryRefCounts to the whole project root, not the subdirectory cwd', () => {
      const syms: MockSymbol[] = [
        { name: 'used', kind: 'function', filePath: 'f.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      const subdir = path.join(process.cwd(), 'src')
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subdir)
      try {
        runSkeleton({ file: 'f.ts', stats: true })
      } finally {
        cwdSpy.mockRestore()
      }
      const rootDirArg = mockQueryRefCounts.mock.calls[0]?.[2]
      expect(rootDirArg).not.toBe(subdir)
      expect(rootDirArg).toBe(resolveProjectRoot({ project: subdir }))
    })
  })

  // ---- runBrief -----------------------------------------------------------

  describe('runBrief', () => {
    it('returns 1 when the symbol is not found', () => {
      mockQuerySymbols.mockReturnValue([])
      const code = runBrief({ spec: 'f.ts::missing' })
      expect(code).toBe(1)
    })

    // Same reasoning as runSymbol/runRefs/runFind: limit: 0 (or negative) must be rejected up
    // front instead of silently slicing the caller list to zero, consistent with every other
    // --limit flag in this codebase.
    it('rejects limit: 0 as an explicit invalid-argument error instead of silently showing zero callers', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { stderr } = capture(() => {
        const code = runBrief({ spec: 'f.ts::myFunc', limit: 0 })
        expect(code).toBe(1)
      })
      expect(stderr.toLowerCase()).toContain('limit')
      expect(mockResolveCallers).not.toHaveBeenCalled()
    })

    it('rejects a negative limit as an explicit invalid-argument error', () => {
      const { stderr } = capture(() => {
        const code = runBrief({ spec: 'f.ts::myFunc', limit: -1 })
        expect(code).toBe(1)
      })
      expect(stderr.toLowerCase()).toContain('limit')
      expect(mockResolveCallers).not.toHaveBeenCalled()
    })

    it('assembles symbol, callers, and section into JSON shape', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([{ caller: 'caller1', kind: 'function', file: 'g.ts', line: 3 }])
      mockFindContainingSection.mockReturnValue({ heading: 'Usage', content: 'body', lineStart: 8, lineEnd: 25 })
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', json: true }) })
      const parsed = JSON.parse(stdout) as {
        symbol: { name: string }
        callers: Array<{ caller: string }>
        section: { heading: string } | null
      }
      expect(parsed.symbol.name).toBe('myFunc')
      expect(parsed.callers).toHaveLength(1)
      expect(parsed.callers[0]?.caller).toBe('caller1')
      expect(parsed.section?.heading).toBe('Usage')
    })

    it('renders plain text with symbol body, callers, and section line', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([{ caller: 'caller1', kind: 'function', file: 'g.ts', line: 3 }])
      mockFindContainingSection.mockReturnValue({ heading: 'Usage', content: 'body', lineStart: 8, lineEnd: 25 })
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc' }) })
      expect(stdout).toContain('myFunc')
      expect(stdout).toContain('function myFunc() {}')
      expect(stdout).toContain('Callers (1):')
      expect(stdout).toContain('caller1')
      expect(stdout).toContain('Section: Usage')
    })

    it('omits the Section line entirely when no containing section is found', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([])
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc' }) })
      expect(stdout).not.toContain('Section:')
    })

    it('shows a real elided-count message when true caller count exceeds the display limit', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const tenCallers = Array.from({ length: 10 }, (_, i) => ({ caller: `caller${i}`, kind: 'function', file: 'g.ts', line: i + 1 }))
      mockResolveCallers.mockReturnValue(tenCallers)
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', limit: 5 }) })
      // resolveCallers must be queried for the true count, not capped at the display limit --
      // otherwise callers.length can never exceed shown.length and the elided message can't fire.
      expect(mockResolveCallers).toHaveBeenCalledWith('myFunc')
      expect(stdout).toContain('Callers (10):')
      expect(stdout).toContain('...(5 more elided)')
    })

    it('signals the true caller count and truncation in JSON mode', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const tenCallers = Array.from({ length: 10 }, (_, i) => ({ caller: `caller${i}`, kind: 'function', file: 'g.ts', line: i + 1 }))
      mockResolveCallers.mockReturnValue(tenCallers)
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', limit: 5, json: true }) })
      const parsed = JSON.parse(stdout) as { callers: unknown[]; totalCallers: number; truncated: boolean }
      expect(parsed.callers).toHaveLength(5)
      expect(parsed.totalCallers).toBe(10)
      expect(parsed.truncated).toBe(true)
    })

    it('reports the true uncapped caller count via queryRefCounts, not the length of resolveCallers own (internally-capped) list', () => {
      // Regression: resolveCallers(name) with no explicit limit still applies its own internal
      // default cap (500, in graph_commands.ts's queryRefs call). A prior version of runBrief
      // trusted callers.length as "the true count" (per a since-corrected comment claiming
      // resolveCallers was queried with "its own much larger default limit"), so once a symbol
      // had more references than that cap, totalCallers silently reported the capped number
      // instead of the real one. Here resolveCallers is mocked to return a small capped-looking
      // list while queryRefCounts (the real uncapped COUNT(*) query) reports a much larger true
      // total -- proving runBrief reads the count from queryRefCounts, not callers.length.
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const cappedCallers = Array.from({ length: 10 }, (_, i) => ({ caller: `caller${i}`, kind: 'function', file: 'g.ts', line: i + 1 }))
      mockResolveCallers.mockReturnValue(cappedCallers)
      mockQueryRefCounts.mockReturnValue(new Map([['myFunc', 800]]))
      mockFindContainingSection.mockReturnValue(null)

      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', limit: 5 }) })
      expect(stdout).toContain('Callers (800):')
      expect(stdout).toContain('...(795 more elided)')

      const { stdout: jsonOut } = capture(() => { runBrief({ spec: 'f.ts::myFunc', limit: 5, json: true }) })
      const parsed = JSON.parse(jsonOut) as { totalCallers: number; truncated: boolean }
      expect(parsed.totalCallers).toBe(800)
      expect(parsed.truncated).toBe(true)
    })

    it('re-reads the body from disk when the indexed symbol has an empty body (regression)', () => {
      // Regression: symbols with an empty stored `body` exist by construction -- e.g. HTML/Liquid
      // heading symbols produced by `sectionsToHeadingSymbols` (parser.ts) always store
      // `body: ''`. Unlike runRead and runSymbol, runBrief rendered `match.body` directly with no
      // disk fallback, so those symbols showed header lines and a `~0 tok` estimate but a blank body.
      const file = path.join(tempDir, 'page.html')
      fs.writeFileSync(file, '<html>\n<h2>Some Heading</h2>\n<p>content</p>\n</html>\n')
      const sym: MockSymbol = { name: 'Some Heading', kind: 'heading', filePath: file, lineStart: 2, lineEnd: 2, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([])
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: `${file}::Some Heading` }) })
      expect(stdout).toContain('<h2>Some Heading</h2>')
      expect(stdout).not.toContain('~0 tok')
    })
  })

  // ---- runGrep ------------------------------------------------------------

  describe('runGrep', () => {
    it('returns 1 for invalid regex', () => {
      const code = runGrep({ pattern: '[invalid(', path: tempDir })
      expect(code).toBe(1)
    })

    it('finds matches in files', () => {
      const f = path.join(tempDir, 'test.txt')
      fs.writeFileSync(f, 'line one\nhello world\nline three')
      const { stdout } = capture(() => { runGrep({ pattern: 'hello', path: f }) })
      expect(stdout).toContain('hello world')
    })

    it('returns 1 when no matches', () => {
      const f = path.join(tempDir, 'no-match.txt')
      fs.writeFileSync(f, 'nothing here')
      const code = runGrep({ pattern: 'ZZZNOMATCH', path: f })
      expect(code).toBe(1)
    })

    it('returns 1 when path does not exist', () => {
      const code = runGrep({ pattern: 'x', path: path.join(tempDir, 'nonexistent') })
      expect(code).toBe(1)
    })

    it('emits JSON when json flag is set', () => {
      const f = path.join(tempDir, 'j.txt')
      fs.writeFileSync(f, 'match this line')
      const { stdout } = capture(() => { runGrep({ pattern: 'match', path: f, json: true }) })
      const parsed = JSON.parse(stdout) as Array<{ file: string; line: number; text: string }>
      expect(Array.isArray(parsed)).toBe(true)
      expect(parsed[0]?.text).toContain('match')
    })

    it('matches a $-anchored pattern on CRLF line endings (M3)', () => {
      // A trailing \r left on each line by a naive split('\n') sits between the match
      // text and the string end, so a $-anchor never lines up on CRLF files.
      const f = path.join(tempDir, 'crlf.txt')
      fs.writeFileSync(f, 'line one\r\nhello world\r\nline three\r\n')
      const code = runGrep({ pattern: 'world$', path: f })
      expect(code).toBe(0)
    })

    it('does not leave a stray \\r in the matched line text on CRLF files (M3)', () => {
      const f = path.join(tempDir, 'crlf2.txt')
      fs.writeFileSync(f, 'hello world\r\nline three\r\n')
      const { stdout } = capture(() => { runGrep({ pattern: 'hello', path: f }) })
      expect(stdout).toContain('hello world')
      expect(stdout).not.toMatch(/world\r/)
    })

    it('skips node_modules when walking a directory recursively (item3)', () => {
      const nmDir = path.join(tempDir, 'node_modules', 'somepkg')
      fs.mkdirSync(nmDir, { recursive: true })
      fs.writeFileSync(path.join(nmDir, 'index.js'), 'const findme = 1')
      fs.writeFileSync(path.join(tempDir, 'real.ts'), 'const findme = 2')
      const { stdout } = capture(() => { runGrep({ pattern: 'findme', path: tempDir }) })
      expect(stdout).toContain('real.ts')
      expect(stdout).not.toContain('node_modules')
    })

    it('merges hits from multiple explicit paths in argument order', () => {
      const f1 = path.join(tempDir, 'a.txt')
      const f2 = path.join(tempDir, 'b.txt')
      fs.writeFileSync(f1, 'alpha match one\nnothing here')
      fs.writeFileSync(f2, 'beta match two\nnothing here either')
      const { stdout } = capture(() => { runGrep({ pattern: 'match', path: [f1, f2] }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('a.txt')
      expect(lines[0]).toContain('match one')
      expect(lines[1]).toContain('b.txt')
      expect(lines[1]).toContain('match two')
    })

    it('applies the max-lines cap once across the combined hits from multiple paths, not per file', () => {
      const f1 = path.join(tempDir, 'multi1.txt')
      const f2 = path.join(tempDir, 'multi2.txt')
      fs.writeFileSync(f1, 'needle\nneedle\nneedle')
      fs.writeFileSync(f2, 'needle\nneedle\nneedle')
      const { stdout, stderr } = capture(() => { runGrep({ pattern: 'needle', path: [f1, f2], maxLines: 4 }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(4)
      expect(stderr).toContain('2 more lines omitted')
    })

    it('includes -C context lines around a match, clamped at the top of the file', () => {
      const f = path.join(tempDir, 'context.txt')
      fs.writeFileSync(f, 'match line\nline2\nline3\nline4\nline5')
      const { stdout } = capture(() => { runGrep({ pattern: 'match', path: f, context: 2, json: true }) })
      const parsed = JSON.parse(stdout) as Array<{ file: string; line: number; text: string; context?: Array<{ line: number; text: string }> }>
      expect(parsed).toHaveLength(1)
      const hit = parsed[0]
      // Match is on line 1 -- there are no lines above it, so context is clamped to
      // start at line 1 instead of extending to a nonexistent line -1.
      expect(hit?.context?.map((c) => c.line)).toEqual([1, 2, 3])
      expect(hit?.context?.[2]?.text).toBe('line3')
    })

    it('renders -C context lines in plain-text output using grep-style : and - separators', () => {
      const f = path.join(tempDir, 'context-plain.txt')
      fs.writeFileSync(f, 'line1\nline2\nmatchhere\nline4\nline5')
      const { stdout } = capture(() => { runGrep({ pattern: 'matchhere', path: f, context: 1 }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(3)
      expect(lines[0]).toContain('-2- line2')
      expect(lines[1]).toContain(':3: matchhere')
      expect(lines[2]).toContain('-4- line4')
    })

    it('omits the context field entirely when -C is not given (no regression in JSON shape)', () => {
      const f = path.join(tempDir, 'nocontext.txt')
      fs.writeFileSync(f, 'plain match line')
      const { stdout } = capture(() => { runGrep({ pattern: 'match', path: f, json: true }) })
      const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>
      expect(parsed[0]).not.toHaveProperty('context')
    })
  })

  // ---- runConfigGet -------------------------------------------------------

  describe('runConfigGet', () => {
    it('reads a key from a JSON file', () => {
      const f = path.join(tempDir, 'config.json')
      fs.writeFileSync(f, JSON.stringify({ project: { version: '1.2.3' } }))
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'project.version' }) })
      expect(stdout.trim()).toBe('"1.2.3"')
    })

    it('returns 1 when key not found in JSON', () => {
      const f = path.join(tempDir, 'c.json')
      fs.writeFileSync(f, JSON.stringify({ a: 1 }))
      const code = runConfigGet({ file: f, key: 'missing.key' })
      expect(code).toBe(1)
    })

    it('returns 1 and does not emit undefined when leaf key is missing from an existing parent', () => {
      // Regression: before fix, obj traversal would produce undefined for the leaf and emit JSON.stringify(undefined) = "undefined" while returning 0.
      const f = path.join(tempDir, 'leaf-missing.json')
      fs.writeFileSync(f, JSON.stringify({ project: { name: 'foo' } }))
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'project.missing' }) })
      // Must not emit the string "undefined" — that is not valid JSON output
      expect(stdout).not.toContain('undefined')
    })

    it('returns 1 when file does not exist', () => {
      const code = runConfigGet({ file: path.join(tempDir, 'nope.json'), key: 'x' })
      expect(code).toBe(1)
    })

    it('reads a key from a TOML-like INI file', () => {
      const f = path.join(tempDir, 'pyproject.toml')
      fs.writeFileSync(f, '[project]\nversion = "2.0.0"\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'project.version' }) })
      expect(stdout.trim()).toBe('2.0.0')
    })

    it('reads a TOML/INI key with aligned multi-space formatting before the equals sign', () => {
      // Regression: startsWith(`${leafKey} =`) / startsWith(`${leafKey}=`) only recognized
      // exactly zero or one space before '=', so aligned-key files (tox.ini/setup.cfg style)
      // failed to resolve a present, valid key.
      const f = path.join(tempDir, 'aligned.toml')
      fs.writeFileSync(f, '[testenv]\ndeps       = pytest\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'testenv.deps' }) })
      expect(stdout.trim()).toBe('pytest')
    })

    it('reads a TOML/INI key with a tab before the equals sign', () => {
      const f = path.join(tempDir, 'tabbed.toml')
      fs.writeFileSync(f, '[testenv]\ndeps\t= pytest\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'testenv.deps' }) })
      expect(stdout.trim()).toBe('pytest')
    })

    it('does not match a longer key name as a prefix of the requested key', () => {
      // Regression guard: the fix must not turn `startsWith` into an unanchored regex that
      // lets "deps" match a "deps2 = ..." line.
      const f = path.join(tempDir, 'prefix.toml')
      fs.writeFileSync(f, '[testenv]\ndeps2 = wrong\ndeps       = pytest\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'testenv.deps' }) })
      expect(stdout.trim()).toBe('pytest')
    })

    it('treats a key containing regex metacharacters as a literal, not a pattern', () => {
      // leafKey is embedded in a RegExp; it must be escaped so metacharacters in a
      // user-supplied key are matched literally instead of throwing or misbehaving.
      const f = path.join(tempDir, 'special.toml')
      fs.writeFileSync(f, '[testenv]\na(b)+  = special\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'testenv.a(b)+' }) })
      expect(stdout.trim()).toBe('special')
    })

    it('does not resolve a bare key to a value found only inside a named section', () => {
      // Regression guard (task #109): a bare (non-dotted) key lookup must only match a
      // genuinely top-level key -- one appearing before any [section] header -- not a
      // same-named key nested inside an unrelated section. Before the fix, the section
      // check was skipped entirely whenever no section was requested, so this incorrectly
      // resolved to the section-scoped value.
      const f = path.join(tempDir, 'bare-key-section.toml')
      fs.writeFileSync(f, '[some_section]\nsome_key = "wrong"\n')
      const code = runConfigGet({ file: f, key: 'some_key' })
      expect(code).toBe(1)
    })

    it('resolves a bare key that is genuinely top-level, ahead of any [section] header', () => {
      const f = path.join(tempDir, 'bare-key-toplevel.toml')
      fs.writeFileSync(f, 'some_key = "right"\n[some_section]\nsome_key = "wrong"\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'some_key' }) })
      expect(stdout.trim()).toBe('right')
    })

    it('reads a flat top-level key from a YAML file', () => {
      const f = path.join(tempDir, 'c.yaml')
      fs.writeFileSync(f, '# comment\nname: myapp\nother: x\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'name' }) })
      expect(stdout.trim()).toBe('myapp')
    })

    it('reads a nested YAML key by indentation (2-space)', () => {
      const f = path.join(tempDir, 'n.yaml')
      fs.writeFileSync(f, 'database:\n  host: localhost\n  port: 5432\nname: app\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'database.host' }) })
      expect(stdout.trim()).toBe('localhost')
    })

    it('reads a nested YAML key with 4-space indentation', () => {
      const f = path.join(tempDir, 'four.yaml')
      fs.writeFileSync(f, 'service:\n    port: 8080\n    nested:\n        deep: yes\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'service.nested.deep' }) })
      expect(stdout.trim()).toBe('yes')
    })

    it('preserves a colon inside a YAML value', () => {
      const f = path.join(tempDir, 'url.yaml')
      fs.writeFileSync(f, 'database:\n  url: postgres://u:p@h/db\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'database.url' }) })
      expect(stdout.trim()).toBe('postgres://u:p@h/db')
    })

    it('strips surrounding quotes from a YAML value', () => {
      const f = path.join(tempDir, 'q.yaml')
      fs.writeFileSync(f, 'creds:\n  user: "admin"\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'creds.user' }) })
      expect(stdout.trim()).toBe('admin')
    })

    it('returns 1 for a missing YAML key', () => {
      const f = path.join(tempDir, 'm.yaml')
      fs.writeFileSync(f, 'database:\n  host: localhost\n')
      const code = runConfigGet({ file: f, key: 'database.missing' })
      expect(code).toBe(1)
    })

    it('reads a key from YAML frontmatter in a Markdown file, regardless of extension', () => {
      const f = path.join(tempDir, 'SKILL.md')
      fs.writeFileSync(f, '---\ntitle: My Skill\nversion: 2.3.1\n---\n# Heading\nbody text\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'version' }) })
      expect(stdout.trim()).toBe('2.3.1')
    })

    it('reads a nested key from YAML frontmatter (2-space indentation)', () => {
      const f = path.join(tempDir, 'nested.md')
      fs.writeFileSync(f, '---\ndatabase:\n  host: localhost\n  port: 5432\n---\n# Doc\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'database.host' }) })
      expect(stdout.trim()).toBe('localhost')
    })

    it('falls back to TOML/INI-style lookup for a Markdown file with no frontmatter', () => {
      // Regression guard: a .md file that never opens a frontmatter fence must keep
      // resolving through the pre-existing TOML/INI fallback, unaffected by the new
      // frontmatter branch.
      const f = path.join(tempDir, 'notes.md')
      fs.writeFileSync(f, '[project]\nversion = "9.9.9"\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'project.version' }) })
      expect(stdout.trim()).toBe('9.9.9')
    })

    it('does not crash on an unclosed frontmatter fence and falls through to extension-based dispatch', () => {
      // No closing '---' -- consistent with doc_compact.ts, this is not treated as
      // frontmatter. It falls through to the TOML/INI fallback, which finds no
      // 'title =' line either, so the lookup reports not-found rather than throwing.
      const f = path.join(tempDir, 'unclosed.md')
      fs.writeFileSync(f, '---\ntitle: Draft\nno closing fence here\n')
      const code = runConfigGet({ file: f, key: 'title' })
      expect(code).toBe(1)
    })
  })

  // ---- runCsvQuery ----------------------------------------------------

  describe('runCsvQuery', () => {
    const CSV = 'id,name,status\n1,Alice,active\n2,Bob,inactive\n'

    it('emits all columns and rows as CSV by default', () => {
      const f = path.join(tempDir, 'people.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvQuery({ file: f }) })
      expect(stdout).toContain('id,name,status')
      expect(stdout).toContain('1,Alice,active')
    })

    it('projects a column subset via --columns', () => {
      const f = path.join(tempDir, 'cols.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvQuery({ file: f, columns: 'name,status' }) })
      expect(stdout.split('\n')[0]).toBe('name,status')
      expect(stdout).not.toContain('id,name')
    })

    it('filters rows via --where col=value', () => {
      const f = path.join(tempDir, 'where.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvQuery({ file: f, where: ['status=active'] }) })
      expect(stdout).toContain('Alice')
      expect(stdout).not.toContain('Bob')
    })

    it('emits JSON rows when --json is set', () => {
      const f = path.join(tempDir, 'json.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvQuery({ file: f, json: true }) })
      // guardJsonRows wraps the rows in an { items, truncated, totalCount } envelope so large
      // results can be capped without changing the top-level JSON shape (see read_commands.ts).
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.items[0]).toEqual({ id: '1', name: 'Alice', status: 'active' })
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(parsed.items.length)
    })

    it('returns 1 and reports the error for an unknown --where column', () => {
      const f = path.join(tempDir, 'badwhere.csv')
      fs.writeFileSync(f, CSV)
      const code = runCsvQuery({ file: f, where: ['nope=x'] })
      expect(code).toBe(1)
    })

    it('returns 1 when the file does not exist', () => {
      const code = runCsvQuery({ file: path.join(tempDir, 'missing.csv') })
      expect(code).toBe(1)
    })

    it('filters rows via multiple ANDed --where operators', () => {
      const numCsv = 'id,name,age\n1,Alice,30\n2,Bob,25\n3,Carol,40\n'
      const f = path.join(tempDir, 'wheres.csv')
      fs.writeFileSync(f, numCsv)
      const { stdout } = capture(() => {
        runCsvQuery({ file: f, where: ['age>28', 'name!=Carol'] })
      })
      expect(stdout).toContain('Alice')
      expect(stdout).not.toContain('Bob')
      expect(stdout).not.toContain('Carol')
    })

    it('applies a custom --delimiter', () => {
      const f = path.join(tempDir, 'tab.tsv')
      fs.writeFileSync(f, 'id\tname\n1\tAlice\n')
      const { stdout } = capture(() => {
        runCsvQuery({ file: f, delimiter: '\t' })
      })
      expect(stdout).toContain('id,name')
      expect(stdout).toContain('1,Alice')
    })

    it('synthesizes column names with --no-header', () => {
      const f = path.join(tempDir, 'noheader.csv')
      fs.writeFileSync(f, '1,Alice\n2,Bob\n')
      const { stdout } = capture(() => {
        runCsvQuery({ file: f, noHeader: true })
      })
      expect(stdout).toContain('col1,col2')
    })

    // Regression: an empty or header-only CSV silently produced zero stdout output (just a
    // blank/empty header line from formatCsvTable) instead of a clear message, unlike every
    // other format handler's "not found"/no-match miss (section, read, symbol, xlsx-sheets,
    // pdf-meta).
    it('prints a clear message instead of silent empty output for a fully empty CSV', () => {
      const f = path.join(tempDir, 'empty.csv')
      fs.writeFileSync(f, '')
      let code = -1
      const { stdout } = capture(() => { code = runCsvQuery({ file: f }) })
      expect(stdout).toContain(`No data rows found in ${f}`)
      expect(code).toBe(0)
    })

    it('prints a clear message instead of silent empty output for a header-only CSV', () => {
      const f = path.join(tempDir, 'headeronly.csv')
      fs.writeFileSync(f, 'id,name,status\n')
      let code = -1
      const { stdout } = capture(() => { code = runCsvQuery({ file: f }) })
      expect(stdout).toContain(`No data rows found in ${f}`)
      expect(code).toBe(0)
    })

    it('caps output to the first N rows via a valid --head', () => {
      const f = path.join(tempDir, 'head.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvQuery({ file: f, head: '1' }) })
      expect(stdout).toContain('Alice')
      expect(stdout).not.toContain('Bob')
    })

    // Regression: --head was parsed with raw parseInt instead of the same
    // requireNonNegativeInt validation the parallel xlsx --head path already uses. A
    // non-numeric value produced NaN, which `.slice(0, NaN)` silently turns into 0 rows
    // with a misleading "N more rows elided" message instead of a clear error.
    it('returns 1 and reports a clear error for a non-numeric --head', () => {
      const f = path.join(tempDir, 'badhead.csv')
      fs.writeFileSync(f, CSV)
      let code = -1
      const { stderr } = capture(() => { code = runCsvQuery({ file: f, head: 'abc' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('--head')
      expect(stderr).toContain('abc')
    })

    // Regression: a negative --head silently returned all-but-the-last-N rows instead of
    // erroring, because `.slice(0, -5)` reinterprets a negative count as "from the end".
    it('returns 1 and reports a clear error for a negative --head', () => {
      const f = path.join(tempDir, 'neghead.csv')
      fs.writeFileSync(f, CSV)
      let code = -1
      const { stderr } = capture(() => { code = runCsvQuery({ file: f, head: '-5' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('--head')
    })
  })

  // ---- runCsvProfile ---------------------------------------------------

  describe('runCsvProfile', () => {
    const CSV = 'id,name,status\n1,Alice,active\n2,Bob,inactive\n'

    it('prints a per-column type/null/distinct/range summary', () => {
      const f = path.join(tempDir, 'profile.csv')
      fs.writeFileSync(f, CSV)
      const { stdout } = capture(() => { runCsvProfile({ file: f }) })
      expect(stdout).toContain('id  (number)')
      expect(stdout).toContain('status  (string)')
    })

    it('returns 1 when the file does not exist', () => {
      const code = runCsvProfile({ file: path.join(tempDir, 'missing.csv') })
      expect(code).toBe(1)
    })

    it('prints a clear message instead of silent empty output for a fully empty CSV', () => {
      const f = path.join(tempDir, 'profile-empty.csv')
      fs.writeFileSync(f, '')
      let code = -1
      const { stdout } = capture(() => { code = runCsvProfile({ file: f }) })
      expect(stdout).toContain(`No data rows found in ${f}`)
      expect(code).toBe(0)
    })

    it('prints a clear message instead of silent empty output for a header-only CSV', () => {
      const f = path.join(tempDir, 'profile-headeronly.csv')
      fs.writeFileSync(f, 'id,name,status\n')
      let code = -1
      const { stdout } = capture(() => { code = runCsvProfile({ file: f }) })
      expect(stdout).toContain(`No data rows found in ${f}`)
      expect(code).toBe(0)
    })
  })

  describe('runListSections', () => {
    it('returns 1 when no sections found', () => {
      mockListSections.mockReturnValue([])
      const code = runListSections({ file: 'empty.md' })
      expect(code).toBe(1)
    })

    it('prints section headings', () => {
      mockListSections.mockReturnValue(['Install', 'Usage', 'API'])
      const { stdout } = capture(() => { runListSections({ file: 'README.md' }) })
      expect(stdout).toContain('Install')
      expect(stdout).toContain('Usage')
    })
  })

  // ---- runFind ------------------------------------------------------------

  describe('runFind', () => {
    it('returns 1 when no indexed files match', () => {
      mockQuerySymbols.mockReturnValue([])
      const code = runFind({ pattern: 'xyz' })
      expect(code).toBe(1)
    })

    it('deduplicates files', () => {
      const syms: MockSymbol[] = [
        { name: 'fooHelper', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 5, body: 'function fooHelper() {}', docstring: '' },
        { name: 'fooUtil', kind: 'function', filePath: 'src/foo.ts', lineStart: 6, lineEnd: 10, body: 'function fooUtil() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runFind({ pattern: 'foo' }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('foo.ts')
    })

    it('matches a substring pattern, not just an exact symbol name (m31)', () => {
      // The command's own help text promises "pattern"-style matching over an exact name —
      // a partial pattern like 'Helper' must find a symbol named 'sessionHelper'.
      const syms: MockSymbol[] = [
        { name: 'sessionHelper', kind: 'function', filePath: 'src/session.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
        { name: 'unrelatedThing', kind: 'function', filePath: 'src/other.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runFind({ pattern: 'Helper' }) })
      expect(stdout).toContain('session.ts')
      expect(stdout).not.toContain('other.ts')
    })

    it('matches case-insensitively (m31)', () => {
      const syms: MockSymbol[] = [
        { name: 'SessionHelper', kind: 'function', filePath: 'src/session.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runFind({ pattern: 'helper' }) })
      expect(stdout).toContain('session.ts')
    })

    it('caps the number of returned files at --limit (m31)', () => {
      const syms: MockSymbol[] = Array.from({ length: 5 }, (_, i) => ({
        name: `fooItem${i}`,
        kind: 'function',
        filePath: `src/foo${i}.ts`,
        lineStart: 1,
        lineEnd: 5,
        body: '',
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runFind({ pattern: 'foo', limit: 2 }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(2)
    })

    // `.slice(0, 0)` always returns zero files, so a pattern that genuinely matches indexed
    // files would otherwise be reported as "no indexed files match" -- a wrong answer, not
    // just a permissive input. limit: 0 (or negative) must be rejected up front.
    it('rejects limit: 0 as an explicit invalid-argument error instead of returning a false "no matches"', () => {
      const syms: MockSymbol[] = [
        { name: 'fooHelper', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stderr } = capture(() => {
        const code = runFind({ pattern: 'foo', limit: 0 })
        expect(code).toBe(1)
      })
      expect(stderr).not.toContain('No indexed files match')
      expect(stderr.toLowerCase()).toContain('limit')
      expect(mockQuerySymbols).not.toHaveBeenCalled()
    })

    it('rejects a negative limit as an explicit invalid-argument error', () => {
      const { stderr } = capture(() => {
        const code = runFind({ pattern: 'foo', limit: -1 })
        expect(code).toBe(1)
      })
      expect(stderr.toLowerCase()).toContain('limit')
      expect(mockQuerySymbols).not.toHaveBeenCalled()
    })

    it('warns when index scan hits FIND_SCAN_LIMIT', () => {
      // Test that truncation is detected and reported. We create an array with length ===
      // FIND_SCAN_LIMIT (20_000) so that rawSymbols.length === FIND_SCAN_LIMIT and
      // the truncated flag is set.
      const limit = 20_000 // matches FIND_SCAN_LIMIT in read_commands.ts
      const syms: MockSymbol[] = Array.from({ length: limit }, (_, i) => ({
        name: i < 5 ? `match${i}` : `unmatch${i}`, // first 5 match our pattern
        kind: 'function',
        filePath: `src/file${i}.ts`,
        lineStart: 1,
        lineEnd: 5,
        body: '',
        docstring: '',
      }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)

      // Plain-text mode should emit truncation warning to stderr
      const { stdout, stderr } = capture(() => { runFind({ pattern: 'match' }) })
      expect(stderr).toContain('Results may be incomplete')
      expect(stderr).toContain('20000')
      // Should still emit matching files to stdout
      expect(stdout).toContain('file0.ts')

      // JSON mode should include truncated flag
      const jsonOutput = capture(() => { runFind({ pattern: 'match', json: true }) })
      const parsed = JSON.parse(jsonOutput.stdout)
      expect(parsed).toHaveProperty('truncated', true)
      expect(parsed).toHaveProperty('files')
      expect(Array.isArray(parsed.files)).toBe(true)
    })

    // Regression: runFind used to pass a raw `process.cwd()` as querySymbols's rootDir, so
    // invoking the command from a subdirectory of the project silently shrank the scan to that
    // subtree instead of the whole project.
    it('scopes querySymbols to the whole project root, not the subdirectory cwd', () => {
      mockQuerySymbols.mockReturnValue([])
      const subdir = path.join(process.cwd(), 'src')
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(subdir)
      try {
        runFind({ pattern: 'anything' })
      } finally {
        cwdSpy.mockRestore()
      }
      const opts = mockQuerySymbols.mock.calls[0]?.[0]
      expect(opts?.rootDir).not.toBe(subdir)
      expect(opts?.rootDir).toBe(resolveProjectRoot({ project: subdir }))
    })
  })

  // ---- runExports ---------------------------------------------------------

  describe('runExports', () => {
    it('reports no exported symbols', () => {
      const syms: MockSymbol[] = [
        { name: 'internal', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'function internal() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runExports({ file: 'a.ts' }) })
      expect(stdout).toContain('No exported')
    })

    it('lists exported symbols', () => {
      const syms: MockSymbol[] = [
        { name: 'pubFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'export function pubFn() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runExports({ file: 'a.ts' }) })
      expect(stdout).toContain('pubFn')
    })
  })

  // ---- extractImports -------------------------------------------------------

  describe('extractImports', () => {
    it('extracts TS/JS imports (from, bare, require, dynamic)', () => {
      const src = [
        "import { a } from './mod'",
        "import 'side-effect'",
        "const x = require('cjs-pkg')",
        "const y = await import('dyn-pkg')",
        "export { z } from './reexport'",
      ].join('\n')
      expect(extractImports(src, '.ts')).toEqual([
        './mod', 'side-effect', 'cjs-pkg', 'dyn-pkg', './reexport',
      ])
    })

    it('extracts a multi-line Prettier-style import block (regression for #102)', () => {
      const src = [
        "import { spawnSync } from 'node:child_process'",
        '',
        "import { loadConfig } from './config.js'",
        'import {',
        '  type CompressedOutput,',
        '  type ToolFilter,',
        '  capTokens,',
        '  compressOutput,',
        "} from './tool_filters/index.js'",
      ].join('\n')
      expect(extractImports(src, '.ts')).toEqual([
        'node:child_process', './config.js', './tool_filters/index.js',
      ])
    })

    it('extracts Python imports', () => {
      const src = 'import os, sys\nfrom collections import OrderedDict\nimport json as j'
      expect(extractImports(src, '.py')).toEqual(['os', 'sys', 'collections', 'json'])
    })

    it('extracts Go block and single imports', () => {
      const src = 'import (\n  "fmt"\n  "os"\n)\nimport "strings"'
      expect(extractImports(src, '.go')).toEqual(['fmt', 'os', 'strings'])
    })

    it('extracts Rust use and C include', () => {
      expect(extractImports('pub use std::fmt;\nuse crate::thing;', '.rs')).toEqual([
        'std::fmt', 'crate::thing',
      ])
      expect(extractImports('#include <stdio.h>\n#include "local.h"', '.c')).toEqual([
        'stdio.h', 'local.h',
      ])
    })

    it('de-duplicates repeated specifiers', () => {
      expect(extractImports("import a from 'x'\nimport b from 'x'", '.ts')).toEqual(['x'])
    })
  })

  // ---- extractExportNames ---------------------------------------------------

  describe('extractExportNames', () => {
    it('extracts TS declarations, named, and default exports', () => {
      const src = [
        'export function fn() {}',
        'export class Cls {}',
        'export const c = 1',
        'export interface Iface {}',
        'export { hidden as shown }',
        'function localDefault() {}',
        'export default localDefault',
      ].join('\n')
      const names = extractExportNames(src, '.ts')
      expect(names).toContain('fn')
      expect(names).toContain('Cls')
      expect(names).toContain('c')
      expect(names).toContain('Iface')
      expect(names).toContain('shown')
      expect(names).toContain('localDefault')
      expect(names).not.toContain('default')
    })

    it('extracts public Python defs/classes and skips dunder/private', () => {
      const src = 'def public_fn(): pass\nclass PublicCls: pass\ndef _private(): pass'
      expect(extractExportNames(src, '.py')).toEqual(['public_fn', 'PublicCls'])
    })

    it('extracts Rust pub items', () => {
      const src = 'pub fn f() {}\npub struct S {}\nfn private() {}'
      expect(extractExportNames(src, '.rs')).toEqual(['f', 'S'])
    })
  })

  // ---- runChanged -----------------------------------------------------------

  describe('runChanged', () => {
    const mockRunGit = vi.mocked(runGit)

    function gitOk(stdout: string): void {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRunGit.mockReturnValue({ exitCode: 0, stdout, stderr: '' } as any)
    }

    it('lists changed files in plain mode', () => {
      gitOk('a.ts\nb.ts\n')
      const { stdout } = capture(() => { runChanged({ ref: 'HEAD~1' }) })
      expect(stdout).toContain('a.ts')
      expect(stdout).toContain('b.ts')
    })

    it('reports when nothing changed', () => {
      gitOk('')
      const { stdout } = capture(() => { runChanged({}) })
      expect(stdout).toContain('No files changed')
    })

    it('lists changed symbols with kind and location in symbol mode', () => {
      gitOk('a.ts\n')
      const syms: MockSymbol[] = [
        { name: 'changedFn', kind: 'function', filePath: 'a.ts', lineStart: 7, lineEnd: 9, body: 'function changedFn() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runChanged({ symbolMode: true }) })
      expect(stdout).toContain('changedFn (function)')
      expect(stdout).toContain('a.ts:7')
    })

    it('returns 1 when git diff fails', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockRunGit.mockReturnValue({ exitCode: 128, stdout: '', stderr: 'bad ref' } as any)
      const { stderr } = capture(() => {
        expect(runChanged({ ref: 'nope' })).toBe(1)
      })
      expect(stderr).toContain('git diff failed')
    })

    it('scopes symbolMode to symbols overlapping the changed diff hunks, not every symbol in the file (item2)', () => {
      const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
      const nameOnly = { exitCode: 0, stdout: 'a.ts\n', stderr: '' }
      const unifiedDiff = {
        exitCode: 0,
        stdout: [
          'diff --git a/a.ts b/a.ts',
          'index 111..222 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -7,0 +8 @@',
          '+  // touched line',
        ].join('\n'),
        stderr: '',
      }
      mockRunGit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(toplevel as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(nameOnly as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(unifiedDiff as any)
      const syms: MockSymbol[] = [
        { name: 'untouchedFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
        { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 7, lineEnd: 10, body: '', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runChanged({ symbolMode: true }) })
      expect(stdout).toContain('touchedFn')
      expect(stdout).not.toContain('untouchedFn')
    })

    it('falls back to every symbol in the file when the hunk-diff git call fails (item2)', () => {
      const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
      const nameOnly = { exitCode: 0, stdout: 'a.ts\n', stderr: '' }
      const diffFail = { exitCode: 128, stdout: '', stderr: 'boom' }
      mockRunGit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(toplevel as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(nameOnly as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(diffFail as any)
      const syms: MockSymbol[] = [
        { name: 'anyFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runChanged({ symbolMode: true }) })
      expect(stdout).toContain('anyFn')
    })

    it('resolves changed-file paths against the real git repo top-level (rev-parse), not the invoking cwd, so running from a subdirectory does not double the subdirectory segment (regression, item2)', () => {
      // Simulate the command having been invoked from a subdirectory: `projectRoot` here
      // stands in for that subdirectory, while the mocked `rev-parse --show-toplevel`
      // reports the real repo root one level up — exactly the mismatch that occurs when
      // `token-goat changed --symbol` is run from e.g. `src/`.
      const repoRoot = path.join(process.cwd(), 'fixture-repo')
      const subdir = path.join(repoRoot, 'subdir')
      const toplevel = { exitCode: 0, stdout: `${repoRoot}\n`, stderr: '' }
      // git always reports diff paths relative to the repo top-level, regardless of cwd.
      const nameOnly = { exitCode: 0, stdout: 'subdir/touched.ts\n', stderr: '' }
      const diffFail = { exitCode: 128, stdout: '', stderr: 'boom' }
      mockRunGit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(toplevel as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(nameOnly as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(diffFail as any)
      mockQuerySymbols.mockReturnValue([])

      runChanged({ symbolMode: true, projectRoot: subdir })

      expect(mockQuerySymbols).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: resolveIndexPath('subdir/touched.ts', repoRoot) }),
      )
      const arg = mockQuerySymbols.mock.calls[0]?.[0] as { filePath?: string }
      // The bug resolved the git-relative path against the subdirectory cwd instead of the
      // repo root, doubling the "subdir" segment (subdir/subdir/touched.ts).
      expect(arg.filePath).not.toBe(resolveIndexPath('subdir/touched.ts', subdir))
      expect(arg.filePath).not.toContain(path.join('subdir', 'subdir'))
    })
  })
})

describe('parseDiffHunks (item2)', () => {
  it('parses a hunk header with an explicit new-line count into a start/end range keyed by file', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      'index 111..222 100644',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -10,2 +10,3 @@',
      '+line',
      '+line',
      ' unchanged',
    ].join('\n')
    expect(parseDiffHunks(diff).get('a.ts')).toEqual([{ start: 10, end: 12 }])
  })

  it('treats an omitted new-line count as a single-line hunk', () => {
    const diff = [
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -5 +8 @@',
      '-old',
      '+new',
    ].join('\n')
    expect(parseDiffHunks(diff).get('b.ts')).toEqual([{ start: 8, end: 8 }])
  })

  it('anchors a pure-deletion hunk (new count 0) to the insertion point', () => {
    const diff = [
      'diff --git a/c.ts b/c.ts',
      '--- a/c.ts',
      '+++ b/c.ts',
      '@@ -20,3 +19,0 @@',
      '-a',
      '-b',
      '-c',
    ].join('\n')
    expect(parseDiffHunks(diff).get('c.ts')).toEqual([{ start: 19, end: 19 }])
  })

  it('tracks multiple files independently', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/b.ts b/b.ts',
      '--- a/b.ts',
      '+++ b/b.ts',
      '@@ -40,0 +41,2 @@',
      '+p',
      '+q',
    ].join('\n')
    const hunks = parseDiffHunks(diff)
    expect(hunks.get('a.ts')).toEqual([{ start: 1, end: 1 }])
    expect(hunks.get('b.ts')).toEqual([{ start: 41, end: 42 }])
  })

  it('handles deleted files (with +++ /dev/null) without misattributing hunks', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,3 +1,3 @@',
      ' function fooA() {',
      '-  return 1',
      '+  return 2',
      ' }',
      'diff --git a/z.ts b/z.ts',
      'deleted file mode 100644',
      '--- a/z.ts',
      '+++ /dev/null',
      '@@ -1,10 +0,0 @@',
      '-function fooZ() {',
      '-  return 3',
      '-}',
    ].join('\n')
    const hunks = parseDiffHunks(diff)
    // a.ts should only have the modification hunk
    expect(hunks.get('a.ts')).toEqual([{ start: 1, end: 3 }])
    // z.ts is deleted, so it should not appear in the result
    expect(hunks.get('z.ts')).toBeUndefined()
  })
})

describe('extractTranscriptText (#93)', () => {
  it('collects assistant text blocks in order and skips thinking/tool_use/user records', () => {
    const jsonl = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'SECRET' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'step one' }, { type: 'tool_use', name: 'Read' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'final answer' }] } }),
    ].join('\n')
    expect(extractTranscriptText(jsonl)).toBe('step one\nfinal answer')
  })

  it('accepts a plain-string content form', () => {
    const jsonl = JSON.stringify({ type: 'assistant', message: { content: 'plain text' } })
    expect(extractTranscriptText(jsonl)).toBe('plain text')
  })

  it('skips malformed JSON lines without throwing', () => {
    const jsonl = ['not json', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }), '{ broken'].join('\n')
    expect(extractTranscriptText(jsonl)).toBe('ok')
  })

  it('returns empty string for a file that is not a transcript', () => {
    expect(extractTranscriptText('line one\nline two\n')).toBe('')
  })
})

function ref(filePath: string, line: number, context: string): { filePath: string; name: string; line: number; col: number; context: string } {
  return { filePath, name: 'x', line, col: 0, context }
}

describe('runRefs — multi-symbol merged references (#89 gap A)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('routes a single (comma-free) spec through the original single-symbol path unchanged', () => {
    mockQueryRefs.mockReturnValue([ref('src/auth.ts', 10, 'login()')])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'login' })
      expect(code).toBe(0)
    })
    // Single-symbol output has no `symbol:` header — just file:line: context.
    expect(stdout).toContain('src/auth.ts:10: login()')
    expect(stdout).not.toContain('login:')
  })

  it('caps a single-symbol --json output at overflow_guard.max_tokens, wrapping with items/truncated/totalCount instead of an unbounded array', () => {
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 60 },
    } as unknown as ReturnType<typeof loadConfig>)
    mockQueryRefs.mockReturnValue(Array.from({ length: 50 }, (_, i) => ref('src/auth.ts', i + 1, 'x'.repeat(50))))
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'login', json: true })
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
    expect(parsed.truncated).toBe(true)
    expect(parsed.totalCount).toBe(50)
    expect(parsed.items.length).toBeLessThan(50)
  })

  it('merges several symbols, each under its own header, in one call', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'login') return [ref('src/auth.ts', 10, 'login()')]
      if (opts.name === 'refresh') return [ref('src/session.ts', 22, 'refresh()')]
      return []
    })
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'login,refresh,logout' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('login:')
    expect(stdout).toContain('src/auth.ts:10: login()')
    expect(stdout).toContain('refresh:')
    expect(stdout).toContain('src/session.ts:22: refresh()')
    // A symbol with no hits is reported, not silently dropped.
    expect(stdout).toContain('logout: (no references found)')
  })

  it('scopes every comma-separated symbol to a `::`-prefixed file', () => {
    mockQueryRefs.mockReturnValue([])
    capture(() => runRefs({ spec: 'src/auth.ts::login,refresh' }))
    const names = mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['login', 'refresh'])
    for (const call of mockQueryRefs.mock.calls) {
      expect((call[0] as { filePath?: string }).filePath).toBeDefined()
    }
  })

  it('splits the spec on the LAST :: so a file path containing a literal :: keeps the symbol names intact (#m2)', () => {
    mockQueryRefs.mockReturnValue([])
    capture(() => runRefs({ spec: 'a::b::sym1,sym2' }))
    const names = mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['sym1', 'sym2'])
  })

  it('emits a per-symbol map under --json, each entry using the items/truncated/totalCount envelope', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) =>
      opts.name === 'login' ? [ref('src/auth.ts', 10, 'login()')] : [],
    )
    const { stdout } = capture(() => runRefs({ spec: 'login,refresh', json: true }))
    const parsed = JSON.parse(stdout) as Record<string, { items: unknown[]; truncated: boolean; totalCount: number }>
    expect(Object.keys(parsed)).toEqual(['login', 'refresh'])
    expect(parsed.login?.items).toHaveLength(1)
    expect(parsed.login?.truncated).toBe(false)
    expect(parsed.login?.totalCount).toBe(1)
    expect(parsed.refresh?.items).toHaveLength(0)
    expect(parsed.refresh?.truncated).toBe(false)
    expect(parsed.refresh?.totalCount).toBe(0)
  })

  it('caps a per-symbol entry under --json at overflow_guard.max_tokens, wrapping that entry with items/truncated/totalCount instead of an unbounded array', () => {
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 60 },
    } as unknown as ReturnType<typeof loadConfig>)
    mockQueryRefs.mockImplementation((opts: { name: string }) =>
      opts.name === 'login'
        ? Array.from({ length: 50 }, (_, i) => ref('src/auth.ts', i + 1, 'x'.repeat(50)))
        : [ref('src/auth.ts', 1, 'refresh()')],
    )
    const { stdout } = capture(() => runRefs({ spec: 'login,refresh', json: true }))
    const parsed = JSON.parse(stdout) as Record<string, { items: unknown[]; truncated: boolean; totalCount: number }>
    const login = parsed.login as { items: unknown[]; truncated: boolean; totalCount: number }
    expect(login.truncated).toBe(true)
    expect(login.totalCount).toBe(50)
    expect(login.items.length).toBeLessThan(50)
    // Every entry uses the same envelope, even when nothing was truncated.
    const refresh = parsed.refresh as { items: unknown[]; truncated: boolean; totalCount: number }
    expect(Array.isArray(refresh.items)).toBe(true)
    expect(refresh.truncated).toBe(false)
    expect(refresh.totalCount).toBe(1)
  })

  it('returns exit 1 when no symbol in a multi-spec has any references', () => {
    mockQueryRefs.mockReturnValue([])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'nope1,nope2' })
      expect(code).toBe(1)
    })
    expect(stdout).toContain('nope1: (no references found)')
    expect(stdout).toContain('nope2: (no references found)')
  })

  // `LIMIT 0` in SQL always returns zero rows, so a symbol that genuinely has references would
  // otherwise be reported as "no references found" -- a wrong answer, not just a permissive
  // input. limit: 0 (or negative) must be rejected up front instead of reaching queryRefs, for
  // both the single-symbol path and the multi-symbol merged path.
  it('rejects limit: 0 as an explicit invalid-argument error instead of returning a false "no references found" (single symbol)', () => {
    mockQueryRefs.mockReturnValue([ref('src/auth.ts', 10, 'login()')])
    const { stderr } = capture(() => {
      const code = runRefs({ spec: 'login', limit: 0 })
      expect(code).toBe(1)
    })
    expect(stderr).not.toContain('No references found')
    expect(stderr.toLowerCase()).toContain('limit')
    expect(mockQueryRefs).not.toHaveBeenCalled()
  })

  it('rejects limit: 0 as an explicit invalid-argument error for a multi-symbol spec', () => {
    mockQueryRefs.mockReturnValue([ref('src/auth.ts', 10, 'login()')])
    const { stderr } = capture(() => {
      const code = runRefs({ spec: 'login,refresh', limit: 0 })
      expect(code).toBe(1)
    })
    expect(stderr.toLowerCase()).toContain('limit')
    expect(mockQueryRefs).not.toHaveBeenCalled()
  })

  it('rejects a negative limit as an explicit invalid-argument error', () => {
    const { stderr } = capture(() => {
      const code = runRefs({ spec: 'login', limit: -1 })
      expect(code).toBe(1)
    })
    expect(stderr.toLowerCase()).toContain('limit')
    expect(mockQueryRefs).not.toHaveBeenCalled()
  })
})

// A synthetic multi-file fixture, not a single-file stub: `queryRefs` is faked with the
// SAME filtering semantics as the real SQL query (name always filters; filePath, when
// present, additionally restricts rows to that exact file) so these tests exercise the
// real scoping bug rather than merely asserting on call arguments.
function fakeRefsTable(rows: Array<{ filePath: string; name: string; line: number; context: string }>) {
  return (opts: { name: string; filePath?: string }) =>
    rows
      .filter((r) => r.name === opts.name && (opts.filePath === undefined || r.filePath === opts.filePath))
      .map((r) => ({ filePath: r.filePath, name: r.name, line: r.line, col: 0, context: r.context }))
}

describe('runRefs --callers is codebase-wide, not scoped to the symbol\'s defining file (M33)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runRefsSingle: finds callers in other files, not just the file the symbol is defined in', () => {
    // helperFn is DEFINED in src/util.ts but CALLED from three other files — the
    // realistic shape of a flagship "find all callers" query.
    mockQueryRefs.mockImplementation(
      fakeRefsTable([
        { filePath: 'src/a.ts', name: 'helperFn', line: 10, context: 'helperFn()' },
        { filePath: 'src/b.ts', name: 'helperFn', line: 20, context: 'helperFn()' },
        { filePath: 'src/c.ts', name: 'helperFn', line: 30, context: 'helperFn()' },
      ]),
    )

    const { stdout, stderr } = capture(() => {
      const code = runRefs({ spec: 'src/util.ts::helperFn', callers: true })
      expect(code).toBe(0)
    })

    expect(stderr).toBe('')
    expect(stdout).toContain('src/a.ts')
    expect(stdout).toContain('src/b.ts')
    expect(stdout).toContain('src/c.ts')
  })

  it('runRefs (multi-symbol): finds callers in other files for each symbol under --callers', () => {
    mockQueryRefs.mockImplementation(
      fakeRefsTable([
        { filePath: 'src/x.ts', name: 'login', line: 5, context: 'login()' },
        { filePath: 'src/y.ts', name: 'login', line: 15, context: 'login()' },
        { filePath: 'src/z.ts', name: 'refresh', line: 8, context: 'refresh()' },
      ]),
    )

    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/auth.ts::login,refresh', callers: true })
      expect(code).toBe(0)
    })

    expect(stdout).toContain('src/x.ts')
    expect(stdout).toContain('src/y.ts')
    expect(stdout).toContain('src/z.ts')
  })

  it('without --callers, a file::symbol spec still scopes to that file (unchanged behavior)', () => {
    mockQueryRefs.mockImplementation(
      fakeRefsTable([
        { filePath: 'src/a.ts', name: 'helperFn', line: 10, context: 'helperFn()' },
        { filePath: 'src/b.ts', name: 'helperFn', line: 20, context: 'helperFn()' },
      ]),
    )

    capture(() => runRefs({ spec: 'src/a.ts::helperFn' }))

    expect(mockQueryRefs).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'helperFn', filePath: expect.any(String) }),
    )
  })
})

// Overflow-guard coverage for the surgical-read commands that previously returned
// unguarded text (#5): runSymbol / runRefs / runSkeleton / runOutline now route their
// text output through emitGuarded/guardText the same way runRead/runSection do. Each test
// forces output past a tiny max_tokens and asserts the truncation marker appears — all four
// fail on pre-fix code (full, unbounded output, no marker).
describe('overflow guard applies to symbol/refs/skeleton/outline (#5)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 20 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  it('caps runSymbol output', () => {
    const bigLine = 'x'.repeat(500)
    const sym = {
      name: 'huge',
      kind: 'function',
      filePath: 'big.ts',
      lineStart: 1,
      lineEnd: 5,
      body: Array.from({ length: 5 }, () => bigLine).join('\n'),
      docstring: '',
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuerySymbols.mockReturnValue([sym as any])
    const { text } = runSymbol({ name: 'huge' })
    expect(text).toContain('output capped at ~20 tokens')
    expect(text).not.toContain('x'.repeat(500))
  })

  it('caps runSkeleton output', () => {
    const syms = Array.from({ length: 300 }, (_, i) => ({
      name: `sym${i}`,
      kind: 'function',
      filePath: 'big.ts',
      lineStart: i + 1,
      lineEnd: i + 1,
      body: `function sym${i}() {}`,
      docstring: '',
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuerySymbols.mockReturnValue(syms as any)
    const { text } = runSkeleton({ file: 'big.ts' })
    expect(text).toContain('output capped at ~20 tokens')
    expect(text).not.toContain('sym299')
  })

  it('caps runOutline output', () => {
    const syms = Array.from({ length: 300 }, (_, i) => ({
      name: `sym${i}`,
      kind: 'function',
      filePath: 'big.ts',
      lineStart: i + 1,
      lineEnd: i + 2,
      body: `function sym${i}() {}`,
      docstring: '',
    }))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuerySymbols.mockReturnValue(syms as any)
    const { text } = runOutline({ file: 'big.ts' })
    expect(text).toContain('output capped at ~20 tokens')
    expect(text).not.toContain('sym299')
  })

  it('caps runRefs output', () => {
    const refs = Array.from({ length: 300 }, (_, i) => ref('src/big.ts', i + 1, `use${i}()`))
    mockQueryRefs.mockReturnValue(refs)
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'huge' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('output capped at ~20 tokens')
    expect(stdout).not.toContain('use299()')
  })
})
