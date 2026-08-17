import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

// Stub config so the overflow guard (used by emitGuarded in runCoverageReportGaps's text-mode
// branch) has a deterministic, permissive budget instead of reading a real config.toml -- same
// pattern openapi_query.test.ts / read_commands.test.ts use for their own run* coverage.
vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
}))

import {
  detectCoverageFormat,
  parseLcov,
  parseIstanbulFinal,
  parseIstanbulSummary,
  parseCoverageReport,
  filterCoverageGapsByFile,
  formatCoverageGaps,
  type CoverageGapsReport,
} from '../src/coverage_query.js'
import { runCoverageReportGaps } from '../src/read_commands.js'
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

// ---- LCOV fixture: 4 files ----
// clean.ts: 100% covered (zero gaps, omitted from output)
// partial.ts: multiple lines uncovered, including two separate contiguous runs (10-12 and 20-21)
// branchy.ts: fully covered lines/functions, but one uncovered branch
// untested.ts: fully covered lines, but one uncovered function

const LCOV_FIXTURE = `TN:
SF:src/clean.ts
FN:1,cleanFn
FNDA:5,cleanFn
DA:1,5
DA:2,5
DA:3,5
FNF:1
FNH:1
LF:3
LH:3
end_of_record
SF:src/partial.ts
FN:1,partialFn
FNDA:3,partialFn
DA:1,3
DA:2,3
DA:5,0
DA:9,0
DA:10,0
DA:11,0
DA:12,0
DA:20,0
DA:21,0
DA:30,4
FNF:1
FNH:1
LF:10
LH:3
end_of_record
SF:src/branchy.ts
FN:1,branchyFn
FNDA:2,branchyFn
DA:1,2
DA:2,2
BRDA:2,0,0,2
BRDA:2,0,1,0
FNF:1
FNH:1
BRF:2
BRH:1
end_of_record
SF:src/untested.ts
FN:1,usedFn
FN:5,neverCalledFn
FNDA:1,usedFn
FNDA:0,neverCalledFn
DA:1,1
DA:2,1
DA:5,1
DA:6,1
FNF:2
FNH:1
LF:4
LH:4
end_of_record
`

const ISTANBUL_FINAL_FIXTURE = {
  '/repo/src/clean.ts': {
    path: '/repo/src/clean.ts',
    statementMap: { '0': { start: { line: 1 }, end: { line: 1 } } },
    fnMap: { '0': { name: 'cleanFn', loc: { start: { line: 1 }, end: { line: 1 } } } },
    branchMap: {},
    s: { '0': 5 },
    f: { '0': 5 },
    b: {},
  },
  '/repo/src/partial.ts': {
    path: '/repo/src/partial.ts',
    statementMap: {
      '0': { start: { line: 1 }, end: { line: 1 } },
      '1': { start: { line: 2 }, end: { line: 2 } },
      '2': { start: { line: 10 }, end: { line: 10 } },
      '3': { start: { line: 11 }, end: { line: 11 } },
      '4': { start: { line: 12 }, end: { line: 12 } },
    },
    fnMap: {
      '0': { name: 'usedFn', loc: { start: { line: 1 }, end: { line: 1 } } },
      '1': { name: 'unusedFn', loc: { start: { line: 20 }, end: { line: 20 } } },
    },
    branchMap: {
      '0': {
        loc: { start: { line: 30 } },
        locations: [{ start: { line: 30 } }, { start: { line: 31 } }],
      },
    },
    s: { '0': 3, '1': 3, '2': 0, '3': 0, '4': 0 },
    f: { '0': 3, '1': 0 },
    b: { '0': [2, 0] },
  },
}

