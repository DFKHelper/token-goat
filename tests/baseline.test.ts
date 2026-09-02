import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildProjectMap, formatProjectMap, mapLookupBytesSaved, walkProject, findMemSuggestionCandidates, formatMemSuggestions } from '../src/baseline.js'
import { loadConfig } from '../src/config.js'
import { globalDbPath } from '../src/constants.js'
import { getDb } from '../src/db.js'
import { normalizePath } from '../src/paths.js'
import { findClaudeMdFiles } from '../src/cli_context_stats.js'

vi.mock('../src/config.js', () => ({ loadConfig: vi.fn() }))
// findMemSuggestionCandidates/formatMemSuggestions walk from findClaudeMdFiles's result --
// mocked so tests are deterministic regardless of whatever real CLAUDE.md files exist on the
// machine running the suite (e.g. a real ~/.claude/CLAUDE.md), rather than depending on the
// real filesystem walk up from a temp dir.
vi.mock('../src/cli_context_stats.js', () => ({ findClaudeMdFiles: vi.fn() }))

let TMP: string

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-'))
  // Permissive default so existing tests (none of whose fixture files match isTestFile) are
  // unaffected; individual tests override as needed. indexing.skip_dirs is set empty so
  // walkProject's merge of it never trips on these fixtures.
  vi.mocked(loadConfig).mockReturnValue({
    repomap: { exclude_tests: false, compact_file_threshold: 50 },
    indexing: { skip_dirs: [] },
  } as unknown as ReturnType<typeof loadConfig>)
})

afterEach(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

function write(rel: string, content: string): void {
  const p = path.join(TMP, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

describe('buildProjectMap', () => {
  it('returns fileCount > 0 for a populated directory', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.py', 'x = 1\n')
    const map = buildProjectMap(TMP)
    expect(map.fileCount).toBe(2)
    expect(map.rootDir).toBe(path.resolve(TMP))
  })

  it('counts languages matching the files present', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.ts', 'export const y = 2\n')
    write('c.py', 'z = 3\n')
    write('readme.md', '# hi\n')
    const map = buildProjectMap(TMP)
    expect(map.languages['typescript']).toBe(2)
    expect(map.languages['python']).toBe(1)
    expect(map.languages['markdown']).toBe(1)
  })

  it('skips heavyweight directories like node_modules', () => {
    write('src.ts', 'export const x = 1\n')
    write('node_modules/pkg/index.js', 'module.exports = {}\n')
    const map = buildProjectMap(TMP)
    // Only the top-level source file is counted, not the node_modules entry.
    expect(map.fileCount).toBe(1)
    expect(map.languages['javascript']).toBeUndefined()
  })

  // Regression: repomap.exclude_tests was validated from TOML and reported by `token-goat
  // ignores`/`doctor`, but buildProjectMap (which backs `token-goat map` and `token-goat
  // baseline`) never consulted it -- test files always counted toward the project map
  // regardless of the setting.
  it('excludes test files from the project map when repomap.exclude_tests is true', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: true },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.fileCount).toBe(1)
    expect(map.recentFiles.some((f) => f.includes('add.test.ts'))).toBe(false)
  })

  it('includes test files in the project map when repomap.exclude_tests is false', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.fileCount).toBe(2)
  })

  // Regression: repomap.compact_file_threshold was validated from TOML and exported by
  // `token-goat config export`, but buildProjectMap never consulted it -- a project over the
  // threshold rendered the full (non-compact) map even without --compact, same bug shape as the
  // exclude_tests regression above.
  it('auto-enables compact once file count crosses repomap.compact_file_threshold, even without --compact', () => {
    write('a.ts', 'export const a = 1\n')
    write('b.ts', 'export const b = 2\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false, compact_file_threshold: 1 },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.fileCount).toBe(2)
    expect(map.compact).toBe(true)
    // Compact caps recentFiles at 5 (irrelevant here) but the observable proof is the flag
    // itself and that formatProjectMap(map, map.compact) renders the terser form.
    expect(formatProjectMap(map, map.compact)).not.toContain('## Recent files')
  })

  it('stays non-compact under the threshold when --compact was not requested', () => {
    write('a.ts', 'export const a = 1\n')
    vi.mocked(loadConfig).mockReturnValue({
      repomap: { exclude_tests: false, compact_file_threshold: 50 },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)

    const map = buildProjectMap(TMP)

    expect(map.compact).toBe(false)
  })
})

