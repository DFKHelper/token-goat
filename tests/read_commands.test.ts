import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import Database from 'better-sqlite3'

// Stub the DB-layer imports so tests don't need a real SQLite DB
vi.mock('../src/index_reader.js', () => ({
  querySymbols: vi.fn(() => []),
  countSymbols: vi.fn(() => 0),
  queryRefs: vi.fn(() => []),
  countRefs: vi.fn(() => 0),
  getFileEntry: vi.fn(() => null),
  queryRefCounts: vi.fn(() => new Map()),
}))

vi.mock('../src/section_reader.js', () => ({
  readSection: vi.fn(() => null),
  listSections: vi.fn(() => []),
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
  enqueueDirtyPathSafe: vi.fn(),
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

vi.mock('../src/screenshot.js', () => ({
  takeScreenshot: vi.fn(async () => ({ path: '/tmp/out.png', originalBytes: 100, finalBytes: 50 })),
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
  runJsonOutline,
  runJsonQuery,
  runYamlOutline,
  runYamlQuery,
  runSqliteSchema,
  runSqliteQuery,

  runExports,
  runImports,
  runChanged,
  runDiff,
  runLog,
  runRefs,
  runBrief,
  extractImports,
  importsExtensionFor,
  extractExportNames,
  extractTranscriptText,
  parseDiffHunks,
  runScreenshot,
  runZipRead,
} from '../src/read_commands.js'
import { querySymbols, countSymbols, queryRefs, countRefs, queryRefCounts, getFileEntry } from '../src/index_reader.js'
import type { SymbolEntry } from '../src/parser_types.js'
import { runGit } from '../src/util.js'
import { resolveIndexPath } from '../src/paths.js'
import { readSection, listSections, findContainingSection } from '../src/section_reader.js'
import { loadConfig } from '../src/config.js'
import { indexFileSync } from '../src/parser.js'
import { resolveCallers } from '../src/graph_commands.js'
import { resolveProjectRoot } from '../src/project.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { enqueueDirtyPathSafe } from '../src/hooks_index.js'
import { takeScreenshot } from '../src/screenshot.js'

const mockQuerySymbols = vi.mocked(querySymbols)
const mockCountSymbols = vi.mocked(countSymbols)
const mockAppendDirtyPath = vi.mocked(enqueueDirtyPathSafe)
const mockQueryRefCounts = vi.mocked(queryRefCounts)
const mockGetFileEntry = vi.mocked(getFileEntry)
const mockFindContainingSection = vi.mocked(findContainingSection)
const mockResolveCallers = vi.mocked(resolveCallers)
const mockQueryRefs = vi.mocked(queryRefs)
const mockCountRefs = vi.mocked(countRefs)
const mockReadSection = vi.mocked(readSection)
const mockListSections = vi.mocked(listSections)
const mockIndexFileSync = vi.mocked(indexFileSync)
const mockLoadConfig = vi.mocked(loadConfig)
const mockTakeScreenshot = vi.mocked(takeScreenshot)

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
      mockCountSymbols.mockReturnValue(1)
      const { text: stdout } = runSymbol({ name: 'fn', json: true })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(Array.isArray(parsed.items)).toBe(true)
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(1)
    })

    it('reports the true DB total (ignoring the SQL LIMIT already applied to `results`) in --json totalCount, marking truncated even when overflow_guard never kicks in (regression: totalCount used to equal results.length, silently hiding matches beyond --limit)', () => {
      const sym: MockSymbol = { name: 'main', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'function main() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      // 105 real matches in the DB; querySymbols's own LIMIT already cut that down to the 1 row returned above.
      mockCountSymbols.mockReturnValue(105)
      const { text: stdout } = runSymbol({ name: 'main', json: true, limit: 1 })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.items).toHaveLength(1)
      expect(parsed.totalCount).toBe(105)
      expect(parsed.truncated).toBe(true)
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
      mockCountSymbols.mockReturnValue(50)
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
      mockCountSymbols.mockReturnValue(50)
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

    it('self-heals (inline reparse) instead of warning when a file-scoped query targets an index row whose sha is stale (#1)', () => {
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
      // Fix: a stale sha triggers an inline reparse (indexFileSync) before the query runs,
      // instead of just prepending a warning telling the agent to burn a full-file read.
      expect(mockIndexFileSync).toHaveBeenCalled()
      expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath(f), { alreadyResolved: true })
      expect(stdout).not.toContain('STALE')
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

      it('self-heals (inline reparse) instead of warning when the indexed sha differs from the on-disk file sha (#1)', () => {
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
        // Fix: a stale sha triggers an inline reparse before the symbol lookup, instead of just
        // prepending a warning telling the agent to burn a full-file read.
        expect(mockIndexFileSync).toHaveBeenCalled()
        expect(stdout).not.toContain('STALE')
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
        expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath(f), { alreadyResolved: true })
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
      mockListSections.mockReturnValue([])
      runSection({ spec: 'a::b::Heading' })
      expect(mockReadSection).toHaveBeenCalledWith('a::b', 'Heading')
    })

    it('returns 1 when section not found', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Other'])
      const { text: stderr } = runSection({ spec: 'README.md::Install' })
      expect(stderr).toContain('Install')
    })

    it('caps the heading list on section miss at DIDYOUMEAN_LIMIT (5), matching runRead\'s "did you mean" cap, instead of dumping every heading (regression: unbounded "Available sections" dump)', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue([
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
      // Regression: the cap used to be silent, giving no indication that 2 more headings
      // existed beyond the 5 shown.
      expect(stderr).toContain('(2 more not shown)')
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

    it('distinguishes a recognized-but-unsupported language from a plain empty index (regression: Scala/Lua/etc. are indistinguishable from an empty file)', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runSkeleton({ file: 'missing.scala' })
      expect(code).toBe(1)
      // Scala now has an extractor, so empty file gets the standard message
      expect(text).toContain('No indexed symbols found')
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
      expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath('a.ts', process.cwd()), { alreadyResolved: true })
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

    it('self-heals (inline reparse) instead of warning when the on-disk file sha differs from the indexed row (#1)', () => {
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
      // Fix: a stale sha triggers an inline reparse before the symbol listing query, instead of
      // just prepending a warning telling the agent to burn a full-file read.
      expect(mockIndexFileSync).toHaveBeenCalled()
      expect(stdout).not.toContain('STALE')
      expect(stdout).toContain('foo')
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
    it('returns 1 and reports no symbols for an empty file in a supported language', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runOutline({ file: 'empty.dart' })
      expect(code).toBe(1)
      // Dart now has a symbol extractor, so it just reports "no symbols found"
      expect(text).toContain('No indexed symbols found')
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
      expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath('f.ts', process.cwd()), { alreadyResolved: true })
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

    it('self-heals (inline reparse) instead of warning when the on-disk file sha differs from the indexed row (#1)', () => {
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
      // Fix: a stale sha triggers an inline reparse before the symbol listing query, instead of
      // just prepending a warning telling the agent to burn a full-file read.
      expect(mockIndexFileSync).toHaveBeenCalled()
      expect(stdout).not.toContain('STALE')
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
      // Third arg is the resolved symbol's own filePath -- runBrief passes it through so
      // resolveCallers can disambiguate a same-named symbol defined elsewhere (regression:
      // task #136, same-project name-collision merging in callers/dead).
      expect(mockResolveCallers).toHaveBeenCalledWith('myFunc', undefined, 'f.ts')
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
      const parsed = JSON.parse(stdout) as { items: Array<{ file: string; line: number; text: string }>; truncated: boolean; totalCount: number }
      expect(Array.isArray(parsed.items)).toBe(true)
      expect(parsed.items[0]?.text).toContain('match')
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(1)
    })

    it('surfaces truncated:true and the real totalCount in JSON mode when hits exceed --max-lines', () => {
      const f = path.join(tempDir, 'jtrunc.txt')
      fs.writeFileSync(f, 'needle\nneedle\nneedle\nneedle')
      const { stdout } = capture(() => { runGrep({ pattern: 'needle', path: f, maxLines: 2, json: true }) })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.items).toHaveLength(2)
      expect(parsed.truncated).toBe(true)
      expect(parsed.totalCount).toBe(4)
    })

    it('does not report truncated:true when hit count exactly equals --max-lines (boundary, not off-by-one)', () => {
      // Regression/mutation-verification target: the JSON truncation flag is `hits.length >
      // maxLines`, not `>=` -- when the real hit count exactly equals the cap, every hit was
      // returned and nothing was actually elided, so truncated must stay false.
      const f = path.join(tempDir, 'jexact.txt')
      fs.writeFileSync(f, 'needle\nneedle')
      const { stdout } = capture(() => { runGrep({ pattern: 'needle', path: f, maxLines: 2, json: true }) })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.items).toHaveLength(2)
      expect(parsed.truncated).toBe(false)
      expect(parsed.totalCount).toBe(2)
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
      const parsed = JSON.parse(stdout) as { items: Array<{ file: string; line: number; text: string; context?: Array<{ line: number; text: string }> }> }
      expect(parsed.items).toHaveLength(1)
      const hit = parsed.items[0]
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
      const parsed = JSON.parse(stdout) as { items: Array<Record<string, unknown>> }
      expect(parsed.items[0]).not.toHaveProperty('context')
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

    it('reads a key from a section whose name contains a "#" or ";" character (regression: the section-header scan did trimmed.split(/[#;]/)[0] before checking startsWith("[")/endsWith("]"), so a section name legitimately containing "#" or ";" -- both legal in INI/TOML section names -- got truncated before the closing "]" was seen, silently dropping the header and making every key nested under it unreachable)', () => {
      const f = path.join(tempDir, 'hash-section.ini')
      fs.writeFileSync(f, '[server#1]\nhost = example.com\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'server#1.host' }) })
      expect(stdout.trim()).toBe('example.com')
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

    it('strips a trailing inline comment from a TOML value containing an escaped quote (regression: stripInlineComment had no backslash-escape awareness, so an escaped quote inside a double-quoted value was misread as the real closing quote -- the following literal quote then reopened a new unterminated quoted region, and any trailing #/; comment on the same line was wrongly treated as still inside quotes and never stripped)', () => {
      const f = path.join(tempDir, 'escaped-quote.toml')
      fs.writeFileSync(f, '[tool]\nname = "a\\"b" # real comment should be stripped\n')
      const { stdout } = capture(() => { runConfigGet({ file: f, key: 'tool.name' }) })
      expect(stdout.trim()).not.toContain('comment')
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

    // Regression: --json + --head reported totalCount/truncated off the already-head-limited
    // rows array (queryCsv applies --head internally before returning), so a 50-row CSV capped
    // to --head 5 showed totalCount:5 truncated:false -- indistinguishable from "the file only
    // has 5 rows" even though 45 real rows were silently dropped. Fixed by reading
    // queryCsv's own pre-head result.totalRows instead of the post-head array's length.
    it('reflects --head truncation honestly in the --json envelope (regression: totalCount used to equal the head-limited count, not the true row count)', () => {
      const f = path.join(tempDir, 'head_json.csv')
      const lines = ['id,name']
      for (let i = 1; i <= 50; i++) lines.push(`${i},row${i}`)
      fs.writeFileSync(f, lines.join('\n') + '\n')
      const { stdout } = capture(() => { runCsvQuery({ file: f, head: '5', json: true }) })
      const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      expect(parsed.items.length).toBe(5)
      expect(parsed.truncated).toBe(true)
      expect(parsed.totalCount).toBe(50)
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

  // ---- runJsonOutline ---------------------------------------------------

  describe('runJsonOutline', () => {
    it('summarizes an array of objects: length, element type, and merged key/type shape', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, JSON.stringify([
        { id: 1, name: 'Alice', tags: ['a', 'b'] },
        { id: 2, name: 'Bob', tags: [] },
        { id: 3, name: 'Carol', tags: ['c'] },
      ]))
      const { stdout } = capture(() => { runJsonOutline({ file: f }) })
      expect(stdout).toContain('array of 3 elements (object)')
      expect(stdout).toContain('id: number')
      expect(stdout).toContain('name: string')
      expect(stdout).toContain('tags: array (2)')
    })

    it('flags a heterogeneous array whose sampled elements have different key sets', () => {
      const f = path.join(tempDir, 'mixed.json')
      fs.writeFileSync(f, JSON.stringify([{ a: 1, b: 2 }, { a: 1, c: 3 }]))
      const { stdout } = capture(() => { runJsonOutline({ file: f }) })
      expect(stdout).toContain('shape varies across sample')
    })

    it('summarizes a top-level object as top-level keys with type and size', () => {
      const f = path.join(tempDir, 'config.json')
      fs.writeFileSync(f, JSON.stringify({ name: 'app', version: '1.0.0', deps: { a: 1, b: 2 }, items: [1, 2, 3] }))
      const { stdout } = capture(() => { runJsonOutline({ file: f }) })
      expect(stdout).toContain('name: string')
      expect(stdout).toContain('deps: object (2)')
      expect(stdout).toContain('items: array (3)')
    })

    it('summarizes a top-level scalar as a primitive', () => {
      const f = path.join(tempDir, 'scalar.json')
      fs.writeFileSync(f, '42')
      const { stdout } = capture(() => { runJsonOutline({ file: f }) })
      expect(stdout).toContain('(scalar number)')
    })

    it('emits a structured outline object under --json', () => {
      const f = path.join(tempDir, 'people2.json')
      fs.writeFileSync(f, JSON.stringify([{ id: 1 }, { id: 2 }]))
      const { stdout } = capture(() => { runJsonOutline({ file: f, json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.kind).toBe('array')
      expect(parsed.length).toBe(2)
    })

    it('returns 1 when the file does not exist', () => {
      const code = runJsonOutline({ file: path.join(tempDir, 'missing.json') })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on invalid JSON', () => {
      const f = path.join(tempDir, 'bad.json')
      fs.writeFileSync(f, '{ not valid json')
      let code = -1
      const { stderr } = capture(() => { code = runJsonOutline({ file: f }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse JSON')
    })
  })

  // ---- runJsonQuery ------------------------------------------------------

  describe('runJsonQuery', () => {
    const PEOPLE = JSON.stringify({
      items: [
        { id: 1, name: 'Alice', status: 'active' },
        { id: 2, name: 'Bob', status: 'inactive' },
        { id: 3, name: 'Carol', status: 'active' },
      ],
    })

    it('extracts a single value at a dot-path', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[0].name' }) })
      expect(stdout.trim()).toBe('"Alice"')
    })

    it('extracts a nested object as pretty-printed JSON text by default', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[1]' }) })
      expect(stdout).toContain('"name": "Bob"')
    })

    it('projects a field across every array element with [*]', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[*].name' }) })
      expect(stdout).toContain('"Alice"')
      expect(stdout).toContain('"Bob"')
      expect(stdout).toContain('"Carol"')
    })

    it('filters array elements by field value with [field=value]', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[status=active]' }) })
      expect(stdout).toContain('Alice')
      expect(stdout).toContain('Carol')
      expect(stdout).not.toContain('Bob')
    })

    it('emits a JSON envelope with items/truncated/totalCount for a fanned result under --json', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[*].id', json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.items).toEqual([1, 2, 3])
      expect(parsed.totalCount).toBe(3)
      expect(parsed.truncated).toBe(false)
    })

    it('caps a fanned result to --head, reporting the real total and an elision note in text mode', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[*].id', head: '1' }) })
      expect(stdout).toContain('2 more items elided')
    })

    it('caps a fanned --json result to --head, reflecting the head cut in truncated/totalCount', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[*].id', head: '1', json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.items).toEqual([1])
      expect(parsed.totalCount).toBe(3)
      expect(parsed.truncated).toBe(true)
    })

    it('caps an oversized text-mode fanned result at overflow_guard.max_tokens', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 20 },
      } as unknown as ReturnType<typeof loadConfig>)
      const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `person-${i}-`.repeat(5) }))
      const f = path.join(tempDir, 'big.json')
      fs.writeFileSync(f, JSON.stringify({ items }))
      const { stdout } = capture(() => { runJsonQuery({ file: f, path: 'items[*]' }) })
      expect(stdout).toContain('output capped at')
    })

    it('returns 1 with a clear error for a missing key on a non-fanned path', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      let code = -1
      const { stderr } = capture(() => { code = runJsonQuery({ file: f, path: 'items[0].doesNotExist' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('path not found')
    })

    it('returns 1 with a clear error for an out-of-range array index', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      let code = -1
      const { stderr } = capture(() => { code = runJsonQuery({ file: f, path: 'items[99]' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('out of range')
    })

    it('returns 1 with a clear error for an invalid path spec', () => {
      const f = path.join(tempDir, 'people.json')
      fs.writeFileSync(f, PEOPLE)
      let code = -1
      const { stderr } = capture(() => { code = runJsonQuery({ file: f, path: 'items[unterminated' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('invalid path spec')
    })

    it('returns 1 when the file does not exist', () => {
      const code = runJsonQuery({ file: path.join(tempDir, 'missing.json'), path: 'foo' })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on invalid JSON', () => {
      const f = path.join(tempDir, 'bad.json')
      fs.writeFileSync(f, '{ not valid json')
      let code = -1
      const { stderr } = capture(() => { code = runJsonQuery({ file: f, path: 'foo' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse JSON')
    })
  })

  // ---- runYamlOutline / runYamlQuery -------------------------------------

  describe('runYamlOutline', () => {
    it('summarizes a single-document YAML mapping as top-level keys with type and size', () => {
      const f = path.join(tempDir, 'config.yaml')
      fs.writeFileSync(f, 'name: app\nversion: "1.0.0"\ndeps:\n  a: 1\n  b: 2\nitems:\n  - 1\n  - 2\n  - 3\n')
      const { stdout } = capture(() => { runYamlOutline({ file: f }) })
      expect(stdout).toContain('name: string')
      expect(stdout).toContain('deps: object (2)')
      expect(stdout).toContain('items: array (3)')
    })

    it('summarizes a YAML sequence of mappings: length, element type, and merged key/type shape', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, '- id: 1\n  name: Alice\n- id: 2\n  name: Bob\n')
      const { stdout } = capture(() => { runYamlOutline({ file: f }) })
      expect(stdout).toContain('array of 2 elements (object)')
      expect(stdout).toContain('id: number')
      expect(stdout).toContain('name: string')
    })

    it('outlines a multi-document YAML stream as an array of documents', () => {
      const f = path.join(tempDir, 'multi.yaml')
      fs.writeFileSync(f, 'kind: Service\n---\nkind: Deployment\n')
      const { stdout } = capture(() => { runYamlOutline({ file: f }) })
      expect(stdout).toContain('array of 2 elements (object)')
    })

    it('emits a structured outline object under --json', () => {
      const f = path.join(tempDir, 'people2.yaml')
      fs.writeFileSync(f, '- id: 1\n- id: 2\n')
      const { stdout } = capture(() => { runYamlOutline({ file: f, json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.kind).toBe('array')
      expect(parsed.length).toBe(2)
    })

    it('returns 1 when the file does not exist', () => {
      const code = runYamlOutline({ file: path.join(tempDir, 'missing.yaml') })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on invalid YAML', () => {
      const f = path.join(tempDir, 'bad.yaml')
      fs.writeFileSync(f, 'key: [unterminated\n')
      let code = -1
      const { stderr } = capture(() => { code = runYamlOutline({ file: f }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse YAML')
    })
  })

  describe('runYamlQuery', () => {
    const PEOPLE_YAML = 'items:\n  - id: 1\n    name: Alice\n    status: active\n  - id: 2\n    name: Bob\n    status: inactive\n  - id: 3\n    name: Carol\n    status: active\n'

    it('extracts a single value at a dot-path', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[0].name' }) })
      expect(stdout.trim()).toBe('"Alice"')
    })

    it('projects a field across every array element with [*]', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[*].name' }) })
      expect(stdout).toContain('"Alice"')
      expect(stdout).toContain('"Bob"')
      expect(stdout).toContain('"Carol"')
    })

    it('filters array elements by field value with [field=value]', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[status=active]' }) })
      expect(stdout).toContain('Alice')
      expect(stdout).toContain('Carol')
      expect(stdout).not.toContain('Bob')
    })

    it('indexes into a multi-document YAML stream with [n]', () => {
      const f = path.join(tempDir, 'multi.yaml')
      fs.writeFileSync(f, 'kind: Service\nmetadata:\n  name: svc\n---\nkind: Deployment\nmetadata:\n  name: dep\n')
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: '[1].kind' }) })
      expect(stdout.trim()).toBe('"Deployment"')
    })

    it('emits a JSON envelope with items/truncated/totalCount for a fanned result under --json', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[*].id', json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.items).toEqual([1, 2, 3])
      expect(parsed.totalCount).toBe(3)
      expect(parsed.truncated).toBe(false)
    })

    it('caps a fanned result to --head, reporting the real total and an elision note in text mode', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[*].id', head: '1' }) })
      expect(stdout).toContain('2 more items elided')
    })

    it('caps a fanned --json result to --head, reflecting the head cut in truncated/totalCount', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[*].id', head: '1', json: true }) })
      const parsed = JSON.parse(stdout)
      expect(parsed.items).toEqual([1])
      expect(parsed.totalCount).toBe(3)
      expect(parsed.truncated).toBe(true)
    })

    it('caps an oversized text-mode fanned result at overflow_guard.max_tokens', () => {
      mockLoadConfig.mockReturnValue({
        overflow_guard: { enabled: true, max_tokens: 20 },
      } as unknown as ReturnType<typeof loadConfig>)
      const lines = ['items:']
      for (let i = 0; i < 500; i++) {
        lines.push(`  - id: ${i}`)
        lines.push(`    name: "${`person-${i}-`.repeat(5)}"`)
      }
      const f = path.join(tempDir, 'big.yaml')
      fs.writeFileSync(f, lines.join('\n') + '\n')
      const { stdout } = capture(() => { runYamlQuery({ file: f, path: 'items[*]' }) })
      expect(stdout).toContain('output capped at')
    })

    it('returns 1 with a clear error for a missing key on a non-fanned path', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      let code = -1
      const { stderr } = capture(() => { code = runYamlQuery({ file: f, path: 'items[0].doesNotExist' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('path not found')
    })

    it('returns 1 with a clear error for an out-of-range array index', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      let code = -1
      const { stderr } = capture(() => { code = runYamlQuery({ file: f, path: 'items[99]' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('out of range')
    })

    it('returns 1 with a clear error for an invalid path spec', () => {
      const f = path.join(tempDir, 'people.yaml')
      fs.writeFileSync(f, PEOPLE_YAML)
      let code = -1
      const { stderr } = capture(() => { code = runYamlQuery({ file: f, path: 'items[unterminated' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('invalid path spec')
    })

    it('returns 1 when the file does not exist', () => {
      const code = runYamlQuery({ file: path.join(tempDir, 'missing.yaml'), path: 'foo' })
      expect(code).toBe(1)
    })

    it('returns 1 with a clear message on invalid YAML', () => {
      const f = path.join(tempDir, 'bad.yaml')
      fs.writeFileSync(f, 'key: [unterminated\n')
      let code = -1
      const { stderr } = capture(() => { code = runYamlQuery({ file: f, path: 'foo' }) })
      expect(code).toBe(1)
      expect(stderr).toContain('Failed to parse YAML')
    })
  })

  // ---- runSqliteSchema / runSqliteQuery ----------------------------------

  describe('runSqliteSchema / runSqliteQuery', () => {
    function makeFixtureDb(): string {
      const f = path.join(tempDir, 'fixture.db')
      const db = new Database(f)
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT
        );
      `)
      const insert = db.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)')
      insert.run(1, 'Alice', 'alice@example.com')
      insert.run(2, 'Bob', 'bob@example.com')
      insert.run(3, 'Carol', null)
      db.close()
      return f
    }

    describe('runSqliteSchema', () => {
      it('prints table/column/row-count detail for a real database', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => { runSqliteSchema({ file: f }) })
        expect(stdout).toContain('users  (table, 3 rows)')
        expect(stdout).toContain('id INTEGER')
        expect(stdout).toContain('name TEXT')
      })

      it('emits a structured schema object under --json', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => { runSqliteSchema({ file: f, json: true }) })
        const parsed = JSON.parse(stdout)
        expect(parsed.tables[0].name).toBe('users')
        expect(parsed.tables[0].rowCount).toBe(3)
      })

      it('returns 1 with a clear message when the file does not exist', () => {
        let code = -1
        const { stderr } = capture(() => { code = runSqliteSchema({ file: path.join(tempDir, 'missing.db') }) })
        expect(code).toBe(1)
        expect(stderr).toContain('file not found')
      })

      it('returns 1 with a clear message for a corrupt/non-SQLite file, never a raw stack trace', () => {
        const f = path.join(tempDir, 'not-a-db.txt')
        fs.writeFileSync(f, 'just plain text, definitely not a sqlite database')
        let code = -1
        const { stderr } = capture(() => { code = runSqliteSchema({ file: f }) })
        expect(code).toBe(1)
        expect(stderr).toContain('not a valid SQLite database')
      })
    })

    describe('runSqliteQuery', () => {
      it('runs a SELECT and prints a CSV-style table', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => { runSqliteQuery({ file: f, sql: 'SELECT id, name FROM users ORDER BY id' }) })
        expect(stdout.split('\n')[0]).toBe('id,name')
        expect(stdout).toContain('1,Alice')
      })

      it('emits a JSON envelope with columns/items/truncated/totalCount under --json', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => {
          runSqliteQuery({ file: f, sql: 'SELECT id, name FROM users ORDER BY id', json: true })
        })
        const parsed = JSON.parse(stdout)
        expect(parsed.columns).toEqual(['id', 'name'])
        expect(parsed.items).toEqual([
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
          { id: 3, name: 'Carol' },
        ])
        expect(parsed.truncated).toBe(false)
      })

      it('limits results with --head and notes elision in text mode', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => {
          runSqliteQuery({ file: f, sql: 'SELECT id FROM users ORDER BY id', head: '1' })
        })
        expect(stdout).toContain('1')
        expect(stdout).not.toContain('2\n3')
        expect(stdout).toContain('more rows elided')
      })

      it('reflects --head truncation in the --json envelope', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => {
          runSqliteQuery({ file: f, sql: 'SELECT id FROM users ORDER BY id', head: '1', json: true })
        })
        const parsed = JSON.parse(stdout)
        expect(parsed.items).toEqual([{ id: 1 }])
        expect(parsed.truncated).toBe(true)
      })

      // Regression: totalCount was read off the already-head-sliced rows array (capped.totalCount),
      // so --head 1 against a 3-row result reported totalCount:1 instead of the true row count 3 --
      // a JSON consumer had no honest signal of how many rows the query actually matched.
      it('reports the true row count in totalCount, not the --head-limited count', () => {
        const f = makeFixtureDb()
        const { stdout } = capture(() => {
          runSqliteQuery({ file: f, sql: 'SELECT id FROM users ORDER BY id', head: '1', json: true })
        })
        const parsed = JSON.parse(stdout)
        expect(parsed.totalCount).toBe(3)
      })

      it('caps an oversized result at overflow_guard.max_tokens under --json', () => {
        mockLoadConfig.mockReturnValue({
          overflow_guard: { enabled: true, max_tokens: 20 },
        } as unknown as ReturnType<typeof loadConfig>)
        const f = path.join(tempDir, 'big.db')
        const db = new Database(f)
        db.exec('CREATE TABLE items (id INTEGER, blob TEXT)')
        const insert = db.prepare('INSERT INTO items (id, blob) VALUES (?, ?)')
        for (let i = 0; i < 500; i++) insert.run(i, `item-${i}-`.repeat(5))
        db.close()
        const { stdout } = capture(() => {
          runSqliteQuery({ file: f, sql: 'SELECT * FROM items', json: true })
        })
        const parsed = JSON.parse(stdout)
        expect(parsed.truncated).toBe(true)
      })

      it('rejects an INSERT attempt, returning 1 with a clear message', () => {
        const f = makeFixtureDb()
        let code = -1
        const { stderr } = capture(() => {
          code = runSqliteQuery({ file: f, sql: "INSERT INTO users (id, name) VALUES (4, 'Eve')" })
        })
        expect(code).toBe(1)
        expect(stderr).toContain('only SELECT statements are allowed')
        // Row count must be unchanged -- the rejection happened before execution.
        const check = new Database(f, { readonly: true })
        const row = check.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
        check.close()
        expect(row.c).toBe(3)
      })

      it('rejects a DROP TABLE attempt, returning 1 with a clear message', () => {
        const f = makeFixtureDb()
        let code = -1
        const { stderr } = capture(() => { code = runSqliteQuery({ file: f, sql: 'DROP TABLE users' }) })
        expect(code).toBe(1)
        expect(stderr).toContain('only SELECT statements are allowed')
        const check = new Database(f, { readonly: true })
        const row = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
        check.close()
        expect(row).toBeDefined()
      })

      it('rejects a multi-statement injection attempt, returning 1 with a clear message', () => {
        const f = makeFixtureDb()
        let code = -1
        const { stderr } = capture(() => {
          code = runSqliteQuery({ file: f, sql: 'SELECT 1; DROP TABLE users;' })
        })
        expect(code).toBe(1)
        expect(stderr).toContain('multiple statements are not allowed')
        const check = new Database(f, { readonly: true })
        const row = check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='users'").get()
        check.close()
        expect(row).toBeDefined()
      })

      it('returns 1 with a clear message when the file does not exist', () => {
        let code = -1
        const { stderr } = capture(() => {
          code = runSqliteQuery({ file: path.join(tempDir, 'missing.db'), sql: 'SELECT 1' })
        })
        expect(code).toBe(1)
        expect(stderr).toContain('file not found')
      })

      it('returns 1 with a clear message for a corrupt/non-SQLite file', () => {
        const f = path.join(tempDir, 'not-a-db.txt')
        fs.writeFileSync(f, 'not a database at all')
        let code = -1
        const { stderr } = capture(() => { code = runSqliteQuery({ file: f, sql: 'SELECT 1' }) })
        expect(code).toBe(1)
        expect(stderr).toContain('not a valid SQLite database')
      })
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

    it('strips a trailing # comment from a Python import line (regression: `import os  # note` folded the comment into the module name)', () => {
      const src = [
        'import os  # the os module',
        'import sys',
        'import a, b  # two at once',
      ].join('\n')
      expect(extractImports(src, '.py')).toEqual(['os', 'sys', 'a', 'b'])
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

    it('extracts Rust restricted-visibility re-exports (regression: bare `pub\\s+` missed `pub(crate) use`/`pub(super) use`/`pub(in ...) use`)', () => {
      const src = [
        'pub(crate) use foo::Bar;',
        'pub(super) use x::Y;',
        'pub(in crate::a) use z::W;',
        '    pub(crate) use indented::Thing;',
      ].join('\n')
      expect(extractImports(src, '.rs')).toEqual([
        'foo::Bar', 'x::Y', 'z::W', 'indented::Thing',
      ])
    })

    it('extracts Zig @import builtins (regression: the @-prefixed builtin never matched the generic import|require|use fallback, so every .zig file reported zero imports)', () => {
      const src = [
        'const std = @import("std");',
        'const foo = @import("foo.zig");',
        'pub const bar = @import("bar.zig");',
        'const a = @import("a.zig"); const b = @import("b.zig");',
      ].join('\n')
      expect(extractImports(src, '.zig')).toEqual(['std', 'foo.zig', 'bar.zig', 'a.zig', 'b.zig'])
    })

    it('extracts R library/require/source loads (regression: library/source are not fallback keywords and require( puts a paren where the fallback expects whitespace, so every .r file reported zero imports)', () => {
      const src = [
        'library(dplyr)',
        'require(ggplot2)',
        'library("tidyr")',
        'source("utils.R")',
        'library(data.table, warn.conflicts = FALSE)',
        'suppressMessages(library(stringr))',
      ].join('\n')
      expect(extractImports(src, '.r')).toEqual([
        'dplyr', 'ggplot2', 'tidyr', 'utils.R', 'data.table', 'stringr',
      ])
    })

    it('extracts Lua require() calls in both paren and paren-less quoted forms (regression: the generic fallback only matched the paren-less `require "mod"`, so the dominant `require("mod")` form reported zero imports)', () => {
      const src = [
        'local m = require("foo")',
        "require('bar')",
        'require "baz"',
        'local x = require("a.b.c")',
      ].join('\n')
      expect(extractImports(src, '.lua')).toEqual(['foo', 'bar', 'baz', 'a.b.c'])
    })

    it('de-duplicates repeated specifiers', () => {
      expect(extractImports("import a from 'x'\nimport b from 'x'", '.ts')).toEqual(['x'])
    })

    it('extracts C# using directives, including using static', () => {
      const src = 'using System.Collections.Generic;\nusing static System.Math;\nnamespace Foo {}'
      expect(extractImports(src, '.cs')).toEqual(['System.Collections.Generic', 'System.Math'])
    })

    it('extracts PHP require_once/include_once alongside bare require/include and use', () => {
      const src = [
        "require_once 'a.php';",
        "include_once 'b.php';",
        "require 'c.php';",
        "include 'd.php';",
        'use App\\Foo;',
      ].join('\n')
      expect(extractImports(src, '.php')).toEqual(['a.php', 'b.php', 'c.php', 'd.php', 'App\\Foo'])
    })

    it('extracts PHP require_once/include_once written in function-call form with parens', () => {
      const src = [
        "require_once('e.php');",
        "include_once ('f.php');",
        "require('g.php');",
      ].join('\n')
      expect(extractImports(src, '.php')).toEqual(['e.php', 'f.php', 'g.php'])
    })

    it('extracts PowerShell Import-Module, using module, and dot-sourcing', () => {
      const src = [
        'Import-Module Az.Accounts',
        'Import-Module -Name Pester',
        'using module MyModule.psm1',
        '. .\\helpers.ps1',
      ].join('\n')
      expect(extractImports(src, '.ps1')).toEqual([
        'Az.Accounts',
        'Pester',
        'MyModule.psm1',
        '.\\helpers.ps1',
      ])
    })

    it('matches PowerShell Import-Module case-insensitively (regression: generic fallback is lowercase-only and never matched capitalized "Import-Module")', () => {
      expect(extractImports('IMPORT-MODULE Az.Storage', '.psm1')).toEqual(['Az.Storage'])
    })

    it('extracts Makefile include/-include/sinclude directives (regression: generic fallback requires a literal "#include" and never matched bare "include")', () => {
      const src = [
        'include config.mk',
        '-include optional.mk',
        'sinclude legacy.mk',
        'include foo.mk bar.mk',
        '',
        'all:',
        '\tinclude this is a recipe line, not a directive',
        '# include commented.mk',
      ].join('\n')
      expect(extractImports(src, '.mk')).toEqual([
        'config.mk',
        'optional.mk',
        'legacy.mk',
        'foo.mk',
        'bar.mk',
      ])
    })

    it('strips a trailing # comment from a Makefile include line (regression: the comment words and bare "#" were mis-extracted as phantom include targets)', () => {
      const src = [
        'include config.mk  # optional local overrides',
        'include a.mk b.mk # two targets',
      ].join('\n')
      expect(extractImports(src, '.mk')).toEqual(['config.mk', 'a.mk', 'b.mk'])
    })
  })

  describe('importsExtensionFor', () => {
    it('maps a bare Makefile/GNUmakefile/BSDmakefile basename to the synthetic .mk key (regression: path.extname() alone yields "" for these, routing to the generic fallback that never matches bare "include")', () => {
      expect(importsExtensionFor('Makefile')).toBe('.mk')
      expect(importsExtensionFor('/repo/GNUmakefile')).toBe('.mk')
      expect(importsExtensionFor('/repo/BSDmakefile')).toBe('.mk')
      expect(importsExtensionFor('makefile')).toBe('.mk')
    })

    it('falls back to the real extension for everything else', () => {
      expect(importsExtensionFor('src/foo.ts')).toBe('.ts')
      expect(importsExtensionFor('build.mk')).toBe('.mk')
    })
  })

  // Regression (command-entry-point coverage gap): extractImports(text, '.mk') and
  // importsExtensionFor() are both unit-proven above, but nothing exercised them wired together
  // through the real `token-goat imports` command handler against an actual file named
  // "Makefile" on disk -- the exact injected-seam failure mode this project's own CLAUDE.md
  // warns about (a helper-level test proving the pieces work individually while the real
  // command-entry-point wiring could still be broken). Found via an independent Codex pre-push
  // review of this batch's diff.
  describe('runImports against a real Makefile (command-entry-point wiring)', () => {
    it('reports the include directives of a file literally named "Makefile"', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imports-makefile-'))
      try {
        const file = path.join(dir, 'Makefile')
        fs.writeFileSync(file, 'include config.mk\n-include optional.mk\n\nall:\n\techo build\n')
        const { stdout } = capture(() => {
          const code = runImports({ file })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('config.mk')
        expect(stdout).toContain('optional.mk')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
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

  // ---- runDiff --------------------------------------------------------------

  describe('runDiff', () => {
    const mockRunGit = vi.mocked(runGit)

    function twoHunkDiff(filePath: string): string {
      return [
        `diff --git a/${filePath} b/${filePath}`,
        'index 111..222 100644',
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        '@@ -1,2 +1,2 @@',
        '-function untouchedFn() {',
        '+function untouchedFn() { // edited',
        '   return 1',
        '@@ -10,2 +10,3 @@',
        ' function touchedFn() {',
        '+  // touched line',
        '   return 2',
      ].join('\n')
    }

    it('shows only the hunk overlapping the symbol\'s line range, not an unrelated hunk in the same file', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: twoHunkDiff('a.ts'), stderr: '' })
      const { stdout, stderr } = capture(() => {
        expect(runDiff({ spec: 'a.ts::touchedFn' })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('touched line')
      expect(stdout).not.toContain('untouchedFn')
    })

    it('runs a plain `git diff -- file` (no ref) by default', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: twoHunkDiff('a.ts'), stderr: '' })
      runDiff({ spec: 'a.ts::touchedFn' })
      expect(mockRunGit).toHaveBeenCalledWith(['diff', '--unified=0', '--', 'a.ts'], expect.anything())
    })

    it('passes an explicit ref range straight through to git diff as a single token', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: twoHunkDiff('a.ts'), stderr: '' })
      runDiff({ spec: 'a.ts::touchedFn', ref: 'HEAD~3..HEAD' })
      expect(mockRunGit).toHaveBeenCalledWith(['diff', 'HEAD~3..HEAD', '--unified=0', '--', 'a.ts'], expect.anything())
    })

    it('reports "no changes" (non-error) when a hunk exists but does not overlap the symbol', () => {
      const sym: MockSymbol = { name: 'untouchedFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({
        exitCode: 0,
        stdout: [
          'diff --git a/a.ts b/a.ts',
          'index 111..222 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -10,2 +10,3 @@',
          ' function touchedFn() {',
          '+  // touched line',
          '   return 2',
        ].join('\n'),
        stderr: '',
      })
      const { stdout } = capture(() => {
        expect(runDiff({ spec: 'a.ts::untouchedFn' })).toBe(0)
      })
      expect(stdout).toContain('No changes')
    })

    it('reports "no changes" (non-error) when the file has no diff at all', () => {
      const sym: MockSymbol = { name: 'anyFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: '', stderr: '' })
      const { stdout } = capture(() => {
        expect(runDiff({ spec: 'a.ts::anyFn' })).toBe(0)
      })
      expect(stdout).toContain('No changes')
    })

    it('fails the same way runRead does when the symbol does not resolve (not found + did-you-mean)', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'a.ts::missingSym' })).toBe(1)
      })
      expect(stderr).toContain("Symbol 'missingSym' not found in 'a.ts'")
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('fails with formatAmbiguity\'s shape when the symbol matches several distinct definitions', () => {
      const candA: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' }
      const candB: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 23, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([candA, candB] as any)
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'a.ts::render' })).toBe(1)
      })
      expect(stderr).toContain('Ambiguous symbol')
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('errors up front (never spawns git) when the spec has no ::symbol part', () => {
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'a.ts' })).toBe(1)
      })
      expect(stderr).toContain('file::symbol')
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('returns 1 and reports the git failure when git diff itself errors', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 128, stdout: '', stderr: 'bad ref' })
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'a.ts::touchedFn', ref: 'nope' })).toBe(1)
      })
      expect(stderr).toContain('git diff failed')
    })

    it('emits a structured items envelope in --json mode, scoped to the same overlapping hunk', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: twoHunkDiff('a.ts'), stderr: '' })
      const { stdout } = capture(() => {
        expect(runDiff({ spec: 'a.ts::touchedFn', json: true })).toBe(0)
      })
      const parsed = JSON.parse(stdout) as { symbol: string; hunks: Array<{ text: string }> }
      expect(parsed.symbol).toBe('touchedFn')
      expect(parsed.hunks).toHaveLength(1)
      expect(parsed.hunks[0]?.text).toContain('touched line')
    })
  })

  // ---- runLog ------------------------------------------------------------

  describe('runLog', () => {
    const mockRunGit = vi.mocked(runGit)

    function oneCommitLogDashL(filePath: string, hash = 'a'.repeat(40)): string {
      return [
        `commit ${hash}`,
        'Author: Test User <test@example.com>',
        'Date:   Mon Jan 1 00:00:00 2026 +0000',
        '',
        '    touch touchedFn',
        '',
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        '@@ -10,2 +10,3 @@',
        ' function touchedFn() {',
        '+  // touched line',
        '   return 2',
      ].join('\n')
    }

    it('shows the symbol\'s scoped history', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: oneCommitLogDashL('a.ts'), stderr: '' })
      const { stdout, stderr } = capture(() => {
        expect(runLog({ spec: 'a.ts::touchedFn' })).toBe(0)
      })
      expect(stderr).toBe('')
      expect(stdout).toContain('touchedFn')
      expect(stdout).toContain('touched line')
    })

    it('builds a `git log -L<start>,<end>:<file> --max-count=<default>` call with no ref', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: oneCommitLogDashL('a.ts'), stderr: '' })
      runLog({ spec: 'a.ts::touchedFn' })
      expect(mockRunGit).toHaveBeenCalledWith(['log', '-L10,12:a.ts', '--max-count=20'], expect.anything())
    })

    it('appends an explicit ref as the starting point and respects a custom --max-count', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: oneCommitLogDashL('a.ts'), stderr: '' })
      runLog({ spec: 'a.ts::touchedFn', ref: 'HEAD~3', maxCount: 5 })
      expect(mockRunGit).toHaveBeenCalledWith(['log', '-L10,12:a.ts', '--max-count=5', 'HEAD~3'], expect.anything())
    })

    it('reports a clean "no history" message (non-error) when git log has no output', () => {
      const sym: MockSymbol = { name: 'anyFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: '', stderr: '' })
      const { stdout } = capture(() => {
        expect(runLog({ spec: 'a.ts::anyFn' })).toBe(0)
      })
      expect(stdout).toContain('No history')
    })

    it('fails the same way runDiff does when the symbol does not resolve (not found + did-you-mean)', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stderr } = capture(() => {
        expect(runLog({ spec: 'a.ts::missingSym' })).toBe(1)
      })
      expect(stderr).toContain("Symbol 'missingSym' not found in 'a.ts'")
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('fails with formatAmbiguity\'s shape when the symbol matches several distinct definitions', () => {
      const candA: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' }
      const candB: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 23, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([candA, candB] as any)
      const { stderr } = capture(() => {
        expect(runLog({ spec: 'a.ts::render' })).toBe(1)
      })
      expect(stderr).toContain('Ambiguous symbol')
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('errors up front (never spawns git) when the spec has no ::symbol part', () => {
      const { stderr } = capture(() => {
        expect(runLog({ spec: 'a.ts' })).toBe(1)
      })
      expect(stderr).toContain('file::symbol')
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('returns 1 and reports the git failure when git log itself errors', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockRunGit.mockReturnValue({ exitCode: 128, stdout: '', stderr: 'bad ref' })
      const { stderr } = capture(() => {
        expect(runLog({ spec: 'a.ts::touchedFn', ref: 'nope' })).toBe(1)
      })
      expect(stderr).toContain('git log failed')
    })

    it('emits a structured commits envelope in --json mode with hash/author/date/message/diff per entry', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const hash = 'b'.repeat(40)
      mockRunGit.mockReturnValue({ exitCode: 0, stdout: oneCommitLogDashL('a.ts', hash), stderr: '' })
      const { stdout } = capture(() => {
        expect(runLog({ spec: 'a.ts::touchedFn', json: true })).toBe(0)
      })
      const parsed = JSON.parse(stdout) as {
        symbol: string
        commits: Array<{ hash: string; author: string; date: string; message: string; diff: string }>
      }
      expect(parsed.symbol).toBe('touchedFn')
      expect(parsed.commits).toHaveLength(1)
      expect(parsed.commits[0]?.hash).toBe(hash)
      expect(parsed.commits[0]?.author).toBe('Test User <test@example.com>')
      expect(parsed.commits[0]?.date).toBe('Mon Jan 1 00:00:00 2026 +0000')
      expect(parsed.commits[0]?.message).toBe('touch touchedFn')
      expect(parsed.commits[0]?.diff).toContain('touched line')
    })

    it('parses multiple commit blocks into separate entries', () => {
      const sym: MockSymbol = { name: 'touchedFn', kind: 'function', filePath: 'a.ts', lineStart: 10, lineEnd: 12, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const hashA = 'c'.repeat(40)
      const hashB = 'd'.repeat(40)
      mockRunGit.mockReturnValue({
        exitCode: 0,
        stdout: [oneCommitLogDashL('a.ts', hashA), oneCommitLogDashL('a.ts', hashB)].join('\n'),
        stderr: '',
      })
      const { stdout } = capture(() => {
        expect(runLog({ spec: 'a.ts::touchedFn', json: true })).toBe(0)
      })
      const parsed = JSON.parse(stdout) as { commits: Array<{ hash: string }> }
      expect(parsed.commits).toHaveLength(2)
      expect(parsed.commits[0]?.hash).toBe(hashA)
      expect(parsed.commits[1]?.hash).toBe(hashB)
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

  it('reports the true DB total (ignoring the SQL LIMIT already applied to `results`) in single-symbol --json totalCount, marking truncated even when overflow_guard never kicks in (regression: totalCount used to equal results.length, silently hiding refs beyond --limit)', () => {
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
    mockQueryRefs.mockReturnValue([ref('src/auth.ts', 10, 'login()')])
    // 219 real references in the DB; queryRefs's own LIMIT already cut that down to the 1 row returned above.
    mockCountRefs.mockReturnValue(219)
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'login', json: true, limit: 1 })
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
    expect(parsed.items).toHaveLength(1)
    expect(parsed.totalCount).toBe(219)
    expect(parsed.truncated).toBe(true)
  })

  it('caps a single-symbol --json output at overflow_guard.max_tokens, wrapping with items/truncated/totalCount instead of an unbounded array', () => {
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 60 },
    } as unknown as ReturnType<typeof loadConfig>)
    mockQueryRefs.mockReturnValue(Array.from({ length: 50 }, (_, i) => ref('src/auth.ts', i + 1, 'x'.repeat(50))))
    mockCountRefs.mockReturnValue(50)
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
    const expectedFilePath = resolveIndexPath('src/auth.ts')
    for (const call of mockQueryRefs.mock.calls) {
      expect((call[0] as { filePath?: string }).filePath).toBe(expectedFilePath)
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
    mockCountRefs.mockImplementation((opts: { name: string }) => (opts.name === 'login' ? 1 : 0))
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
    mockCountRefs.mockImplementation((opts: { name: string }) => (opts.name === 'login' ? 50 : 1))
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

describe('runRefs --top (high-fanout grouped-by-file summary, #333)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  it('groups a high-fanout symbol by file, ranked by count descending, capped to the top N files', () => {
    mockQueryRefs.mockReturnValue([
      ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x'), ref('src/a.ts', 3, 'x'),
      ref('src/b.ts', 1, 'x'), ref('src/b.ts', 2, 'x'),
      ref('src/c.ts', 1, 'x'),
    ])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'ToolFilter', top: 2 })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('6 references across 3 files (showing top 2)')
    expect(stdout).toContain('3  src/a.ts')
    expect(stdout).toContain('2  src/b.ts')
    // Only the top 2 are listed by name -- c.ts is elided, not silently dropped.
    expect(stdout).not.toContain('src/c.ts')
    expect(stdout).toContain('1 more files, 1 more references elided')
    // --top replaces the per-line dump entirely -- no individual file:line: context lines.
    expect(stdout).not.toContain(':1: x')
  })

  it('omits the elision note when every file fits within --top', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x'), ref('src/b.ts', 1, 'x')])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 5 }))
    expect(stdout).toContain('2 references across 2 files (showing top 2)')
    expect(stdout).not.toContain('elided')
  })

  it('emits the fileCounts/totalFiles/totalRefs/shown envelope under --json instead of items/truncated/totalCount', () => {
    mockQueryRefs.mockReturnValue([
      ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x'),
      ref('src/b.ts', 1, 'x'),
    ])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 1, json: true }))
    const parsed = JSON.parse(stdout) as {
      fileCounts: Array<{ file: string; count: number }>
      totalFiles: number
      totalRefs: number
      shown: number
    }
    expect(parsed.fileCounts).toEqual([{ file: 'src/a.ts', count: 2 }])
    expect(parsed.totalFiles).toBe(2)
    expect(parsed.totalRefs).toBe(3)
    expect(parsed.shown).toBe(1)
  })

  it('applies --top per-symbol in a multi-symbol spec, each under its own header', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) =>
      opts.name === 'login'
        ? [ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x')]
        : [ref('src/b.ts', 1, 'x')],
    )
    const { stdout } = capture(() => runRefs({ spec: 'login,refresh', top: 1 }))
    expect(stdout).toContain('login:')
    expect(stdout).toContain('2 references across 1 files (showing top 1)')
    expect(stdout).toContain('refresh:')
    expect(stdout).toContain('1 references across 1 files (showing top 1)')
  })

  it('takes precedence over --callers for text output when both are set', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x')])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 5, callers: true }))
    expect(stdout).toContain('2 references across 1 files')
    // The caller-grouped per-line view (":line  context") is not also present.
    expect(stdout).not.toContain(':1  x')
  })

  it('rejects --top 0 as an explicit invalid-argument error instead of rendering an empty summary', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x')])
    const { stderr } = capture(() => {
      const code = runRefs({ spec: 'login', top: 0 })
      expect(code).toBe(1)
    })
    expect(stderr.toLowerCase()).toContain('top')
    expect(mockQueryRefs).not.toHaveBeenCalled()
  })

  it('rejects a negative --top as an explicit invalid-argument error', () => {
    const { stderr } = capture(() => {
      const code = runRefs({ spec: 'login', top: -1 })
      expect(code).toBe(1)
    })
    expect(stderr.toLowerCase()).toContain('top')
    expect(mockQueryRefs).not.toHaveBeenCalled()
  })

  // Regression: queryRefs defaults to a 100-row cap ordered by file_path/line (an alphabetical
  // ordering, not count-based) -- sized for "read these individual matches", not for the
  // by-file aggregation --top exists specifically to serve on high-fanout (100+ ref) symbols.
  // Without overriding that default, --top's ranking silently drops every ref in
  // alphabetically-later files before the count comparison ever happens.
  it('scans well beyond the default 100-row cap when --top is given without an explicit --limit (single-symbol spec)', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x')])
    capture(() => runRefs({ spec: 'login', top: 2 }))
    const call = mockQueryRefs.mock.calls[0]?.[0] as { limit?: number }
    expect(call.limit).toBeGreaterThan(100)
  })

  it('scans well beyond the default 100-row cap when --top is given without an explicit --limit (multi-symbol spec)', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x')])
    capture(() => runRefs({ spec: 'login,refresh', top: 2 }))
    for (const call of mockQueryRefs.mock.calls) {
      const opts = call[0] as { limit?: number }
      expect(opts.limit).toBeGreaterThan(100)
    }
  })

  it('still honors an explicit --limit alongside --top instead of overriding it with the wide top-scan limit', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x')])
    capture(() => runRefs({ spec: 'login', top: 2, limit: 5 }))
    const call = mockQueryRefs.mock.calls[0]?.[0] as { limit?: number }
    expect(call.limit).toBe(5)
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

// Type-resolved "exact" tier (ts_refs.ts): name-based matching alone conflates two unrelated
// symbols sharing a name. These tests exercise the real querySymbols->resolveTypedRefs wiring
// end to end through runRefs/runRefsSingle (index_reader.js is mocked at the top of this file,
// but ts_refs.ts is NOT, so these hit the real TypeScript compiler API against real temp files).
describe('runRefs — type-resolved tier disambiguates same-named symbols (ts_refs.ts)', () => {
  let dir: string

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refs-typed-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('excludes the false-positive reference to an unrelated same-named method, keeps the true one', () => {
    const fooSrc = ['export class Foo {', '  run(): void {', "    console.log('foo')", '  }', '}', ''].join('\n')
    const barSrc = ['export class Bar {', '  run(): void {', "    console.log('bar')", '  }', '}', ''].join('\n')
    const callerASrc = ["import { Foo } from './fileA'", 'const foo = new Foo()', 'foo.run()', ''].join('\n')
    const callerBSrc = ["import { Bar } from './fileB'", 'const bar = new Bar()', 'bar.run()', ''].join('\n')
    const fileA = path.join(dir, 'fileA.ts')
    const callerA = path.join(dir, 'callerA.ts')
    const callerB = path.join(dir, 'callerB.ts')
    fs.writeFileSync(fileA, fooSrc)
    fs.writeFileSync(path.join(dir, 'fileB.ts'), barSrc)
    fs.writeFileSync(callerA, callerASrc)
    fs.writeFileSync(callerB, callerBSrc)

    mockQuerySymbols.mockReturnValue([
      { name: 'run', kind: 'method', filePath: fileA, lineStart: 2, lineEnd: 4, body: '', docstring: '' } satisfies SymbolEntry,
    ])
    mockQueryRefs.mockReturnValue([
      // col 0 mirrors the real indexer's column semantics for `foo.run()` -- parser.ts's
      // extractRefs records the call-expression's own start (at `foo`), not the callee
      // identifier's column; both lines below start flush left, so that start column is 0.
      { filePath: callerA, name: 'run', line: 3, col: 0, context: '' },
      { filePath: callerB, name: 'run', line: 3, col: 0, context: '' },
    ])

    const { stdout } = capture(() => {
      const code = runRefs({ spec: `${fileA}::run` })
      expect(code).toBe(0)
    })

    expect(stdout).toContain(callerA)
    expect(stdout).not.toContain(callerB)
  })

  it('falls back to unfiltered name-based results when the definition is ambiguous (querySymbols finds 2+ matches)', () => {
    mockQuerySymbols.mockReturnValue([
      { name: 'run', kind: 'method', filePath: 'src/a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' } satisfies SymbolEntry,
      { name: 'run', kind: 'method', filePath: 'src/b.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '' } satisfies SymbolEntry,
    ])
    mockQueryRefs.mockReturnValue([
      { filePath: 'src/x.ts', name: 'run', line: 1, col: 0, context: '' },
    ])

    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'run' })
      expect(code).toBe(0)
    })

    expect(stdout).toContain('src/x.ts')
  })

  it('falls back to unfiltered name-based results when the definition is not a TypeScript file', () => {
    mockQuerySymbols.mockReturnValue([
      { name: 'run', kind: 'function', filePath: 'src/legacy.py', lineStart: 1, lineEnd: 3, body: '', docstring: '' } satisfies SymbolEntry,
    ])
    mockQueryRefs.mockReturnValue([
      { filePath: 'src/x.py', name: 'run', line: 1, col: 0, context: '' },
    ])

    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'run' })
      expect(code).toBe(0)
    })

    expect(stdout).toContain('src/x.py')
  })

  it('never crashes/hangs when the definition file does not actually exist on disk', () => {
    mockQuerySymbols.mockReturnValue([
      { name: 'run', kind: 'function', filePath: path.join(dir, 'missing.ts'), lineStart: 1, lineEnd: 3, body: '', docstring: '' } satisfies SymbolEntry,
    ])
    mockQueryRefs.mockReturnValue([
      { filePath: path.join(dir, 'caller.ts'), name: 'run', line: 1, col: 0, context: '' },
    ])

    const { stdout, stderr } = capture(() => {
      const code = runRefs({ spec: 'run' })
      expect(code).toBe(0)
    })

    expect(stderr).toBe('')
    expect(stdout).toContain('caller.ts')
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

describe('runScreenshot --width/--height validation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a non-numeric --width before launching a browser', async () => {
    // Regression: parseInt(opts.width, 10) on garbage input produces NaN, which isn't
    // nullish, so it survives takeScreenshot's `?? 1280` fallback and reaches Chrome DevTools
    // Protocol, producing an opaque Emulation.setDeviceMetricsOverride failure after a full
    // browser launch. Validating up front must reject before takeScreenshot is ever called.
    await expect(
      runScreenshot('https://example.com', '/tmp/out.png', { width: 'abc' }),
    ).rejects.toThrow('--width must be a number')
    expect(mockTakeScreenshot).not.toHaveBeenCalled()
  })

  it('rejects a non-numeric --height before launching a browser', async () => {
    await expect(
      runScreenshot('https://example.com', '/tmp/out.png', { height: 'abc' }),
    ).rejects.toThrow('--height must be a number')
    expect(mockTakeScreenshot).not.toHaveBeenCalled()
  })

  it('rejects a zero or negative --width/--height', async () => {
    await expect(
      runScreenshot('https://example.com', '/tmp/out.png', { width: '0' }),
    ).rejects.toThrow('--width must be a positive number')
    await expect(
      runScreenshot('https://example.com', '/tmp/out.png', { height: '-10' }),
    ).rejects.toThrow('--height must be a positive number')
    expect(mockTakeScreenshot).not.toHaveBeenCalled()
  })

  it('accepts valid --width/--height and calls takeScreenshot with parsed numbers', async () => {
    await runScreenshot('https://example.com', '/tmp/out.png', { width: '800', height: '600' })
    expect(mockTakeScreenshot).toHaveBeenCalledWith(
      'https://example.com',
      '/tmp/out.png',
      expect.objectContaining({ width: 800, height: 600 }),
    )
  })
})

