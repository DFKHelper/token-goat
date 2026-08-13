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

// Stubbed for the same reason as the index_reader stub above: the empty-index check is a real DB count, and these tests drive the query layer through mocks, so without this every miss would look like an unindexed project.
vi.mock('../src/index_health.js', () => ({
  isIndexEmptyForProject: vi.fn(() => false),
  emptyIndexMessage: vi.fn(
    () =>
      'no files indexed for this project — every read command will return empty, which looks like a genuine "not found" rather than a missing index; run \'token-goat index .\' here',
  ),
  suggestedIndexCommand: vi.fn(() => 'token-goat index .'),
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
import { resolveIndexPath, toDisplayPath } from '../src/paths.js'
import { readSection, listSections, findContainingSection } from '../src/section_reader.js'
import { loadConfig } from '../src/config.js'
import { indexFileSync } from '../src/parser.js'
import { resolveCallers } from '../src/graph_commands.js'
import { resolveProjectRoot } from '../src/project.js'
import { fingerprintContent } from '../src/fingerprint.js'
import { enqueueDirtyPathSafe } from '../src/hooks_index.js'
import { takeScreenshot } from '../src/screenshot.js'
import { isIndexEmptyForProject } from '../src/index_health.js'

const mockQuerySymbols = vi.mocked(querySymbols)
// The real querySymbols() takes an optional opts param; mockImplementation callbacks below narrow it to a required object (never actually called with none/undefined by read_commands.ts) so their bodies can access opts.name/opts.filePath directly.
type QuerySymbolsOpts = NonNullable<Parameters<typeof querySymbols>[0]>
const mockCountSymbols = vi.mocked(countSymbols)
const mockIsIndexEmptyForProject = vi.mocked(isIndexEmptyForProject)
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
  parent?: string
}

describe('read_commands', () => {
  let tempDir: string

  /**
   * An empty real file with the given extension, inside this test's temp dir. Several tests below
   * assert on the message an *empty index result* produces, and used to pass a bare name like
   * `missing.scala` that never existed on disk. A nonexistent path is now reported as unreadable --
   * which outranks every language branch -- so those tests would have kept passing while pinning
   * nothing about the branch they were named for.
   */
  function emptyFixture(ext: string): string {
    const file = path.join(tempDir, `fixture${ext}`)
    fs.writeFileSync(file, '')
    return file
  }

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

    it('appends a Did you mean block with near-name candidates on a miss', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name !== undefined) return [] // the primary lookup misses
        // the near-name scan (no `name` filter) sees the full indexed set
        return [
          { name: 'runSymbol', kind: 'function', filePath: 'src/read_commands.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '', parent: '' },
          { name: 'unrelated', kind: 'function', filePath: 'src/other.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '', parent: '' },
        ]
      })
      const { text, code } = runSymbol({ name: 'runSymbo' })
      expect(code).toBe(1)
      expect(text).toContain('Did you mean:')
      expect(text).toContain('runSymbol')
      expect(text).not.toContain('unrelated')
    })

    it('excludes 1-2 char indexed names from the reverse-containment match and ranks the closest-length candidate first (regression: unfloored reverse containment let `b`/`n`/etc. bury the real match)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name !== undefined) return []
        // `b`, `n`, `mb` are all substrings of 'runSymbo' and would previously match via
        // reverse containment (query.includes(shortSymbol)), crowding out the real answer.
        return [
          { name: 'b', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
          { name: 'n', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '', parent: '' },
          { name: 'mb', kind: 'function', filePath: 'a.ts', lineStart: 3, lineEnd: 3, body: '', docstring: '', parent: '' },
          { name: 'run', kind: 'function', filePath: 'a.ts', lineStart: 4, lineEnd: 4, body: '', docstring: '', parent: '' },
          { name: 'runSymbol', kind: 'function', filePath: 'src/read_commands.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '', parent: '' },
        ]
      })
      const { text, code } = runSymbol({ name: 'runSymbo' })
      expect(code).toBe(1)
      expect(text).not.toContain('  - b')
      expect(text).not.toContain('  - n')
      expect(text).not.toContain('  - mb')
      // 'runSymbol' (9 chars) is closer in length to the 8-char query than 'run' (3 chars),
      // so it must be listed first even though `run` also qualifies via forward containment.
      const lines = text.split('\n')
      const runSymbolIdx = lines.indexOf('  - runSymbol')
      const runIdx = lines.indexOf('  - run')
      expect(runSymbolIdx).toBeGreaterThan(-1)
      expect(runIdx).toBeGreaterThan(-1)
      expect(runSymbolIdx).toBeLessThan(runIdx)
    })

    // Substring ranking cannot reach a typo that DROPS or SWAPS a character: `parseConfg` is neither a substring of `parseConfig` nor the reverse, so every candidate is filtered out and the caller is sent to outline for a name one keystroke away. A bounded edit-distance pass runs only when substring matching found nothing, so it can add an answer where there was none but can never reorder or displace a substring match.
    it('surfaces a one-character-typo symbol that substring matching cannot reach', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name !== undefined) return []
        return [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' },
        ]
      })
      mockIsIndexEmptyForProject.mockReturnValue(false)
      const { text } = runSymbol({ name: 'parseConfg' })
      expect(text).toContain('Did you mean:')
      expect(text).toContain('parseConfig')
    })

    // The edit-distance pass must stay a fallback rather than a net: a query far from every candidate still yields no suggestion, so the block never fills with noise simply because the substring pass came back empty.
    it('still suggests nothing when no candidate is within the typo threshold', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name !== undefined) return []
        return [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' },
        ]
      })
      mockIsIndexEmptyForProject.mockReturnValue(false)
      const { text } = runSymbol({ name: 'zzzzzzzzzz' })
      expect(text).not.toContain('Did you mean:')
    })

    it('points at semantic search when a miss has no near-name candidates', () => {
      mockQuerySymbols.mockReturnValue([])
      // The fallback is suppressed on a genuinely empty index, where semantic would fail the same way symbol just did. This test is about the populated-index branch -- a miss with no near-name candidates -- so the emptiness check has to be pinned false, otherwise the mocked empty querySymbols makes the project look unindexed and the test passes or fails for the wrong reason.
      mockIsIndexEmptyForProject.mockReturnValue(false)
      const { text, code } = runSymbol({ name: 'zzz_totally_gibberish' })
      expect(code).toBe(1)
      expect(text).not.toContain('Did you mean:')
      expect(text).toContain('token-goat semantic "zzz_totally_gibberish"')
    })

    // The other half of the same branch: with no candidates AND no index, the semantic pointer is a second dead end and must be replaced by the note naming the real fix.
    it('suppresses the semantic pointer when the project has no indexed files', () => {
      mockQuerySymbols.mockReturnValue([])
      mockIsIndexEmptyForProject.mockReturnValue(true)
      const { text } = runSymbol({ name: 'zzz_totally_gibberish' })
      expect(text).not.toContain('token-goat semantic')
      expect(text).toContain('no files indexed for this project')
    })

    it('leaves --json output on a miss unchanged by the Did you mean suggestion', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name !== undefined) return []
        return [{ name: 'runSymbol', kind: 'function', filePath: 'src/read_commands.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '', parent: '' }]
      })
      const { text, code } = runSymbol({ name: 'runSymbo', json: true })
      expect(code).toBe(1)
      expect(text).toBe(`No matches for 'runSymbo'`)
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

    // getDisplayRoot()/toDisplayPath() wiring: runSymbol never resolved its own project root
    // before this fix, so its header always printed the raw absolute filePath. process.cwd() in
    // this test process is this repo's own root (no chdir happens anywhere in this file), so
    // findProject(cwd) resolves to this repo, and a fixture path genuinely inside it is now
    // shortened for human output while a path outside it (an unrelated temp dir) stays absolute.
    describe('project-relative display paths (toDisplayPath/getDisplayRoot wiring)', () => {
      const inProjectAbs = path.join(process.cwd(), 'src', 'display-fixture.ts')
      const outOfProjectAbs = path.join(os.tmpdir(), 'tg-outside-project-fixture', 'far.ts')

      it('shortens an in-project symbol path to project-relative in human (non-JSON) output', () => {
        const sym: MockSymbol = { name: 'inProjSym', kind: 'function', filePath: inProjectAbs, lineStart: 1, lineEnd: 1, body: 'x', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        const { text } = runSymbol({ name: 'inProjSym' })
        expect(text).toContain('src/display-fixture.ts:1-1')
        expect(text).not.toContain(inProjectAbs)
      })

      it('leaves an out-of-project symbol path absolute in human output, even alongside an in-project row', () => {
        const inRow: MockSymbol = { name: 'mixedSym', kind: 'function', filePath: inProjectAbs, lineStart: 1, lineEnd: 1, body: 'x', docstring: '' }
        const outRow: MockSymbol = { name: 'mixedSym', kind: 'function', filePath: outOfProjectAbs, lineStart: 2, lineEnd: 2, body: 'y', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([inRow, outRow] as any)
        const { text } = runSymbol({ name: 'mixedSym' })
        expect(text).toContain('src/display-fixture.ts:1-1')
        // Out-of-project rows are returned unchanged by toDisplayPath (absolute, un-normalized) --
        // it only ever normalizes slashes for a path it actually shortens.
        expect(text).toContain(`${outOfProjectAbs}:2-2`)
      })

      // Oracle replaced: this used to assert --json "stays absolute", pinning the very inconsistency being fixed -- outline/skeleton/refs/types/dead/callers/test-for --json all render rows through toDisplayPath because root-relative is reproducible while absolute is specific to one machine and one drive-letter casing, and `symbol` was the last holdout. The invariant that was worth keeping -- an out-of-project path must NOT be mangled into something relative -- is kept below as the negative control.
      it('--json renders an in-project filePath root-relative, matching human output and the outline/skeleton/refs --json convention', () => {
        const sym: MockSymbol = { name: 'jsonSym', kind: 'function', filePath: inProjectAbs, lineStart: 1, lineEnd: 1, body: 'x', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockCountSymbols.mockReturnValue(1)
        const { text } = runSymbol({ name: 'jsonSym', json: true })
        const parsed = JSON.parse(text) as { items: Array<{ filePath: string }> }
        expect(parsed.items[0]?.filePath).toBe('src/display-fixture.ts')
      })

      it('--json leaves an out-of-project filePath absolute (negative control: root-relativising is not applied blindly)', () => {
        const sym: MockSymbol = { name: 'jsonFarSym', kind: 'function', filePath: outOfProjectAbs, lineStart: 2, lineEnd: 2, body: 'y', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockCountSymbols.mockReturnValue(1)
        const { text } = runSymbol({ name: 'jsonFarSym', json: true })
        const parsed = JSON.parse(text) as { items: Array<{ filePath: string }> }
        expect(parsed.items[0]?.filePath).toBe(outOfProjectAbs)
      })

      it('produces identical output whether process.cwd() is the project root or a subdirectory of it (cwd-independence)', () => {
        const sym: MockSymbol = { name: 'cwdIndepSym', kind: 'function', filePath: inProjectAbs, lineStart: 1, lineEnd: 1, body: 'x', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        const before = process.cwd()
        try {
          process.chdir(before)
          const atRoot = runSymbol({ name: 'cwdIndepSym' }).text
          process.chdir(path.join(before, 'src'))
          const atSubdir = runSymbol({ name: 'cwdIndepSym' }).text
          expect(atSubdir).toBe(atRoot)
          expect(atRoot).toContain('src/display-fixture.ts:1-1')
        } finally {
          process.chdir(before)
        }
      })
    })

    // ---- runSymbol --grep (project-wide name-pattern search) --------------

    describe('runSymbol --grep', () => {
      it('errors clearly when neither a name nor --grep is given, without querying', () => {
        const { text, code } = runSymbol({})
        expect(code).toBe(1)
        expect(text).toBe('symbol requires a name or --grep <pattern>')
        expect(mockQuerySymbols).not.toHaveBeenCalled()
      })

      it('rejects combining an exact name with --grep, without querying', () => {
        const { text, code } = runSymbol({ name: 'foo', grep: '^run' })
        expect(code).toBe(1)
        expect(text).toContain('--grep')
        expect(text).toContain('cannot be combined')
        expect(mockQuerySymbols).not.toHaveBeenCalled()
      })

      it('matches by regex project-wide with no positional name', () => {
        const items: MockSymbol[] = [
          { name: 'runWorker', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
          { name: 'stopWorker', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        const { text, code } = runSymbol({ grep: '^run' })
        expect(code).toBe(0)
        expect(text).toContain('runWorker')
        expect(text).not.toContain('stopWorker')
      })

      it('falls back to a literal substring match when the pattern does not compile as regex', () => {
        const items: MockSymbol[] = [
          { name: 'run(worker)', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
          { name: 'runOther', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        // '(worker' is invalid regex (unbalanced paren) -- must fall back to literal substring.
        const { text, code } = runSymbol({ grep: '(worker' })
        expect(code).toBe(0)
        expect(text).toContain('run(worker)')
        expect(text).not.toContain('runOther')
      })

      // This is the trap called out in the task spec: querySymbols applies a SQL LIMIT before
      // --grep ever sees the rows. If the implementation naively passed the caller's small
      // --limit straight through to the SQL query and filtered afterward, the unfiltered top-N
      // would be dominated by non-matching noise and the matching rows past row N would never
      // even be fetched. The over-fetch-then-filter-then-slice fix must still return a full
      // --limit worth of MATCHING rows.
      it('filters the SQL result BEFORE the --limit slice, not after (regression: --limit N --grep P must return up to N matching rows, not N unfiltered rows filtered down)', () => {
        const items: MockSymbol[] = []
        for (let i = 0; i < 40; i++) {
          items.push({ name: `noise${i}`, kind: 'function', filePath: 'a.ts', lineStart: i + 1, lineEnd: i + 1, body: '', docstring: '' })
        }
        for (let i = 0; i < 10; i++) {
          items.push({ name: `run${i}`, kind: 'function', filePath: 'a.ts', lineStart: 100 + i, lineEnd: 100 + i, body: '', docstring: '' })
        }
        // Mimics the real SQL `LIMIT ?` behavior: only returns as many rows as the query asked
        // for. If runSymbol passes the caller's small --limit straight through instead of
        // over-fetching, this mock hands back only noise rows and every 'run*' row is lost
        // before --grep ever runs.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockImplementation((opts?: any) => {
          const lim = (opts?.limit as number | undefined) ?? items.length
          return items.slice(0, lim) as unknown as ReturnType<typeof mockQuerySymbols>
        })
        const { text, code } = runSymbol({ grep: '^run', limit: 3 })
        expect(code).toBe(0)
        const matchedNames = [...text.matchAll(/# (\S+) \(/g)].map((m) => m[1])
        expect(matchedNames).toHaveLength(3)
        for (const name of matchedNames) expect(name?.startsWith('run')).toBe(true)
      })

      it('composes with --kind and --file, forwarding both to the underlying query', () => {
        const items: MockSymbol[] = [
          { name: 'runFoo', kind: 'function', filePath: 'src/bar.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        const { code } = runSymbol({ grep: '^run', kind: 'function', file: 'src/bar.ts' })
        expect(code).toBe(0)
        expect(mockQuerySymbols).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'function', filePath: expect.stringContaining('bar.ts') as unknown as string }),
        )
      })

      it('distinguishes filtered-to-empty (matches exist in scope, --grep hid all of them) from genuinely-empty, in text output', () => {
        const items: MockSymbol[] = [
          { name: 'stopWorker', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        const { text, code } = runSymbol({ grep: '^run' })
        expect(code).toBe(0)
        expect(text).toContain('--grep')
        expect(text).toContain('filtered out')
        expect(text).not.toBe('No matches for \'^run\'')
      })

      it('distinguishes filtered-to-empty from genuinely-empty in --json output (totalCount: 0, not the pre-filter count)', () => {
        const items: MockSymbol[] = [
          { name: 'stopWorker', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        const { text, code } = runSymbol({ grep: '^run', json: true })
        expect(code).toBe(0)
        const parsed = JSON.parse(text) as { items: unknown[]; truncated: boolean; totalCount: number }
        expect(parsed.items).toHaveLength(0)
        expect(parsed.totalCount).toBe(0)
      })

      it('reports an honest post-grep totalCount in --json, not the pre-grep scope count from countSymbols', () => {
        const items: MockSymbol[] = [
          { name: 'runA', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
          { name: 'runB', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '' },
          { name: 'stopC', kind: 'function', filePath: 'a.ts', lineStart: 3, lineEnd: 3, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        // countSymbols would report the whole pre-grep scope (3) if it were used for grep's
        // totalCount instead of the post-grep filtered count (2) -- contradicting the 2 rows
        // actually returned.
        mockCountSymbols.mockReturnValue(3)
        const { text } = runSymbol({ grep: '^run', json: true })
        const parsed = JSON.parse(text) as { items: unknown[]; truncated: boolean; totalCount: number }
        expect(parsed.items).toHaveLength(2)
        expect(parsed.totalCount).toBe(2)
        expect(parsed.truncated).toBe(false)
      })
    })

    describe('--stats', () => {
      it('text mode: header line carries the ref count and documented flag', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: '', docstring: 'does a thing' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 7]]))
        const { text: stdout } = runSymbol({ name: 'myFn', stats: true })
        expect(stdout).toContain('7 refs')
        expect(stdout).toContain('documented')
      })

      it('without --stats: output is byte-identical to the pre-existing (no-suffix) expectation, and queryRefCounts is not called', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        const withStats = runSymbol({ name: 'myFn', stats: true })
        mockQueryRefCounts.mockClear()
        const withoutStats = runSymbol({ name: 'myFn' })
        expect(withoutStats.text).toBe('# myFn (function) — src/foo.ts:1-1')
        // Dead-wiring guard: prove --stats actually changes output rather than merely being
        // accepted and ignored -- a byte-identical assertion alone can't catch a flag that was
        // registered on the CLI but never forwarded into the handler.
        expect(withStats.text).not.toBe(withoutStats.text)
        expect(mockQueryRefCounts).not.toHaveBeenCalled()
      })

      it('JSON mode: refCount and hasDoc are present with --stats, absent without it', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 5]]))
        const withStats = JSON.parse(runSymbol({ name: 'myFn', stats: true, json: true }).text) as {
          items: { refCount?: number; hasDoc?: boolean }[]
        }
        expect(withStats.items[0]?.refCount).toBe(5)
        expect(withStats.items[0]?.hasDoc).toBe(false)

        const withoutStats = JSON.parse(runSymbol({ name: 'myFn', json: true }).text) as {
          items: { refCount?: number; hasDoc?: boolean }[]
        }
        expect(withoutStats.items[0]?.refCount).toBeUndefined()
        expect(withoutStats.items[0]?.hasDoc).toBeUndefined()
      })

      it('queryRefCounts is not called when a --grep search filters to zero matches, even with --stats set', () => {
        const items: MockSymbol[] = [{ name: 'stopWorker', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' }]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        mockQueryRefCounts.mockClear()
        runSymbol({ grep: '^run', stats: true })
        expect(mockQueryRefCounts).not.toHaveBeenCalled()
      })

      it('queryRefCounts is called with every matched name when multiple candidates are returned (project-wide count per NAME, not per definition site)', () => {
        const items: MockSymbol[] = [
          { name: 'runA', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
          { name: 'runB', kind: 'function', filePath: 'b.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '' },
        ]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue(items as any)
        mockQueryRefCounts.mockReturnValue(new Map([['runA', 1], ['runB', 2]]))
        runSymbol({ grep: '^run', stats: true })
        expect(mockQueryRefCounts).toHaveBeenCalledWith(['runA', 'runB'], expect.anything(), expect.anything())
      })
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

    // A proper `file::symbol` spec that genuinely resolves to nothing keeps its own
    // not-found wording untouched -- only the bare-name (no `::` at all) case below changes.
    it('a proper file::symbol spec with a bad symbol keeps its existing not-found wording', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runRead({ spec: 'src/foo.ts::missingSymbol' })
      expect(code).toBe(1)
      expect(text).toContain("Symbol 'missingSymbol' not found in 'src/foo.ts'")
      expect(text).not.toContain('Invalid spec')
    })

    // Cross-file "did you mean": `walkProject` is guessed against the wrong file (`src/util.ts`)
    // but is actually defined in `src/baseline.ts`. The new lead line must name that file and
    // spec BEFORE the existing (unchanged) same-file "Did you mean" list.
    it('leads with the cross-file spec when the symbol name exists in a different, indexed file', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'walkProject' && opts?.filePath === undefined) {
          return [{ name: 'walkProject', kind: 'function', filePath: 'src/baseline.ts', lineStart: 10, lineEnd: 20, body: '', docstring: '', parent: '' }]
        }
        if (opts?.name === 'walkProject' && opts?.filePath !== undefined) {
          return []
        }
        if (opts?.filePath !== undefined) {
          // Similar (not just any) names, so the fixed ranking still surfaces them -- an
          // unrelated same-file candidate would now correctly be filtered out, defeating this
          // test's actual point (lead-line ordering ahead of the same-file did-you-mean list).
          return [
            { name: 'walkProjectSync', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' },
            { name: 'walkProjectHelper', kind: 'function', filePath: 'src/util.ts', lineStart: 3, lineEnd: 4, body: '', docstring: '', parent: '' },
          ]
        }
        return []
      })
      const { text, code } = runRead({ spec: 'src/util.ts::walkProject' })
      expect(code).toBe(1)
      expect(text).toContain("Symbol 'walkProject' not found in 'src/util.ts'")
      expect(text).toContain("'walkProject' is defined in src/baseline.ts")
      expect(text).toContain('token-goat read "src/baseline.ts::walkProject"')
      // Existing same-file did-you-mean list stays present and unchanged underneath.
      expect(text).toContain('Did you mean:')
      expect(text).toContain('walkProjectSync')
      expect(text).toContain('walkProjectHelper')
      const leadIdx = text.indexOf("is defined in")
      const sameFileIdx = text.indexOf('Did you mean:')
      expect(leadIdx).toBeGreaterThan(-1)
      expect(sameFileIdx).toBeGreaterThan(-1)
      expect(leadIdx).toBeLessThan(sameFileIdx)
    })

    it('a symbol name that exists nowhere still gets the plain not-found message plus the unchanged same-file list only', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'totallyMissingEverywhere') return []
        if (opts?.filePath !== undefined) {
          // Similar to the query so it survives the similarity ranking -- see the comment above.
          return [{ name: 'totallyMissingEverywhereToo', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { text, code } = runRead({ spec: 'src/util.ts::totallyMissingEverywhere' })
      expect(code).toBe(1)
      expect(text).toContain("Symbol 'totallyMissingEverywhere' not found in 'src/util.ts'")
      expect(text).not.toContain('is defined in')
      expect(text).toContain('Did you mean:')
      expect(text).toContain('totallyMissingEverywhereToo')
    })

    // Defect fix: the did-you-mean list used to be an arbitrary same-file dump regardless of
    // relevance to the query. When nothing in the file resembles the query, point at `outline`
    // (the command that lists the file's real symbols) instead of dead-ending silently.
    it('points at outline when a symbol miss has no similar same-file candidates', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'zzz_totally_unrelated') return []
        if (opts?.filePath !== undefined) {
          return [{ name: 'sleepSync', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { text, code } = runRead({ spec: 'src/util.ts::zzz_totally_unrelated' })
      expect(code).toBe(1)
      expect(text).not.toContain('Did you mean:')
      expect(text).toContain('token-goat outline src/util.ts')
    })

    // The database-layer cap used to be applied BEFORE ranking (querySymbols({ limit:
    // DIDYOUMEAN_LIMIT })), so on a file with many symbols the true near-match could be
    // outside the arbitrary storage-order first-N and never even considered for ranking.
    // Fixed by scanning a bounded superset (FIND_SCAN_LIMIT) and ranking BEFORE capping.
    // Query is 'parseConf' (a genuine forward-substring prefix of 'parseConfig'), not a typo
    // like 'parseConfg' -- the reused substring-based matcher (same one runSymbol already
    // uses) does not catch a missing-interior-character typo, only real substring relations.
    it('finds the true near-match even when it is not among the first DIDYOUMEAN_LIMIT symbols in storage order (defect-B regression)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'parseConf') return []
        if (opts?.filePath !== undefined) {
          // Twelve unrelated names first (storage order), then the true near-match last --
          // capping at DIDYOUMEAN_LIMIT (5) before ranking would never see it.
          const unrelated = Array.from({ length: 12 }, (_, i) => ({
            name: `alpha${i + 1}`, kind: 'function', filePath: 'src/util.ts', lineStart: i + 1, lineEnd: i + 1, body: '', docstring: '', parent: '',
          }))
          return [...unrelated, { name: 'parseConfig', kind: 'function', filePath: 'src/util.ts', lineStart: 100, lineEnd: 105, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { text, code } = runRead({ spec: 'src/util.ts::parseConf' })
      expect(code).toBe(1)
      expect(text).toContain('Did you mean:')
      expect(text).toContain('parseConfig')
      expect(text).not.toContain('alpha')
    })

    // Regression: a bare symbol name with no `::` used to say "Could not read: <name>" once
    // readFileText failed, which frames a spec-format mistake as a filesystem problem and
    // sends an agent hunting for a file that was never the argument's intent. When the bare
    // name IS indexed, point at the exact `file::symbol` spec to retry with instead.
    it('a bare indexed name (no :: separator) points at the resolved file::symbol spec instead of falsely claiming a file could not be read', () => {
      const sym: MockSymbol = { name: 'didYouMean', kind: 'function', filePath: 'src/read_commands.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { text, code } = runRead({ spec: 'didYouMean' })
      expect(code).toBe(1)
      expect(text).not.toContain('Could not read')
      expect(text).toContain('Did you mean:')
      expect(text).toContain('token-goat read "src/read_commands.ts::didYouMean"')
    })

    // When the bare name matches nothing indexed either, fall back to the same "Invalid spec"
    // wording `similar`/`blame` (graph_commands.ts) already use for this exact case, instead
    // of a third, differently-worded dialect of the same error.
    it('a bare unindexed name (no :: separator) gets the shared "Invalid spec" wording, not a false "Could not read"', () => {
      mockQuerySymbols.mockReturnValue([])
      const { text, code } = runRead({ spec: 'totallyUnknownSymbolXyz' })
      expect(code).toBe(1)
      expect(text).not.toContain('Could not read')
      expect(text).toBe('Invalid spec - expected "file::symbol", got: totallyUnknownSymbolXyz')
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
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
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
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
        if (opts.filePath !== undefined) return []
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return [wrongMatch as any]
      })
      const { code } = runRead({ spec: 'utils.ts::helper' })
      expect(code).toBe(1)
    })

    it('does match a real path-segment boundary in the partial-path fallback (M34)', () => {
      const rightMatch: MockSymbol = { name: 'helper', kind: 'function', filePath: 'src/utils.ts', lineStart: 1, lineEnd: 3, body: 'function helper() {}', docstring: '' }
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
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
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
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
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
        if (opts.name === 'foo') return [fooInA, fooInB] as unknown as ReturnType<typeof mockQuerySymbols>
        if (opts.name === 'B') return [classB] as unknown as ReturnType<typeof mockQuerySymbols>
        if (opts.name === 'A') return [classA] as unknown as ReturnType<typeof mockQuerySymbols>
        return []
      })
      const { text: stdout } = runRead({ spec: 'src/widget.php::B.foo' })
      expect(stdout).toContain('B.foo body')
      expect(stdout).not.toContain('A.foo body')
    })

    it('backward-compat: rows with parent === "" (schema v8, not yet reindexed since the v8->v9 parent-column migration) still resolve via the docstring-as-parent fallback', () => {
      // Explicit regression coverage for the migration's compatibility contract: a symbol
      // written before this change (parent column defaulted to '' by the ALTER TABLE) but
      // whose docstring still holds the old overloaded parent-name convention must keep
      // resolving correctly until the file is reindexed and a real `parent` is populated.
      // (M35b above exercises the same fallback implicitly via MockSymbol objects that omit
      // `parent` entirely -- TypeScript's optional field defaults it to undefined, not the
      // real schema's '', so this test pins the exact post-migration on-disk shape.)
      const classA: MockSymbol = { name: 'A', kind: 'class', filePath: 'src/widget.php', lineStart: 1, lineEnd: 1, body: 'class A {', docstring: '', parent: '' }
      const classB: MockSymbol = { name: 'B', kind: 'class', filePath: 'src/widget.php', lineStart: 10, lineEnd: 10, body: 'class B {', docstring: '', parent: '' }
      const fooInA: MockSymbol = { name: 'foo', kind: 'method', filePath: 'src/widget.php', lineStart: 3, lineEnd: 5, body: 'A.foo body', docstring: 'A', parent: '' }
      const fooInB: MockSymbol = { name: 'foo', kind: 'method', filePath: 'src/widget.php', lineStart: 12, lineEnd: 14, body: 'B.foo body', docstring: 'B', parent: '' }
      mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
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
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
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
        // fileA/fileB resolve to absolute paths inside this repo's own project root (the test
        // process's cwd), so formatAmbiguity's toDisplayPath() shortens them to project-relative
        // form for human output -- src/utils.ts / lib/utils.ts, not the raw absolute fileA/fileB.
        expect(stdout).toContain('  - src/utils.ts::helper (line 3)')
        expect(stdout).toContain('  - lib/utils.ts::helper (line 7)')
        // Each retry targets that candidate's own file -- not the original ambiguous "utils.ts" spec,
        // which would just re-enter this same ambiguous resolution path.
        expect(stdout).toContain('token-goat read "src/utils.ts::helper"')
        expect(stdout).toContain('token-goat read "lib/utils.ts::helper"')
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
        // Both fixture paths live inside this repo's own project root (the test process's cwd),
        // so formatAmbiguity's toDisplayPath() shortens fileA/fileB to project-relative form.
        expect(stdout).toContain('  - src/compress.ts::ClassA.compress (line 3)')
        expect(stdout).toContain('  - src/compress.ts::ClassB.compress (line 22)')
        expect(stdout).toContain('  - lib/compress.ts::compress (line 7)')

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

      it('a parentless top-level candidate sharing its file with a parented sibling (the original bug: cli.ts::run) gets an @LINE-anchored retry, while the parented sibling keeps its plain qualifier', () => {
        // Reproduces the reported defect literally: a class method `cmdUninstall.run` (has a
        // parent) and a top-level function `run` (no parent) both named 'run' in the same file.
        // Before the fix, the top-level one's suggested retry was the bare 'run' qualifier --
        // byte-identical to the spec that was already ambiguous, an infinite retry loop.
        const cmdUninstall: MockSymbol = { name: 'cmdUninstall', kind: 'class', filePath: 'src/cli.ts', lineStart: 680, lineEnd: 720, body: '', docstring: '', parent: '' }
        const parentedRun: MockSymbol = { name: 'run', kind: 'method', filePath: 'src/cli.ts', lineStart: 691, lineEnd: 695, body: 'cmdUninstall.run body', docstring: '', parent: 'cmdUninstall' }
        const topLevelRun: MockSymbol = { name: 'run', kind: 'function', filePath: 'src/cli.ts', lineStart: 3999, lineEnd: 4010, body: 'top-level run body', docstring: '', parent: '' }
        poolMock([cmdUninstall, parentedRun, topLevelRun])

        const { text: stdout, code } = runRead({ spec: 'src/cli.ts::run' })
        expect(code).toBe(1)
        expect(stdout).toContain("Ambiguous symbol 'run'")
        // Parented candidate: plain qualifier, unchanged.
        expect(stdout).toContain('  - cmdUninstall.run (line 691)  ->  token-goat read "src/cli.ts::cmdUninstall.run"')
        // Parentless candidate: anchored qualifier, not the bare (already-failed) 'run' spec.
        expect(stdout).toContain('  - run@3999 (line 3999)  ->  token-goat read "src/cli.ts::run@3999"')
        expect(stdout).not.toMatch(/->\s+token-goat read "src\/cli\.ts::run"\s*$/m)

        // The anchored suggestion must actually round-trip to exactly the top-level candidate.
        const anchored = runRead({ spec: 'src/cli.ts::run@3999' })
        expect(anchored.code).toBe(0)
        expect(anchored.text).toContain('top-level run body')
        expect(anchored.text).not.toContain('cmdUninstall.run body')
        // And the parented suggestion still round-trips to its own candidate, unchanged.
        const parented = runRead({ spec: 'src/cli.ts::cmdUninstall.run' })
        expect(parented.code).toBe(0)
        expect(parented.text).toContain('cmdUninstall.run body')
        expect(parented.text).not.toContain('top-level run body')
      })

      it('two same-file candidates that would render the identical Parent.symbol qualifier (two classes literally both named Foo) both get distinct, working @LINE anchors', () => {
        const fooClass1: MockSymbol = { name: 'Foo', kind: 'class', filePath: 'src/dup.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' }
        const fooClass2: MockSymbol = { name: 'Foo', kind: 'class', filePath: 'src/dup.ts', lineStart: 20, lineEnd: 30, body: '', docstring: '', parent: '' }
        const bar1: MockSymbol = { name: 'bar', kind: 'method', filePath: 'src/dup.ts', lineStart: 3, lineEnd: 5, body: 'first bar body', docstring: '', parent: 'Foo' }
        const bar2: MockSymbol = { name: 'bar', kind: 'method', filePath: 'src/dup.ts', lineStart: 22, lineEnd: 24, body: 'second bar body', docstring: '', parent: 'Foo' }
        poolMock([fooClass1, fooClass2, bar1, bar2])

        const { text: stdout, code } = runRead({ spec: 'src/dup.ts::bar' })
        expect(code).toBe(1)
        expect(stdout).toContain("Ambiguous symbol 'bar'")
        expect(stdout).toContain('  - Foo.bar@3 (line 3)  ->  token-goat read "src/dup.ts::Foo.bar@3"')
        expect(stdout).toContain('  - Foo.bar@22 (line 22)  ->  token-goat read "src/dup.ts::Foo.bar@22"')

        const first = runRead({ spec: 'src/dup.ts::Foo.bar@3' })
        expect(first.code).toBe(0)
        expect(first.text).toContain('first bar body')
        expect(first.text).not.toContain('second bar body')
        const second = runRead({ spec: 'src/dup.ts::Foo.bar@22' })
        expect(second.code).toBe(0)
        expect(second.text).toContain('second bar body')
        expect(second.text).not.toContain('first bar body')
      })
    })

    describe('symbol spec line anchors (@LINE)', () => {
      it('file::symbol@LINE selects the top-level candidate a bare qualifier could never uniquely address', () => {
        const cmdUninstall: MockSymbol = { name: 'cmdUninstall', kind: 'class', filePath: 'src/cli.ts', lineStart: 680, lineEnd: 720, body: '', docstring: '', parent: '' }
        const parentedRun: MockSymbol = { name: 'run', kind: 'method', filePath: 'src/cli.ts', lineStart: 691, lineEnd: 695, body: 'cmdUninstall.run body', docstring: '', parent: 'cmdUninstall' }
        const topLevelRun: MockSymbol = { name: 'run', kind: 'function', filePath: 'src/cli.ts', lineStart: 3999, lineEnd: 4010, body: 'top-level run body', docstring: '', parent: '' }
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = [cmdUninstall, parentedRun, topLevelRun]
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })

        const { text: stdout, code } = runRead({ spec: 'src/cli.ts::run@3999' })
        expect(code).toBe(0)
        expect(stdout).toContain('top-level run body')
        expect(stdout).not.toContain('cmdUninstall.run body')
      })

      it('Parent.method@LINE (combined dotted + anchor form) resolves the exact candidate', () => {
        const classA: MockSymbol = { name: 'ClassA', kind: 'class', filePath: 'src/comp.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '' }
        const classB: MockSymbol = { name: 'ClassB', kind: 'class', filePath: 'src/comp.ts', lineStart: 20, lineEnd: 30, body: '', docstring: '' }
        const renderInA: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 3, lineEnd: 5, body: 'ClassA.render body', docstring: '' }
        const renderInB: MockSymbol = { name: 'render', kind: 'method', filePath: 'src/comp.ts', lineStart: 22, lineEnd: 24, body: 'ClassB.render body', docstring: '' }
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = [classA, classB, renderInA, renderInB]
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })

        const { text: stdout, code } = runRead({ spec: 'src/comp.ts::ClassB.render@22' })
        expect(code).toBe(0)
        expect(stdout).toContain('ClassB.render body')
        expect(stdout).not.toContain('ClassA.render body')
      })

      it('an anchor that matches no candidate errors with the same "not found" wording used by every other no-match case', () => {
        const topLevelRun: MockSymbol = { name: 'run', kind: 'function', filePath: 'src/cli.ts', lineStart: 3999, lineEnd: 4010, body: 'top-level run body', docstring: '', parent: '' }
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = [topLevelRun]
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })

        const { text: stdout, code } = runRead({ spec: 'src/cli.ts::run@1' })
        expect(code).toBe(1)
        expect(stdout).toContain("Symbol 'run@1' not found in 'src/cli.ts'")
      })

      it('a real file@N-M line-range spec still parses as a range, not a symbol anchor, even though it also ends in @<digits>', () => {
        const f = path.join(tempDir, 'anchor-collision.txt')
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive\n')
        const { text: stdout, code } = runRead({ spec: `${f}@2-4` })
        expect(code).toBe(0)
        expect(stdout).toContain('two\nthree\nfour')
        expect(stdout).not.toContain('one')
        expect(stdout).not.toContain('five')
        expect(mockQuerySymbols).not.toHaveBeenCalled()
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

      it('does not enqueue the dirty queue when --force-refresh is not set and the index is already current', () => {
        const content = 'export function foo() {\n  return 1\n}'
        const f = path.join(tempDir, 'no-refresh.ts')
        fs.writeFileSync(f, content)
        // The index is already present and current (sha matches the on-disk bytes), so neither the
        // stale-sha reparse nor the never-indexed on-demand parse should fire -- and thus no
        // gratuitous dirty-queue enqueue (which would trigger a needless re-embed). A null
        // getFileEntry here would instead be the "never indexed" case, which now correctly parses
        // on demand and DOES enqueue.
        mockGetFileEntry.mockReturnValueOnce({
          filePath: f, sha: fingerprintContent(content), mtime: 0, language: 'ts', indexedAt: 0, embedSha: '',
        } as never)
        mockQuerySymbols.mockReturnValue([
          { name: 'foo', filePath: f, lineStart: 1, lineEnd: 3, body: 'export function foo() {}' } as never,
        ])
        runRead({ spec: `${f}::foo` })
        expect(mockAppendDirtyPath).not.toHaveBeenCalled()
      })

      it('parses a never-indexed on-disk file on demand and enqueues it (mocked-DB counterpart of the on-demand-index e2e)', () => {
        const content = 'export function foo() {\n  return 1\n}'
        const f = path.join(tempDir, 'never-indexed.ts')
        fs.writeFileSync(f, content)
        // getFileEntry null (default mock) == not indexed; the file exists on disk, so the read
        // path parses it once on demand rather than returning "symbol not found" and forcing a
        // full-file Read. That reparse enqueues the file for the worker to (re-)embed.
        mockGetFileEntry.mockReturnValue(null)
        mockQuerySymbols.mockReturnValue([
          { name: 'foo', filePath: f, lineStart: 1, lineEnd: 3, body: 'export function foo() {}' } as never,
        ])
        runRead({ spec: `${f}::foo` })
        expect(mockIndexFileSync).toHaveBeenCalled()
        expect(mockAppendDirtyPath).toHaveBeenCalledWith(resolveIndexPath(f), { alreadyResolved: true })
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

    // ---- `::` numeric line-range fallback ----------------------------------
    // Agents naturally type `read "file::120-140"` (the `::` symbol separator) instead of the
    // documented `file@120-140`. Before this fallback that failed with "Symbol not found" and the
    // agent burned a sed/full-Read round-trip. When the `::` token is a pure numeric range and no
    // symbol matched, serve those lines instead.
    describe('read "file::N-M" numeric line-range fallback', () => {
      function rangeFile(): string {
        const f = path.join(tempDir, 'colon-range.txt')
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive\n')
        return f
      }

      it('serves an inclusive range for file::N-M when no symbol matches', () => {
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${rangeFile()}::2-4` })
        expect(code).toBe(0)
        expect(stdout).toContain('two\nthree\nfour')
        expect(stdout).not.toContain('one')
        expect(stdout).not.toContain('five')
      })

      it('accepts the colon separator form file::N:M', () => {
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${rangeFile()}::2:4` })
        expect(code).toBe(0)
        expect(stdout).toContain('two\nthree\nfour')
      })

      it('accepts the comma separator form file::N,M', () => {
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${rangeFile()}::2,4` })
        expect(code).toBe(0)
        expect(stdout).toContain('two\nthree\nfour')
      })

      it('serves a single line for file::N', () => {
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${rangeFile()}::3` })
        expect(code).toBe(0)
        expect(stdout).toContain('three')
        expect(stdout).not.toContain('two')
      })

      it('does NOT hijack a real symbol whose lookup succeeds (fallback only fires on a miss)', () => {
        // A genuine symbol match must win; the numeric fallback is a last resort. (No all-digit
        // identifier is valid anyway, but prove a matched symbol is served, not a line range.)
        const f = rangeFile()
        mockQuerySymbols.mockReturnValue([
          { name: 'realSym', filePath: f, lineStart: 1, lineEnd: 2, body: 'real symbol body' } as never,
        ])
        const { text: stdout, code } = runRead({ spec: `${f}::realSym` })
        expect(code).toBe(0)
        expect(stdout).toContain('real symbol body')
      })
    })

    // ---- multi-symbol read (file::a,b) -------------------------------------
    describe('multi-symbol read (file::a,b)', () => {
      function poolMock(pool: MockSymbol[]): void {
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = pool
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })
      }

      const symA: MockSymbol = { name: 'alphaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'alphaFn body', docstring: '' }
      const symB: MockSymbol = { name: 'betaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 5, lineEnd: 5, body: 'betaFn body', docstring: '' }

      it('returns both symbol bodies in text mode', () => {
        poolMock([symA, symB])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,betaFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('alphaFn')
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('betaFn')
        expect(stdout).toContain('betaFn body')
      })

      it('returns an object keyed by both symbol names in JSON mode, each a real nested object', () => {
        poolMock([symA, symB])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,betaFn', json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(stdout) as Record<string, { name: string; body: string }>
        expect(payload.alphaFn?.name).toBe('alphaFn')
        expect(payload.alphaFn?.body).toBe('alphaFn body')
        expect(payload.betaFn?.name).toBe('betaFn')
        expect(payload.betaFn?.body).toBe('betaFn body')
      })

      it('REGRESSION: file::120,140 still serves the numeric line range, not two symbols', () => {
        const f = path.join(tempDir, 'colon-range-multi.txt')
        fs.writeFileSync(f, Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n') + '\n')
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${f}::2,4` })
        expect(code).toBe(0)
        expect(stdout).toContain('line2\nline3\nline4')
        expect(stdout).not.toContain('line1')
        expect(stdout).not.toContain('line5')
      })

      it('one existing + one missing symbol: existing body returned, missing one reported inline, exit code 0', () => {
        poolMock([symA])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,missingFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('missingFn')
        expect(stdout).toContain('not found')
      })

      it('returns exit code 1 when no symbol in the list resolves', () => {
        poolMock([])
        const { code } = runRead({ spec: 'src/foo.ts::missingA,missingB' })
        expect(code).toBe(1)
      })

      it('single-symbol read output is byte-identical to before (no comma path regression)', () => {
        poolMock([symA])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('alphaFn body')
        // No multi-symbol heading/merge artifacts leak into the single-symbol path.
        expect(stdout).not.toContain('alphaFn:\n')
      })

      it('--stats: each symbol in a multi-symbol read carries its own ref count', () => {
        poolMock([symA, symB])
        mockQueryRefCounts.mockReturnValue(new Map([['alphaFn', 3], ['betaFn', 0]]))
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,betaFn', stats: true })
        expect(code).toBe(0)
        expect(stdout).toContain('3 refs')
        expect(stdout).toContain('0 refs')
      })
    })

    // ---- cross-file multi-symbol read (a.ts::x,b.ts::y) --------------------
    describe('cross-file multi-symbol read (a.ts::x,b.ts::y)', () => {
      function poolMock(pool: MockSymbol[]): void {
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = pool
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })
      }

      const symA: MockSymbol = { name: 'alphaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'alphaFn body', docstring: '' }
      const symB: MockSymbol = { name: 'betaFn', kind: 'function', filePath: 'src/bar.ts', lineStart: 5, lineEnd: 5, body: 'betaFn body', docstring: '' }

      it('reads two symbols from two different files in text mode, keyed by file::symbol', () => {
        poolMock([symA, symB])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('src/foo.ts::alphaFn:\n')
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('src/bar.ts::betaFn:\n')
        expect(stdout).toContain('betaFn body')
      })

      it('reads two symbols from two different files in JSON mode, keyed by file::symbol', () => {
        poolMock([symA, symB])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn', json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(stdout) as Record<string, { name: string; body: string }>
        expect(payload['src/foo.ts::alphaFn']?.name).toBe('alphaFn')
        expect(payload['src/foo.ts::alphaFn']?.body).toBe('alphaFn body')
        expect(payload['src/bar.ts::betaFn']?.name).toBe('betaFn')
        expect(payload['src/bar.ts::betaFn']?.body).toBe('betaFn body')
      })

      it('same symbol name in two different files: both entries survive distinctly', () => {
        const fooSame: MockSymbol = { name: 'sameFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'foo sameFn body', docstring: '' }
        const barSame: MockSymbol = { name: 'sameFn', kind: 'function', filePath: 'src/bar.ts', lineStart: 9, lineEnd: 9, body: 'bar sameFn body', docstring: '' }
        poolMock([fooSame, barSame])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::sameFn,src/bar.ts::sameFn', json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(stdout) as Record<string, { body: string }>
        expect(Object.keys(payload)).toHaveLength(2)
        expect(payload['src/foo.ts::sameFn']?.body).toBe('foo sameFn body')
        expect(payload['src/bar.ts::sameFn']?.body).toBe('bar sameFn body')
        expect(stdout).toContain('foo sameFn body')
        expect(stdout).toContain('bar sameFn body')
      })

      it('one valid symbol + one from a nonexistent file: partial success, exit 0, error entry inline', () => {
        poolMock([symA])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,src/does-not-exist.ts::betaFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('src/does-not-exist.ts::betaFn')
        expect(stdout).toContain('not found')
      })

      it('same-file file::a,b form is still byte-identical (single file keeps bare-name keying)', () => {
        poolMock([symA, { ...symB, filePath: 'src/foo.ts' }])
        const { text: stdout, code } = runRead({ spec: 'src/foo.ts::alphaFn,betaFn' })
        expect(code).toBe(0)
        expect(stdout).toContain('alphaFn:\n')
        expect(stdout).toContain('betaFn:\n')
        expect(stdout).not.toContain('src/foo.ts::alphaFn:\n')
        expect(stdout).not.toContain('src/foo.ts::betaFn:\n')
      })

      it('REGRESSION: file::10,20 numeric range still works, not misparsed as cross-file', () => {
        const f = path.join(tempDir, 'colon-range-crossfile.txt')
        fs.writeFileSync(f, Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n') + '\n')
        mockQuerySymbols.mockReturnValue([])
        const { text: stdout, code } = runRead({ spec: `${f}::2,4` })
        expect(code).toBe(0)
        expect(stdout).toContain('line2\nline3\nline4')
        expect(stdout).not.toContain('line1')
        expect(stdout).not.toContain('line5')
      })
    })

    describe('--stats', () => {
      it('text mode: header line carries the ref count and documented flag', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: 'does a thing' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 7]]))
        const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn', stats: true })
        expect(stdout).toContain('7 refs')
        expect(stdout).toContain('documented')
      })

      it('text mode: an undocumented symbol renders "undocumented", not just the documented case', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 0]]))
        const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn', stats: true })
        expect(stdout).toContain('0 refs')
        expect(stdout).toContain('undocumented')
      })

      it('text mode: a single ref renders "1 ref", not "1 refs" -- the plural-only assertions above pass either way, so the singular branch needs its own pin', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: 'does a thing' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 1]]))
        const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn', stats: true })
        expect(stdout).toContain('[1 ref, documented]')
        expect(stdout).not.toContain('1 refs')
      })

      it('JSON mode: refCount is present with the right number', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['myFn', 5]]))
        const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn', stats: true, json: true })
        const parsed = JSON.parse(stdout) as { refCount?: number }
        expect(parsed.refCount).toBe(5)
      })

      it('without --stats: output is byte-identical to the pre-existing expectation, and queryRefCounts is not called', () => {
        const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        const { text: stdout } = runRead({ spec: 'src/foo.ts::myFn' })
        expect(stdout).toContain('# 1 line (~5 tok)\nfunction myFn() {}')
        expect(mockQueryRefCounts).not.toHaveBeenCalled()
      })

      it('text mode: a bare parent-name docstring (regex-adapter overload of the docstring column) renders "undocumented", not "documented" (regression: M35b parent-name convention)', () => {
        const sym: MockSymbol = { name: 'undocumentedMethod', kind: 'method', filePath: 'src/Widget.kt', lineStart: 1, lineEnd: 1, body: 'fun undocumentedMethod() {}', docstring: 'Widget' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['undocumentedMethod', 0]]))
        const { text: stdout } = runRead({ spec: 'src/Widget.kt::undocumentedMethod', stats: true })
        expect(stdout).toContain('undocumented')
        expect(stdout).not.toContain(', documented]')
      })

      it('text mode: a real doc comment with spaces still renders "documented" (fix must not over-correct)', () => {
        const sym: MockSymbol = { name: 'add', kind: 'method', filePath: 'src/Widget.kt', lineStart: 1, lineEnd: 1, body: 'fun add() {}', docstring: 'Adds two numbers.' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['add', 0]]))
        const { text: stdout } = runRead({ spec: 'src/Widget.kt::add', stats: true })
        expect(stdout).toContain(', documented]')
      })

      it('text mode: a genuine one-word doc comment ending in punctuation (e.g. "Deprecated.") still renders "documented" (edge case: punctuation defeats the bare-identifier regex)', () => {
        const sym: MockSymbol = { name: 'legacy', kind: 'method', filePath: 'src/Widget.kt', lineStart: 1, lineEnd: 1, body: 'fun legacy() {}', docstring: 'Deprecated.' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockQuerySymbols.mockReturnValue([sym as any])
        mockQueryRefCounts.mockReturnValue(new Map([['legacy', 0]]))
        const { text: stdout } = runRead({ spec: 'src/Widget.kt::legacy', stats: true })
        expect(stdout).toContain(', documented]')
      })
    })
  })

  // ---- runSection ---------------------------------------------------------

  describe('listing --json filePath identity', () => {
    // Merging a comma-separated spec into one payload made the per-row file identifier load-bearing: skeleton projected only name/kind/lineStart/lineEnd, so two rows reading lineStart 3 were indistinguishable while meaning different files.
    it('identifies which file each merged skeleton row came from', () => {
      mockQuerySymbols.mockImplementation((opts?: { filePath?: string }) => {
        const f = String(opts?.filePath ?? '')
        if (f.includes('b.ts')) return [{ name: 'shared', kind: 'function', filePath: 'b.ts', lineStart: 3, lineEnd: 4, body: '', docstring: '', parent: '' }] as never
        return [{ name: 'shared', kind: 'function', filePath: 'a.ts', lineStart: 3, lineEnd: 4, body: '', docstring: '', parent: '' }] as never
      })
      const { text } = runSkeleton({ file: 'a.ts,b.ts', json: true })
      const payload = JSON.parse(text) as { items: { filePath: string }[] }
      expect(payload.items).toHaveLength(2)
      expect(payload.items.map((i) => i.filePath)).toEqual(['a.ts', 'b.ts'])
    })

    // An absolute path renders the same query differently on every machine (and on Windows differs by drive-letter casing), so it cannot be compared across runs or fed back verbatim. toDisplayPath is what the rest of the codebase already uses for this.
    it('renders outline filePath relative to the project root, not as an absolute path', () => {
      mockQuerySymbols.mockReturnValue([{ name: 'sym', kind: 'function', filePath: path.resolve(process.cwd(), 'sub/a.ts'), lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never)
      const { text } = runOutline({ file: 'sub/a.ts,other.ts', json: true, projectRoot: process.cwd() })
      const payload = JSON.parse(text) as { items: { filePath: string }[] }
      expect(payload.items[0]?.filePath).toBe('sub/a.ts')
    })
  })

  describe('multi-file listing --json', () => {
    // Text blocks are joined with a blank line, which for --json produced N complete documents back to back -- no parser accepts that, so the flag failed outright on exactly the input it exists to serve.
    it('returns one parseable document for a comma-separated spec, not concatenated ones', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        const f = String(opts?.filePath ?? '')
        if (f.includes('b.ts')) return [{ name: 'fromB', kind: 'function', filePath: 'b.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never
        return [{ name: 'fromA', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never
      })
      const { text, code } = runOutline({ file: 'a.ts,b.ts', json: true })
      expect(code).toBe(0)
      const payload = JSON.parse(text) as { items: { name: string }[]; totalCount: number; truncated: boolean }
      expect(payload.items.map((i) => i.name)).toEqual(['fromA', 'fromB'])
      expect(payload.totalCount).toBe(2)
      expect(payload.truncated).toBe(false)
    })

    it('merges skeleton the same way', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        const f = String(opts?.filePath ?? '')
        if (f.includes('b.ts')) return [{ name: 'fromB', kind: 'function', filePath: 'b.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never
        return [{ name: 'fromA', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never
      })
      const { text } = runSkeleton({ file: 'a.ts,b.ts', json: true })
      const payload = JSON.parse(text) as { items: { name: string }[] }
      expect(payload.items.map((i) => i.name)).toEqual(['fromA', 'fromB'])
    })

    // A file that yields prose rather than JSON (unreadable, or no indexed symbols) must neither be spliced in as text -- which breaks parsing again -- nor dropped, which would let a failed file read as an empty one.
    it('reports a failing file in errors while staying parseable', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        const f = String(opts?.filePath ?? '')
        if (f.includes('b.ts')) return [] as never
        return [{ name: 'fromA', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never
      })
      const { text, code } = runOutline({ file: 'a.ts,b.ts', json: true })
      expect(code).toBe(0)
      const payload = JSON.parse(text) as { items: { name: string }[]; errors?: { file: string; message: string }[] }
      expect(payload.items.map((i) => i.name)).toEqual(['fromA'])
      expect(payload.errors).toHaveLength(1)
      expect(payload.errors?.[0]?.file).toBe('b.ts')
      expect(payload.errors?.[0]?.message).not.toBe('')
    })

    // Control: with every file succeeding there is no errors key at all, so the merged payload is shaped exactly like a single-file one and a caller never has to branch on file count.
    it('omits errors entirely when every file succeeded', () => {
      mockQuerySymbols.mockImplementation(() => [{ name: 'sym', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never)
      const { text } = runOutline({ file: 'a.ts,b.ts', json: true })
      const payload = JSON.parse(text) as Record<string, unknown>
      expect(payload).not.toHaveProperty('errors')
      expect(Object.keys(payload)).toEqual(['items', 'truncated', 'totalCount'])
    })

    // Control: the text path is untouched -- still one headed block per file joined by a blank line.
    it('leaves multi-file text output as separate headed blocks', () => {
      mockQuerySymbols.mockImplementation(() => [{ name: 'sym', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }] as never)
      const { text } = runOutline({ file: 'a.ts,b.ts' })
      expect(text).toContain('# Outline: a.ts')
      expect(text).toContain('# Outline: b.ts')
    })
  })

  describe('outline --json payload shape', () => {
    // outline exists to map a file WITHOUT its bodies, but the JSON branch spread the raw symbol row, so every body came along. On src/cli.ts that was 45 KB of an 87 KB payload.
    it('omits symbol bodies from --json output', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alphaFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: 'function alphaFn() { return SENTINEL_BODY_TEXT }', docstring: 'docs here', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', json: true })
      expect(text).not.toContain('SENTINEL_BODY_TEXT')
      const payload = JSON.parse(text) as { items: Record<string, unknown>[] }
      expect(payload.items[0]).not.toHaveProperty('body')
    })

    // The fields outline actually renders, plus the structural ones, must survive -- dropping bodies must not quietly become dropping the payload.
    it('keeps the fields outline renders and the row identity', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alphaFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: 'function alphaFn() { return SENTINEL_BODY_TEXT }', docstring: 'docs here', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', json: true })
      const payload = JSON.parse(text) as { items: Record<string, unknown>[]; totalCount: number }
      expect(payload.items[0]).toMatchObject({
        name: 'alphaFn',
        kind: 'function',
        lineStart: 1,
        lineEnd: 3,
        docstring: 'docs here',
      })
      expect(payload.totalCount).toBe(1)
      // filePath is omitted for a single file: the caller named it, and every per-row field costs rows under the byte cap. The multi-file suite covers its presence where it is load-bearing.
      expect(payload.items[0]).not.toHaveProperty('filePath')
    })

    // --stats adds its two columns to the projected row rather than being lost with the spread it replaced.
    it('still adds the --stats columns to the projected row', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alphaFn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: 'function alphaFn() { return SENTINEL_BODY_TEXT }', docstring: 'docs here', parent: '' },
        ] as never,
      )
      mockQueryRefCounts.mockReturnValue(new Map([['alphaFn', 7]]) as never)
      const { text } = runOutline({ file: 'a.ts', json: true, stats: true })
      const payload = JSON.parse(text) as { items: Record<string, unknown>[] }
      expect(payload.items[0]).toMatchObject({ refCount: 7, hasDoc: true })
      expect(payload.items[0]).not.toHaveProperty('body')
    })
  })

  describe('outline/skeleton --grep', () => {
    // Without a name filter the only way to find one area of a large file is to dump every symbol in it (src/cli.ts alone lists 502), which is precisely the full-file read these commands exist to avoid.
    it('narrows outline to symbols whose name matches the pattern', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text, code } = runOutline({ file: 'a.ts', grep: 'Config' })
      expect(code).toBe(0)
      expect(text).toContain('parseConfig')
      expect(text).toContain('writeConfig')
      expect(text).not.toContain('unrelatedThing')
    })

    it('narrows skeleton the same way', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runSkeleton({ file: 'a.ts', grep: 'Config' })
      expect(text).toContain('parseConfig')
      expect(text).not.toContain('unrelatedThing')
    })

    // The pattern is matched against the symbol NAME only. Anchors have to work for that to be usable at all -- a caller narrowing to constructors or a naming prefix needs ^ to mean the start of the name.
    it('treats the pattern as a regex against the symbol name', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', grep: '^parse' })
      expect(text).toContain('parseConfig')
      expect(text).not.toContain('writeConfig')
    })

    // An unparseable pattern is far more often a caller meaning the literal text than a mistake worth an error, so it degrades to a substring match rather than costing a round trip. Same convention as every other --grep flag.
    it('falls back to a literal substring match when the pattern is not valid regex', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'readConfig(', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text, code } = runOutline({ file: 'a.ts', grep: 'Config(' })
      expect(code).toBe(0)
      expect(text).toContain('readConfig(')
      expect(text).not.toContain('unrelatedThing')
    })

    // The two filters narrow the same set, so they must intersect rather than one overriding the other.
    it('composes with --min-lines instead of one filter overriding the other', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', grep: 'Config', minLines: 5 })
      expect(text).toContain('parseConfig')
      expect(text).not.toContain('writeConfig')
      expect(text).not.toContain('unrelatedThing')
    })

    // A --grep that matches nothing is the most likely way these listings go empty, so it inherits the filtered-to-empty notice and must name --grep rather than looking like a file with no symbols.
    it('names --grep in the notice when it empties the listing', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text, code } = runOutline({ file: 'a.ts', grep: 'zzzz' })
      expect(code).toBe(0)
      expect(text).toContain('all 3 indexed symbols were filtered out')
      expect(text).toContain('--grep zzzz')
    })

    // Every existing case here filters out 2 or more symbols, so the singular branch shipped saying "all 1 indexed symbol were filtered out" -- the noun agreed with the count and the verb did not, which reads as a typo in the tool rather than as a report about the file. One survivor is the most common way to reach this notice, so it is the case most seen.
    it('agrees the verb with the count when exactly one symbol was filtered out', () => {
      mockQuerySymbols.mockReturnValue(
        [{ name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' }] as never,
      )
      const { text, code } = runOutline({ file: 'a.ts', grep: 'zzzz' })
      expect(code).toBe(0)
      expect(text).toContain('all 1 indexed symbol was filtered out')
      expect(text).not.toContain('symbol were filtered out')
    })

    // Negative control: the plural branch is untouched by the singular fix and must keep its own agreement. Passes both before and after, so it proves the singular assertion above is doing the work rather than the pair drifting together.
    it('keeps the plural verb when more than one symbol was filtered out', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', grep: 'zzzz' })
      expect(text).toContain('all 2 indexed symbols were filtered out')
    })

    // With both filters active the notice must name both -- blaming only one sends the caller to widen the wrong knob.
    it('names both filters in the notice when both are active', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', grep: 'zzzz', minLines: 5 })
      expect(text).toContain('--min-lines 5')
      expect(text).toContain('--grep zzzz')
      expect(text).toContain('widen or drop the filters')
    })

    // JSON output must narrow with the text output, not silently return every symbol to a caller that asked for a subset.
    it('applies the filter to --json output and keeps totalCount consistent with items', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts', grep: 'Config', json: true })
      const payload = JSON.parse(text) as { items: { name: string }[]; totalCount: number }
      expect(payload.items.map((i) => i.name)).toEqual(['parseConfig', 'writeConfig'])
      expect(payload.totalCount).toBe(2)
    })

    // Control: with no --grep the listing is unchanged, so the flag cannot alter the default path.
    it('leaves the listing untouched when --grep is absent', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'parseConfig', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 10, body: '', docstring: '', parent: '' },
          { name: 'writeConfig', kind: 'function', filePath: 'a.ts', lineStart: 12, lineEnd: 13, body: '', docstring: '', parent: '' },
          { name: 'unrelatedThing', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts' })
      expect(text).toContain('parseConfig')
      expect(text).toContain('unrelatedThing')
      expect(text).not.toContain('filtered out')
    })
  })

  describe('filtered-to-empty listings', () => {
    // A filter that removes every symbol used to render exactly like a file with no symbols at all -- "(0 symbols)" and nothing else -- except the genuinely-empty case gets noSymbolsMessage explaining itself, so the filtered case was the one that read as a definitive answer about the file when it was really a statement about the filter.
    it('outline says the filter emptied the listing rather than implying the file has no symbols', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alpha', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
          { name: 'beta', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text, code } = runOutline({ file: 'a.ts', minLines: 9999 })
      expect(code).toBe(0)
      expect(text).toContain('--min-lines 9999')
      expect(text).toContain('all 2 indexed symbols were filtered out')
    })

    it('skeleton says the same for the same reason', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alpha', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
          { name: 'beta', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text, code } = runSkeleton({ file: 'a.ts', minLines: 9999 })
      expect(code).toBe(0)
      expect(text).toContain('all 2 indexed symbols were filtered out')
    })

    // Control: with no filter emptying it, the listing is byte-unchanged -- the notice must not leak into an ordinary populated outline.
    it('does not add the notice when the filter kept symbols', () => {
      mockQuerySymbols.mockReturnValue(
        [
          { name: 'alpha', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
          { name: 'beta', kind: 'function', filePath: 'a.ts', lineStart: 2, lineEnd: 2, body: '', docstring: '', parent: '' },
        ] as never,
      )
      const { text } = runOutline({ file: 'a.ts' })
      expect(text).not.toContain('filtered out')
      expect(text).toContain('alpha')
    })

    // Control for the class this fix belongs to: when there was nothing to filter in the first place, the dedicated empty-result message stands on its own and must not be relabelled as a filtering artefact, even though --min-lines was passed.
    it('keeps the dedicated empty-result message when there was nothing to filter', () => {
      mockQuerySymbols.mockReturnValue([] as never)
      const { text } = runOutline({ file: 'a.ts', minLines: 9999 })
      expect(text).not.toContain('filtered out')
      expect(text).toContain('Could not read')
    })
  })

  describe('runSection', () => {
    it('returns 1 for invalid spec without ::', () => {
      const { code } = runSection({ spec: 'no-separator' })
      expect(code).toBe(1)
    })

    it('splits on the LAST :: so a file path containing a literal :: still resolves the correct heading (#m2)', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue([])
      runSection({ spec: 'a::b::Heading' })
      // Third arg is the pin-aware readFileText helper, threaded through so a section read
      // re-verifies file identity under MCP confinement (see src/section_reader.ts's readFn
      // param) instead of section_reader.ts's raw fs.readFileSync bypassing the pin entirely.
      expect(mockReadSection).toHaveBeenCalledWith('a::b', 'Heading', expect.any(Function))
    })

    it('returns 1 when section not found', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Other'])
      const { text: stderr } = runSection({ spec: 'README.md::Install' })
      expect(stderr).toContain('Install')
    })

    // Containment cannot reach a misspelled heading WORD: `Instalation` is neither a substring of `Installation` nor the reverse, so before the edit-distance fallback a one-character slip in a heading the caller already knows produced the same bare outline pointer as a query about nothing at all.
    it('suggests a heading whose word is one typo away from the query', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Installation and Setup', 'Configuration Options'])
      const { text } = runSection({ spec: 'README.md::Instalation' })
      expect(text).toContain('Did you mean:')
      expect(text).toContain('Installation and Setup')
    })

    // Negative control: the fallback stays a fallback rather than a net, so a query near no heading word still gets the outline pointer instead of an arbitrary suggestion.
    it('still suggests no heading when the query is near no heading word', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Installation and Setup', 'Configuration Options'])
      const { text } = runSection({ spec: 'README.md::zzzzzzzz' })
      expect(text).not.toContain('Did you mean:')
      expect(text).toContain('outline')
    })

    // The similarity filter drops every candidate for a query unrelated to any heading, which leaves the miss with no next step at all -- worse than the old unfiltered dump, which at least revealed what the file contained. Point at outline, the command that lists headings, mirroring the `Try: token-goat semantic` fallback runSymbol already prints for the same shape of dead end.
    it('points at outline when a section miss has no similar headings, so a total miss is not a dead end', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Getting Started', 'Configuration'])
      const { text, code } = runSection({ spec: 'README.md::zzzz_totally_unrelated' })
      expect(code).toBe(1)
      expect(text).not.toContain('Did you mean:')
      expect(text).toContain('token-goat outline README.md')
    })

    // A file with no headings at all is a different answer from one whose headings simply did not match: pointing at outline there would send the caller to a command that prints nothing.
    it('names an empty heading set instead of pointing at outline when the file has no headings', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue([])
      const { text } = runSection({ spec: 'README.md::anything' })
      expect(text).toContain('has no headings')
      expect(text).not.toContain('token-goat outline')
    })

    it('reports "File not found" instead of a misleading "Section not found" when the file itself does not exist (regression: a bad path masqueraded as a missing heading, sending an agent hunting for a section that was never the actual problem)', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue([])
      const { text: stderr, code } = runSection({ spec: 'nonexistent-file-xyz/SKILL.md::Some Heading' })
      expect(code).toBe(1)
      expect(stderr).toContain('File not found')
      expect(stderr).not.toContain("Section 'Some Heading' not found")
    })

    // Updated for the similarity filter (defect-1 fix): every listed heading now shares the
    // query word "Setup" so all 7 pass the filter and the DIDYOUMEAN_LIMIT cap is still the
    // thing under test, instead of an unrelated query ('Nonexistent') that the filter would
    // now correctly drop to zero candidates.
    it('caps the heading list on section miss at DIDYOUMEAN_LIMIT (5), matching runRead\'s "did you mean" cap, instead of dumping every heading (regression: unbounded "Available sections" dump)', () => {
      mockReadSection.mockReturnValue(null)
      // Distinct, strictly increasing lengths so the similarity ranking (closest length to the
      // query first) has no ties to break -- which 5 of the 7 survive the cap is deterministic.
      mockListSections.mockReturnValue([
        'Setup1', 'Setup12', 'Setup123', 'Setup1234', 'Setup12345', 'Setup123456', 'Setup1234567',
      ])
      const { text: stderr } = runSection({ spec: 'README.md::Setup' })
      expect(stderr).toContain('Did you mean')
      expect(stderr).toContain('Setup1')
      expect(stderr).toContain('Setup12')
      expect(stderr).toContain('Setup123')
      expect(stderr).toContain('Setup1234')
      expect(stderr).toContain('Setup12345')
      // Only the 5 closest-in-length candidates are shown — the 2 longest are suppressed.
      expect(stderr).not.toContain('Setup123456')
      expect(stderr).not.toContain('Setup1234567')
      // Regression: the cap used to be silent, giving no indication that 2 more headings
      // existed beyond the 5 shown.
      expect(stderr).toContain('(2 more not shown)')
    })

    it('filters the suggestion list by similarity to the query instead of dumping every heading verbatim (defect-1 regression: a query with no plausible relation to any heading printed the exact same "Did you mean" list as a near-miss query)', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Getting Started', 'Installation and Setup', 'Configuration Options', 'Advanced Tuning'])
      const nearMiss = runSection({ spec: 'README.md::Install' })
      expect(nearMiss.text).toContain('Did you mean')
      expect(nearMiss.text).toContain('Installation and Setup')
      expect(nearMiss.text).not.toContain('Getting Started')
      expect(nearMiss.text).not.toContain('Configuration Options')
      expect(nearMiss.text).not.toContain('Advanced Tuning')

      const noRelation = runSection({ spec: 'README.md::zzzz' })
      expect(noRelation.text).not.toContain('Did you mean')
      expect(noRelation.text).not.toContain('Getting Started')
      expect(noRelation.text).not.toContain('Installation and Setup')
      expect(noRelation.text).not.toContain('Configuration Options')
      expect(noRelation.text).not.toContain('Advanced Tuning')
    })

    it('on an ambiguous widened-rule miss, lists exactly the matching candidates and no unrelated headings', () => {
      mockReadSection.mockReturnValue(null)
      mockListSections.mockReturnValue(['Database Setup', 'Cache Setup', 'Getting Started', 'Advanced Tuning'])
      const { text: stderr } = runSection({ spec: 'README.md::Setup' })
      expect(stderr).toContain('Did you mean')
      expect(stderr).toContain('Database Setup')
      expect(stderr).toContain('Cache Setup')
      expect(stderr).not.toContain('Getting Started')
      expect(stderr).not.toContain('Advanced Tuning')
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

    // ---- multi-heading section (file::A,B) ---------------------------------
    describe('multi-heading section (file::A,B)', () => {
      function headingMock(sections: Record<string, { content: string; heading: string; lineStart: number; lineEnd: number }>): void {
        mockReadSection.mockImplementation((_file: string, heading: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (sections[heading] ?? null) as any
        })
      }

      it('returns both section bodies in text mode', () => {
        headingMock({
          Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 },
          Architecture: { content: '## Architecture\nsome design notes', heading: 'Architecture', lineStart: 5, lineEnd: 6 },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'doc.md::Commands,Architecture' })
        expect(code).toBe(0)
        expect(stdout).toContain('Commands')
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('Architecture')
        expect(stdout).toContain('some design notes')
      })

      it('returns an object keyed by both headings in JSON mode, each a real nested object', () => {
        headingMock({
          Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 },
          Architecture: { content: '## Architecture\nsome design notes', heading: 'Architecture', lineStart: 5, lineEnd: 6 },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'doc.md::Commands,Architecture', json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(stdout) as Record<string, { heading: string; content: string }>
        expect(payload.Commands?.heading).toBe('Commands')
        expect(payload.Commands?.content).toContain('npm test')
        expect(payload.Architecture?.heading).toBe('Architecture')
        expect(payload.Architecture?.content).toContain('some design notes')
      })

      it('one existing + one missing heading: existing section returned, missing one reported inline, exit code 0', () => {
        headingMock({
          Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'doc.md::Commands,MissingHeading' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('MissingHeading')
        expect(stdout).toContain('not found')
      })

      it('returns exit code 1 when no heading in the list resolves', () => {
        headingMock({})
        mockListSections.mockReturnValue([])
        const { code } = runSection({ spec: 'doc.md::MissingA,MissingB' })
        expect(code).toBe(1)
      })

      it('single-heading section output is byte-identical to before (no comma path regression)', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockReadSection.mockReturnValue({ content: '## Install\nrun npm install', heading: 'Install', startLine: 5, endLine: 10 } as any)
        const { text: stdout, code } = runSection({ spec: 'README.md::Install' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm install')
        // No multi-heading merge artifacts leak into the single-heading path.
        expect(stdout).not.toContain('Install:\n')
      })
    })

    // ---- cross-file multi-heading section (a.md::H1,b.md::H2) --------------
    describe('cross-file multi-heading section (a.md::H1,b.md::H2)', () => {
      // Keyed by [file][heading] (unlike the same-file headingMock above, which is keyed by
      // heading alone) so two different files can supply the same heading name independently.
      function crossFileHeadingMock(byFile: Record<string, Record<string, { content: string; heading: string; lineStart: number; lineEnd: number }>>): void {
        mockReadSection.mockImplementation((file: string, heading: string) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (byFile[file]?.[heading] ?? null) as any
        })
      }

      it('returns both section bodies, one per file, in a single call', () => {
        crossFileHeadingMock({
          'README.md': { Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 } },
          'CLAUDE.arch.md': { 'Component Map': { content: '## Component Map\nparser -> worker', heading: 'Component Map', lineStart: 5, lineEnd: 6 } },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,CLAUDE.arch.md::Component Map' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('parser -> worker')
      })

      it('a bare heading after a file::Heading segment inherits the previous file (mirrors runRead\'s cross-file inheritance)', () => {
        crossFileHeadingMock({
          'README.md': {
            Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 },
          },
          'CLAUDE.md': {
            Install: { content: '## Install\nnpm install', heading: 'Install', lineStart: 3, lineEnd: 4 },
            Layout: { content: '## Layout\nsrc/ and tests/', heading: 'Layout', lineStart: 5, lineEnd: 6 },
          },
        })
        mockListSections.mockReturnValue([])
        // The trailing 'Layout' has no '::' of its own, so it must inherit the MOST RECENT file
        // ('CLAUDE.md'), not the first one -- a spec must cross a file boundary before the
        // inheritance rule is exercised at all. An earlier version of this test used
        // 'README.md::Commands,Install', which parseCrossFileMultiSpec declines outright (only one
        // segment carries '::'), so it ran the pre-existing same-file path and passed identically
        // before and after cross-file support existed -- it asserted nothing about inheritance.
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,CLAUDE.md::Install,Layout' })
        expect(code).toBe(0)
        // Third arg is the pin-aware readFileText helper (see the #m2 test above for why).
        expect(mockReadSection).toHaveBeenCalledWith('README.md', 'Commands', expect.any(Function))
        expect(mockReadSection).toHaveBeenCalledWith('CLAUDE.md', 'Install', expect.any(Function))
        expect(mockReadSection).toHaveBeenCalledWith('CLAUDE.md', 'Layout', expect.any(Function))
        // Not README.md: inheritance carries the latest file forward, never resets to the first.
        expect(mockReadSection).not.toHaveBeenCalledWith('README.md', 'Layout', expect.any(Function))
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('npm install')
        expect(stdout).toContain('src/ and tests/')
      })

      it('the same heading name in two different files does not collide -- each is keyed by its full file::heading pair, not the bare heading', () => {
        crossFileHeadingMock({
          'README.md': { Commands: { content: '## Commands\nnpm run readme-cmd', heading: 'Commands', lineStart: 1, lineEnd: 2 } },
          'CLAUDE.md': { Commands: { content: '## Commands\nnpm run claude-cmd', heading: 'Commands', lineStart: 9, lineEnd: 10 } },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,CLAUDE.md::Commands', json: true })
        expect(code).toBe(0)
        const payload = JSON.parse(stdout) as Record<string, { content: string }>
        // Bare 'Commands' would only ever hold one of the two -- proves neither call clobbered
        // the other.
        expect(payload['Commands']).toBeUndefined()
        expect(payload['README.md::Commands']?.content).toContain('npm run readme-cmd')
        expect(payload['CLAUDE.md::Commands']?.content).toContain('npm run claude-cmd')
      })

      it('one existing file::heading + one missing heading in a real file: existing section returned, the miss reported inline, exit code 0 (mirrors runReadMulti\'s partial-success contract)', () => {
        crossFileHeadingMock({
          'README.md': { Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 } },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,CLAUDE.md::NoSuchHeading' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('NoSuchHeading')
        expect(stdout).toContain('not found')
      })

      it('every heading missing across every file: exit code 1', () => {
        crossFileHeadingMock({})
        mockListSections.mockReturnValue([])
        const { code } = runSection({ spec: 'README.md::MissingA,CLAUDE.md::MissingB' })
        expect(code).toBe(1)
      })

      it('a nonexistent file in a multi-file spec reports "File not found" for that pair, not a misleading "Section not found"', () => {
        crossFileHeadingMock({
          'README.md': { Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 } },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,nonexistent-file-xyz/SKILL.md::Some Heading' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('File not found')
      })

      it('same-file multi-heading specs (file::A,B) are unaffected: parseCrossFileMultiSpec declines and the pre-existing single-file branch still runs', () => {
        crossFileHeadingMock({
          'README.md': {
            Commands: { content: '## Commands\nnpm test', heading: 'Commands', lineStart: 1, lineEnd: 2 },
            Architecture: { content: '## Architecture\nsome design notes', heading: 'Architecture', lineStart: 5, lineEnd: 6 },
          },
        })
        mockListSections.mockReturnValue([])
        const { text: stdout, code } = runSection({ spec: 'README.md::Commands,Architecture' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm test')
        expect(stdout).toContain('some design notes')
        // Bare-key form of the pre-existing same-file path, not the file-qualified cross-file key.
        expect(stdout).toContain('Commands:\n')
        expect(stdout).not.toContain('README.md::Commands:\n')
      })

      it('single-file single-heading specs (file::Heading) are unaffected: parseCrossFileMultiSpec declines outright (no comma)', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockReadSection.mockReturnValue({ content: '## Install\nrun npm install', heading: 'Install', startLine: 5, endLine: 10 } as any)
        const { text: stdout, code } = runSection({ spec: 'README.md::Install' })
        expect(code).toBe(0)
        expect(stdout).toContain('npm install')
      })
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
      // The file has to exist on disk: a path that does not is now reported as unreadable, which
      // outranks every language branch, so a nonexistent fixture would pass this for the wrong reason.
      const { text, code } = runSkeleton({ file: emptyFixture('.scala') })
      expect(code).toBe(1)
      // Scala now has an extractor, so empty file gets the standard message
      expect(text).toContain('No indexed symbols found')
    })

    it('does not claim an unsupported language for a plain empty result on a supported extension', () => {
      mockQuerySymbols.mockReturnValue([])
      // Existing file again -- this assertion is a not-contains, so an unreadable-path message
      // would satisfy it vacuously and stop pinning the language branch at all.
      const { text } = runSkeleton({ file: emptyFixture('.ts') })
      expect(text).not.toContain('no symbol extractor yet')
      expect(text).toContain('No indexed symbols found')
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
      expect(stdout).toContain('1 symbol')
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
      const { text, code } = runOutline({ file: emptyFixture('.dart') })
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
    it('runOutline JSON mode: a bare parent-name docstring reports hasDoc: false, not a false positive (regression: M35b parent-name convention)', () => {
      const syms: MockSymbol[] = [
        { name: 'undocumentedMethod', kind: 'method', filePath: 'f.kt', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'Widget' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      const { text: stdout } = runOutline({ file: 'f.kt', stats: true, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string; hasDoc?: boolean }> }
      expect(parsed.items.find((p) => p.name === 'undocumentedMethod')?.hasDoc).toBe(false)
    })

    it('runSkeleton JSON mode: a bare parent-name docstring reports hasDoc: false, not a false positive (regression: M35b parent-name convention)', () => {
      const syms: MockSymbol[] = [
        { name: 'undocumentedMethod', kind: 'method', filePath: 'f.kt', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'Widget' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      mockQueryRefCounts.mockReturnValue(new Map())
      const { text: stdout } = runSkeleton({ file: 'f.kt', stats: true, json: true })
      const parsed = JSON.parse(stdout) as { items: Array<{ name: string; hasDoc?: boolean }> }
      expect(parsed.items.find((p) => p.name === 'undocumentedMethod')?.hasDoc).toBe(false)
    })

    it('runOutline text mode does not render a bare parent-name docstring as a "# Widget" doc-comment line', () => {
      const syms: MockSymbol[] = [
        { name: 'undocumentedMethod', kind: 'method', filePath: 'f.kt', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'Widget' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runOutline({ file: 'f.kt' })
      expect(stdout).not.toContain('# Widget')
    })

    it('runOutline text mode still renders a real doc comment as "# <text>" (fix must not over-correct)', () => {
      const syms: MockSymbol[] = [
        { name: 'add', kind: 'method', filePath: 'f.kt', lineStart: 1, lineEnd: 5, body: 'x', docstring: 'Adds two numbers.' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { text: stdout } = runOutline({ file: 'f.kt' })
      expect(stdout).toContain('# Adds two numbers.')
    })

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

    it('ambiguity retry lines name brief itself, not read', () => {
      // formatAmbiguity defaults its commandName to 'read', so an unparameterized call site sends the user to a command that answers a different question than the one they asked.
      const candA: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' }
      const candB: MockSymbol = { name: 'render', kind: 'function', filePath: 'a.ts', lineStart: 20, lineEnd: 23, body: '', docstring: '', parent: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([candA, candB] as any)
      const { stderr } = capture(() => {
        expect(runBrief({ spec: 'a.ts::render' })).toBe(1)
      })
      expect(stderr).toContain("Ambiguous symbol 'render'")
      expect(stderr).toContain('token-goat brief "')
      expect(stderr).not.toContain('token-goat read "')
    })

    // A proper `file::symbol` spec that genuinely resolves to nothing keeps its own
    // "Symbol not found" wording untouched -- only the bare-name (no `::` at all) case below
    // changes.
    it('a proper file::symbol spec with a bad symbol keeps its existing "Symbol not found" wording', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stderr } = capture(() => {
        const code = runBrief({ spec: 'f.ts::missing' })
        expect(code).toBe(1)
      })
      expect(stderr).toContain('Symbol not found: f.ts::missing')
    })

    // Regression: a bare symbol name with no `::` used to say "Symbol not found", which is
    // false when the name IS indexed -- an agent reads that as "does not exist" and stops
    // looking. Point at the exact `file::symbol` spec to retry with instead.
    it('a bare indexed name (no :: separator) points at the resolved file::symbol spec instead of falsely claiming the symbol is missing', () => {
      const sym: MockSymbol = { name: 'didYouMean', kind: 'function', filePath: 'src/read_commands.ts', lineStart: 1, lineEnd: 5, body: '', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { stderr } = capture(() => {
        const code = runBrief({ spec: 'didYouMean' })
        expect(code).toBe(1)
      })
      expect(stderr).not.toContain('Symbol not found')
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('token-goat brief "src/read_commands.ts::didYouMean"')
    })

    // When the bare name matches nothing indexed either, fall back to the same "Invalid spec"
    // wording `similar`/`blame` already use for this exact case.
    it('a bare unindexed name (no :: separator) gets the shared "Invalid spec" wording, not a false "Symbol not found"', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stderr } = capture(() => {
        const code = runBrief({ spec: 'totallyUnknownSymbolXyz' })
        expect(code).toBe(1)
      })
      expect(stderr).not.toContain('Symbol not found')
      expect(stderr).toContain('Invalid spec - expected "file::symbol", got: totallyUnknownSymbolXyz')
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

    // ---- brief --exclude-tests ---------------------------------------------
    // brief was the last member of the refs/callers/dead/symbol/semantic/changed family without
    // this flag, and the one where it bites hardest: it caps callers at --limit 20 by default, so
    // for a symbol exercised mostly by tests the whole window is noise (measured on this repo's own
    // index, loadConfig's caller output is 56% test call sites).
    const briefSym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
    const prodCaller = { caller: 'prodCaller', kind: 'function', file: 'src/g.ts', line: 3 }
    const testCaller = { caller: 'testCaller', kind: 'function', file: 'tests/g.test.ts', line: 9 }

    it('--exclude-tests drops callers whose call site is a test file, keeping production ones', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller, testCaller])
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', excludeTests: true }) })
      expect(stdout).toContain('prodCaller')
      expect(stdout).not.toContain('testCaller')
    })

    it('--exclude-tests makes the caller count agree with the rows actually shown', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller, testCaller])
      // The uncapped COUNT(*) counts test refs too. Trusting it while filtering the list would print "Callers (2):" above a single row -- the exact count-vs-rows disagreement tests/guards/count_agreement_dedup.test.ts exists to catch.
      mockQueryRefCounts.mockReturnValueOnce(new Map([['myFunc', 2]]))
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', excludeTests: true }) })
      expect(stdout).toContain('Callers (1)')
      expect(stdout).not.toContain('Callers (2)')
      expect(stdout).not.toContain('more elided')
    })

    it('--exclude-tests scans unbounded rather than filtering a pre-capped page', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller])
      capture(() => { runBrief({ spec: 'f.ts::myFunc', excludeTests: true }) })
      // Filtering resolveCallers' default 500-row page would silently under-return whenever test refs occupy slots real callers would otherwise hold; the flag has to reach the query so the scan is unbounded before the filter runs.
      expect(mockResolveCallers).toHaveBeenCalledWith('myFunc', undefined, 'f.ts', expect.anything(), true)
    })

    it('--exclude-tests says the filter emptied the caller block rather than reporting zero callers', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([testCaller])
      const { stdout } = capture(() => {
        // A bare "Callers (0):" reads as "nothing calls this", which for a test-only symbol is the opposite of the truth and invites deleting live code.
        expect(runBrief({ spec: 'f.ts::myFunc', excludeTests: true })).toBe(0)
      })
      expect(stdout).toContain('no non-test callers')
      expect(stdout).toContain('1 in test file hidden by --exclude-tests')
    })

    it('omitting --exclude-tests leaves output byte-identical, test callers and all', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller, testCaller])
      mockQueryRefCounts.mockReturnValueOnce(new Map([['myFunc', 2]]))
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc' }) })
      expect(stdout).toContain('testCaller')
      expect(stdout).toContain('Callers (2)')
      expect(stdout).not.toContain('--exclude-tests')
    })

    it('--json reports hiddenByExcludeTests only when the filter actually hid something', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller, testCaller])
      const withFlag = capture(() => { runBrief({ spec: 'f.ts::myFunc', json: true, excludeTests: true }) }).stdout
      const parsedOn = JSON.parse(withFlag) as { hiddenByExcludeTests?: number; totalCallers: number; callers: unknown[] }
      expect(parsedOn.hiddenByExcludeTests).toBe(1)
      expect(parsedOn.totalCallers).toBe(1)
      expect(parsedOn.callers).toHaveLength(1)
      const withoutFlag = capture(() => { runBrief({ spec: 'f.ts::myFunc', json: true }) }).stdout
      // Absent, not zero: the field must not appear at all in default output.
      expect(JSON.parse(withoutFlag)).not.toHaveProperty('hiddenByExcludeTests')
    })

    it('--exclude-tests that hides nothing adds no note and no JSON field', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([briefSym as any])
      mockResolveCallers.mockReturnValue([prodCaller])
      const { stdout } = capture(() => { runBrief({ spec: 'f.ts::myFunc', json: true, excludeTests: true }) })
      expect(JSON.parse(stdout)).not.toHaveProperty('hiddenByExcludeTests')
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

    // --json path-spelling: symbol.filePath and callers[].file used to echo the raw row verbatim
    // even though the plain-text block above already renders both via toDisplayPath(rootDir, ...)
    // -- same command, same repo, two spellings decided only by --json. Matches
    // outline/skeleton/refs/types/dead/callers/test-for/symbol --json.
    it('renders --json symbol.filePath and callers[].file root-relative, matching the plain-text block', () => {
      const briefDisplayFixture = path.join(process.cwd(), 'src', 'brief-display-fixture.ts')
      const briefCallerFixture = path.join(process.cwd(), 'src', 'brief-caller-fixture.ts')
      const sym: MockSymbol = { name: 'briefJsonSym', kind: 'function', filePath: briefDisplayFixture, lineStart: 10, lineEnd: 20, body: 'function briefJsonSym() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([{ caller: 'caller1', kind: 'function', file: briefCallerFixture, line: 3 }])
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: `${briefDisplayFixture}::briefJsonSym`, json: true }) })
      const parsed = JSON.parse(stdout) as { symbol: { filePath: string }; callers: Array<{ file: string }> }
      expect(parsed.symbol.filePath).toBe('src/brief-display-fixture.ts')
      expect(parsed.callers[0]?.file).toBe('src/brief-caller-fixture.ts')
    })

    it('--json leaves an out-of-project symbol.filePath and callers[].file absolute (negative control)', () => {
      const outOfProjectSym = path.join(os.tmpdir(), 'tg-brief-outside-project-fixture', 'far.ts')
      const outOfProjectCaller = path.join(os.tmpdir(), 'tg-brief-outside-project-fixture', 'farCaller.ts')
      const sym: MockSymbol = { name: 'briefFarSym', kind: 'function', filePath: outOfProjectSym, lineStart: 1, lineEnd: 1, body: 'x', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      mockResolveCallers.mockReturnValue([{ caller: 'farCaller', kind: 'function', file: outOfProjectCaller, line: 1 }])
      mockFindContainingSection.mockReturnValue(null)
      const { stdout } = capture(() => { runBrief({ spec: `${outOfProjectSym}::briefFarSym`, json: true }) })
      const parsed = JSON.parse(stdout) as { symbol: { filePath: string }; callers: Array<{ file: string }> }
      expect(parsed.symbol.filePath).toBe(outOfProjectSym)
      expect(parsed.callers[0]?.file).toBe(outOfProjectCaller)
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
      // Original intent preserved: no explicit limit is passed, so the caller list comes back on resolveCallers' own default page and the elided count must come from the uncapped COUNT(*), not this list's length. The trailing rootDir/excludeTests args arrived with `brief --exclude-tests`; rootDir is already resolved here, so threading it avoids a second git shell-out for the same value, and `false` pins that the unbounded-scan path stays off by default.
      expect(mockResolveCallers).toHaveBeenCalledWith('myFunc', undefined, 'f.ts', expect.any(String), false)
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

    // ---- multi-symbol brief (file::a,b) ------------------------------------
    describe('multi-symbol brief (file::a,b)', () => {
      function poolMock(pool: MockSymbol[]): void {
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = pool
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })
      }

      const symA: MockSymbol = { name: 'alphaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'alphaFn body', docstring: '' }
      const symB: MockSymbol = { name: 'betaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 5, lineEnd: 5, body: 'betaFn body', docstring: '' }

      it('returns both symbols merged in text mode', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,betaFn' })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('alphaFn:\n')
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('betaFn:\n')
        expect(stdout).toContain('betaFn body')
      })

      it('returns an object keyed by both symbol names in JSON mode, each a real nested object', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,betaFn', json: true })
          expect(code).toBe(0)
        })
        const payload = JSON.parse(stdout) as Record<string, { symbol: { name: string; body: string } }>
        expect(payload.alphaFn?.symbol.name).toBe('alphaFn')
        expect(payload.alphaFn?.symbol.body).toBe('alphaFn body')
        expect(payload.betaFn?.symbol.name).toBe('betaFn')
        expect(payload.betaFn?.symbol.body).toBe('betaFn body')
      })

      it('one existing + one missing symbol: existing bundle returned, missing one reported as an error entry, exit code 0', () => {
        poolMock([symA])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,missingFn', json: true })
          expect(code).toBe(0)
        })
        const payload = JSON.parse(stdout) as Record<string, unknown>
        expect((payload.alphaFn as { symbol: { body: string } }).symbol.body).toBe('alphaFn body')
        expect((payload.missingFn as { error: string }).error).toContain('not found')
      })

      it('returns exit code 1 when no symbol in the list resolves', () => {
        poolMock([])
        let code = 0
        capture(() => { code = runBrief({ spec: 'src/foo.ts::missingA,missingB' }) })
        expect(code).toBe(1)
      })

      it('reports an invalid --limit once for the whole call, not once per symbol', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        let code = 0
        const { stdout, stderr } = capture(() => { code = runBrief({ spec: 'src/foo.ts::alphaFn,betaFn', limit: 0 }) })
        expect(code).toBe(1)
        // --limit is a whole-invocation flag, so validating it per sub-call would repeat the usage error once per symbol and dress it up as a per-symbol resolution failure ("alphaFn:\n--limit must be...") -- which also drives anyFound false and routes a usage error through the not-found path.
        expect(stderr.match(/--limit must be a positive number/g)).toHaveLength(1)
        expect(stderr).not.toContain('alphaFn:')
        expect(stderr).not.toContain('betaFn:')
        expect(stdout).toBe('')
      })

      it('single-symbol brief output is byte-identical to before (no comma path regression)', () => {
        poolMock([symA])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => { runBrief({ spec: 'src/foo.ts::alphaFn' }) })
        expect(stdout).toContain('alphaFn body')
        // No multi-symbol merge artifacts leak into the single-symbol path.
        expect(stdout).not.toContain('alphaFn:\n')
      })
    })

    describe('cross-file multi-spec brief (a.ts::x,b.ts::y)', () => {
      function poolMock(pool: MockSymbol[]): void {
        mockQuerySymbols.mockImplementation((opts: QuerySymbolsOpts = {}) => {
          let rows = pool
          if (opts.name !== undefined) rows = rows.filter((r) => r.name === opts.name)
          if (opts.filePath !== undefined) rows = rows.filter((r) => r.filePath === opts.filePath)
          return rows as unknown as ReturnType<typeof mockQuerySymbols>
        })
      }

      const symA: MockSymbol = { name: 'alphaFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'alphaFn body', docstring: '' }
      const symB: MockSymbol = { name: 'betaFn', kind: 'function', filePath: 'src/bar.ts', lineStart: 5, lineEnd: 5, body: 'betaFn body', docstring: '' }

      it('bundles two symbols from two different files in text mode, keyed by file::symbol', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn' })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('src/foo.ts::alphaFn:\n')
        expect(stdout).toContain('alphaFn body')
        expect(stdout).toContain('src/bar.ts::betaFn:\n')
        expect(stdout).toContain('betaFn body')
      })

      it('bundles two symbols from two different files in JSON mode, keyed by file::symbol', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn', json: true })
          expect(code).toBe(0)
        })
        const payload = JSON.parse(stdout) as Record<string, { symbol: { name: string; body: string } }>
        expect(payload['src/foo.ts::alphaFn']?.symbol.name).toBe('alphaFn')
        expect(payload['src/foo.ts::alphaFn']?.symbol.body).toBe('alphaFn body')
        expect(payload['src/bar.ts::betaFn']?.symbol.name).toBe('betaFn')
        expect(payload['src/bar.ts::betaFn']?.symbol.body).toBe('betaFn body')
      })

      it('keeps blocks distinct when the same symbol name is defined in two different files, keying each by its full file::symbol pair', () => {
        const fooSame: MockSymbol = { name: 'sameFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'foo sameFn body', docstring: '' }
        const barSame: MockSymbol = { name: 'sameFn', kind: 'function', filePath: 'src/bar.ts', lineStart: 9, lineEnd: 9, body: 'bar sameFn body', docstring: '' }
        poolMock([fooSame, barSame])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::sameFn,src/bar.ts::sameFn', json: true })
          expect(code).toBe(0)
        })
        const payload = JSON.parse(stdout) as Record<string, { symbol: { body: string } }>
        expect(Object.keys(payload)).toHaveLength(2)
        expect(payload['src/foo.ts::sameFn']?.symbol.body).toBe('foo sameFn body')
        expect(payload['src/bar.ts::sameFn']?.symbol.body).toBe('bar sameFn body')
        // Same-name collision would otherwise silently overwrite one block's text with the other's.
        const { stdout: textOut } = capture(() => { runBrief({ spec: 'src/foo.ts::sameFn,src/bar.ts::sameFn' }) })
        expect(textOut).toContain('foo sameFn body')
        expect(textOut).toContain('bar sameFn body')
      })

      it('a bare segment after file::symbol inherits the previous file across a real file boundary (a.ts::x,b.ts::y,z resolves z against b.ts)', () => {
        const symX: MockSymbol = { name: 'x', kind: 'function', filePath: 'src/a.ts', lineStart: 1, lineEnd: 1, body: 'x body', docstring: '' }
        const symY: MockSymbol = { name: 'y', kind: 'function', filePath: 'src/b.ts', lineStart: 2, lineEnd: 2, body: 'y body', docstring: '' }
        const symZ: MockSymbol = { name: 'z', kind: 'function', filePath: 'src/b.ts', lineStart: 3, lineEnd: 3, body: 'z body', docstring: '' }
        poolMock([symX, symY, symZ])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/a.ts::x,src/b.ts::y,z' })
          expect(code).toBe(0)
        })
        // The load-bearing assertion: `z` (a bare segment) resolved -- proving the spec crossed a
        // file boundary and `z` was looked up against src/b.ts (the file to its left), not src/a.ts.
        // A spec like `a.ts::x,y` has only one `::` segment and never reaches this cross-file path
        // at all -- it would still resolve today via the pre-existing same-file multi-symbol path,
        // proving nothing about this change.
        expect(stdout).toContain('src/a.ts::x:\n')
        expect(stdout).toContain('x body')
        expect(stdout).toContain('src/b.ts::y:\n')
        expect(stdout).toContain('y body')
        expect(stdout).toContain('z:\n')
        expect(stdout).toContain('z body')
      })

      it('one existing + one missing symbol: existing bundle returned, missing one reported as an error entry, exit code 0', () => {
        poolMock([symA])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,src/bar.ts::missingFn', json: true })
          expect(code).toBe(0)
        })
        const payload = JSON.parse(stdout) as Record<string, unknown>
        expect((payload['src/foo.ts::alphaFn'] as { symbol: { body: string } }).symbol.body).toBe('alphaFn body')
        expect((payload['src/bar.ts::missingFn'] as { error: string }).error).toContain('not found')
      })

      it('returns exit code 1 when no pair in the cross-file spec resolves', () => {
        poolMock([])
        let code = 0
        capture(() => { code = runBrief({ spec: 'src/foo.ts::missingA,src/bar.ts::missingB' }) })
        expect(code).toBe(1)
      })

      it('applies --limit per symbol on the cross-file path, not once globally, matching runBriefMulti\'s same-file behavior', () => {
        poolMock([symA, symB])
        const tenCallers = Array.from({ length: 10 }, (_, i) => ({ caller: `caller${i}`, kind: 'function', file: 'g.ts', line: i + 1 }))
        // Both symbols independently have 10 resolvable callers -- --limit 3 must cap each pair's
        // own shown list to 3, not share one global slice across the whole call.
        mockResolveCallers.mockReturnValue(tenCallers)
        mockFindContainingSection.mockReturnValue(null)
        const { stdout } = capture(() => {
          const code = runBrief({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn', limit: 3 })
          expect(code).toBe(0)
        })
        // Pin WHICH symbols were resolved first -- the pre-fix mis-parse would fold this spec into
        // one bogus lookup and satisfy a bare per-call property assertion vacuously.
        expect(mockResolveCallers.mock.calls.map((c) => c[0])).toEqual(['alphaFn', 'betaFn'])
        // Each block independently reports the true count (10) and elides down to the per-symbol limit (3), proving --limit was applied per symbol, not once for the whole call.
        expect(stdout).toContain('src/foo.ts::alphaFn:\n')
        expect(stdout).toContain('src/bar.ts::betaFn:\n')
        const alphaBlock = stdout.slice(stdout.indexOf('src/foo.ts::alphaFn:'), stdout.indexOf('src/bar.ts::betaFn:'))
        const betaBlock = stdout.slice(stdout.indexOf('src/bar.ts::betaFn:'))
        expect(alphaBlock).toContain('Callers (10):')
        expect(alphaBlock).toContain('...(7 more elided)')
        expect(betaBlock).toContain('Callers (10):')
        expect(betaBlock).toContain('...(7 more elided)')
      })

      it('reports an invalid --limit once for the whole call, not once per pair', () => {
        poolMock([symA, symB])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        let code = 0
        const { stdout, stderr } = capture(() => { code = runBrief({ spec: 'src/foo.ts::alphaFn,src/bar.ts::betaFn', limit: 0 }) })
        expect(code).toBe(1)
        expect(stderr.match(/--limit must be a positive number/g)).toHaveLength(1)
        expect(stdout).toBe('')
      })

      it('does not affect a same-file multi-spec (only one distinct file involved) -- byte-identical to the pre-existing same-file output', () => {
        poolMock([symA, { ...symB, filePath: 'src/foo.ts' }])
        mockResolveCallers.mockReturnValue([])
        mockFindContainingSection.mockReturnValue(null)
        // Only one `::` segment in this spec (`src/foo.ts::alphaFn`), so parseCrossFileMultiSpec
        // declines and this still runs the pre-existing runBriefMulti same-file path, unchanged.
        const { stdout } = capture(() => { runBrief({ spec: 'src/foo.ts::alphaFn,betaFn' }) })
        expect(stdout).toContain('alphaFn:\n')
        expect(stdout).toContain('betaFn:\n')
        expect(stdout).not.toContain('src/foo.ts::alphaFn:\n')
        expect(stdout).not.toContain('src/foo.ts::betaFn:\n')
      })
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
        // One transaction, not 500 implicit ones. Each bare .run() commits and fsyncs on its own, which is unnoticeable on a fast local disk but took 51-55s on a CI runner -- past the 30s testTimeout. Same 500 rows and same assertions, just without paying 500 fsyncs.
        db.transaction(() => {
          for (let i = 0; i < 500; i++) insert.run(i, `item-${i}-`.repeat(5))
        })()
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
    it('reports no exported symbols for a real file with genuinely nothing to export (pinned exit code)', () => {
      // 'a.ts' is not readable from disk here, so this also proves the empty-result branch is
      // reached only because `symbols` is non-empty (indexed) -- not because the disk check was
      // skipped entirely.
      const syms: MockSymbol[] = [
        { name: 'internal', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'function internal() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => {
        const code = runExports({ file: 'a.ts' })
        expect(code).toBe(0)
      })
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

    it('errors on a path that is neither readable from disk nor indexed, instead of reporting the empty-result message', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stdout, stderr } = capture(() => {
        const code = runExports({ file: 'src/__nonexistent_exports_target__.ts' })
        expect(code).toBe(1)
      })
      expect(stderr).toContain('Could not read: src/__nonexistent_exports_target__.ts')
      expect(stdout).not.toContain('No exported')
    })

    it('still reports from the index when the file is indexed but has since been deleted from disk (no error)', () => {
      // The path is never written to disk in this test -- readFileText() naturally returns null
      // for it, so this exercises the "indexed but absent from disk" side of the conjunction.
      const syms: MockSymbol[] = [
        { name: 'pubFn', kind: 'function', filePath: 'gone.ts', lineStart: 1, lineEnd: 5, body: 'export function pubFn() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout, stderr } = capture(() => {
        const code = runExports({ file: 'gone.ts' })
        expect(code).toBe(0)
      })
      expect(stdout).toContain('pubFn')
      expect(stderr).not.toContain('Could not read')
    })
  })

  describe('runExports --grep', () => {
    it('filters exported symbols to those whose NAME matches the pattern', () => {
      const syms: MockSymbol[] = [
        { name: 'pubAlpha', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'export function pubAlpha() {}', docstring: '' },
        { name: 'pubBeta', kind: 'function', filePath: 'a.ts', lineStart: 7, lineEnd: 9, body: 'export function pubBeta() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => {
        const code = runExports({ file: 'a.ts', grep: 'Alpha' })
        expect(code).toBe(0)
      })
      expect(stdout).toContain('pubAlpha')
      expect(stdout).not.toContain('pubBeta')
    })

    // Negative control: proves --grep actually narrows the set rather than the plumbing being a
    // no-op that happens to pass the positive test above.
    it('negative control: an unfiltered call still returns both exports', () => {
      const syms: MockSymbol[] = [
        { name: 'pubAlpha', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'export function pubAlpha() {}', docstring: '' },
        { name: 'pubBeta', kind: 'function', filePath: 'a.ts', lineStart: 7, lineEnd: 9, body: 'export function pubBeta() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runExports({ file: 'a.ts' }) })
      expect(stdout).toContain('pubAlpha')
      expect(stdout).toContain('pubBeta')
    })

    it('reports a filtered-to-empty notice, distinct from "No exported symbols", when --grep matches nothing among real exports', () => {
      const syms: MockSymbol[] = [
        { name: 'pubGamma', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'export function pubGamma() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => {
        const code = runExports({ file: 'a.ts', grep: '__no_such_export_xyzzy__' })
        expect(code).toBe(0)
      })
      expect(stdout).toContain('--grep')
      expect(stdout).not.toContain('No exported symbols found')
    })

    it('falls back to a literal substring match for an invalid regex instead of erroring', () => {
      const syms: MockSymbol[] = [
        { name: 'pubDelta', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'export function pubDelta() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => {
        const code = runExports({ file: 'a.ts', grep: '[unclosed' })
        expect(code).toBe(0)
      })
      expect(stdout).toContain('--grep')
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

    it('extracts imports for .mts/.cts (explicit-ESM/explicit-CJS TypeScript), not just .ts/.js', () => {
      // Regression test: .mts/.cts were missing from the dispatch list, so these files fell
      // through to the far weaker generic `import|require|use|#include` fallback instead of
      // the dedicated TS/JS matcher used here.
      const src = "import { a } from './mod'\nconst x = require('cjs-pkg')"
      expect(extractImports(src, '.mts')).toEqual(['./mod', 'cjs-pkg'])
      expect(extractImports(src, '.cts')).toEqual(['./mod', 'cjs-pkg'])
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

    it('extracts a module-info.java\'s JPMS `requires` declarations, alongside regular imports (regression: the import-only regex never matched "requires", so a module-info.java -- the authoritative dependency list for a Java 9+ module -- silently reported zero imports/deps)', () => {
      const src = [
        'module com.example.app {',
        '  requires java.base;',
        '  requires transitive com.example.core;',
        '  requires static com.example.optional;',
        '  exports com.example.app.api;',
        '}',
      ].join('\n')
      expect(extractImports(src, '.java')).toEqual([
        'java.base', 'com.example.core', 'com.example.optional',
      ])
    })

    it('extracts Rust use and C include', () => {
      expect(extractImports('pub use std::fmt;\nuse crate::thing;', '.rs')).toEqual([
        'std::fmt', 'crate::thing',
      ])
      expect(extractImports('#include <stdio.h>\n#include "local.h"', '.c')).toEqual([
        'stdio.h', 'local.h',
      ])
    })

    it('expands a Rust grouped `use base::{a, b}` into one target per selector, including nested groups, `self`, and renames (regression: `[^;{]+` stopped at `{`, capturing only the truncated prefix)', () => {
      const src = [
        'use std::{fs, io};',
        'use std::io::{self, Read, Write as W};',
        'use std::{fs::File, io::{self, Read}};',
      ].join('\n')
      const targets = extractImports(src, '.rs')
      expect(targets).toContain('std::fs')
      expect(targets).toContain('std::io')
      // `self` inside `io::{self, Read}` resolves to the group's own module (std::io), not a
      // literal "std::io::self".
      expect(targets).not.toContain('std::io::self')
      expect(targets).toContain('std::io::Read')
      // A rename (`Write as W`) resolves to the original name callers reference.
      expect(targets).toContain('std::io::Write')
      expect(targets).not.toContain('std::io::W')
      // Nested group: std::{fs::File, io::{self, Read}}
      expect(targets).toContain('std::fs::File')
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

    it('extracts Elixir alias/import/require/use, expanding grouped aliases (regression: the generic fallback caught import/require/use but not `alias`, the dominant cross-module form)', () => {
      const src = [
        '  alias Foo.Bar',
        '  alias MyApp.{Repo, User}',
        '  import Ecto.Query',
        '  require Logger',
        '  use Phoenix.Controller, namespace: MyApp',
      ].join('\n')
      expect(extractImports(src, '.ex')).toEqual([
        'Foo.Bar', 'MyApp.Repo', 'MyApp.User', 'Ecto.Query', 'Logger', 'Phoenix.Controller',
      ])
    })

    it('extracts CSS/Sass/Less @import (bare and url() forms) and Sass @use/@forward (regression: the generic fallback mangled the url() form into the literal text "url(...)")', () => {
      const src = [
        '@import "bare.css";',
        "@import 'bare-single.css';",
        '@import url("quoted.css");',
        '@import url(bare-url.css);',
        "@use 'module';",
        "@forward 'shared';",
      ].join('\n')
      expect(extractImports(src, '.css')).toEqual([
        'bare.css', 'bare-single.css', 'quoted.css', 'bare-url.css', 'module', 'shared',
      ])
      expect(extractImports('@import url(plain.less);', '.less')).toEqual(['plain.less'])
      expect(extractImports("@use 'sass:math';", '.scss')).toEqual(['sass:math'])
    })

    it('extracts Terraform module source dependencies (regression: "source" matches no generic-fallback keyword at all, so every .tf file reported zero imports/deps despite module composition being the language\'s one real cross-file dependency)', () => {
      const src = [
        'module "network" {',
        '  source = "./modules/network"',
        '}',
        '',
        'module "app" {',
        '  source = "git::https://example.com/modules/app.git"',
        '}',
      ].join('\n')
      expect(extractImports(src, '.tf')).toEqual([
        './modules/network', 'git::https://example.com/modules/app.git',
      ])
    })

    it('extracts every target from a comma-separated legacy @import line, not just the first', () => {
      // Regression test: a single .exec() capturing one quoted group silently dropped every
      // target after the first on a line like `@import "reset", "base", "layout";`.
      expect(extractImports('@import "reset", "base", "layout";', '.css')).toEqual([
        'reset', 'base', 'layout',
      ])
    })

    it('generic fallback (Dart/Apex/etc.): matches a real import but not a keyword-as-substring false positive (regression: an unanchored match let "use" inside "because"/"house" fabricate phantom imports)', () => {
      const src = [
        'because this comment mentions house rules', // "use" is a substring of both words
        'import Foo.Bar', // real generic-fallback import, should still match
      ].join('\n')
      expect(extractImports(src, '.dart')).toEqual(['Foo.Bar'])
      // #include's leading "#" is itself a non-word character, so the same guard must not
      // also break the pre-existing C/C++ #include branch's sibling keyword form.
      expect(extractImports('#include <stdio.h>', '.unknownext')).toEqual(['stdio.h'])
    })

    it('extracts Kotlin imports, resolving an `as` alias to its clean import path (mirrors kotlin.ts IMPORT_RE, not the generic fallback\'s greedy capture)', () => {
      const src = [
        'import foo.Bar as Baz', // aliased import -- must resolve to "foo.Bar", not "foo.Bar as Baz"
        'import kotlinx.android.synthetic.main.activity_main.*', // wildcard import
      ].join('\n')
      expect(extractImports(src, '.kt')).toEqual(['foo.Bar', 'kotlinx.android.synthetic.main.activity_main.*'])
      expect(extractImports('import foo.Bar as Baz', '.kts')).toEqual(['foo.Bar'])
    })

    it('extracts Swift imports, stripping the submodule-import keyword (mirrors swift.ts IMPORT_RE, not the generic fallback\'s greedy capture)', () => {
      const src = [
        'import class UIKit.UIView', // submodule import -- must resolve to "UIKit.UIView", not "class UIKit.UIView"
        '@testable import MyApp', // testable import
      ].join('\n')
      expect(extractImports(src, '.swift')).toEqual(['UIKit.UIView', 'MyApp'])
    })

    it('extracts Haskell imports, stripping qualified/safe modifiers and hiding/selector clauses (regression: the generic fallback\'s greedy capture swallowed "qualified Data.Map as Map" verbatim)', () => {
      const src = [
        'import qualified Data.Map as Map', // idiomatic qualified import
        'import Data.List (sort, nub)', // explicit selector list
        'import safe qualified Data.Set as Set', // Safe Haskell, modifier order
        'import Data.Text hiding (map)', // hiding clause
      ].join('\n')
      expect(extractImports(src, '.hs')).toEqual(['Data.Map', 'Data.List', 'Data.Set', 'Data.Text'])
    })

    it('de-duplicates repeated specifiers', () => {
      expect(extractImports("import a from 'x'\nimport b from 'x'", '.ts')).toEqual(['x'])
    })

    it('extracts C# using directives, including using static', () => {
      const src = 'using System.Collections.Generic;\nusing static System.Math;\nnamespace Foo {}'
      expect(extractImports(src, '.cs')).toEqual(['System.Collections.Generic', 'System.Math'])
    })

    it('extracts C# 10 file-scoped implicit usings (global using System;), including global using static (regression: the anchored ^using never matched a line starting with "global")', () => {
      const src = 'global using System;\nglobal using static System.Math;'
      expect(extractImports(src, '.cs')).toEqual(['System', 'System.Math'])
    })

    it('extracts C# using alias directives (using X = Y.Z;), resolving to the aliased target rather than dropping the line entirely (regression: the trailing "= Y.Z" left no "\\s*;" immediately after the alias name, so the whole directive silently matched nothing)', () => {
      const src = 'using Project = PC.MyCompany.Project;\nusing System;'
      expect(extractImports(src, '.cs')).toEqual(['PC.MyCompany.Project', 'System'])
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

    it('expands a PHP group-use declaration (use App\\{Foo, Bar};), including renames (regression: [\\w\\\\]+ stopped at "{", so the whole line was silently dropped, not merely truncated)', () => {
      const src = 'use App\\Models\\{User, Post as BlogPost};'
      const targets = extractImports(src, '.php')
      expect(targets).toContain('App\\Models\\User')
      expect(targets).toContain('App\\Models\\Post')
      expect(targets).not.toContain('App\\Models\\BlogPost')
    })

    it('extracts single-symbol PHP use function/use const imports (regression: the target regex\'s [\\w\\\\]+ captured "function"/"const" as the target itself, then failed to match the trailing ";", silently dropping the whole line)', () => {
      const src = [
        'use function App\\Helpers\\format_date;',
        'use const App\\Config\\MAX_RETRIES;',
      ].join('\n')
      const targets = extractImports(src, '.php')
      expect(targets).toContain('App\\Helpers\\format_date')
      expect(targets).toContain('App\\Config\\MAX_RETRIES')
    })

    it('extracts Liquid include/render/section tag targets (regression: none of "include"/"render"/"section" match the generic import|require|use|#include fallback -- no leading "#" and none of those words is itself "import"/"require"/"use" -- so every .liquid file silently reported zero imports/deps despite liquid.ts already indexing the same tags as AdapterImport entries)', () => {
      const src = [
        "{% include 'header' %}",
        "{%- include 'footer.liquid' -%}",
        '{% render "card", product: product %}',
        "{% section 'hero-banner' %}",
      ].join('\n')
      expect(extractImports(src, '.liquid')).toEqual(['header', 'footer.liquid', 'card', 'hero-banner'])
    })

    it('extracts GraphQL "# import" pragma targets (regression: the pragma has free-form text between the "import" keyword and the quoted path -- "# import FragmentName from \\"./x.graphql\\"" -- so the generic import|require|use|#include fallback\'s capture class [^\'">;]+ started right after "import" instead of at the quoted target, fabricating the non-actionable blob "FragmentName from " instead of the real target, despite graphql_idx.ts already indexing the same pragma as an AdapterImport entry)', () => {
      const src = [
        '# import FragmentName from "./someFragment.graphql"',
        '#import OtherFragment from "./other.gql"',
        'query Foo {',
        '  bar { ...FragmentName }',
        '}',
      ].join('\n')
      expect(extractImports(src, '.graphql')).toEqual(['./someFragment.graphql', './other.gql'])
      expect(extractImports(src, '.gql')).toEqual(['./someFragment.graphql', './other.gql'])
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

    it('extracts require/require_relative from a .rake file (regression: .rake fell through to the generic fallback, which never matches require_relative)', () => {
      const src = ["require 'json'", "require_relative 'lib/foo'"].join('\n')
      expect(extractImports(src, '.rake')).toEqual(['json', 'lib/foo'])
    })

    it('expands a Scala grouped import (import foo.bar.{A, B, C}) into its individual selectors (regression: .scala/.sc had no dedicated branch, so this fell through to the generic fallback, whose capture class does not stop at "{" and so returned the single truncated, non-actionable blob "foo.bar.{A, B, C}" instead of three real import targets -- mirrors the same brace-group fix already applied to scala.ts\'s symbol-index extractor)', () => {
      const src = 'import foo.bar.{A, B, C}'
      expect(extractImports(src, '.scala')).toEqual(['foo.bar.A', 'foo.bar.B', 'foo.bar.C'])
      expect(extractImports(src, '.sc')).toEqual(['foo.bar.A', 'foo.bar.B', 'foo.bar.C'])
    })

    it('resolves a Scala grouped-import rename (A => B) to the original (left-hand) symbol, and a wildcard selector (_) to base._, matching scala.ts', () => {
      const src = 'import foo.bar.{Old => New, _}'
      expect(extractImports(src, '.scala')).toEqual(['foo.bar.Old', 'foo.bar._'])
    })

    it('still extracts a plain (non-grouped) Scala import, including a wildcard import', () => {
      const src = ['import scala.util.matching.Regex', 'import java.util._'].join('\n')
      expect(extractImports(src, '.scala')).toEqual(['scala.util.matching.Regex', 'java.util._'])
    })

    it('extracts named ES-module imports from Vue/Svelte/Astro single-file components (regression: .vue/.svelte/.astro have no dedicated branch, so a <script> block\'s named import fell through to the generic fallback, whose capture class does not stop at "{" -- for "import { ref } from \'vue\'" that fabricated the non-actionable blob "{ ref } from \'vue" instead of the real target "vue", and a default-import sibling line was correctly extracted only by accident)', () => {
      const vueSrc = [
        '<script setup>',
        "import { ref, computed } from 'vue'",
        "import Foo from './Foo.vue'",
        '</script>',
        '<template><div>{{ ref }}</div></template>',
      ].join('\n')
      expect(extractImports(vueSrc, '.vue')).toEqual(['vue', './Foo.vue'])

      const svelteSrc = [
        '<script>',
        "  import { onMount } from 'svelte'",
        '</script>',
      ].join('\n')
      expect(extractImports(svelteSrc, '.svelte')).toEqual(['svelte'])

      const astroSrc = [
        '---',
        "import { getCollection } from 'astro:content'",
        '---',
        '<div></div>',
      ].join('\n')
      expect(extractImports(astroSrc, '.astro')).toEqual(['astro:content'])
    })

    it('extracts Bash source/dot-sourcing targets (regression: neither "source foo.sh" nor the POSIX ". foo.sh" form matches the generic import|require|use|#include fallback -- "source" is not in its keyword set and a bare "." is not a word character, so every .sh/.bash file silently reported zero imports/deps despite sourcing being the one real cross-file dependency shell scripts have)', () => {
      const src = [
        '#!/bin/bash',
        'source "./lib/common.sh"',
        '. ./lib/other.sh',
        'echo "hello"',
      ].join('\n')
      expect(extractImports(src, '.sh')).toEqual(['./lib/common.sh', './lib/other.sh'])
      expect(extractImports(src, '.bash')).toEqual(['./lib/common.sh', './lib/other.sh'])
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

  describe('runImports --grep', () => {
    it('filters imports to those whose MODULE SPECIFIER matches the pattern', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imports-grep-'))
      try {
        const file = path.join(dir, 'entry.ts')
        fs.writeFileSync(file, "import { a } from 'alpha-pkg'\nimport { b } from 'beta-pkg'\n")
        const { stdout } = capture(() => {
          const code = runImports({ file, grep: 'alpha' })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('alpha-pkg')
        expect(stdout).not.toContain('beta-pkg')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    // Negative control: proves --grep actually narrows the set rather than the plumbing being a
    // no-op that happens to pass the positive test above.
    it('negative control: an unfiltered call still returns both imports', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imports-grep-neg-'))
      try {
        const file = path.join(dir, 'entry.ts')
        fs.writeFileSync(file, "import { a } from 'alpha-pkg'\nimport { b } from 'beta-pkg'\n")
        const { stdout } = capture(() => { runImports({ file }) })
        expect(stdout).toContain('alpha-pkg')
        expect(stdout).toContain('beta-pkg')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('reports a filtered-to-empty notice, distinct from "No imports found", when --grep matches nothing among real imports', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imports-grep-empty-'))
      try {
        const file = path.join(dir, 'entry.ts')
        fs.writeFileSync(file, "import { a } from 'gamma-pkg'\n")
        const { stdout } = capture(() => {
          const code = runImports({ file, grep: '__no_such_import_xyzzy__' })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('--grep')
        expect(stdout).not.toContain('No imports found')
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    it('falls back to a literal substring match for an invalid regex instead of erroring', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-imports-grep-invalid-'))
      try {
        const file = path.join(dir, 'entry.ts')
        fs.writeFileSync(file, "import { a } from 'delta-pkg'\n")
        const { stdout } = capture(() => {
          const code = runImports({ file, grep: '[unclosed' })
          expect(code).toBe(0)
        })
        expect(stdout).toContain('--grep')
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

    it('extracts .mts/.cts exports (explicit-ESM/explicit-CJS TypeScript), not just .ts', () => {
      expect(extractExportNames('export function fn() {}', '.mts')).toEqual(['fn'])
      expect(extractExportNames('export function fn() {}', '.cts')).toEqual(['fn'])
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

    it('--grep filters the changed-file list by path', () => {
      gitOk('src/a.ts\ntests/a.test.ts\nvendor/b.ts\n')
      const withoutFlag = capture(() => { runChanged({ ref: 'HEAD~1' }) }).stdout
      expect(withoutFlag).toContain('tests/a.test.ts')

      const withFlag = capture(() => { runChanged({ ref: 'HEAD~1', grep: '^src/' }) }).stdout
      expect(withFlag).toContain('src/a.ts')
      expect(withFlag).not.toContain('tests/a.test.ts')
      expect(withFlag).not.toContain('vendor/b.ts')
    })

    it('says the match was filtered out, not "No files changed", when --grep matches none of the changed files (plural, count > 1)', () => {
      gitOk('src/a.ts\nsrc/b.ts\n')
      const result = capture(() => {
        const code = runChanged({ ref: 'HEAD~1', grep: '^nomatch/' })
        expect(code).toBe(0)
      })
      const all = result.stdout + result.stderr
      expect(all).toContain('all 2 changed files were filtered out by --grep')
      expect(all).not.toContain('No files changed')
    })

    // Singular count branch, pinned separately from the plural control above so a fixture landing on count===1 is actually asserted, not just reached.
    it('uses singular wording when exactly one file changed and --grep filtered it out', () => {
      gitOk('src/only.ts\n')
      const result = capture(() => {
        const code = runChanged({ ref: 'HEAD~1', grep: '^nomatch/' })
        expect(code).toBe(0)
      })
      const all = result.stdout + result.stderr
      expect(all).toContain('all 1 changed file was filtered out by --grep')
      expect(all).not.toContain('1 changed files')
    })

    it('--json keeps totalCount at the post-grep count', () => {
      gitOk('src/a.ts\ntests/a.test.ts\n')
      const parsed = JSON.parse(capture(() => { runChanged({ ref: 'HEAD~1', json: true, grep: '^src/' }) }).stdout) as { items: string[]; totalCount: number }
      expect(parsed.items).toEqual(['src/a.ts'])
      expect(parsed.totalCount).toBe(1)
    })

    it('falls back to a literal substring match for an invalid regex, never throwing', () => {
      gitOk('src/[unclosed]weird.ts\nsrc/other.ts\n')
      const { stdout } = capture(() => {
        const code = runChanged({ ref: 'HEAD~1', grep: '[unclosed' })
        expect(code).toBe(0)
      })
      expect(stdout).toContain('src/[unclosed]weird.ts')
      expect(stdout).not.toContain('src/other.ts')
    })

    it('lists changed symbols with kind and location in symbol mode', () => {
      // Distinguish the rev-parse (project root) call from git diff --name-only -- gitOk's single
      // canned response for every runGit call would otherwise make resolveProjectRoot's toplevel
      // resolve to the literal string 'a.ts', which then collides with the symbol's own indexed
      // filePath ('a.ts') and toDisplayPath prints '.' instead of the real relative path.
      const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
      const nameOnly = { exitCode: 0, stdout: 'a.ts\n', stderr: '' }
      const noHunkDiff = { exitCode: 0, stdout: '', stderr: '' }
      mockRunGit
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(toplevel as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(nameOnly as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockReturnValueOnce(noHunkDiff as any)
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

    // --json emitting prose is a success status with an unparseable body: the caller gets exit 0
    // and JSON.parse throws. `callers`/`dead`/`deps`/`types` were migrated to always emit the
    // envelope; `changed` kept prose on all three of its zero-row paths. Each is pinned
    // separately because they are three distinct early returns, not one shared branch.
    describe('--json always emits a parseable envelope, never prose', () => {
      function parse(stdout: string): { items: unknown[]; truncated: boolean; totalCount: number } {
        return JSON.parse(stdout) as { items: unknown[]; truncated: boolean; totalCount: number }
      }

      it('emits an empty envelope, not "No files changed.", when nothing changed', () => {
        gitOk('')
        const { stdout } = capture(() => { expect(runChanged({ json: true })).toBe(0) })
        expect(() => parse(stdout)).not.toThrow()
        expect(parse(stdout)).toEqual({ items: [], truncated: false, totalCount: 0 })
      })

      it('emits an empty envelope in --symbol mode when nothing changed', () => {
        gitOk('')
        const { stdout } = capture(() => { expect(runChanged({ json: true, symbolMode: true })).toBe(0) })
        expect(() => parse(stdout)).not.toThrow()
        expect(parse(stdout).items).toEqual([])
      })

      it('emits an empty envelope when --grep filters every changed file out', () => {
        gitOk('src/a.ts\nsrc/b.ts\n')
        const { stdout } = capture(() => { expect(runChanged({ ref: 'HEAD~1', json: true, grep: '^nomatch/' })).toBe(0) })
        expect(() => parse(stdout)).not.toThrow()
        // totalCount is the POST-filter count, matching the populated branch and the siblings --
        // never the pre-filter 2, which would claim rows the payload does not carry.
        expect(parse(stdout)).toEqual({ items: [], truncated: false, totalCount: 0 })
      })

      it('emits an empty envelope when the changed files carry no indexed symbols', () => {
        const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
        const nameOnly = { exitCode: 0, stdout: 'a.ts\n', stderr: '' }
        const noHunkDiff = { exitCode: 0, stdout: '', stderr: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockRunGit.mockReturnValueOnce(toplevel as any).mockReturnValueOnce(nameOnly as any).mockReturnValueOnce(noHunkDiff as any)
        mockQuerySymbols.mockReturnValue([])
        const { stdout } = capture(() => { expect(runChanged({ json: true, symbolMode: true })).toBe(0) })
        expect(() => parse(stdout)).not.toThrow()
        expect(parse(stdout).items).toEqual([])
      })

      // Text mode is the control: the human notices must survive the migration verbatim, so this
      // fix cannot be "made green" by deleting the prose branch outright.
      it('keeps the human notices in text mode', () => {
        gitOk('')
        expect(capture(() => { runChanged({}) }).stdout).toContain('No files changed')
        gitOk('src/a.ts\nsrc/b.ts\n')
        const filtered = capture(() => { runChanged({ ref: 'HEAD~1', grep: '^nomatch/' }) })
        expect(filtered.stdout + filtered.stderr).toContain('were filtered out by --grep')
      })
    })

    // --exclude-tests: the last member of the refs/callers/dead/call-chain/impact/semantic/symbol
    // family that lacked it. Filters the changed-FILE path, so it applies in --symbol mode too,
    // exactly as --grep already documents for itself.
    describe('--exclude-tests', () => {
      it('drops changed test files and keeps the rest', () => {
        gitOk('src/a.ts\ntests/a.test.ts\nsrc/b.spec.ts\n')
        const { stdout } = capture(() => { expect(runChanged({ ref: 'HEAD~1', excludeTests: true })).toBe(0) })
        expect(stdout).toContain('src/a.ts')
        expect(stdout).not.toContain('tests/a.test.ts')
        expect(stdout).not.toContain('src/b.spec.ts')
      })

      it('is byte-identical to the unfiltered output when omitted', () => {
        gitOk('src/a.ts\ntests/a.test.ts\n')
        const off = capture(() => { runChanged({ ref: 'HEAD~1' }) }).stdout
        gitOk('src/a.ts\ntests/a.test.ts\n')
        const explicitlyOff = capture(() => { runChanged({ ref: 'HEAD~1', excludeTests: false }) }).stdout
        expect(explicitlyOff).toBe(off)
        expect(off).toContain('tests/a.test.ts')
      })

      it('composes with --grep -- a file must satisfy both', () => {
        gitOk('src/a.ts\nsrc/a.test.ts\ntests/b.ts\nvendor/c.ts\n')
        const { stdout } = capture(() => { runChanged({ ref: 'HEAD~1', excludeTests: true, grep: '^src/' }) })
        expect(stdout).toContain('src/a.ts')
        expect(stdout).not.toContain('src/a.test.ts')
        expect(stdout).not.toContain('tests/b.ts')
        expect(stdout).not.toContain('vendor/c.ts')
      })

      it('names the hidden count and exits 0 when it filters everything out, rather than reading as "nothing changed"', () => {
        gitOk('tests/a.test.ts\ntests/b.test.ts\n')
        const result = capture(() => { expect(runChanged({ ref: 'HEAD~1', excludeTests: true })).toBe(0) })
        const all = result.stdout + result.stderr
        expect(all).toContain('2 in test files hidden by --exclude-tests')
        expect(all).not.toContain('No files changed')
      })

      // Singular branch pinned separately: a fixture landing on count===1 is otherwise never
      // asserted, which is exactly how "1 in test files" shipped across the rest of the family.
      it('uses singular wording when exactly one test file was hidden', () => {
        gitOk('tests/only.test.ts\n')
        const result = capture(() => { expect(runChanged({ ref: 'HEAD~1', excludeTests: true })).toBe(0) })
        const all = result.stdout + result.stderr
        expect(all).toContain('1 in test file hidden by --exclude-tests')
        expect(all).not.toContain('1 in test files')
      })

      // Found in review. --grep runs first, so when it leaves only test files and
      // --exclude-tests then empties the list, the unqualified "No non-test files changed" is
      // true of the --grep slice but false of the diff: src/app.ts changed and is not a test.
      it('names --grep too when it is what hid the non-test files, instead of claiming none changed', () => {
        gitOk('src/app.ts\ntests/app.test.ts\n')
        const result = capture(() => {
          expect(runChanged({ ref: 'HEAD~1', grep: '^tests/', excludeTests: true })).toBe(0)
        })
        const all = result.stdout + result.stderr
        expect(all).toContain('1 in test file hidden by --exclude-tests')
        expect(all).toContain('did not match the filter')
        // The precise claim that was false: src/app.ts is a changed non-test file.
        expect(all).not.toContain('No non-test files changed')
      })

      it('keeps the unqualified wording when --grep is absent, so the message is not padded with an irrelevant filter', () => {
        gitOk('tests/a.test.ts\n')
        const result = capture(() => { runChanged({ ref: 'HEAD~1', excludeTests: true }) })
        const all = result.stdout + result.stderr
        expect(all).toContain('No non-test files changed')
        expect(all).not.toContain('did not match the filter')
      })

      // --grep active but discarding nothing: every changed file matched, so there is no
      // second filter to blame and the unqualified wording is the accurate one.
      it('keeps the unqualified wording when --grep matched everything it saw', () => {
        gitOk('tests/a.test.ts\ntests/b.test.ts\n')
        const result = capture(() => { runChanged({ ref: 'HEAD~1', grep: '^tests/', excludeTests: true }) })
        const all = result.stdout + result.stderr
        expect(all).toContain('No non-test files changed')
        expect(all).not.toContain('did not match the filter')
      })

      it('emits an empty envelope under --json when it filters everything out', () => {
        gitOk('tests/a.test.ts\n')
        const { stdout } = capture(() => { expect(runChanged({ ref: 'HEAD~1', excludeTests: true, json: true })).toBe(0) })
        expect(() => JSON.parse(stdout)).not.toThrow()
        expect(JSON.parse(stdout)).toEqual({ items: [], truncated: false, totalCount: 0 })
      })

      // Found in review: --symbol capped each file's symbol query at a bare 1000. A changed
      // symbol past that cutoff read as absent -- "No symbols changed." in text, and an empty
      // envelope with `truncated: false` under --json, which asserts nothing was cut. Asserted on
      // the query argument rather than via a 1000-symbol fixture, which would be slow to build
      // and would pin the old cap's exact value rather than the intent.
      it('does not silently cap each file\'s symbol query, which would hide a changed symbol past the cutoff', () => {
        const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
        const nameOnly = { exitCode: 0, stdout: 'a.ts\n', stderr: '' }
        const noHunkDiff = { exitCode: 0, stdout: '', stderr: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockRunGit.mockReturnValueOnce(toplevel as any).mockReturnValueOnce(nameOnly as any).mockReturnValueOnce(noHunkDiff as any)
        mockQuerySymbols.mockReturnValue([])
        capture(() => { runChanged({ symbolMode: true }) })
        const limits = mockQuerySymbols.mock.calls.map((c) => (c[0] as { limit?: number }).limit ?? 0)
        expect(limits.length).toBeGreaterThan(0)
        for (const limit of limits) expect(limit).toBeGreaterThanOrEqual(20_000)
      })

      it('applies in --symbol mode, where it filters the file path', () => {
        const toplevel = { exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' }
        const nameOnly = { exitCode: 0, stdout: 'a.ts\ntests/a.test.ts\n', stderr: '' }
        const noHunkDiff = { exitCode: 0, stdout: '', stderr: '' }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockRunGit.mockReturnValueOnce(toplevel as any).mockReturnValueOnce(nameOnly as any).mockReturnValueOnce(noHunkDiff as any)
        mockQuerySymbols.mockReturnValue([])
        capture(() => { runChanged({ symbolMode: true, excludeTests: true }) })
        // The test file must never reach the index query at all -- filtering the rendered output
        // instead would still pay the lookup and still leak via any file-level side effect.
        for (const call of mockQuerySymbols.mock.calls) {
          expect((call[0] as { filePath?: string }).filePath ?? '').not.toContain('a.test.ts')
        }
      })
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

    // Second call site for the cross-file lead: resolveSymbolSpecOrEmitError, shared by
    // runDiff/runLog. Same shape as runRead's own cross-file test above.
    it('leads with the cross-file spec (runDiff, second call site) when the symbol exists in a different indexed file', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'walkProject' && opts?.filePath === undefined) {
          return [{ name: 'walkProject', kind: 'function', filePath: 'src/baseline.ts', lineStart: 10, lineEnd: 20, body: '', docstring: '', parent: '' }]
        }
        if (opts?.name === 'walkProject' && opts?.filePath !== undefined) {
          return []
        }
        if (opts?.filePath !== undefined) {
          // Similar to the query so it survives the similarity ranking -- see the comment on
          // runRead's equivalent test above.
          return [{ name: 'walkProjectSync', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'src/util.ts::walkProject' })).toBe(1)
      })
      expect(stderr).toContain("Symbol 'walkProject' not found in 'src/util.ts'")
      expect(stderr).toContain("'walkProject' is defined in src/baseline.ts")
      expect(stderr).toContain('token-goat diff "src/baseline.ts::walkProject"')
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('walkProjectSync')
      expect(mockRunGit).not.toHaveBeenCalled()
    })

    it('a symbol name that exists nowhere (runDiff) still gets the plain not-found message plus the unchanged same-file list only', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'totallyMissingEverywhere') return []
        if (opts?.filePath !== undefined) {
          // Similar to the query so it survives the similarity ranking.
          return [{ name: 'totallyMissingEverywhereToo', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'src/util.ts::totallyMissingEverywhere' })).toBe(1)
      })
      expect(stderr).toContain("Symbol 'totallyMissingEverywhere' not found in 'src/util.ts'")
      expect(stderr).not.toContain('is defined in')
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('totallyMissingEverywhereToo')
    })

    // Same shared resolveSymbolSpecOrEmitError code path as runRead's equivalent tests above
    // -- covers the second (:3423-area) call site named in the task.
    it('points at outline when a symbol miss (runDiff) has no similar same-file candidates', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'zzz_totally_unrelated') return []
        if (opts?.filePath !== undefined) {
          return [{ name: 'sleepSync', kind: 'function', filePath: 'src/util.ts', lineStart: 1, lineEnd: 2, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'src/util.ts::zzz_totally_unrelated' })).toBe(1)
      })
      expect(stderr).not.toContain('Did you mean:')
      expect(stderr).toContain('token-goat outline src/util.ts')
    })

    // Defect-B regression for the shared resolveSymbolSpecOrEmitError path: the DB-layer cap
    // used to be applied before ranking, so the true near-match could be outside the arbitrary
    // storage-order first-N and never considered.
    it('finds the true near-match even when it is not among the first DIDYOUMEAN_LIMIT symbols in storage order (runDiff, defect-B regression)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockImplementation((opts?: any) => {
        if (opts?.name === 'parseConf') return []
        if (opts?.filePath !== undefined) {
          const unrelated = Array.from({ length: 12 }, (_, i) => ({
            name: `alpha${i + 1}`, kind: 'function', filePath: 'src/util.ts', lineStart: i + 1, lineEnd: i + 1, body: '', docstring: '', parent: '',
          }))
          return [...unrelated, { name: 'parseConfig', kind: 'function', filePath: 'src/util.ts', lineStart: 100, lineEnd: 105, body: '', docstring: '', parent: '' }]
        }
        return []
      })
      const { stderr } = capture(() => {
        expect(runDiff({ spec: 'src/util.ts::parseConf' })).toBe(1)
      })
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('parseConfig')
      expect(stderr).not.toContain('alpha')
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

  // The `::`-prefixed file only disambiguates which same-named symbol is meant (fed to applyTypedRefsTier's querySymbols call); it must never scope queryRefs itself, or references living in other files would be silently dropped -- the exact reported bug.
  it('queries every comma-separated symbol codebase-wide, never scoping queryRefs to the `::`-prefixed file', () => {
    mockQueryRefs.mockReturnValue([])
    capture(() => runRefs({ spec: 'src/auth.ts::login,refresh' }))
    const names = mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['login', 'refresh'])
    for (const call of mockQueryRefs.mock.calls) {
      expect((call[0] as { filePath?: string }).filePath).toBeUndefined()
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

// Cross-file multi-spec: `src/a.ts::x,src/b.ts::y`. Regression coverage for the reported bug --
// parseMultiRefsSpec's findSpecSeparator is a lastIndexOf('::'), so a spec crossing a file
// boundary used to fold into one bogus file/symbol-list pair (file=`src/read_commands.ts::runSection,src/install.ts`,
// symbol=`installHooks`) and silently report a genuinely-referenced symbol as unreferenced.
describe('runRefs — cross-file multi-spec (a.ts::x,b.ts::y)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('merges references for two symbols defined in two different files, querying each codebase-wide (not scoped to its defining file)', () => {
    mockQueryRefs.mockImplementation((opts: { name: string; filePath?: string }) => {
      if (opts.name === 'runSection') return [ref('src/cli.ts', 5, 'runSection(x)')]
      if (opts.name === 'installHooks') return [ref('src/cli.ts', 491, 'installHooks()')]
      return []
    })
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('runSection:')
    expect(stdout).toContain('src/cli.ts:5: runSection(x)')
    expect(stdout).toContain('installHooks:')
    expect(stdout).toContain('src/cli.ts:491: installHooks()')
    const calls = mockQueryRefs.mock.calls as [{ name: string; filePath?: string }][]
    const runSectionCall = calls.find((c) => c[0].name === 'runSection')?.[0]
    const installHooksCall = calls.find((c) => c[0].name === 'installHooks')?.[0]
    expect(runSectionCall?.filePath).toBeUndefined()
    expect(installHooksCall?.filePath).toBeUndefined()
  })

  it('regression: the exact reported spec no longer reports a false "no references found" for a referenced symbol', () => {
    // Before the fix, lastIndexOf('::') folded this whole spec into file=`src/read_commands.ts::runSection,src/install.ts`
    // symbol=`installHooks`, that bogus file never matched anything, and installHooks -- which
    // genuinely has references -- was reported as unreferenced.
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'installHooks') return [ref('src/cli.ts', 491, 'installHooks()'), ref('tests/install.test.ts', 12, 'installHooks()')]
      return []
    })
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks' })
      expect(code).toBe(0)
    })
    expect(stdout).not.toContain('No references found')
    expect(stdout).not.toContain('installHooks: (no references found)')
    expect(stdout).toContain('installHooks:')
    expect(stdout).toContain('src/cli.ts:491: installHooks()')
  })

  // The two pairs below query the same symbol name ('run') with no filePath scoping (the fix), so
  // mockQueryRefs can no longer differentiate them by opts.filePath -- differentiate by call order
  // instead, pinning WHICH queries ran (via keyFor's block keys) rather than a query-argument property.
  it('keeps blocks distinct when the same symbol name is defined in two different files, keying each by its full file::symbol pair', () => {
    mockQueryRefs.mockImplementationOnce(() => [ref('src/caller1.ts', 1, 'a.run()')]).mockImplementationOnce(() => [ref('src/caller2.ts', 2, 'b.run()')])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/a.ts::run,src/b.ts::run' })
      expect(code).toBe(0)
    })
    expect(mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string; filePath?: string }))).toEqual([{ name: 'run' }, { name: 'run' }])
    // Same-name collision would otherwise silently overwrite one block with the other.
    expect(stdout).toContain('src/a.ts::run:')
    expect(stdout).toContain('src/b.ts::run:')
    expect(stdout).toContain('src/caller1.ts:1: a.run()')
    expect(stdout).toContain('src/caller2.ts:2: b.run()')
    expect(stdout).not.toMatch(/^run:/m)
  })

  it('a bare segment after file::symbol inherits the previous file across a real file boundary, threading it into disambiguation (a.ts::x,b.ts::y,z resolves z against b.ts)', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'x') return [ref('src/callerX.ts', 1, 'x()')]
      if (opts.name === 'y') return [ref('src/callerY.ts', 2, 'y()')]
      if (opts.name === 'z') return [ref('src/callerZ.ts', 3, 'z()')]
      return []
    })
    // querySymbols is what now receives the defining-file hint (via applyTypedRefsTier's disambiguation call) -- queryRefs itself is never scoped. An empty return keeps the typed tier a pass-through so the raw queryRefs results above surface unchanged.
    mockQuerySymbols.mockReturnValue([])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/a.ts::x,src/b.ts::y,z' })
      expect(code).toBe(0)
    })
    expect(mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string; filePath?: string }))).toEqual([{ name: 'x' }, { name: 'y' }, { name: 'z' }])
    const symbolCalls = mockQuerySymbols.mock.calls as [{ name: string; filePath?: string }][]
    const zSymbolCall = symbolCalls.find((c) => c[0].name === 'z')?.[0]
    // The load-bearing assertion: `z` (a bare segment) must resolve against src/b.ts (the file
    // to its left), not src/a.ts -- proving the spec actually crossed a file boundary. A spec
    // like `a.ts::x,y` has only one `::` segment and never reaches this cross-file path at all.
    expect(zSymbolCall?.filePath).toBe('src/b.ts')
    expect(stdout).toContain('src/callerZ.ts:3: z()')
  })

  it('reports a bare "(no references found)" for a pair with no hits alongside a found pair, without failing the whole call', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => (opts.name === 'runSection' ? [ref('src/cli.ts', 5, 'runSection(x)')] : []))
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::nope' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('runSection:')
    expect(stdout).toContain('nope: (no references found)')
  })

  it('returns exit 1 when NO pair in a cross-file spec has any references (total failure, matching the same-file multi-spec contract)', () => {
    mockQueryRefs.mockReturnValue([])
    const code = runRefs({ spec: 'src/read_commands.ts::nope1,src/install.ts::nope2' })
    expect(code).toBe(1)
  })

  it('emits a per-pair map under --json, keyed by full file::symbol when more than one file is involved', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => (opts.name === 'runSection' ? [ref('src/cli.ts', 5, 'runSection(x)')] : []))
    mockCountRefs.mockImplementation((opts: { name: string }) => (opts.name === 'runSection' ? 1 : 0))
    const { stdout } = capture(() => runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks', json: true }))
    const parsed = JSON.parse(stdout) as Record<string, { items: unknown[]; truncated: boolean; totalCount: number }>
    expect(Object.keys(parsed)).toEqual(['src/read_commands.ts::runSection', 'src/install.ts::installHooks'])
    expect(parsed['src/read_commands.ts::runSection']?.items).toHaveLength(1)
    expect(parsed['src/install.ts::installHooks']?.items).toHaveLength(0)
  })

  it('respects --callers on the cross-file path by never scoping the query to either pair\'s defining file', () => {
    mockQueryRefs.mockReturnValue([ref('src/caller.ts', 1, 'call()')])
    capture(() => runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks', callers: true }))
    // Pin WHICH queries ran, not just a property of whatever ran: the pre-fix mis-parse issued a single query and would satisfy a bare per-call property assertion vacuously.
    expect(mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['runSection', 'installHooks'])
    for (const call of mockQueryRefs.mock.calls) {
      expect((call[0] as { filePath?: string }).filePath).toBeUndefined()
    }
  })

  it('respects --limit on the cross-file path, passed through to every pair\'s query', () => {
    mockQueryRefs.mockReturnValue([ref('src/caller.ts', 1, 'call()')])
    capture(() => runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks', limit: 3 }))
    // Same reason as the --callers test above: assert both pairs were queried, so the pre-fix single-query mis-parse cannot pass this vacuously.
    expect(mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)).toEqual(['runSection', 'installHooks'])
    for (const call of mockQueryRefs.mock.calls) {
      expect((call[0] as { limit?: number }).limit).toBe(3)
    }
  })

  it('does not affect a same-file multi-spec (only one distinct file involved) -- output stays keyed by bare symbol', () => {
    mockQueryRefs.mockReturnValue([])
    capture(() => runRefs({ spec: 'src/auth.ts::login,refresh' }))
    // Only one `::` segment in this spec (`src/auth.ts::login`), so parseCrossFileMultiSpec declines and this still runs the pre-existing same-file path -- unchanged from before.
    const names = mockQueryRefs.mock.calls.map((c) => (c[0] as { name: string }).name)
    expect(names).toEqual(['login', 'refresh'])
  })
})

describe('runRefs --exclude-tests (single-symbol path, additive opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // vi.clearAllMocks() clears calls but not a prior test's mockReturnValue implementation --
    // an earlier describe block in this file leaves mockLoadConfig pinned to a small
    // overflow_guard.max_tokens, which would otherwise truncate this block's small fixtures.
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: false } } as unknown as ReturnType<typeof loadConfig>)
  })

  it('hides refs whose call site is a test file, leaving default (flag-absent) output byte-identical', () => {
    const rows = [
      ref('src/auth.ts', 10, 'login()'),
      ref('tests/auth.test.ts', 5, 'login()'),
      ref('tests/auth2.test.ts', 9, 'login()'),
    ]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)

    const withoutFlag = capture(() => {
      const code = runRefs({ spec: 'login' })
      expect(code).toBe(0)
    }).stdout
    // Pinned expectation: unflagged output is exactly today's 3-line dump, both test paths present.
    expect(withoutFlag.trim().split('\n')).toEqual(['src/auth.ts:10: login()', 'tests/auth.test.ts:5: login()', 'tests/auth2.test.ts:9: login()'])

    const withFlag = capture(() => {
      const code = runRefs({ spec: 'login', excludeTests: true })
      expect(code).toBe(0)
    }).stdout
    expect(withFlag).toContain('src/auth.ts:10: login()')
    expect(withFlag).not.toContain('tests/auth.test.ts')
    expect(withFlag).not.toContain('tests/auth2.test.ts')
    expect(withFlag).toContain('1 reference (2 in test files hidden by --exclude-tests)')
    expect(withFlag).not.toEqual(withoutFlag)
  })

  it('--json keeps the items/truncated/totalCount shape, with an exact 1-of-3 filtered totalCount', () => {
    const rows = [
      ref('src/auth.ts', 10, 'login()'),
      ref('tests/auth.test.ts', 5, 'login()'),
      ref('tests/auth2.test.ts', 9, 'login()'),
    ]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)

    const withoutFlag = JSON.parse(capture(() => runRefs({ spec: 'login', json: true })).stdout) as { items: unknown[]; totalCount: number }
    expect(withoutFlag.items).toHaveLength(3)
    expect(withoutFlag.totalCount).toBe(3)

    const withFlag = JSON.parse(capture(() => runRefs({ spec: 'login', json: true, excludeTests: true })).stdout) as { items: unknown[]; totalCount: number; truncated: boolean }
    expect(withFlag.items).toHaveLength(1)
    expect(withFlag.totalCount).toBe(1)
    expect(withFlag.truncated).toBe(false)
  })
})

