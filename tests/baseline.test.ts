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
    expect(text).toContain("## Top symbols: none — no files indexed for this project; run 'token-goat index .'")
    expect(text).not.toContain('## Top symbols\n')
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

    // `dupHelper` is defined in three files and referenced 90 times in total, so its raw count beats
    // `soloFn`'s 40 -- but no single dupHelper definition owns those 90, so its share is 90/3 = 30.
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
      expect(names).toEqual(['soloFn', 'dupHelper'])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('mapLookupBytesSaved', () => {
  // Regression: the map_lookup byte accounting deduplicated its surfaced files through a Set, but
  // fed it RELATIVE recentFiles ('a.ts') alongside ABSOLUTE, normalizePath-form topSymbols
  // filePaths ('c:/.../a.ts'). A file present in BOTH lists (a recently-modified file that also
  // carries a headline symbol -- extremely common) therefore landed as two distinct Set keys and
  // had its on-disk size counted twice, inflating the stat. Seeds a headline symbol whose
  // normalized file_path points at the same real file buildProjectMap will also surface as a recent
  // file, then asserts the accounting counts that file exactly once.
  it('counts a file surfaced as both a recent file and a top symbol exactly once', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-baseline-mapdup-'))
    // Large body so fullSourceBytes dwarfs the emitted map text: with the double-count bug the
    // returned value is ~2x the file size (well above it); deduplicated it is size - emittedText
    // (strictly below the file size). A tiny file would clamp both to the Math.max(1, ...) floor.
    const bigBody = Array.from({ length: 400 }, (_, i) => `  const line${i} = ${i} * 2`).join('\n')
    const source = `export function mapDupHeadlineFn5w8() {\n${bigBody}\n  return 1\n}\n`
    const fileBytes = Buffer.byteLength(source, 'utf8')
    fs.writeFileSync(path.join(root, 'a.ts'), source)

    const filePath = `${normalizePath(root)}/a.ts`
    const db = getDb(globalDbPath())
    db.prepare(
      'INSERT INTO symbols (file_path, name, kind, line_start, line_end, body, docstring) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(filePath, 'mapDupHeadlineFn5w8', 'function', 1, 1, source, '')

    // cmdMap always runs with cwd === map.rootDir (buildProjectMap(process.cwd())), which is the
    // condition under which the bug actually bites: the buggy dedup fed a RELATIVE recentFile
    // ('a.ts') into the Set, and it only resolves to the real file (and thus gets double-counted
    // alongside the absolute topSymbol path) when cwd is the project root. Reproduce that here.
    const savedCwd = process.cwd()
    try {
      process.chdir(root)
      const map = buildProjectMap(root)
      // Precondition: the same file really is present in both lists, or this test proves nothing.
      expect(map.topSymbols.some((s) => s.name === 'mapDupHeadlineFn5w8')).toBe(true)
      expect(map.recentFiles).toContain('a.ts')

      const text = formatProjectMap(map, map.compact)
      const bytesSaved = mapLookupBytesSaved(map, text)
      // Counted once: fullSourceBytes == fileBytes, so bytesSaved == fileBytes - emittedText < fileBytes.
      // Double-counted: fullSourceBytes == 2*fileBytes, so bytesSaved > fileBytes.
      expect(bytesSaved).toBeGreaterThan(0)
      expect(bytesSaved).toBeLessThan(fileBytes)
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