describe('runZipRead — directory entry (regression: extractZipEntry decompresses a directory entry to a defined, empty Uint8Array, not undefined, so it silently "succeeded" with empty output instead of a clear error)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  it('reports a clear error, not empty content, when the requested entry is a directory', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zipread-test-'))
    const zipPath = path.join(dir, 'archive.zip')
    try {
      const zip = zipSync({
        'sub/': new Uint8Array(0),
        'sub/file.txt': strToU8('hello'),
      })
      fs.writeFileSync(zipPath, zip)

      const { stdout, stderr } = capture(() => {
        const code = runZipRead({ file: zipPath, entry: 'sub/' })
        expect(code).toBe(1)
      })
      expect(stderr).toContain("Entry 'sub/' is a directory, not a file")
      expect(stdout).toBe('')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still reads a real file entry\'s content normally', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zipread-test-'))
    const zipPath = path.join(dir, 'archive.zip')
    try {
      const zip = zipSync({
        'sub/': new Uint8Array(0),
        'sub/file.txt': strToU8('hello'),
      })
      fs.writeFileSync(zipPath, zip)

      const { stdout } = capture(() => {
        const code = runZipRead({ file: zipPath, entry: 'sub/file.txt' })
        expect(code).toBe(0)
      })
      expect(stdout.trim()).toBe('hello')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