describe('runRefs --grep (single-symbol path, filters on call-site file path)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: false } } as unknown as ReturnType<typeof loadConfig>)
  })

  it('keeps only refs whose call-site file path matches the pattern', () => {
    const rows = [
      ref('src/auth.ts', 10, 'login()'),
      ref('tests/auth.test.ts', 5, 'login()'),
      ref('vendor/legacy.ts', 9, 'login()'),
    ]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)

    const withFlag = capture(() => {
      const code = runRefs({ spec: 'login', grep: '^src/' })
      expect(code).toBe(0)
    }).stdout
    expect(withFlag).toContain('src/auth.ts:10: login()')
    expect(withFlag).not.toContain('tests/auth.test.ts')
    expect(withFlag).not.toContain('vendor/legacy.ts')
  })

  // Negative control: flag-absent output is byte-identical to today, proving the --grep test above is not vacuous.
  it('leaves output unchanged when --grep is omitted', () => {
    const rows = [ref('src/auth.ts', 10, 'login()'), ref('tests/auth.test.ts', 5, 'login()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const text = capture(() => runRefs({ spec: 'login' })).stdout
    expect(text.trim().split('\n')).toEqual(['src/auth.ts:10: login()', 'tests/auth.test.ts:5: login()'])
  })

  it('says the match was filtered out, not "no references found", when --grep matches none of the refs that do exist (plural, count > 1)', () => {
    const rows = [ref('src/a.ts', 1, 'f()'), ref('src/b.ts', 2, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const result = capture(() => {
      const code = runRefs({ spec: 'f', grep: '^nomatch/' })
      expect(code).toBe(0)
    })
    const all = result.stdout + result.stderr
    expect(all).toContain('all 2 references were filtered out by --grep')
    expect(all).not.toContain('no references found')
  })

  // The same branch under --json handed the caller exit 0 plus an unparseable prose body, the
  // defect already fixed for callers/dead/deps/types. Text mode above is the control.
  it('emits an empty envelope under --json when --grep filters every reference out', () => {
    const rows = [ref('src/a.ts', 1, 'f()'), ref('src/b.ts', 2, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const { stdout } = capture(() => {
      expect(runRefs({ spec: 'f', grep: '^nomatch/', json: true })).toBe(0)
    })
    expect(() => JSON.parse(stdout)).not.toThrow()
    // totalCount is the post-filter count, never the pre-filter 2.
    expect(JSON.parse(stdout)).toEqual({ items: [], truncated: false, totalCount: 0 })
  })

  // Singular count branch: a bug shipped once where every fixture happened to filter 2+ items, leaving the count === 1 branch unasserted -- this pins both the verb ("was") and the noun ("reference", not "references").
  it('uses singular wording when exactly one reference existed and --grep filtered it out', () => {
    const rows = [ref('src/only.ts', 1, 'g()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const result = capture(() => {
      const code = runRefs({ spec: 'g', grep: '^nomatch/' })
      expect(code).toBe(0)
    })
    const all = result.stdout + result.stderr
    expect(all).toContain('all 1 reference was filtered out by --grep')
    expect(all).not.toContain('1 references')
  })

  // The index stores ABSOLUTE call-site paths while runRefsSingle RENDERS them root-relative, so a row the caller sees as `src/a.ts` was stored as `C:/.../src/a.ts`. Filtering the stored field made an anchored pattern test a string the caller can never see: `--grep "^src/"` matched nothing against a listing where every visible row began with `src/`. Every sibling fixture here builds rows from RELATIVE paths, which models the wrong data and is exactly why this passed in unit tests while failing against the real binary -- so this fixture is deliberately absolute.
  it('matches --grep against the path as rendered, not the absolute stored path', () => {
    // Give resolveProjectRoot a real toplevel: mockRunGit is otherwise unset here, and getDisplayRoot() has to resolve to a genuine root for the rendered path to be root-relative at all.
    vi.mocked(runGit).mockReturnValue({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' } as never)
    const root = process.cwd().replace(/\\/g, '/')
    const rows = [ref(`${root}/src/a.ts`, 1, 'f()'), ref(`${root}/tests/a.test.ts`, 2, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const result = capture(() => {
      const code = runRefs({ spec: 'f', grep: '^src/' })
      expect(code).toBe(0)
    })
    const all = result.stdout + result.stderr
    expect(all).toContain('src/a.ts')
    expect(all).not.toContain('filtered out by --grep')
  })

  // Negative control: an anchor that genuinely matches nothing still empties the listing, so the assertion above is about the path being rendered before the test and not about --grep having quietly stopped filtering. Passes both before and after the fix.
  it('still filters everything out for an anchor that matches no rendered path', () => {
    // Give resolveProjectRoot a real toplevel: mockRunGit is otherwise unset here, and getDisplayRoot() has to resolve to a genuine root for the rendered path to be root-relative at all.
    vi.mocked(runGit).mockReturnValue({ exitCode: 0, stdout: `${process.cwd()}\n`, stderr: '' } as never)
    const root = process.cwd().replace(/\\/g, '/')
    const rows = [ref(`${root}/src/a.ts`, 1, 'f()'), ref(`${root}/tests/a.test.ts`, 2, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const result = capture(() => {
      const code = runRefs({ spec: 'f', grep: '^nosuchdir/' })
      expect(code).toBe(0)
    })
    const all = result.stdout + result.stderr
    expect(all).toContain('all 2 references were filtered out by --grep')
  })

  it('--json keeps totalCount honest at the post-grep count, not the unfiltered total', () => {
    const rows = [ref('src/a.ts', 1, 'f()'), ref('tests/a.test.ts', 2, 'f()'), ref('src/b.ts', 3, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const withFlag = JSON.parse(capture(() => runRefs({ spec: 'f', json: true, grep: '^src/' })).stdout) as { items: unknown[]; totalCount: number }
    expect(withFlag.items).toHaveLength(2)
    expect(withFlag.totalCount).toBe(2)
  })

  it('falls back to a literal substring match for an invalid regex, never throwing', () => {
    const rows = [ref('src/[unclosed]weird.ts', 1, 'f()'), ref('src/other.ts', 2, 'f()')]
    mockQueryRefs.mockReturnValue(rows)
    mockCountRefs.mockReturnValue(rows.length)
    const text = capture(() => {
      const code = runRefs({ spec: 'f', grep: '[unclosed' })
      expect(code).toBe(0)
    }).stdout
    expect(text).toContain('src/[unclosed]weird.ts')
    expect(text).not.toContain('src/other.ts')
  })
})

describe('runRefs --exclude-tests (cross-file multi-spec path, additive opt-in)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: false } } as unknown as ReturnType<typeof loadConfig>)
  })

  it('filters test-file refs on the distinct runRefsCrossFile path too (not just runRefsSingle), with exact per-symbol counts', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'runSection') {
        return [ref('src/cli.ts', 5, 'runSection(x)'), ref('tests/cli.test.ts', 1, 'runSection(x)')]
      }
      if (opts.name === 'installHooks') {
        return [ref('src/cli.ts', 491, 'installHooks()'), ref('tests/install.test.ts', 12, 'installHooks()'), ref('tests/install2.test.ts', 2, 'installHooks()')]
      }
      return []
    })
    const withoutFlag = capture(() => {
      const code = runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks' })
      expect(code).toBe(0)
    }).stdout
    expect(withoutFlag).toContain('tests/cli.test.ts:1: runSection(x)')
    expect(withoutFlag).toContain('tests/install.test.ts:12: installHooks()')
    expect(withoutFlag).toContain('tests/install2.test.ts:2: installHooks()')

    const withFlag = capture(() => {
      const code = runRefs({ spec: 'src/read_commands.ts::runSection,src/install.ts::installHooks', excludeTests: true })
      expect(code).toBe(0)
    }).stdout
    expect(withFlag).toContain('src/cli.ts:5: runSection(x)')
    expect(withFlag).toContain('src/cli.ts:491: installHooks()')
    expect(withFlag).not.toContain('tests/cli.test.ts')
    expect(withFlag).not.toContain('tests/install.test.ts')
    expect(withFlag).not.toContain('tests/install2.test.ts')
    expect(withFlag).toContain('1 in test file hidden by --exclude-tests')
    expect(withFlag).toContain('2 in test files hidden by --exclude-tests')
    expect(withFlag).not.toEqual(withoutFlag)
  })

  // A symbol referenced ONLY from tests must not report as unreferenced. Both the single-spec and cross-file paths previously emitted a bare "no references found" once the filter emptied the set, which reads as "this symbol is dead" and invites deleting live code -- the same empty-store-renders-as-absence class already fixed for map/doctor/hint-stats here.
  it('says references were suppressed rather than "no references found" when every ref was a test ref', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => (opts.name === 'onlyTested' ? [ref('tests/a.test.ts', 3, 'onlyTested()'), ref('tests/b.test.ts', 9, 'onlyTested()')] : []))

    const withoutFlag = capture(() => runRefs({ spec: 'onlyTested' }))
    expect(withoutFlag.stdout).toContain('tests/a.test.ts')

    const withFlag = capture(() => {
      const code = runRefs({ spec: 'onlyTested', excludeTests: true })
      expect(code).toBe(1)
    })
    const all = withFlag.stdout + withFlag.stderr
    expect(all).toContain('No non-test references found')
    expect(all).toContain('2 in test files hidden by --exclude-tests')
  })

  it('says the same on the cross-file path when one spec is left with nothing', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'realUse') return [ref('src/cli.ts', 5, 'realUse()')]
      if (opts.name === 'testOnly') return [ref('tests/x.test.ts', 2, 'testOnly()')]
      return []
    })
    const withFlag = capture(() => {
      const code = runRefs({ spec: 'src/a.ts::realUse,src/b.ts::testOnly', excludeTests: true })
      expect(code).toBe(0)
    }).stdout
    expect(withFlag).toContain('no non-test references found')
    expect(withFlag).toContain('1 in test file hidden by --exclude-tests')
    expect(withFlag).not.toContain('(no references found)')
  })

  it('--grep filters by call-site file path on the cross-file path too, with the filtered-to-empty notice per symbol', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) => {
      if (opts.name === 'realUse') return [ref('src/cli.ts', 5, 'realUse()'), ref('vendor/x.ts', 1, 'realUse()')]
      if (opts.name === 'testOnly') return [ref('vendor/y.ts', 2, 'testOnly()')]
      return []
    })
    const withFlag = capture(() => {
      const code = runRefs({ spec: 'src/a.ts::realUse,src/b.ts::testOnly', grep: '^src/' })
      expect(code).toBe(0)
    }).stdout
    expect(withFlag).toContain('src/cli.ts:5: realUse()')
    expect(withFlag).not.toContain('vendor/x.ts')
    expect(withFlag).toContain('all 1 reference was filtered out by --grep')
  })
})

