import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Stub config so the overflow guard (used by emitGuarded in runConflicts's text-mode branch)
// has a deterministic, permissive budget instead of reading a real config.toml -- same pattern
// coverage_query.test.ts / openapi_query.test.ts use for their own run* coverage. loadConfig()
// is also called internally by walkProject (indexing.skip_dirs), so the mock must return that
// shape too for the multi-file directory-scan tests below.
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

import {
  parseConflicts,
  summarizeFileConflicts,
  formatConflicts,
  formatConflictSummaries,
  type FileConflicts,
} from '../src/conflict_query.js'
import { runConflicts } from '../src/read_commands.js'
import { loadConfig } from '../src/config.js'

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

const TWO_WAY_FIXTURE = [
  'before',
  '<<<<<<< HEAD',
  'ours line 1',
  'ours line 2',
  '=======',
  'theirs line 1',
  '>>>>>>> feature-branch',
  'after',
  '',
].join('\n')

const DIFF3_FIXTURE = [
  'before',
  '<<<<<<< HEAD',
  'ours',
  '||||||| merged common ancestors',
  'base',
  '=======',
  'theirs',
  '>>>>>>> feature-branch',
  'after',
  '',
].join('\n')

const MULTI_REGION_FIXTURE = [
  'top',
  '<<<<<<< HEAD',
  'ours-1',
  '=======',
  'theirs-1',
  '>>>>>>> branch-a',
  'middle',
  '<<<<<<< HEAD',
  'ours-2',
  '=======',
  'theirs-2',
  '>>>>>>> branch-b',
  'bottom',
  '',
].join('\n')

const CLEAN_FIXTURE = 'no markers here\njust ordinary code\n'

const MISSING_SEPARATOR_FIXTURE = ['<<<<<<< HEAD', 'ours', '>>>>>>> feature', ''].join('\n')

const MISSING_END_FIXTURE = ['<<<<<<< HEAD', 'ours', '=======', 'theirs', ''].join('\n')

const NESTED_START_FIXTURE = [
  '<<<<<<< HEAD',
  'ours-outer',
  '<<<<<<< nested',
  'ours-inner',
  '=======',
  'theirs-inner',
  '>>>>>>> end',
  '',
].join('\n')

describe('parseConflicts', () => {
  it('parses a single two-way conflict region with labels, content, and 1-indexed line range', () => {
    const result = parseConflicts('src/a.ts', TWO_WAY_FIXTURE)
    expect(result.warnings).toEqual([])
    expect(result.regions).toHaveLength(1)
    const r = result.regions[0]!
    expect(r.filePath).toBe('src/a.ts')
    expect(r.lineStart).toBe(2)
    expect(r.lineEnd).toBe(7)
    expect(r.ours).toEqual({ label: 'HEAD', content: 'ours line 1\nours line 2' })
    expect(r.base).toBeNull()
    expect(r.theirs).toEqual({ label: 'feature-branch', content: 'theirs line 1' })
  })

  it('parses a diff3 three-way conflict, capturing the ||||||| base section', () => {
    const result = parseConflicts('src/b.ts', DIFF3_FIXTURE)
    expect(result.warnings).toEqual([])
    expect(result.regions).toHaveLength(1)
    const r = result.regions[0]!
    expect(r.ours).toEqual({ label: 'HEAD', content: 'ours' })
    expect(r.base).toEqual({ label: 'merged common ancestors', content: 'base' })
    expect(r.theirs).toEqual({ label: 'feature-branch', content: 'theirs' })
    expect(r.lineStart).toBe(2)
    expect(r.lineEnd).toBe(8)
  })

  it('parses multiple conflict regions in one file, each with its own line range', () => {
    const result = parseConflicts('src/c.ts', MULTI_REGION_FIXTURE)
    expect(result.warnings).toEqual([])
    expect(result.regions).toHaveLength(2)
    expect(result.regions[0]!.ours.content).toBe('ours-1')
    expect(result.regions[0]!.theirs.label).toBe('branch-a')
    expect(result.regions[1]!.ours.content).toBe('ours-2')
    expect(result.regions[1]!.theirs.label).toBe('branch-b')
    expect(result.regions[0]!.lineEnd).toBeLessThan(result.regions[1]!.lineStart)
  })

  it('returns zero regions and zero warnings for a file with no conflict markers', () => {
    const result = parseConflicts('src/clean.ts', CLEAN_FIXTURE)
    expect(result.regions).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('surfaces a warning (not a crash, not a silently-misparsed region) for a missing "======="', () => {
    const result = parseConflicts('src/bad1.ts', MISSING_SEPARATOR_FIXTURE)
    expect(result.regions).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.filePath).toBe('src/bad1.ts')
    expect(result.warnings[0]!.line).toBe(1)
    expect(result.warnings[0]!.message).toMatch(/Unterminated conflict marker/)
  })

  it('surfaces a warning for a missing ">>>>>>>" (unterminated at EOF)', () => {
    const result = parseConflicts('src/bad2.ts', MISSING_END_FIXTURE)
    expect(result.regions).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.line).toBe(1)
    expect(result.warnings[0]!.message).toMatch(/end of file/)
  })

  it('flags a nested "<<<<<<<" as unterminating the outer region, then recovers and parses the inner region', () => {
    const result = parseConflicts('src/bad3.ts', NESTED_START_FIXTURE)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]!.line).toBe(1)
    expect(result.warnings[0]!.message).toMatch(/found a new/)
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.ours.content).toBe('ours-inner')
    expect(result.regions[0]!.theirs.content).toBe('theirs-inner')
  })

  it('parses a region whose "=======" carries trailing whitespace, like its sibling markers do', () => {
    const text = ['<<<<<<< HEAD', 'ours', '=======  ', 'theirs', '>>>>>>> feature', ''].join('\n')
    const result = parseConflicts('src/trailsp.ts', text)
    // Was: the strict `/^={7}$/` missed this separator, so the region stayed in the ours state to
    // EOF -- zero regions, plus a warning claiming no '>>>>>>>' matched when one was right there.
    expect(result.warnings).toEqual([])
    expect(result.regions).toHaveLength(1)
    expect(result.regions[0]!.ours).toEqual({ label: 'HEAD', content: 'ours' })
    expect(result.regions[0]!.theirs).toEqual({ label: 'feature', content: 'theirs' })
    expect(result.regions[0]!.lineStart).toBe(1)
    expect(result.regions[0]!.lineEnd).toBe(5)
  })

  it('does not treat a labelled or over-long "=======" line as a separator', () => {
    // The tolerance above is whitespace only, deliberately unlike the other three markers' label
    // capture: content lines that merely start with seven `=` must stay content, or a prose file
    // would have its ours section silently truncated at the first such line.
    const labelled = parseConflicts('src/lbl.ts', ['<<<<<<< HEAD', '======= notes', 'ours', '=======', 'theirs', '>>>>>>> feature', ''].join('\n'))
    expect(labelled.warnings).toEqual([])
    expect(labelled.regions).toHaveLength(1)
    expect(labelled.regions[0]!.ours.content).toBe('======= notes\nours')
    const overlong = parseConflicts('src/ovl.ts', ['<<<<<<< HEAD', '========', 'ours', '=======', 'theirs', '>>>>>>> feature', ''].join('\n'))
    expect(overlong.regions).toHaveLength(1)
    expect(overlong.regions[0]!.ours.content).toBe('========\nours')
  })
})