const ISTANBUL_SUMMARY_FIXTURE = {
  '/repo/src/clean.ts': {
    lines: { total: 10, covered: 10, skipped: 0, pct: 100 },
    statements: { total: 10, covered: 10, skipped: 0, pct: 100 },
    functions: { total: 2, covered: 2, skipped: 0, pct: 100 },
    branches: { total: 4, covered: 4, skipped: 0, pct: 100 },
  },
  '/repo/src/partial.ts': {
    lines: { total: 20, covered: 15, skipped: 0, pct: 75 },
    statements: { total: 20, covered: 15, skipped: 0, pct: 75 },
    functions: { total: 3, covered: 2, skipped: 0, pct: 66.6 },
    branches: { total: 6, covered: 4, skipped: 0, pct: 66.6 },
  },
  total: {
    lines: { total: 30, covered: 25, skipped: 0, pct: 83.3 },
    statements: { total: 30, covered: 25, skipped: 0, pct: 83.3 },
    functions: { total: 5, covered: 4, skipped: 0, pct: 80 },
    branches: { total: 10, covered: 8, skipped: 0, pct: 80 },
  },
}

describe('detectCoverageFormat', () => {
  it('reads a summary report carrying only its total aggregate as a summary, not an empty final', () => {
    // A project with nothing instrumented still gets a coverage-summary.json, and it holds only
    // the `total` key. Filtering `total` out left no entries to match on, so the report came back
    // under the wrong format name.
    const metric = { total: 0, covered: 0, skipped: 0, pct: 'Unknown' }
    const text = JSON.stringify({ total: { lines: metric, statements: metric, functions: metric, branches: metric } })
    expect(detectCoverageFormat(text)).toBe('istanbul-summary')
  })

  it('still reads a genuinely empty object as an empty final report', () => {
    // The other side of the check above: `{}` has no `total` to identify it, and erroring on a
    // valid-but-contentless report would be worse than picking one of the two empty readings.
    expect(detectCoverageFormat('{}')).toBe('istanbul-final')
  })

  it('detects LCOV from a TN:/SF: content prefix, not a filename extension', () => {
    // No file extension involved at all here -- this asserts the content-based mechanism
    // actually implemented (a leading TN:/SF: record), not an extension-based one.
    expect(detectCoverageFormat(LCOV_FIXTURE)).toBe('lcov')
    expect(detectCoverageFormat('SF:foo.ts\nDA:1,1\nend_of_record\n')).toBe('lcov')
  })

  it('detects istanbul-final from statementMap/s per-file shape', () => {
    expect(detectCoverageFormat(JSON.stringify(ISTANBUL_FINAL_FIXTURE))).toBe('istanbul-final')
  })

  it('detects istanbul-summary from lines/statements/functions/branches aggregate shape', () => {
    expect(detectCoverageFormat(JSON.stringify(ISTANBUL_SUMMARY_FIXTURE))).toBe('istanbul-summary')
  })

  it('treats an empty JSON object as an empty istanbul-final report rather than erroring', () => {
    expect(detectCoverageFormat('{}')).toBe('istanbul-final')
  })

  it('throws on content that is neither valid JSON nor LCOV-shaped', () => {
    expect(() => detectCoverageFormat('this is not a coverage report at all')).toThrow(/could not detect/)
  })

  it('throws on valid JSON that matches neither Istanbul shape', () => {
    expect(() => detectCoverageFormat(JSON.stringify({ hello: 'world' }))).toThrow(/not a recognized coverage report/)
  })

  // Regression (mutation-testing gap): the root-shape guard explicitly rejects a JSON array
  // (typeof [] === 'object', so the array check needs its own Array.isArray branch, not just
  // the typeof/null checks). Dropping that branch still passed the full suite, since an empty
  // array's filtered Object.entries() is also empty and fell through to the "empty object ->
  // empty istanbul-final report" fallback instead of throwing -- silently misdetecting a JSON
  // array root as a valid, contentless coverage report.
  it('throws on a JSON array root instead of misdetecting it as an empty coverage report', () => {
    expect(() => detectCoverageFormat('[]')).toThrow(/not a recognized coverage report/)
  })
})