// getDisplayRoot()/toDisplayPath() wiring: runRefsSingle never resolved its own project root
// before this fix, so plain (non --top/--callers) `refs` output always printed the raw absolute
// filePath. process.cwd() in this test process is this repo's own root (no chdir happens
// elsewhere in this file), so findProject(cwd) resolves to this repo.
describe('runRefs — project-relative display paths (toDisplayPath/getDisplayRoot wiring)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const inProjectAbs = path.join(process.cwd(), 'src', 'refs-display-fixture.ts')
  const outOfProjectAbs = path.join(os.tmpdir(), 'tg-outside-project-refs-fixture', 'far.ts')

  it('shortens an in-project ref path to project-relative in human output', () => {
    mockQueryRefs.mockReturnValue([ref(inProjectAbs, 10, 'inProjSym()')])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'inProjSym' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('src/refs-display-fixture.ts:10: inProjSym()')
    expect(stdout).not.toContain(inProjectAbs)
  })

  it('leaves an out-of-project ref path absolute in human output, even alongside an in-project row', () => {
    mockQueryRefs.mockReturnValue([
      ref(inProjectAbs, 10, 'mixedSym()'),
      ref(outOfProjectAbs, 20, 'mixedSym()'),
    ])
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'mixedSym' })
      expect(code).toBe(0)
    })
    expect(stdout).toContain('src/refs-display-fixture.ts:10: mixedSym()')
    expect(stdout).toContain(`${outOfProjectAbs}:20: mixedSym()`)
  })

  // Oracle replaced: this used to assert --json "stays absolute", pinning the very inconsistency being fixed. outline/skeleton --json already render rows through toDisplayPath because root-relative is reproducible while absolute is specific to one machine and one drive-letter casing; refs was the outlier. The invariant that was worth keeping -- an out-of-project path must NOT be mangled into something relative -- is kept below as the negative control.
  it('--json renders an in-project path root-relative, matching the text rows and the outline/skeleton --json convention', () => {
    mockQueryRefs.mockReturnValue([ref(inProjectAbs, 10, 'jsonSym()')])
    mockCountRefs.mockReturnValue(1)
    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'jsonSym', json: true })
      expect(code).toBe(0)
    })
    const parsed = JSON.parse(stdout) as { items: Array<{ filePath: string }> }
    expect(parsed.items[0]?.filePath).toBe('src/refs-display-fixture.ts')
  })

  it('--json leaves an out-of-project path absolute (negative control: root-relativising is not applied blindly)', () => {
    mockQueryRefs.mockReturnValue([ref(outOfProjectAbs, 20, 'farSym()')])
    mockCountRefs.mockReturnValue(1)
    const { stdout } = capture(() => runRefs({ spec: 'farSym', json: true }))
    const parsed = JSON.parse(stdout) as { items: Array<{ filePath: string }> }
    expect(parsed.items[0]?.filePath).toBe(outOfProjectAbs)
  })

  it('produces identical output whether process.cwd() is the project root or a subdirectory of it (cwd-independence)', () => {
    mockQueryRefs.mockReturnValue([ref(inProjectAbs, 10, 'cwdIndepSym()')])
    const before = process.cwd()
    try {
      process.chdir(before)
      const atRoot = capture(() => runRefs({ spec: 'cwdIndepSym' })).stdout
      process.chdir(path.join(before, 'src'))
      const atSubdir = capture(() => runRefs({ spec: 'cwdIndepSym' })).stdout
      expect(atSubdir).toBe(atRoot)
      expect(atRoot).toContain('src/refs-display-fixture.ts:10: cwdIndepSym()')
    } finally {
      process.chdir(before)
    }
  })
})

