import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Stub the DB-layer imports so tests don't need a real SQLite DB
vi.mock('../src/index_reader.js', () => ({
  querySymbols: vi.fn(() => []),
  queryRefs: vi.fn(() => []),
  getFileEntry: vi.fn(() => null),
}))

vi.mock('../src/section_reader.js', () => ({
  readSection: vi.fn(() => null),
  listSections: vi.fn(() => []),
  listAllSections: vi.fn(() => []),
  extractSection: vi.fn(() => null),
}))

// Partial-mock util so runGit is controllable while ensureNewline (used by emit) keeps its real behavior.
vi.mock('../src/util.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, runGit: vi.fn() }
})

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
  runExports,
  runChanged,
  runRefs,
  extractImports,
  extractExportNames,
  extractTranscriptText,
} from '../src/read_commands.js'
import { querySymbols, queryRefs } from '../src/index_reader.js'
import { runGit } from '../src/util.js'
import { resolveIndexPath } from '../src/paths.js'
import { readSection, listSections, listAllSections } from '../src/section_reader.js'

const mockQuerySymbols = vi.mocked(querySymbols)
const mockQueryRefs = vi.mocked(queryRefs)
const mockReadSection = vi.mocked(readSection)
const mockListSections = vi.mocked(listSections)
const mockListAllSections = vi.mocked(listAllSections)

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
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  // ---- runSymbol ----------------------------------------------------------

  describe('runSymbol', () => {
    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const { stderr } = capture(() => { runSymbol({ name: 'missing' }) })
      expect(stderr).toContain('missing')
    })

    it('returns 0 and prints symbols when found', () => {
      const sym: MockSymbol = { name: 'myFunc', kind: 'function', filePath: 'src/foo.ts', lineStart: 10, lineEnd: 20, body: 'function myFunc() {}', docstring: '' }
      mockQuerySymbols.mockReturnValue([sym as Parameters<typeof mockQuerySymbols>[0] extends infer _O ? never : never] as unknown as ReturnType<typeof mockQuerySymbols>)
      const { stdout } = capture(() => { runSymbol({ name: 'myFunc' }) })
      expect(stdout).toContain('myFunc')
    })

    it('emits JSON when json flag is set', () => {
      const sym: MockSymbol = { name: 'fn', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'function fn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { stdout } = capture(() => { runSymbol({ name: 'fn', json: true }) })
      const parsed = JSON.parse(stdout) as unknown[]
      expect(Array.isArray(parsed)).toBe(true)
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
  })

  // ---- runRead ------------------------------------------------------------

  describe('runRead', () => {
    it('reads a plain file when no :: separator', () => {
      const f = path.join(tempDir, 'plain.txt')
      fs.writeFileSync(f, 'hello world')
      const { stdout } = capture(() => { runRead({ spec: f }) })
      expect(stdout).toContain('hello world')
    })

    it('returns 1 when file does not exist', () => {
      const code = runRead({ spec: path.join(tempDir, 'nope.txt') })
      expect(code).toBe(1)
    })

    it('returns 1 when symbol not found', () => {
      mockQuerySymbols.mockReturnValue([])
      const code = runRead({ spec: 'src/foo.ts::missing' })
      expect(code).toBe(1)
    })

    it('prints body when symbol found', () => {
      const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 1, body: 'function myFn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { stdout } = capture(() => { runRead({ spec: 'src/foo.ts::myFn' }) })
      expect(stdout).toContain('myFn')
    })

    it('prints correct line count in header (inclusive both ends)', () => {
      // lineStart=5, lineEnd=10 spans 6 lines, not 5
      const sym: MockSymbol = { name: 'myFn', kind: 'function', filePath: 'src/foo.ts', lineStart: 5, lineEnd: 10, body: 'function myFn() {}', docstring: '' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue([sym as any])
      const { stdout } = capture(() => { runRead({ spec: 'src/foo.ts::myFn' }) })
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

    // ---- line-range reads (file@N-M) --------------------------------------
    // These exercise the @N-M syntax the Python build had and the TS port dropped. Each asserts on sliced content, so it fails on pre-feature code (where `file@2-4` fell through to symbol resolution and errored "Could not read") and passes once the range path exists.
    describe('line-range reads (file@N-M)', () => {
      function rangeFile(): string {
        const f = path.join(tempDir, 'lines.txt')
        fs.writeFileSync(f, 'one\ntwo\nthree\nfour\nfive\n')
        return f
      }

      it('reads an inclusive N-M range', () => {
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@2-4` }) })
        expect(stdout).toContain('two\nthree\nfour')
        expect(stdout).not.toContain('one')
        expect(stdout).not.toContain('five')
      })

      it('reads a single line with @N', () => {
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@3` }) })
        expect(stdout).toContain('three')
        expect(stdout).not.toContain('two')
        expect(stdout).not.toContain('four')
      })

      it('does not count a trailing newline as an extra line', () => {
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@1-99` }) })
        expect(stdout).toContain('# lines 1-5 of 5')
        expect(stdout.trimEnd().endsWith('five')).toBe(true)
      })

      it('clamps an end past EOF to the last line', () => {
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@4-100` }) })
        expect(stdout).toContain('four\nfive')
        expect(stdout).toContain('# lines 4-5 of 5')
      })

      it('errors when start > end', () => {
        let code = 0
        const { stderr } = capture(() => { code = runRead({ spec: `${rangeFile()}@5-2` }) })
        expect(code).toBe(1)
        expect(stderr).toContain('before start')
      })

      it('errors when start < 1', () => {
        let code = 0
        // Assert the range-specific message, not just the exit code: a plain file-not-found also returns 1, so a code-only check would pass even with the range path disabled.
        const { stderr } = capture(() => { code = runRead({ spec: `${rangeFile()}@0-3` }) })
        expect(code).toBe(1)
        expect(stderr).toContain('start must be >= 1')
      })

      it('errors when start is past EOF', () => {
        let code = 0
        const { stderr } = capture(() => { code = runRead({ spec: `${rangeFile()}@99` }) })
        expect(code).toBe(1)
        expect(stderr).toContain('past end of file')
      })

      it('reads an out-of-project path without consulting the index', () => {
        // Line-range reads must not require an indexed project (closes the out-of-project read gap). The symbol index is never queried.
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@2-3` }) })
        expect(stdout).toContain('two\nthree')
        expect(mockQuerySymbols).not.toHaveBeenCalled()
      })

      it('emits structured JSON with the json flag', () => {
        const { stdout } = capture(() => { runRead({ spec: `${rangeFile()}@2-3`, json: true }) })
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
    })
  })

  // ---- runSection ---------------------------------------------------------

  describe('runSection', () => {
    it('returns 1 for invalid spec without ::', () => {
      const code = runSection({ spec: 'no-separator' })
      expect(code).toBe(1)
    })

    it('returns 1 when section not found', () => {
      mockReadSection.mockReturnValue(null)
      mockListAllSections.mockReturnValue(['Other'])
      const { stderr } = capture(() => { runSection({ spec: 'README.md::Install' }) })
      expect(stderr).toContain('Install')
    })

    it('shows full heading list on section miss', () => {
      mockReadSection.mockReturnValue(null)
      mockListAllSections.mockReturnValue(['Title', 'Introduction', 'Installation', 'Usage', 'API Reference', 'Contributing'])
      const { stderr } = capture(() => { runSection({ spec: 'README.md::Nonexistent' }) })
      expect(stderr).toContain('Available sections')
      expect(stderr).toContain('Introduction')
      expect(stderr).toContain('API Reference')
      expect(stderr).toContain('Contributing')
    })

    it('prints section content when found', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '## Install\nrun npm install', heading: 'Install', startLine: 5, endLine: 10 } as any)
      const { stdout } = capture(() => { runSection({ spec: 'README.md::Install' }) })
      expect(stdout).toContain('npm install')
    })

    it('annotates the header with a redirect note when a prefix redirect resolved it (#92)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Business / logic\nbody', heading: 'Business / logic', lineStart: 1, lineEnd: 2, redirectedFrom: 'Business' } as any)
      const { stdout } = capture(() => { runSection({ spec: 'doc.md::Business' }) })
      expect(stdout).toContain("redirected from: 'Business'")
      expect(stdout).toContain('Business / logic')
    })

    it('omits the redirect note on an exact match (#92)', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Setup\nbody', heading: 'Setup', lineStart: 1, lineEnd: 2 } as any)
      const { stdout } = capture(() => { runSection({ spec: 'doc.md::Setup' }) })
      expect(stdout).not.toContain('redirected from')
    })

    it('emits JSON when json flag is set', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockReadSection.mockReturnValue({ content: '# Hello', heading: 'Hello', startLine: 1, endLine: 2 } as any)
      const { stdout } = capture(() => { runSection({ spec: 'doc.md::Hello', json: true }) })
      const parsed = JSON.parse(stdout) as { heading: string }
      expect(parsed.heading).toBe('Hello')
    })
  })

  // ---- runSkeleton --------------------------------------------------------

  describe('runSkeleton', () => {
    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const code = runSkeleton({ file: 'missing.ts' })
      expect(code).toBe(1)
    })

    it('prints skeleton header with symbol count', () => {
      const syms: MockSymbol[] = [
        { name: 'foo', kind: 'function', filePath: 'a.ts', lineStart: 5, lineEnd: 15, body: 'function foo() {}', docstring: '' },
        { name: 'bar', kind: 'class', filePath: 'a.ts', lineStart: 20, lineEnd: 40, body: 'class bar {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runSkeleton({ file: 'a.ts' }) })
      expect(stdout).toContain('Skeleton')
      expect(stdout).toContain('2 symbols')
    })

    it('reports correct total lines when filtering by minLines', () => {
      const syms: MockSymbol[] = [
        { name: 'tiny', kind: 'function', filePath: 'a.ts', lineStart: 1, lineEnd: 5, body: 'x', docstring: '' },
        { name: 'large', kind: 'class', filePath: 'a.ts', lineStart: 10, lineEnd: 30, body: 'class {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runSkeleton({ file: 'a.ts', minLines: 10 }) })
      expect(stdout).toContain('1 symbols')
      expect(stdout).toContain('30 lines')
    })
  })

  // ---- runOutline ---------------------------------------------------------

  describe('runOutline', () => {
    it('returns 1 when no symbols found', () => {
      mockQuerySymbols.mockReturnValue([])
      const code = runOutline({ file: 'empty.ts' })
      expect(code).toBe(1)
    })

    it('prints outline with line ranges', () => {
      const syms: MockSymbol[] = [
        { name: 'myFunc', kind: 'function', filePath: 'f.ts', lineStart: 10, lineEnd: 30, body: 'function myFunc() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runOutline({ file: 'f.ts' }) })
      expect(stdout).toContain('10')
      expect(stdout).toContain('myFunc')
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
  })

  // ---- runListSections ----------------------------------------------------

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
        { name: 'a', kind: 'function', filePath: 'src/foo.ts', lineStart: 1, lineEnd: 5, body: 'function a() {}', docstring: '' },
        { name: 'b', kind: 'function', filePath: 'src/foo.ts', lineStart: 6, lineEnd: 10, body: 'function b() {}', docstring: '' },
      ]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockQuerySymbols.mockReturnValue(syms as any)
      const { stdout } = capture(() => { runFind({ pattern: 'foo' }) })
      const lines = stdout.trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('foo.ts')
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

  it('emits a per-symbol map under --json', () => {
    mockQueryRefs.mockImplementation((opts: { name: string }) =>
      opts.name === 'login' ? [ref('src/auth.ts', 10, 'login()')] : [],
    )
    const { stdout } = capture(() => runRefs({ spec: 'login,refresh', json: true }))
    const parsed = JSON.parse(stdout) as Record<string, unknown[]>
    expect(Object.keys(parsed)).toEqual(['login', 'refresh'])
    expect(parsed.login).toHaveLength(1)
    expect(parsed.refresh).toHaveLength(0)
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
})