describe('parseLcov', () => {
  let report: CoverageGapsReport

  beforeEach(() => {
    report = parseLcov(LCOV_FIXTURE)
  })

  it('counts two same-named functions separately instead of collapsing them onto the last one', () => {
    // Two functions in one file may legitimately share a name -- methods of two classes, or a
    // nested function shadowing an outer one. Keying by name alone kept only the last FN record,
    // so the total was undercounted and the earlier one could never be reported as a gap.
    const dup = parseLcov(['TN:', 'SF:/src/x.js', 'FN:1,foo', 'FN:5,foo', 'FNDA:0,foo', 'FNDA:0,foo', 'DA:1,1', 'DA:5,1', 'end_of_record'].join('\n'))
    const f = dup.files[0]!
    expect(f.functionsTotal).toBe(2)
    expect(f.functionsHit).toBe(0)
    expect(f.uncoveredFunctions).toEqual([{ name: 'foo', line: 1 }, { name: 'foo', line: 5 }])
  })

  it('collapses a genuinely repeated FN record, which is one function listed twice', () => {
    const repeated = parseLcov(['SF:/src/x.js', 'FN:1,foo', 'FN:1,foo', 'FNDA:0,foo', 'DA:1,0', 'end_of_record'].join('\n'))
    expect(repeated.files[0]!.functionsTotal).toBe(1)
  })

  it('sums FNDA hits for a shared name, so a covered run is not overwritten by an uncovered one', () => {
    // LCOV v1 keys hits by name only, so with a shared name it cannot say which function ran.
    // Overwriting made the answer depend on record order; summing reports the name as covered,
    // which is the reading that does not invent a gap the report never claimed.
    // DA:9,0 keeps the file in the report: with the functions all covered it would otherwise have
    // no gap at all and be dropped by rankAndFilter, leaving nothing to assert the counts on.
    const shared = parseLcov(['SF:/src/x.js', 'FN:1,foo', 'FN:5,foo', 'FNDA:3,foo', 'FNDA:0,foo', 'DA:1,1', 'DA:9,0', 'end_of_record'].join('\n'))
    const f = shared.files[0]!
    expect(f.functionsHit).toBe(2)
    expect(f.uncoveredFunctions).toEqual([])
  })

  it('omits the fully-covered file', () => {
    expect(report.files.find((f) => f.filePath === 'src/clean.ts')).toBeUndefined()
  })

  it('collapses contiguous uncovered lines into ranges, with gaps producing separate ranges', () => {
    const partial = report.files.find((f) => f.filePath === 'src/partial.ts')
    expect(partial).toBeDefined()
    // Uncovered lines: 5, 9, 10, 11, 12, 20, 21 -> ranges [5,5] [9,12] [20,21]
    expect(partial!.uncoveredLineRanges).toEqual([
      { start: 5, end: 5 },
      { start: 9, end: 12 },
      { start: 20, end: 21 },
    ])
    expect(partial!.uncoveredLineCount).toBe(7)
    expect(partial!.linesHit).toBe(3)
    expect(partial!.linesTotal).toBe(10)
  })

  it('reports an uncovered branch (BRDA hit-count 0) without flagging fully-covered lines/functions', () => {
    const branchy = report.files.find((f) => f.filePath === 'src/branchy.ts')
    expect(branchy).toBeDefined()
    expect(branchy!.uncoveredLineRanges).toEqual([])
    expect(branchy!.uncoveredFunctions).toEqual([])
    expect(branchy!.uncoveredBranches).toEqual([{ line: 2 }])
    expect(branchy!.branchesHit).toBe(1)
    expect(branchy!.branchesTotal).toBe(2)
  })

  it('reports an uncovered function (FNDA hit-count 0) without flagging fully-covered lines', () => {
    const untested = report.files.find((f) => f.filePath === 'src/untested.ts')
    expect(untested).toBeDefined()
    expect(untested!.uncoveredLineRanges).toEqual([])
    expect(untested!.uncoveredFunctions).toEqual([{ name: 'neverCalledFn', line: 5 }])
    expect(untested!.functionsHit).toBe(1)
    expect(untested!.functionsTotal).toBe(2)
  })

  it('treats a BRDA hit-count of "-" (never executed) as an uncovered branch', () => {
    const r = parseLcov('SF:src/x.ts\nDA:1,1\nBRDA:1,0,0,-\nend_of_record\n')
    const x = r.files.find((f) => f.filePath === 'src/x.ts')
    expect(x!.uncoveredBranches).toEqual([{ line: 1 }])
  })

  it('joins an LCOV v2 three-field FN record (FN:<start>,<end>,<name>) with its FNDA by name', () => {
    // Regression: lcov >= 2.0 (geninfo) may emit an optional end-line field in FN records.
    // Keying fnLines by everything after the first comma ("10,foo") while FNDA keys by the bare
    // name ("foo") made every function in a v2 report a phantom uncovered function.
    const r = parseLcov('SF:src/v2.ts\nFN:5,10,foo\nFNDA:3,foo\nDA:5,3\nend_of_record\n')
    const f = r.files.find((f2) => f2.filePath === 'src/v2.ts')
    // foo was hit 3 times -- the file has no gaps at all and must be omitted entirely.
    expect(f).toBeUndefined()

    // And an actually-uncovered v2-format function is still reported, at its start line.
    const r2 = parseLcov('SF:src/v2b.ts\nFN:7,12,bar\nFNDA:0,bar\nDA:7,1\nend_of_record\n')
    const f2b = r2.files.find((x) => x.filePath === 'src/v2b.ts')
    expect(f2b).toBeDefined()
    expect(f2b!.uncoveredFunctions).toEqual([{ name: 'bar', line: 7 }])
  })

  it('sorts files worst-offenders-first by uncovered-line-count descending', () => {
    // partial.ts has 7 uncovered lines; branchy.ts and untested.ts have 0 uncovered lines but
    // still appear (branch/function gaps), so partial.ts must sort first.
    expect(report.files[0]!.filePath).toBe('src/partial.ts')
  })

  // Regression (mutation-testing gap): rankAndFilter's sort has an explicit tie-break
  // (a.filePath.localeCompare(b.filePath)) for files with equal uncoveredLineCount, so ordering
  // is deterministic regardless of the source report's own file order. Dropping the tie-break
  // still passed the full suite, since Array.prototype.sort is stable and every existing
  // multi-file fixture's insertion order already happened to match alphabetical order for its
  // tied entries -- masking the fact that without the tie-break, two equally-uncovered files
  // sorted only by their position in the source report, not by path.
  it('breaks a tie in uncovered-line-count by filePath ascending, independent of source order', () => {
    // Both files have 0 uncovered lines but a real gap (an uncovered function), so both survive
    // rankAndFilter's filter and tie on uncoveredLineCount -- and are inserted in
    // reverse-alphabetical order, so a source-order-preserving (no tie-break) sort would list
    // zzz.ts before aaa.ts.
    const lcov = [
      'SF:src/zzz.ts',
      'FN:1,zzzFn',
      'FNDA:0,zzzFn',
      'DA:1,1',
      'end_of_record',
      'SF:src/aaa.ts',
      'FN:1,aaaFn',
      'FNDA:0,aaaFn',
      'DA:1,1',
      'end_of_record',
      '',
    ].join('\n')
    const r = parseLcov(lcov)
    expect(r.files.map((f) => f.filePath)).toEqual(['src/aaa.ts', 'src/zzz.ts'])
  })

  // Regression: rankAndFilter's tie-break used a.filePath.localeCompare(b.filePath) -- with no
  // explicit locale this resolves to the host's default ICU collation (Windows regional
  // setting, or LANG/LC_ALL on Linux/CI), which can order two tied paths differently across
  // machines, defeating the "determinism" the tie-break exists for. formatCoverageGaps's output
  // can be truncated by size, so a locale-dependent tie order can silently change which files
  // survive truncation on a different machine. The fix uses a plain ordinal (UTF-16 code-unit)
  // comparison instead, matching hooks_read.ts's isProtectedRecentRead fix for the identical
  // bug class -- so localeCompare must never be invoked by this code path at all.
  it('breaks the uncovered-line-count tie without calling the locale-dependent String.prototype.localeCompare', () => {
    const lcov = [
      'SF:src/zzz.ts',
      'FN:1,zzzFn',
      'FNDA:0,zzzFn',
      'DA:1,1',
      'end_of_record',
      'SF:src/aaa.ts',
      'FN:1,aaaFn',
      'FNDA:0,aaaFn',
      'DA:1,1',
      'end_of_record',
      '',
    ].join('\n')
    const localeCompareSpy = vi.spyOn(String.prototype, 'localeCompare')
    try {
      parseLcov(lcov)
      expect(localeCompareSpy).not.toHaveBeenCalled()
    } finally {
      localeCompareSpy.mockRestore()
    }
  })

  it('tolerates a missing trailing end_of_record by closing the last open section at EOF', () => {
    const r = parseLcov('SF:src/noeor.ts\nDA:1,0\n')
    const f = r.files.find((f2) => f2.filePath === 'src/noeor.ts')
    expect(f).toBeDefined()
    expect(f!.uncoveredLineRanges).toEqual([{ start: 1, end: 1 }])
  })

  it('produces the "no gaps" state (empty files array) when every file is 100% covered', () => {
    const r = parseLcov('SF:src/clean.ts\nDA:1,1\nDA:2,1\nend_of_record\n')
    expect(r.files).toEqual([])
  })
})