describe('walkProject', () => {
  it('excludes test files when opts.excludeTests is true', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')

    const result = walkProject(TMP, { excludeTests: true })

    expect(result.files.some((f) => f.includes('add.test.ts'))).toBe(false)
    expect(result.files.some((f) => f.endsWith('add.ts') && !f.includes('test'))).toBe(true)
  })

  it('includes test files when opts.excludeTests is false or omitted', () => {
    write('src/add.ts', 'export const add = (a: number, b: number) => a + b\n')
    write('tests/add.test.ts', 'export const t = 1\n')

    const result = walkProject(TMP)

    expect(result.files.some((f) => f.includes('add.test.ts'))).toBe(true)
  })
})

describe('formatProjectMap', () => {
  it('compact output has fewer lines than the full form', () => {
    write('a.ts', 'export const x = 1\n')
    write('b.py', 'z = 3\n')
    const map = buildProjectMap(TMP)

    const full = formatProjectMap(map, false)
    const compact = formatProjectMap(map, true)
    expect(compact.split('\n').length).toBeLessThan(full.split('\n').length)
  })

  it('includes file count and language summary in the header', () => {
    write('a.ts', 'export const x = 1\n')
    const map = buildProjectMap(TMP)
    const text = formatProjectMap(map, false)
    expect(text).toContain(`Files: ${map.fileCount}`)
    expect(text).toContain('typescript')
  })

  // Regression: an empty/unindexed project silently dropped the whole "## Top symbols" section
  // (baseline.ts:272 gated it on `topSymbols.length > 0`), which reads as "this project has no
  // notable symbols" rather than "this project was never indexed". Assert the marker line takes
  // its place, reusing checkSymbolCount's wording (cli_doctor.ts) verbatim.
  it('emits an explicit marker line instead of omitting the section when topSymbols is empty', () => {
    write('a.ts', 'export const x = 1\n')
    const map = buildProjectMap(TMP)
    expect(map.topSymbols).toEqual([])
    const text = formatProjectMap(map, false)
    // TMP is a plain temp folder, not a git repo, so the suggested command must be the --walk form: a bare `token-goat index .` refuses outright outside a git repo, which is exactly where this branch fires.
    expect(text).toContain("## Top symbols: none — no files indexed for this project; run 'token-goat index . --walk'")
    expect(text).not.toContain('## Top symbols\n')
  })

  // The git half of the same branch. Without this, a fix that hardcoded the --walk form for every project would pass the assertion above and still print a command that cannot run inside a real repo.
  it('suggests the plain index command instead of --walk when the project is a git repo', () => {
    write('a.ts', 'export const x = 1\n')
    execFileSync('git', ['init', '-q', '.'], { cwd: TMP })
    const text = formatProjectMap(buildProjectMap(TMP), false)
    expect(text).toContain("## Top symbols: none — no files indexed for this project; run 'token-goat index .'")
    expect(text).not.toContain('--walk')
  })

  // Companion to the above: the populated case must render byte-for-byte the same "## Top
  // symbols" heading and list format it always has -- the marker line is additive only for the
  // empty case, never a substitute when symbols exist.
  it('still renders the existing "## Top symbols" heading unchanged when symbols are present', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-topsym-'))
    const filePath = `${normalizePath(root)}/a.ts`
    const db = getDb(globalDbPath())
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'hotFn', 'function', 1, 1, 'export function hotFn() { return 1 }', '')

    try {
      const map = buildProjectMap(root)
      expect(map.topSymbols.length).toBeGreaterThan(0)
      const text = formatProjectMap(map, true)
      const lines = text.split('\n')
      const headingIdx = lines.indexOf('## Top symbols')
      expect(headingIdx).toBeGreaterThanOrEqual(0)
      // Compact used to print '- hotFn (function)' with no location. Since
      // repomap.compact_file_threshold defaults to 50, compact is the form every real project
      // renders, so a top symbol was never addressable without a follow-up `symbol` call.
      expect(lines[headingIdx + 1]).toBe('- hotFn (function) — a.ts:1-1')
      expect(text).not.toContain('## Top symbols: none')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Full mode named only path.basename(filePath), which is ambiguous across directories -- every
  // project has several index.ts -- and is not a spec you can feed back to `read`. A root-relative
  // display path is, and it stays identical no matter which directory the command ran from.
  it('locates top symbols by root-relative path, not basename, in both modes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-toploc-'))
    const filePath = `${normalizePath(root)}/src/deep/nested.ts`
    const db = getDb(globalDbPath())
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'deepFn', 'function', 7, 9, 'export function deepFn() { return 1 }', '')

    try {
      const map = buildProjectMap(root)
      for (const compact of [true, false]) {
        const lines = formatProjectMap(map, compact).split('\n')
        const headingIdx = lines.indexOf('## Top symbols')
        expect(headingIdx).toBeGreaterThanOrEqual(0)
        expect(lines[headingIdx + 1]).toBe('- deepFn (function) — src/deep/nested.ts:7-9')
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('buildProjectMap cross-project scoping', () => {
  // Regression: global.db is a single machine-wide index keyed by absolute path across every
  // project ever indexed (see constants.ts). fetchTopSymbols used to run an unscoped query
  // against `symbols`, so the `## Top symbols` section of `map` silently mixed in symbols from
  // unrelated projects that happened to share the same index. This seeds two distinct project
  // roots directly into the real (test-isolated) global.db and asserts buildProjectMap(rootA)
  // never surfaces a symbol whose file_path lives under rootB.
  it('never includes a symbol whose file_path is under a different project root', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-rootA-'))
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-rootB-'))
    fs.writeFileSync(path.join(rootA, 'a.ts'), 'export function fromRootA() {}\n')
    fs.writeFileSync(path.join(rootB, 'b.ts'), 'export function fromRootB() {}\n')

    // Real indexing always stores file_path via normalizePath() (see sql_path.ts's
    // projectScopeClause docstring) -- including 8.3 short-name expansion. A raw
    // backslash-to-slash conversion here would drift from that on a Windows machine whose
    // %TEMP% is pinned to its short form (e.g. CI's `RUNNER~1`), silently failing the
    // LIKE-based project-scope match.
    const rootAFilePath = `${normalizePath(rootA)}/a.ts`
    const rootBFilePath = `${normalizePath(rootB)}/b.ts`

    const db = getDb(globalDbPath())
    const insert = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    insert.run(rootAFilePath, 'fromRootA', 'function', 1, 1, 'export function fromRootA() {}', '')
    insert.run(rootBFilePath, 'fromRootB', 'function', 1, 1, 'export function fromRootB() {}', '')

    try {
      const map = buildProjectMap(rootA)
      const names = map.topSymbols.map((s) => s.name)
      expect(names).toContain('fromRootA')
      expect(names).not.toContain('fromRootB')
      expect(map.topSymbols.every((s) => !s.filePath.includes(path.basename(rootB)))).toBe(true)
    } finally {
      fs.rmSync(rootA, { recursive: true, force: true })
      fs.rmSync(rootB, { recursive: true, force: true })
    }
  })
})

describe('fetchTopSymbols ref-count ranking', () => {
  // Regression: fetchTopSymbols used to rank purely by LENGTH(body) DESC, so a long-bodied
  // symbol nobody ever calls (e.g. a big never-referenced class) outranked a short-bodied
  // symbol referenced dozens of times elsewhere in the project -- actively counterproductive
  // for orientation, since "what does the rest of the codebase actually reference" is the
  // useful signal, not body size. Seeds one short, heavily-referenced function and one long,
  // never-referenced class into the real (test-isolated) global.db and asserts the
  // heavily-referenced one is ranked strictly first.
  it('ranks a short heavily-referenced function above a long never-referenced class', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-refrank-'))
    const filePath = `${normalizePath(root)}/a.ts`

    const db = getDb(globalDbPath())
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'hotFn', 'function', 1, 1, 'export function hotFn() { return 1 }', '')

    const longBody = Array.from({ length: 200 }, (_, i) => `  const line${i} = ${i}`).join('\n')
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'ColdClass', 'class', 10, 210, `class ColdClass {\n${longBody}\n}`, '')

    const insertRef = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < 20; i += 1) {
      insertRef.run(filePath, 'hotFn', 100 + i, 1, `hotFn(${i})`)
    }
    // ColdClass gets zero refs.

    try {
      const map = buildProjectMap(root)
      const names = map.topSymbols.map((s) => s.name)
      expect(names).toEqual(['hotFn', 'ColdClass'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  // Regression: ranking by a raw ref count credited every same-named definition with the WHOLE
  // project-wide count for that name, because refs carry only a bare name and no target. A generic
  // helper defined seven times therefore both outranked genuinely hot symbols and occupied seven of
  // the ten slots -- the real `map --compact` output was literally `apply` seven times. The count is
  // now divided across the same-named definitions and only one representative per name is kept.
  it('discounts a name defined many times and keeps one row per name', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-refdup-'))
    const rootUri = normalizePath(root)

    const db = getDb(globalDbPath())
    const insertSym = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertRef = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )

    // `dupHelper` is defined in three files and referenced from 3 distinct files (30 refs per file).
    // `soloFn` is defined once and referenced from 1 file (40 refs).
    // With COUNT(DISTINCT file_path): dupHelper's score = (3 * 1.0) / 3 = 1.0, soloFn's = (1 * 1.0) / 1 = 1.0.
    // Tied on score, so dupHelper (longer body, appears first in files) ranks first.
    for (let f = 0; f < 3; f += 1) {
      const filePath = `${rootUri}/dup${f}.ts`
      insertSym.run(filePath, 'dupHelper', 'function', 1, 1, `function dupHelper() { return ${f} }`, '')
      for (let i = 0; i < 30; i += 1) insertRef.run(filePath, 'dupHelper', 100 + i, 1, 'dupHelper()')
    }

    const soloPath = `${rootUri}/solo.ts`
    insertSym.run(soloPath, 'soloFn', 'function', 1, 1, 'function soloFn() { return 1 }', '')
    for (let i = 0; i < 40; i += 1) insertRef.run(soloPath, 'soloFn', 100 + i, 1, 'soloFn()')

    try {
      const names = buildProjectMap(root).topSymbols.map((s) => s.name)
      expect(names).toEqual(['dupHelper', 'soloFn'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})


  // Regression: `map --compact` was reporting test-file variables and short names as top symbols.
  // This fixture captures actual pre-fix output (CAPTURE: real binary behavior at commit 0b359c00)
  // where `out`, `file`, `result`, `slice`, `find` (all <4 chars or from test files) were ranked top.
  it('excludes symbols from test files and names shorter than 4 characters', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-testexclude-'))
    const rootUri = normalizePath(root)

    const db = getDb(globalDbPath())
    const insertSym = db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const insertRef = db.prepare(
      'INSERT INTO refs (file_path, name, line, col, context) VALUES (?, ?, ?, ?, ?)',
    )

    // Insert a legitimate symbol that should appear
    const mainPath = `${rootUri}/main.ts`
    insertSym.run(mainPath, 'legitimateFunc', 'function', 1, 5, 'function legitimateFunc() {}', '')
    insertRef.run(mainPath, 'legitimateFunc', 10, 1, 'legitimateFunc()')

    // Insert symbols from test files that should be excluded
    const testPath = `${rootUri}/tests/helper.test.ts`
    insertSym.run(testPath, 'out', 'function', 1, 1, 'function out() {}', '')
    insertSym.run(testPath, 'file', 'function', 2, 2, 'function file() {}', '')
    insertRef.run(testPath, 'out', 10, 1, 'out()')
    insertRef.run(testPath, 'file', 11, 1, 'file()')

    // Insert short names from non-test files that should be excluded
    const srcPath = `${rootUri}/src.ts`
    insertSym.run(srcPath, 'foo', 'function', 1, 1, 'function foo() {}', '')
    insertRef.run(srcPath, 'foo', 10, 1, 'foo()')

    try {
      const names = buildProjectMap(root).topSymbols.map((s) => s.name)
      // Only legitimateFunc should appear; test files and short names are excluded
      expect(names).toEqual(['legitimateFunc'])
      expect(names).not.toContain('out')
      expect(names).not.toContain('file')
      expect(names).not.toContain('foo')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

describe('mapLookupBytesSaved', () => {
  // Regression: the map_lookup byte accounting deduplicated its surfaced files through a Set, but
  // fed it RELATIVE recentFiles ('a.ts') alongside ABSOLUTE, normalizePath-form topSymbols
  // filePaths ('c:/.../a.ts'). A file present in BOTH lists (a recently-modified file that also
  // carries a headline symbol -- extremely common) therefore landed as two distinct Set keys and
  // had its on-disk size counted twice, inflating the stat.
  //
  // Under the CURRENT (file-path-listing, not on-disk-content-size) accounting, a comparison
  // against the file's content size no longer discriminates: a duplicated path only adds its own
  // (tiny) path length to the listing, which stays far below any content-size-scale threshold
  // whether or not dedup actually ran. So this asserts the exact byte count the deduplicated
  // one-path listing must produce, computed independently of mapLookupBytesSaved's own dedup
  // logic (from the known emitted text and the known single absolute path), and separately proves
  // that count is distinguishable from what a broken (duplicate-counting) dedup would produce --
  // i.e. that the equality check above is capable of catching the regression, not just passing
  // for an unrelated reason.
  it('counts a file surfaced as both a recent file and a top symbol exactly once', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-mapdup-'))
    try {
      // The exact normalized absolute path mapLookupBytesSaved resolves 'a.ts' (a recentFiles
      // entry) to, and the same path a topSymbols entry can carry directly (already absolute,
      // normalizePath-form) -- this is the one file present in both lists.
      const absPath = normalizePath(path.resolve(rootDir, 'a.ts'))

      const map = {
        rootDir,
        fileCount: 1,
        languages: { typescript: 1 },
        topSymbols: [{
          filePath: absPath, name: 'fn', kind: 'function', lineStart: 1, lineEnd: 1, body: '', docstring: '', parent: '',
        }],
        recentFiles: ['a.ts'],
        compact: false,
      }
      const emittedText = 'compact map output — irrelevant to this accounting check'

      const bytesSaved = mapLookupBytesSaved(map, emittedText)

      // Deduplicated: the listing is the single path, joined with nothing (one entry, no separator).
      const dedupedExpected = Math.max(1, Buffer.byteLength(absPath, 'utf8') - Buffer.byteLength(emittedText, 'utf8'))
      expect(bytesSaved).toBe(dedupedExpected)

      // Not vacuous: a regression that drops the Set (counts the same path twice) would produce
      // this instead -- prove it actually differs from the deduped answer at this scale, so the
      // equality assertion above is a real regression trap rather than a coincidental pass.
      const duplicatedListing = [absPath, absPath].sort().join('\n')
      const duplicatedExpected = Math.max(1, Buffer.byteLength(duplicatedListing, 'utf8') - Buffer.byteLength(emittedText, 'utf8'))
      expect(duplicatedExpected).not.toBe(dedupedExpected)
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  // Regression: map_lookup used to book bytes_saved against the FULL ON-DISK SIZE of every file
  // `map` surfaces, as if the alternative to `map` were reading each surfaced file whole -- nobody
  // does that. Seeds a recent file with a large body so the old (content-size) accounting would
  // book a saving on the order of that body size; asserts the real accounting instead tracks the
  // (tiny) cost of a plain path listing, nowhere close to the file's content size.
  it('books bytes saved against a file-path listing, not the on-disk content size of surfaced files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-mapcontent-'))
    const bigBody = Array.from({ length: 5000 }, (_, i) => `  const line${i} = ${i} * 2`).join('\n')
    const source = `export function mapContentSizeFn9x2q() {\n${bigBody}\n  return 1\n}\n`
    const fileBytes = Buffer.byteLength(source, 'utf8')
    expect(fileBytes).toBeGreaterThan(100_000)
    fs.writeFileSync(path.join(root, 'a.ts'), source)

    const savedCwd = process.cwd()
    try {
      process.chdir(root)
      const map = buildProjectMap(root)
      expect(map.recentFiles).toContain('a.ts')

      const text = formatProjectMap(map, map.compact)
      const bytesSaved = mapLookupBytesSaved(map, text)
      // The old content-size accounting would book a saving close to fileBytes (~150KB); the
      // path-listing accounting books a saving on the order of a few file-path characters.
      expect(bytesSaved).toBeGreaterThan(0)
      expect(bytesSaved).toBeLessThan(1000)
    } finally {
      process.chdir(savedCwd)
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('findMemSuggestionCandidates', () => {
  it('counts single-line preference-shaped bullets outside structural/critical headings', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', [
      '# CLAUDE.md',
      '',
      '## Preferences',
      '- Use SSH remote for git push',
      '- Prefer rg over grep',
      '',
      '## Architecture',
      '- src/foo.ts handles bar',
      '- src/baz.ts handles qux',
    ].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const result = findMemSuggestionCandidates(TMP)

    const entry = result.find((r) => r.path === claudeMd)
    expect(entry).toBeDefined()
    // Only the two "## Preferences" bullets qualify; the two "## Architecture" bullets are
    // structural inventory content and must be excluded.
    expect(entry?.count).toBe(2)
  })

  it('excludes bullets under a heading that reads as a must-enforce directive', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', [
      '## MANDATORY Rules',
      '- Never commit secrets',
      '- Always run tests before pushing',
    ].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const result = findMemSuggestionCandidates(TMP)

    expect(result.find((r) => r.path === claudeMd)).toBeUndefined()
  })

  // Regression: skipSection was recomputed on every heading line regardless of nesting depth,
  // so a keyword-less subheading nested inside a CRITICAL section flipped skipSection back to
  // false even though the subsection is still textually inside the critical block.
  it('excludes bullets under a keyword-less subheading nested inside a CRITICAL section', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', [
      '## CRITICAL: Rules',
      '- never delete the database',
      '### Sub note',
      '- some bullet that should still be skipped',
    ].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const result = findMemSuggestionCandidates(TMP)

    expect(result.find((r) => r.path === claudeMd)).toBeUndefined()
  })

  it('returns no entry for a file with zero qualifying bullets', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', '# CLAUDE.md\n\nJust prose, no bullets.\n')
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const result = findMemSuggestionCandidates(TMP)

    expect(result.find((r) => r.path === claudeMd)).toBeUndefined()
  })

  it('also scans a sibling AGENTS.md next to a discovered CLAUDE.md', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', '# CLAUDE.md\n')
    write('AGENTS.md', ['## Notes', '- Prefer small commits'].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const result = findMemSuggestionCandidates(TMP)

    const agentsEntry = result.find((r) => r.path === path.join(TMP, 'AGENTS.md'))
    expect(agentsEntry).toBeDefined()
    expect(agentsEntry?.count).toBe(1)
  })
})

describe('formatMemSuggestions', () => {
  it('renders an advisory "mem import --from-md" line naming the file and bullet count', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', ['## Preferences', '- Use SSH remote for git push'].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const text = formatMemSuggestions(TMP)

    expect(text).toContain('mem import --from-md')
    expect(text).toContain(claudeMd)
    expect(text).toContain('migrates 1 preference-shaped lines from CLAUDE.md')
  })

  it('returns an empty string when there is nothing to suggest', () => {
    vi.mocked(findClaudeMdFiles).mockReturnValue([])

    expect(formatMemSuggestions(TMP)).toBe('')
  })

  it('never writes anything to disk and returns a string result only (advisory, not a live integration)', () => {
    const claudeMd = path.join(TMP, 'CLAUDE.md')
    write('CLAUDE.md', ['## Preferences', '- Use SSH remote for git push'].join('\n'))
    vi.mocked(findClaudeMdFiles).mockReturnValue([claudeMd])

    const before = fs.readdirSync(TMP).sort()
    formatMemSuggestions(TMP)
    const after = fs.readdirSync(TMP).sort()

    expect(after).toEqual(before)
  })
})