// A given path must render with ONE spelling no matter how many symbols the caller asked for. Before this, runRefsSingle passed a real display root while runRefs (multi-symbol) and runRefsCrossFile passed undefined, so `refs a` printed `src/x.ts:10` and `refs "a,b"` printed the absolute path for the identical row. Every case below pairs an in-project positive (root-relative) with an out-of-project negative control (must stay absolute in BOTH arities), so a change that simply stripped prefixes everywhere would fail.
describe('runRefs — path spelling is independent of arity (single vs multi-symbol vs cross-file)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCountRefs.mockReturnValue(1)
  })

  const inAbs = path.join(process.cwd(), 'src', 'arity-fixture.ts')
  const inRel = 'src/arity-fixture.ts'
  const outAbs = path.join(os.tmpdir(), 'tg-arity-outside', 'far.ts')

  const specs: Array<[string, string]> = [
    ['single', 'aritySym'],
    ['multi-symbol', 'aritySym,otherSym'],
    ['cross-file', 'src/a.ts::aritySym,src/b.ts::otherSym'],
  ]

  for (const [label, spec] of specs) {
    it(`renders an in-project row root-relative in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'aritySym()')])
      const { stdout } = capture(() => runRefs({ spec }))
      expect(stdout).toContain(`${inRel}:10: aritySym()`)
      expect(stdout).not.toContain(inAbs)
    })

    it(`leaves an out-of-project row absolute in the ${label} form (negative control)`, () => {
      mockQueryRefs.mockReturnValue([ref(outAbs, 20, 'aritySym()')])
      const { stdout } = capture(() => runRefs({ spec }))
      expect(stdout).toContain(`${outAbs}:20: aritySym()`)
    })

    it(`renders --top file rows root-relative in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'x'), ref(inAbs, 11, 'x')])
      const { stdout } = capture(() => runRefs({ spec, top: 3 }))
      expect(stdout).toContain(`2  ${inRel}`)
      expect(stdout).not.toContain(inAbs)
    })

    it(`renders --callers group headers root-relative in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'callerFn')])
      const { stdout } = capture(() => runRefs({ spec, callers: true }))
      expect(stdout).toContain(`${inRel}:`)
      expect(stdout).not.toContain(inAbs)
    })

    it(`renders --context windows against the root-relative path in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(path.join(process.cwd(), 'package.json'), 2, 'ctxSym()')])
      const { stdout } = capture(() => runRefs({ spec, context: 1 }))
      expect(stdout).toContain('package.json:2: ctxSym()')
      expect(stdout).not.toContain(path.join(process.cwd(), 'package.json'))
    })

    it(`emits a root-relative filePath under --json in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'aritySym()')])
      const { stdout } = capture(() => runRefs({ spec, json: true }))
      const paths = collectJsonFilePaths(JSON.parse(stdout))
      expect(paths).toContain(inRel)
      expect(paths).not.toContain(inAbs)
    })

    it(`emits a root-relative --top fileCounts entry under --json in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'x')])
      const { stdout } = capture(() => runRefs({ spec, top: 2, json: true }))
      expect(collectJsonTopFiles(JSON.parse(stdout))).toContain(inRel)
    })

    it(`honours an anchored --grep against the rendered (root-relative) path in the ${label} form`, () => {
      mockQueryRefs.mockReturnValue([ref(inAbs, 10, 'aritySym()'), ref(outAbs, 20, 'aritySym()')])
      const { stdout } = capture(() => runRefs({ spec, grep: '^src/' }))
      expect(stdout).toContain(`${inRel}:10: aritySym()`)
      // Negative control: --grep really filters, it does not just pass everything through.
      expect(stdout).not.toContain(`${outAbs}:20:`)
    })
  }

  it('renders an absolute path -- never undefined, empty, or cwd-relative -- when no project root resolves', () => {
    const noRootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-refs-noroot-'))
    const target = path.join(noRootDir, 'nested', 'thing.ts')
    const before = process.cwd()
    try {
      process.chdir(noRootDir)
      mockQueryRefs.mockReturnValue([ref(target, 7, 'noRootSym()')])
      const { stdout } = capture(() => runRefs({ spec: 'noRootSym' }))
      const row = stdout.split('\n').find((l) => l.includes(':7:')) ?? ''
      expect(row).not.toContain('undefined')
      expect(row.trim()).not.toBe(':7: noRootSym()')
      // Either an absolute path (no root resolved) or a root-relative one (a root did resolve
      // above the temp dir) is acceptable; a bare cwd-relative `nested/thing.ts` is not, since it
      // would render the same query differently depending on where it was run from.
      expect(row).toContain('noRootSym()')
      expect(row.includes(target) || row.includes(toDisplayPath(process.cwd(), target))).toBe(true)
      expect(row).not.toContain(' nested/thing.ts')
    } finally {
      process.chdir(before)
      fs.rmSync(noRootDir, { recursive: true, force: true })
    }
  })
})