describe('parseIstanbulFinal', () => {
  let report: CoverageGapsReport

  beforeEach(() => {
    report = parseIstanbulFinal(ISTANBUL_FINAL_FIXTURE)
  })

  it('reports a function gap at its declaration line, not where its body opens', () => {
    // Istanbul's `decl` is the declaration itself; `loc` spans the whole function including the
    // body, and the two differ when the body opens on a later line than the name. The declaration
    // line is both what this function's docstring promises and the line worth jumping to.
    const declFirst = parseIstanbulFinal({
      '/tmp/a.js': {
        statementMap: { '0': { start: { line: 3, column: 4 }, end: { line: 3, column: 12 } } },
        fnMap: { '0': { name: 'foo', line: 1, loc: { start: { line: 2, column: 2 }, end: { line: 4, column: 3 } }, decl: { start: { line: 1, column: 6 }, end: { line: 1, column: 9 } } } },
        branchMap: {},
        s: { '0': 0 },
        f: { '0': 0 },
        b: {},
      },
    })
    expect(declFirst.files[0]!.uncoveredFunctions).toEqual([{ name: 'foo', line: 1 }])
  })

  it('falls back to the loc line when a function record carries no decl', () => {
    const noDecl = parseIstanbulFinal({
      '/tmp/a.js': {
        statementMap: {},
        fnMap: { '0': { name: 'bar', loc: { start: { line: 7, column: 0 }, end: { line: 9, column: 1 } } } },
        branchMap: {},
        s: {},
        f: { '0': 0 },
        b: {},
      },
    })
    expect(noDecl.files[0]!.uncoveredFunctions).toEqual([{ name: 'bar', line: 7 }])
  })

  it('omits the fully-covered file', () => {
    expect(report.files.find((f) => f.filePath === '/repo/src/clean.ts')).toBeUndefined()
  })

  it('maps uncovered statements to line ranges, uncovered functions to name+line, uncovered branches to line', () => {
    const partial = report.files.find((f) => f.filePath === '/repo/src/partial.ts')
    expect(partial).toBeDefined()
    expect(partial!.uncoveredLineRanges).toEqual([{ start: 10, end: 12 }])
    expect(partial!.uncoveredFunctions).toEqual([{ name: 'unusedFn', line: 20 }])
    expect(partial!.uncoveredBranches).toEqual([{ line: 31 }])
    expect(partial!.summaryOnly).toBe(false)
  })

  it('does not throw on an fnMap/branchMap entry whose loc is present but has no start key (fail-on-buggy: `loc?.start.line` only guards the loc hop, not the trailing .line access on a missing start)', () => {
    const fixture = {
      '/repo/src/edge.ts': {
        path: '/repo/src/edge.ts',
        statementMap: {},
        s: {},
        fnMap: { '0': { name: 'weird', loc: {} } },
        f: { '0': 0 },
        branchMap: { '0': { loc: {}, locations: [{}] } },
        b: { '0': [0] },
      },
    }
    expect(() => parseIstanbulFinal(fixture)).not.toThrow()
    const result = parseIstanbulFinal(fixture)
    const file = result.files.find((f) => f.filePath === '/repo/src/edge.ts')
    expect(file).toBeDefined()
    expect(file!.uncoveredFunctions).toEqual([{ name: 'weird', line: 0 }])
    expect(file!.uncoveredBranches).toEqual([{ line: 0 }])
  })
})