describe('summarizeFileConflicts', () => {
  it('keeps file, count, line ranges, and labels, but omits ours/base/theirs content', () => {
    const parsed = parseConflicts('src/b.ts', DIFF3_FIXTURE)
    const summary = summarizeFileConflicts(parsed)
    expect(summary.filePath).toBe('src/b.ts')
    expect(summary.conflictCount).toBe(1)
    expect(summary.regions).toEqual([
      { lineStart: 2, lineEnd: 8, oursLabel: 'HEAD', baseLabel: 'merged common ancestors', theirsLabel: 'feature-branch' },
    ])
    expect(summary).not.toHaveProperty('regions[0].content')
    const json = JSON.parse(JSON.stringify(summary)) as { regions: Record<string, unknown>[] }
    expect(json.regions[0]).not.toHaveProperty('content')
    expect(json.regions[0]).not.toHaveProperty('ours')
    expect(json.regions[0]).not.toHaveProperty('theirs')
    expect(json.regions[0]).not.toHaveProperty('base')
  })

  it('preserves warnings unchanged', () => {
    const parsed = parseConflicts('src/bad1.ts', MISSING_SEPARATOR_FIXTURE)
    const summary = summarizeFileConflicts(parsed)
    expect(summary.warnings).toEqual(parsed.warnings)
  })
})