function collectJsonFilePaths(payload: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) visit(n)
      return
    }
    const rec = node as Record<string, unknown>
    if (typeof rec.filePath === 'string') out.push(rec.filePath)
    for (const v of Object.values(rec)) visit(v)
  }
  visit(payload)
  return out
}

function collectJsonTopFiles(payload: unknown): string[] {
  const out: string[] = []
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) visit(n)
      return
    }
    const rec = node as Record<string, unknown>
    if (typeof rec.file === 'string' && typeof rec.count === 'number') out.push(rec.file)
    for (const v of Object.values(rec)) visit(v)
  }
  visit(payload)
  return out
}

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

  it('breaks a count tie by ordinal filePath comparison without calling localeCompare (deterministic across locales/ICU builds)', () => {
    const spy = vi.spyOn(String.prototype, 'localeCompare')
    mockQueryRefs.mockReturnValue([ref('src/zzz.ts', 1, 'x'), ref('src/aaa.ts', 1, 'x')])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 2 }))
    const aaaIdx = stdout.indexOf('src/aaa.ts')
    const zzzIdx = stdout.indexOf('src/zzz.ts')
    expect(aaaIdx).toBeGreaterThanOrEqual(0)
    expect(zzzIdx).toBeGreaterThanOrEqual(0)
    expect(aaaIdx).toBeLessThan(zzzIdx)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
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
    expect(stdout).toContain('2 references across 1 file (showing top 1)')
    expect(stdout).toContain('refresh:')
    expect(stdout).toContain('1 reference across 1 file (showing top 1)')
  })

  it('takes precedence over --callers for text output when both are set', () => {
    mockQueryRefs.mockReturnValue([ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x')])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 5, callers: true }))
    expect(stdout).toContain('2 references across 1 file')
    // The caller-grouped per-line view (":line  context") is not also present.
    expect(stdout).not.toContain(':1  x')
  })

  // --grep must narrow the set --top groups from, not just the per-line dump -- otherwise --top would still rank files --grep was supposed to exclude.
  it('composes with --grep: the grouped-by-file summary reflects the POST-filter set, not the unfiltered one', () => {
    mockQueryRefs.mockReturnValue([
      ref('src/a.ts', 1, 'x'), ref('src/a.ts', 2, 'x'), ref('src/a.ts', 3, 'x'),
      ref('tests/b.test.ts', 1, 'x'), ref('tests/b.test.ts', 2, 'x'),
    ])
    const { stdout } = capture(() => runRefs({ spec: 'login', top: 5, grep: '^src/' }))
    expect(stdout).toContain('3 references across 1 file (showing top 1)')
    expect(stdout).not.toContain('tests/b.test.ts')
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

  // Regression: without --callers, a file::symbol spec used to scope queryRefs to that file too --
  // exactly the reported bug (`refs "src/install.ts::installHooks"` found zero references because
  // installHooks is defined in src/install.ts but called only from src/cli.ts and tests/install.test.ts).
  // The `::`-prefixed file must disambiguate which same-named symbol is meant, never restrict the search.
  it('without --callers, a file::symbol spec is still NOT scoped to that file (regression: same fix as --callers)', () => {
    mockQueryRefs.mockImplementation(
      fakeRefsTable([
        { filePath: 'src/a.ts', name: 'helperFn', line: 10, context: 'helperFn()' },
        { filePath: 'src/b.ts', name: 'helperFn', line: 20, context: 'helperFn()' },
      ]),
    )

    const { stdout } = capture(() => {
      const code = runRefs({ spec: 'src/a.ts::helperFn' })
      expect(code).toBe(0)
    })

    expect(mockQueryRefs).toHaveBeenCalledWith({ name: 'helperFn' })
    // src/b.ts is a DIFFERENT file from the one named in the spec -- this reference must still surface.
    expect(stdout).toContain('src/b.ts:20: helperFn()')
  })

  // The headline reported bug, reproduced with the exact spec from the report: installHooks is
  // DEFINED in src/install.ts but referenced only from src/cli.ts and tests/install.test.ts --
  // files other than the one in the spec. Before the fix this printed "No references found" and
  // exited 1, even though the symbol demonstrably has references.
  it('regression: "refs src/install.ts::installHooks" finds references that occur in OTHER files', () => {
    mockQueryRefs.mockImplementation(
      fakeRefsTable([
        { filePath: 'src/cli.ts', name: 'installHooks', line: 491, context: 'installHooks(root)' },
        { filePath: 'tests/install.test.ts', name: 'installHooks', line: 12, context: 'installHooks(dir)' },
      ]),
    )

    const { stdout, stderr } = capture(() => {
      const code = runRefs({ spec: 'src/install.ts::installHooks' })
      expect(code).toBe(0)
    })

    expect(stderr).toBe('')
    expect(stdout).not.toContain('No references found')
    expect(stdout).toContain('src/cli.ts:491: installHooks(root)')
    expect(stdout).toContain('tests/install.test.ts:12: installHooks(dir)')
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
      { name: 'run', kind: 'method', filePath: fileA, lineStart: 2, lineEnd: 4, body: '', docstring: '', parent: '' } satisfies SymbolEntry,
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
      { name: 'run', kind: 'method', filePath: 'src/a.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' } satisfies SymbolEntry,
      { name: 'run', kind: 'method', filePath: 'src/b.ts', lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' } satisfies SymbolEntry,
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
      { name: 'run', kind: 'function', filePath: 'src/legacy.py', lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' } satisfies SymbolEntry,
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
      { name: 'run', kind: 'function', filePath: path.join(dir, 'missing.ts'), lineStart: 1, lineEnd: 3, body: '', docstring: '', parent: '' } satisfies SymbolEntry,
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

  it('ranks the entry-miss suggestion list by similarity to the query instead of dumping every entry unfiltered', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zipread-test-'))
    const zipPath = path.join(dir, 'archive.zip')
    try {
      const zip = zipSync({
        'sub/config.json': strToU8('{}'),
        'sub/unrelated_asset.png': strToU8('x'),
      })
      fs.writeFileSync(zipPath, zip)

      // 'sub/config.json' genuinely contains the query as a substring.
      const { stderr } = capture(() => {
        const code = runZipRead({ file: zipPath, entry: 'sub/confi' })
        expect(code).toBe(1)
      })
      expect(stderr).toContain("Entry 'sub/confi' not found")
      expect(stderr).toContain('Did you mean:')
      expect(stderr).toContain('sub/config.json')
      expect(stderr).not.toContain('unrelated_asset')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  // Defect fix: an unrelated query used to print every entry in the archive regardless of
  // relevance. It now gets no list at all -- pointing at zip-list (the command that lists
  // every entry) instead of a dead end.
  it('points at zip-list instead of an unranked full dump when no entry resembles the query', async () => {
    const { zipSync, strToU8 } = await import('fflate')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-zipread-test-'))
    const zipPath = path.join(dir, 'archive.zip')
    try {
      const zip = zipSync({ 'sub/file.txt': strToU8('hello') })
      fs.writeFileSync(zipPath, zip)

      const { stderr } = capture(() => {
        const code = runZipRead({ file: zipPath, entry: 'zzz_totally_unrelated' })
        expect(code).toBe(1)
      })
      expect(stderr).toContain("Entry 'zzz_totally_unrelated' not found")
      expect(stderr).not.toContain('Did you mean:')
      expect(stderr).toContain(`token-goat zip-list ${zipPath}`)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---- runRefs unknown-symbol vs genuinely-zero-references (this task) --------

describe('runRefs unknown symbol vs zero-references distinction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({ overflow_guard: { enabled: false } } as unknown as ReturnType<typeof loadConfig>)
    // resolveProjectRoot (not mocked in this file) shells out via runGit; the empty-result
    // branch under test now always resolves rootDir (for the existence check), so this must be
    // stubbed here too, matching the outer 'read_commands' describe's own beforeEach.
    vi.mocked(runGit).mockReturnValue({ exitCode: 1, stdout: '', stderr: 'not a git repo' })
  })

  it('reports "Symbol not found" plus a Did you mean suggestion for a typo of a real, indexed symbol', () => {
    mockQueryRefs.mockReturnValue([])
    mockCountRefs.mockReturnValue(0)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockQuerySymbols.mockImplementation((opts?: any) => {
      if (opts?.name !== undefined) return [] // the existence check misses
      // the near-name scan (no `name` filter) sees the full indexed set
      return [
        { name: 'refsTypoCandidateFn4m8k', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
      ]
    })
    const { stderr, stdout } = capture(() => {
      const code = runRefs({ spec: 'refsTypoCandidateFn4m8' })
      expect(code).toBe(1)
    })
    const all = stdout + stderr
    expect(all).toContain('Symbol not found: refsTypoCandidateFn4m8')
    expect(all).toContain('Did you mean:')
    expect(all).toContain('refsTypoCandidateFn4m8k')
    expect(all).not.toContain('No references found')
  })

  it('keeps today\'s exact "No references found" message, with no "Symbol not found" and no suggestion, for a real symbol that genuinely has zero references', () => {
    mockQueryRefs.mockReturnValue([])
    mockCountRefs.mockReturnValue(0)
    // The symbol IS indexed (the existence check, called with `name`, finds it) -- only the
    // reference query came back empty.
    mockQuerySymbols.mockReturnValue([
      { name: 'refsUnrefFn2p6j', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '' },
    ])
    const { stderr, stdout } = capture(() => {
      const code = runRefs({ spec: 'refsUnrefFn2p6j' })
      expect(code).toBe(1)
    })
    const all = stdout + stderr
    expect(all).toContain("No references found for 'refsUnrefFn2p6j'")
    expect(all).not.toContain('Symbol not found')
    expect(all).not.toContain('Did you mean')
  })
})