describe('parseIstanbulSummary', () => {
  let report: CoverageGapsReport

  beforeEach(() => {
    report = parseIstanbulSummary(ISTANBUL_SUMMARY_FIXTURE)
  })

  it('excludes the "total" aggregate key from per-file results', () => {
    expect(report.files.find((f) => f.filePath === 'total')).toBeUndefined()
  })

  it('omits the fully-covered file', () => {
    expect(report.files.find((f) => f.filePath === '/repo/src/clean.ts')).toBeUndefined()
  })

  it('reports file-level aggregate stats only, with no per-line detail (summaryOnly)', () => {
    const partial = report.files.find((f) => f.filePath === '/repo/src/partial.ts')
    expect(partial).toBeDefined()
    expect(partial!.summaryOnly).toBe(true)
    expect(partial!.uncoveredLineRanges).toEqual([])
    expect(partial!.uncoveredFunctions).toEqual([])
    expect(partial!.uncoveredBranches).toEqual([])
    expect(partial!.linesHit).toBe(15)
    expect(partial!.linesTotal).toBe(20)
    expect(partial!.functionsHit).toBe(2)
    expect(partial!.branchesHit).toBe(4)
  })

  it('does not crash looking for per-line detail that does not exist in this format', () => {
    expect(() => parseIstanbulSummary(ISTANBUL_SUMMARY_FIXTURE)).not.toThrow()
  })
})