describe('formatConflicts / formatConflictSummaries', () => {
  it('prints a clear "no conflicts" message when nothing is found (not empty, not an error)', () => {
    const clean: FileConflicts = { filePath: 'src/clean.ts', regions: [], warnings: [] }
    expect(formatConflicts([clean])).toBe('No conflicts found.')
    expect(formatConflictSummaries([summarizeFileConflicts(clean)])).toBe('No conflicts found.')
  })

  it('omits clean files and includes conflicted files, with full content in the non-summary view', () => {
    const clean: FileConflicts = { filePath: 'src/clean.ts', regions: [], warnings: [] }
    const dirty = parseConflicts('src/dirty.ts', TWO_WAY_FIXTURE)
    const out = formatConflicts([clean, dirty])
    expect(out).not.toContain('src/clean.ts')
    expect(out).toContain('src/dirty.ts')
    expect(out).toContain('ours line 1')
    expect(out).toContain('theirs line 1')
  })

  it('omits full content in the summary view but keeps line ranges and labels', () => {
    const dirty = parseConflicts('src/dirty.ts', TWO_WAY_FIXTURE)
    const out = formatConflictSummaries([summarizeFileConflicts(dirty)])
    expect(out).toContain('src/dirty.ts')
    expect(out).toContain('lines 2-7')
    expect(out).not.toContain('ours line 1')
    expect(out).not.toContain('theirs line 1')
  })

  it('includes a malformed file (warnings only, zero valid regions) rather than silently dropping it', () => {
    const bad = parseConflicts('src/bad1.ts', MISSING_SEPARATOR_FIXTURE)
    const out = formatConflicts([bad])
    expect(out).toContain('src/bad1.ts')
    expect(out).toContain('warnings:')
    expect(out).toMatch(/Unterminated conflict marker/)
  })
})

describe('runConflicts (CLI handler)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-conflicts-cmds-'))
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
      indexing: { skip_dirs: [] },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reports conflicts for a single file', () => {
    const f = path.join(tempDir, 'a.ts')
    fs.writeFileSync(f, TWO_WAY_FIXTURE)
    const { stdout } = capture(() => { runConflicts({ path: f }) })
    expect(stdout).toContain('a.ts')
    expect(stdout).toContain('ours line 1')
  })

  it('emits structured JSON under --json', () => {
    const f = path.join(tempDir, 'a.ts')
    fs.writeFileSync(f, TWO_WAY_FIXTURE)
    const { stdout } = capture(() => { runConflicts({ path: f, json: true }) })
    const parsed = JSON.parse(stdout) as FileConflicts[]
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.regions).toHaveLength(1)
    expect(parsed[0]!.regions[0]!.ours.content).toBe('ours line 1\nours line 2')
  })

  it('emits summary-only JSON (no ours/base/theirs content) under --json --summary', () => {
    const f = path.join(tempDir, 'a.ts')
    fs.writeFileSync(f, TWO_WAY_FIXTURE)
    const { stdout } = capture(() => { runConflicts({ path: f, json: true, summary: true }) })
    const parsed = JSON.parse(stdout) as unknown[]
    expect(parsed).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain('ours line 1')
    expect(JSON.stringify(parsed)).toContain('conflictCount')
  })

  it('prints the "no conflicts" message for a clean file', () => {
    const f = path.join(tempDir, 'clean.ts')
    fs.writeFileSync(f, CLEAN_FIXTURE)
    const { stdout } = capture(() => { runConflicts({ path: f }) })
    expect(stdout).toContain('No conflicts found.')
  })

  it('returns 1 when the given path does not exist', () => {
    const code = runConflicts({ path: path.join(tempDir, 'missing.ts') })
    expect(code).toBe(1)
  })

  it('scans a directory via the real walkProject path, reporting only conflicted files', () => {
    const dirtyFile = path.join(tempDir, 'dirty.ts')
    const cleanFile = path.join(tempDir, 'clean.ts')
    fs.writeFileSync(dirtyFile, TWO_WAY_FIXTURE)
    fs.writeFileSync(cleanFile, CLEAN_FIXTURE)

    const { stdout } = capture(() => { runConflicts({ path: tempDir }) })
    expect(stdout).toContain('dirty.ts')
    expect(stdout).not.toContain('clean.ts')
  })

  it('scans the whole project from cwd when no path is given', () => {
    const dirtyFile = path.join(tempDir, 'dirty.ts')
    const cleanFile = path.join(tempDir, 'clean.ts')
    fs.writeFileSync(dirtyFile, TWO_WAY_FIXTURE)
    fs.writeFileSync(cleanFile, CLEAN_FIXTURE)

    const origCwd = process.cwd()
    process.chdir(tempDir)
    try {
      const { stdout } = capture(() => { runConflicts({}) })
      expect(stdout).toContain('dirty.ts')
      expect(stdout).not.toContain('clean.ts')
    } finally {
      process.chdir(origCwd)
    }
  })
})