describe('parseCoverageReport (auto-detect + parse)', () => {
  it('routes LCOV content to the LCOV parser', () => {
    const r = parseCoverageReport(LCOV_FIXTURE)
    expect(r.format).toBe('lcov')
  })

  it('routes coverage-final.json content to the Istanbul-final parser', () => {
    const r = parseCoverageReport(JSON.stringify(ISTANBUL_FINAL_FIXTURE))
    expect(r.format).toBe('istanbul-final')
  })

  it('routes coverage-summary.json content to the Istanbul-summary parser', () => {
    const r = parseCoverageReport(JSON.stringify(ISTANBUL_SUMMARY_FIXTURE))
    expect(r.format).toBe('istanbul-summary')
  })

  it('strips a leading UTF-8 BOM before parsing a JSON report (fail-on-buggy: JSON.parse throws "Unexpected token" on a BOM-prefixed file, common from Windows editors)', () => {
    const r = parseCoverageReport('﻿' + JSON.stringify(ISTANBUL_FINAL_FIXTURE))
    expect(r.format).toBe('istanbul-final')
  })
})

describe('filterCoverageGapsByFile', () => {
  const report = parseLcov(LCOV_FIXTURE)

  it('matches an exact path', () => {
    const scoped = filterCoverageGapsByFile(report, 'src/partial.ts')
    expect(scoped.files.map((f) => f.filePath)).toEqual(['src/partial.ts'])
  })

  it('matches a suffix at a path-segment boundary', () => {
    const scoped = filterCoverageGapsByFile(report, 'partial.ts')
    expect(scoped.files.map((f) => f.filePath)).toEqual(['src/partial.ts'])
  })

  it('does not falsely suffix-match across a segment boundary', () => {
    const scoped = filterCoverageGapsByFile(report, 'artial.ts')
    expect(scoped.files).toEqual([])
  })

  it('matches case-insensitively on a case-insensitive filesystem (fail-on-buggy: normalizePath only lowercases the drive letter, so a differently-cased query never matched)', () => {
    const prevOverride = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '1'
    try {
      const scoped = filterCoverageGapsByFile(report, 'SRC/PARTIAL.TS')
      expect(scoped.files.map((f) => f.filePath)).toEqual(['src/partial.ts'])
    } finally {
      if (prevOverride === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevOverride
    }
  })

  it('stays case-sensitive on a case-sensitive filesystem', () => {
    const prevOverride = process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
    process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = '0'
    try {
      const scoped = filterCoverageGapsByFile(report, 'SRC/PARTIAL.TS')
      expect(scoped.files).toEqual([])
    } finally {
      if (prevOverride === undefined) delete process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS']
      else process.env['TOKEN_GOAT_CASE_INSENSITIVE_FS'] = prevOverride
    }
  })
})

describe('formatCoverageGaps', () => {
  it('prints a single clear message when the report has zero gaps', () => {
    const empty: CoverageGapsReport = { format: 'lcov', files: [] }
    expect(formatCoverageGaps(empty)).toBe('No coverage gaps found -- 100% coverage.')
  })

  it('renders collapsed ranges, functions, and branches for a detailed report', () => {
    const report = parseLcov(LCOV_FIXTURE)
    const text = formatCoverageGaps(report)
    expect(text).toContain('src/partial.ts')
    expect(text).toContain('9-12')
    expect(text).toContain('20-21')
    expect(text).toContain('neverCalledFn')
  })

  it('marks a summary-only file distinctly instead of pretending to have per-line detail', () => {
    const report = parseIstanbulSummary(ISTANBUL_SUMMARY_FIXTURE)
    const text = formatCoverageGaps(report)
    expect(text).toContain('summary-only report')
  })

  // Regression (mutation-testing gap): the uncovered-branches line pluralizes "line"/"lines"
  // based on how many distinct branch lines there are. Hardcoding the plural form still passed
  // the full suite, since no existing formatCoverageGaps test asserted the exact singular-vs-
  // plural wording -- only that some text containing the data was present.
  it('uses singular "line" for exactly one uncovered branch line, plural "lines" for more than one', () => {
    const branchy = parseLcov(LCOV_FIXTURE)
    const branchyText = formatCoverageGaps(branchy)
    expect(branchyText).toContain('uncovered branches at line: 2')
    expect(branchyText).not.toContain('uncovered branches at lines: 2')

    const multi = parseLcov('SF:src/multi.ts\nDA:1,1\nBRDA:1,0,0,0\nBRDA:2,0,0,0\nend_of_record\n')
    const multiText = formatCoverageGaps(multi)
    expect(multiText).toContain('uncovered branches at lines: 1, 2')
  })
})

describe('runCoverageReportGaps (CLI handler)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-coverage-cmds-'))
    vi.clearAllMocks()
    mockLoadConfig.mockReturnValue({
      overflow_guard: { enabled: true, max_tokens: 25000 },
    } as unknown as ReturnType<typeof loadConfig>)
  })

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('prints only the gaps for an LCOV report', () => {
    const f = path.join(tempDir, 'lcov.info')
    fs.writeFileSync(f, LCOV_FIXTURE)
    const { stdout } = capture(() => { runCoverageReportGaps({ file: f }) })
    expect(stdout).toContain('src/partial.ts')
    expect(stdout).not.toContain('src/clean.ts')
  })

  it('narrows to one file via --file', () => {
    const f = path.join(tempDir, 'lcov.info')
    fs.writeFileSync(f, LCOV_FIXTURE)
    const { stdout } = capture(() => { runCoverageReportGaps({ file: f, fileFilter: 'branchy.ts' }) })
    expect(stdout).toContain('src/branchy.ts')
    expect(stdout).not.toContain('src/partial.ts')
    expect(stdout).not.toContain('src/untested.ts')
  })

  it('emits a structured JSON report under --json', () => {
    const f = path.join(tempDir, 'coverage-final.json')
    fs.writeFileSync(f, JSON.stringify(ISTANBUL_FINAL_FIXTURE))
    const { stdout } = capture(() => { runCoverageReportGaps({ file: f, json: true }) })
    const parsed = JSON.parse(stdout) as CoverageGapsReport
    expect(parsed.format).toBe('istanbul-final')
    expect(parsed.files.map((x) => x.filePath)).toEqual(['/repo/src/partial.ts'])
  })

  it('handles coverage-summary.json gracefully with file-level-only output, no crash', () => {
    const f = path.join(tempDir, 'coverage-summary.json')
    fs.writeFileSync(f, JSON.stringify(ISTANBUL_SUMMARY_FIXTURE))
    let code = -1
    const { stdout } = capture(() => { code = runCoverageReportGaps({ file: f }) })
    expect(code).toBe(0)
    expect(stdout).toContain('summary-only report')
  })

  it('returns 1 when the file does not exist', () => {
    const code = runCoverageReportGaps({ file: path.join(tempDir, 'missing.info') })
    expect(code).toBe(1)
  })

  it('returns 1 with a clean error message on malformed/truncated LCOV-ish input', () => {
    const f = path.join(tempDir, 'bad.info')
    fs.writeFileSync(f, 'not a coverage report of any kind')
    let code = -1
    const { stderr } = capture(() => { code = runCoverageReportGaps({ file: f }) })
    expect(code).toBe(1)
    expect(stderr).toContain('Failed to parse coverage report')
    expect(stderr).not.toMatch(/\.ts:\d+:\d+/) // no stack-trace frame leaking through
  })

  it('returns 1 with a clean error message on truncated/malformed Istanbul JSON', () => {
    const f = path.join(tempDir, 'bad.json')
    fs.writeFileSync(f, '{ "src/x.ts": { "statementMap": ')
    let code = -1
    const { stderr } = capture(() => { code = runCoverageReportGaps({ file: f }) })
    expect(code).toBe(1)
    expect(stderr).toContain('Failed to parse coverage report')
  })

  it('prints the "no gaps" message (human mode) when the report has zero gaps overall', () => {
    const f = path.join(tempDir, 'clean.info')
    fs.writeFileSync(f, 'SF:src/clean.ts\nDA:1,1\nDA:2,1\nend_of_record\n')
    const { stdout } = capture(() => { runCoverageReportGaps({ file: f }) })
    expect(stdout).toContain('No coverage gaps found')
  })

  it('reflects the "no gaps" state as an empty files array under --json', () => {
    const f = path.join(tempDir, 'clean.info')
    fs.writeFileSync(f, 'SF:src/clean.ts\nDA:1,1\nDA:2,1\nend_of_record\n')
    const { stdout } = capture(() => { runCoverageReportGaps({ file: f, json: true }) })
    const parsed = JSON.parse(stdout) as CoverageGapsReport
    expect(parsed.files).toEqual([])
  })
})
