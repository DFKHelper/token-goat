/**
 * Narrow "gaps only" extraction for `token-goat coverage-report-gaps`, so a code-coverage report
 * (which can run to tens of thousands of lines for a real project) never needs a full `Read` just
 * to answer "what isn't tested". Mirrors openapi_query.ts's split: pure parsing/detection/
 * extraction/formatting here, CLI I/O (readFileText, emit/emitErr, overflow guard) in
 * read_commands.ts.
 *
 * Two source formats are supported:
 *  - LCOV `.info` text (hand-rolled line-oriented parser -- the format is simple enough that a
 *    dependency isn't proportionate; see the project convention set by csv_query.ts).
 *  - Istanbul/nyc JSON, in either of its two shapes: `coverage-final.json` (per-file
 *    statementMap/fnMap/branchMap + hit-count maps, giving line/function/branch-level detail) or
 *    `coverage-summary.json` (aggregate-only counts per file, no per-line detail -- reported as
 *    file-level summary stats with an explicit `summaryOnly` flag rather than crashing while
 *    looking for detail that isn't there).
 */

import { normalizePath } from './paths.js'
import { foldPath, stripBom } from './util.js'

// ---- shared types -------------------------------------------------------------

export interface LineRange {
  start: number
  end: number
}

export interface FunctionGap {
  name: string
  line: number
}

export interface BranchGap {
  line: number
}

export interface FileCoverageGaps {
  filePath: string
  linesTotal: number
  linesHit: number
  functionsTotal: number
  functionsHit: number
  branchesTotal: number
  branchesHit: number
  /** Contiguous uncovered line numbers collapsed into ranges (see collapseLineRanges). Empty
   * for a `summaryOnly` file -- coverage-summary.json carries no per-line detail. */
  uncoveredLineRanges: LineRange[]
  /** Total count of individual uncovered lines (linesTotal - linesHit), used for the
   * worst-offenders-first sort regardless of source format. */
  uncoveredLineCount: number
  uncoveredFunctions: FunctionGap[]
  uncoveredBranches: BranchGap[]
  /** True for coverage-summary.json entries: aggregate counts only, no per-line/function/branch
   * detail to report. */
  summaryOnly: boolean
}

export type CoverageReportFormat = 'lcov' | 'istanbul-final' | 'istanbul-summary'

export interface CoverageGapsReport {
  format: CoverageReportFormat
  /** Files with at least one gap, sorted by uncovered-line-count descending (ties broken by
   * path, alphabetically). A file with zero gaps in every category is omitted entirely --
   * there's nothing to show for it. */
  files: FileCoverageGaps[]
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Merges consecutive integers in a sorted, deduplicated line-number list into inclusive
 * ranges, e.g. [42,43,44,47] -> [{start:42,end:44},{start:47,end:47}]. Assumes `sortedLines` is
 * already ascending and has no duplicates (every call site builds it that way). */
function collapseLineRanges(sortedLines: readonly number[]): LineRange[] {
  const ranges: LineRange[] = []
  for (const n of sortedLines) {
    const last = ranges[ranges.length - 1]
    if (last !== undefined && n === last.end + 1) {
      last.end = n
    } else {
      ranges.push({ start: n, end: n })
    }
  }
  return ranges
}

/** True when a file has at least one reportable gap. For a detailed (LCOV / coverage-final)
 * file this is just the per-item lists; for a summaryOnly (coverage-summary.json) file those
 * lists are always empty (no per-item detail exists), so functions/branches hit-vs-total is
 * checked directly instead. */
function hasGap(f: FileCoverageGaps): boolean {
  return (
    f.uncoveredLineCount > 0 ||
    f.uncoveredFunctions.length > 0 ||
    f.uncoveredBranches.length > 0 ||
    f.functionsHit < f.functionsTotal ||
    f.branchesHit < f.branchesTotal
  )
}

/** Drops fully-covered files and sorts the rest worst-offenders-first: uncovered-line-count
 * descending (the most actionable signal -- biggest test-writing opportunity first), ties
 * broken by path ascending for determinism. */
function rankAndFilter(files: readonly FileCoverageGaps[]): FileCoverageGaps[] {
  const withGaps = files.filter(hasGap)
  withGaps.sort((a, b) => b.uncoveredLineCount - a.uncoveredLineCount || a.filePath.localeCompare(b.filePath))
  return withGaps
}

// ---- format detection -----------------------------------------------------------

/**
 * Detects which of the three supported shapes `text` is. JSON is tried first (a clear parse
 * success beats guessing from content); the parsed root is then inspected structurally --
 * per-file entries carrying `statementMap`/`s` are coverage-final, entries carrying
 * `lines`/`statements`/`functions`/`branches` aggregate objects are coverage-summary -- rather
 * than trusting the filename extension, since a report can be piped through renamed. Only when
 * JSON parsing fails does this fall back to LCOV's own content signature (`TN:`/`SF:` as the
 * first non-blank line), mirroring parseOpenApiSpec's "valid JSON is also valid YAML, try the
 * stricter parser first" ordering. Throws a plain Error (no stack trace surfaced to the CLI) when
 * neither shape matches.
 */
export function detectCoverageFormat(text: string): CoverageReportFormat {
  let parsed: unknown
  let isJson = true
  try {
    parsed = JSON.parse(text)
  } catch {
    isJson = false
  }

  if (isJson) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not a recognized coverage report (JSON root is not an object of per-file entries)')
    }
    const entries = Object.entries(parsed as Record<string, unknown>).filter(([k]) => k !== 'total')

    const looksFinal = entries.some(
      ([, v]) => typeof v === 'object' && v !== null && 'statementMap' in (v as object) && 's' in (v as object),
    )
    if (looksFinal) return 'istanbul-final'

    const looksSummary = entries.some(
      ([, v]) =>
        typeof v === 'object' &&
        v !== null &&
        'lines' in (v as object) &&
        'statements' in (v as object) &&
        'functions' in (v as object) &&
        'branches' in (v as object),
    )
    if (looksSummary) return 'istanbul-summary'

    // An empty object ({}) is valid but ambiguous -- treat it as an empty coverage-final report
    // ("0 files, 0 gaps") rather than erroring on a technically-valid-but-contentless input.
    if (entries.length === 0) return 'istanbul-final'

    throw new Error('not a recognized coverage report (JSON does not match Istanbul coverage-final or coverage-summary shape)')
  }

  const trimmedStart = text.replace(/^\s+/, '')
  if (/^(TN:|SF:)/.test(trimmedStart)) return 'lcov'

  throw new Error('could not detect coverage report format (not valid LCOV, and not valid JSON)')
}

// ---- LCOV -------------------------------------------------------------------------

interface LcovFileAccumulator {
  filePath: string
  daLines: Map<number, number>
  fnLines: Map<string, number>
  fnHits: Map<string, number>
  brda: Array<{ line: number; hits: number | null }>
}

function buildLcovFileGaps(acc: LcovFileAccumulator): FileCoverageGaps {
  const linesTotal = acc.daLines.size
  const uncoveredLineNums = [...acc.daLines.entries()]
    .filter(([, hits]) => hits === 0)
    .map(([ln]) => ln)
    .sort((a, b) => a - b)
  const linesHit = linesTotal - uncoveredLineNums.length

  const functionsTotal = acc.fnLines.size
  const uncoveredFunctions: FunctionGap[] = []
  for (const [name, line] of acc.fnLines) {
    if ((acc.fnHits.get(name) ?? 0) === 0) uncoveredFunctions.push({ name, line })
  }
  uncoveredFunctions.sort((a, b) => a.line - b.line)
  const functionsHit = functionsTotal - uncoveredFunctions.length

  const branchesTotal = acc.brda.length
  const uncoveredBranches: BranchGap[] = acc.brda.filter((b) => b.hits === null || b.hits === 0).map((b) => ({ line: b.line }))
  const branchesHit = branchesTotal - uncoveredBranches.length

  return {
    filePath: acc.filePath,
    linesTotal,
    linesHit,
    functionsTotal,
    functionsHit,
    branchesTotal,
    branchesHit,
    uncoveredLineRanges: collapseLineRanges(uncoveredLineNums),
    uncoveredLineCount: uncoveredLineNums.length,
    uncoveredFunctions,
    uncoveredBranches,
    summaryOnly: false,
  }
}

/**
 * Hand-rolled line-oriented LCOV `.info` parser. Record types handled: `SF:` (start a file
 * section), `DA:<line>,<hits>` (line hit data), `FN:<line>,<name>` / `FNDA:<hits>,<name>`
 * (function declaration + hit count, joined by name), `BRDA:<line>,<block>,<branch>,<hits|->`
 * (branch hit data; `-` means never executed, treated the same as a `0` hit count), and
 * `end_of_record` (close the current file section). `TN:` and the `LH:`/`LF:`/`FNH:`/`FNF:`/
 * `BRH:`/`BRF:` summary lines are ignored -- every stat here is computed from the underlying
 * DA/FN/FNDA/BRDA records instead, so a report that omits the optional summary lines (or has
 * them go stale relative to the detail records) still produces correct output. Unrecognized or
 * malformed individual lines are skipped rather than aborting the whole parse -- LCOV producers
 * vary, and a report that's mostly well-formed should still yield whatever gaps it can. A file
 * section left open at end-of-input (a missing trailing `end_of_record`) is still closed and
 * counted, since real-world LCOV output sometimes omits it on the last record.
 */
export function parseLcov(text: string): CoverageGapsReport {
  const files: FileCoverageGaps[] = []
  let cur: LcovFileAccumulator | null = null

  const closeCurrent = (): void => {
    if (cur === null) return
    files.push(buildLcovFileGaps(cur))
    cur = null
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue

    if (line.startsWith('SF:')) {
      closeCurrent()
      cur = { filePath: line.slice(3).trim(), daLines: new Map(), fnLines: new Map(), fnHits: new Map(), brda: [] }
      continue
    }
    if (cur === null) continue
    if (line === 'end_of_record') {
      closeCurrent()
      continue
    }

    if (line.startsWith('DA:')) {
      const [rawLineNo, rawHits] = line.slice(3).split(',')
      const lineNo = Number.parseInt(rawLineNo ?? '', 10)
      const hits = Number.parseInt(rawHits ?? '', 10)
      if (Number.isFinite(lineNo) && Number.isFinite(hits)) cur.daLines.set(lineNo, hits)
      continue
    }

    if (line.startsWith('FN:')) {
      const rest = line.slice(3)
      const comma = rest.indexOf(',')
      if (comma !== -1) {
        const lineNo = Number.parseInt(rest.slice(0, comma), 10)
        const name = rest.slice(comma + 1)
        if (Number.isFinite(lineNo)) cur.fnLines.set(name, lineNo)
      }
      continue
    }

    if (line.startsWith('FNDA:')) {
      const rest = line.slice(5)
      const comma = rest.indexOf(',')
      if (comma !== -1) {
        const hits = Number.parseInt(rest.slice(0, comma), 10)
        const name = rest.slice(comma + 1)
        if (Number.isFinite(hits)) cur.fnHits.set(name, hits)
      }
      continue
    }

    if (line.startsWith('BRDA:')) {
      const parts = line.slice(5).split(',')
      const lineNo = Number.parseInt(parts[0] ?? '', 10)
      const rawHits = parts[3]
      if (Number.isFinite(lineNo)) {
        const hits = rawHits === '-' ? null : Number.parseInt(rawHits ?? '', 10)
        cur.brda.push({ line: lineNo, hits: hits !== null && Number.isFinite(hits) ? hits : null })
      }
      continue
    }
    // TN:, LH:, LF:, FNH:, FNF:, BRH:, BRF:, and any other/unrecognized record -- ignored.
  }
  closeCurrent()

  return { format: 'lcov', files: rankAndFilter(files) }
}

// ---- Istanbul coverage-final.json --------------------------------------------------

interface IstanbulLoc {
  line: number
  column?: number
}
interface IstanbulRange {
  start: IstanbulLoc
  end?: IstanbulLoc
}

/**
 * Extracts gaps from Istanbul/nyc `coverage-final.json`: uncovered statements (`s[id] === 0`,
 * mapped via `statementMap[id]` back to a line), uncovered functions (`f[id] === 0`, mapped via
 * `fnMap[id]` to a name + declaration line), and uncovered branches (any element of `b[id]`
 * that's `0`, mapped via `branchMap[id]` to a line, preferring the specific alternative's own
 * `locations[i]` over the branch's overall `loc`).
 *
 * Per-file line stats are derived from `statementMap`/`s` by bucketing each statement under its
 * *starting* line (rather than expanding every statement's full start-end span into individual
 * line entries) -- Istanbul statements only rarely span multiple physical lines, and bucketing by
 * start line avoids ambiguity when a covered and an uncovered statement share a line. A line is
 * "hit" if any statement starting on it has a nonzero count.
 */
export function parseIstanbulFinal(data: Record<string, unknown>): CoverageGapsReport {
  const files: FileCoverageGaps[] = []

  for (const [filePath, entryRaw] of Object.entries(data)) {
    if (typeof entryRaw !== 'object' || entryRaw === null) continue
    const entry = entryRaw as Record<string, unknown>
    const statementMap = (entry['statementMap'] ?? {}) as Record<string, IstanbulRange>
    const s = (entry['s'] ?? {}) as Record<string, number>
    const fnMap = (entry['fnMap'] ?? {}) as Record<string, { name?: string; loc?: IstanbulRange; decl?: IstanbulRange }>
    const f = (entry['f'] ?? {}) as Record<string, number>
    const branchMap = (entry['branchMap'] ?? {}) as Record<string, { loc?: IstanbulRange; locations?: IstanbulRange[] }>
    const b = (entry['b'] ?? {}) as Record<string, number[]>

    const lineCovered = new Map<number, boolean>()
    for (const [id, hits] of Object.entries(s)) {
      const stmt = statementMap[id]
      if (stmt === undefined || stmt.start === undefined) continue
      const ln = stmt.start.line
      lineCovered.set(ln, (lineCovered.get(ln) ?? false) || num(hits) > 0)
    }
    const linesTotal = lineCovered.size
    const uncoveredLineNums = [...lineCovered.entries()]
      .filter(([, covered]) => !covered)
      .map(([ln]) => ln)
      .sort((a, b2) => a - b2)
    const linesHit = linesTotal - uncoveredLineNums.length

    let functionsTotal = 0
    const uncoveredFunctions: FunctionGap[] = []
    for (const [id, fnInfo] of Object.entries(fnMap)) {
      functionsTotal++
      if (num(f[id]) === 0) {
        // `?.` only guards the hop immediately before it -- `loc?.start` protects against a
        // missing `loc`, but not against `loc` being present with no `start` key (seen in some
        // real coverage-final.json output). Explicit undefined checks, mirroring the
        // statementMap loop above.
        const line = (fnInfo.loc?.start !== undefined ? fnInfo.loc.start.line : undefined) ?? (fnInfo.decl?.start !== undefined ? fnInfo.decl.start.line : undefined) ?? 0
        uncoveredFunctions.push({ name: fnInfo.name !== undefined && fnInfo.name !== '' ? fnInfo.name : '(anonymous)', line })
      }
    }
    uncoveredFunctions.sort((a, b2) => a.line - b2.line)
    const functionsHit = functionsTotal - uncoveredFunctions.length

    let branchesTotal = 0
    const uncoveredBranches: BranchGap[] = []
    for (const [id, hitsArrRaw] of Object.entries(b)) {
      const branchInfo = branchMap[id]
      const hitsArr = Array.isArray(hitsArrRaw) ? hitsArrRaw : []
      branchesTotal += hitsArr.length
      hitsArr.forEach((hits, idx) => {
        if (num(hits) === 0) {
          const locStart = branchInfo?.locations?.[idx]?.start
          const branchStart = branchInfo?.loc?.start
          const line = (locStart !== undefined ? locStart.line : undefined) ?? (branchStart !== undefined ? branchStart.line : undefined) ?? 0
          uncoveredBranches.push({ line })
        }
      })
    }
    const branchesHit = branchesTotal - uncoveredBranches.length

    files.push({
      filePath,
      linesTotal,
      linesHit,
      functionsTotal,
      functionsHit,
      branchesTotal,
      branchesHit,
      uncoveredLineRanges: collapseLineRanges(uncoveredLineNums),
      uncoveredLineCount: uncoveredLineNums.length,
      uncoveredFunctions,
      uncoveredBranches,
      summaryOnly: false,
    })
  }

  return { format: 'istanbul-final', files: rankAndFilter(files) }
}

// ---- Istanbul coverage-summary.json ------------------------------------------------

interface SummaryMetric {
  total?: number
  covered?: number
  skipped?: number
  pct?: number
}

/**
 * Extracts file-level gap counts from Istanbul/nyc `coverage-summary.json`. This format carries
 * no per-line/function/branch detail (no statementMap/fnMap/branchMap, just aggregate
 * total/covered counts per category), so every returned file has `summaryOnly: true`, empty
 * `uncoveredLineRanges`/`uncoveredFunctions`/`uncoveredBranches`, and only the hit/total counts
 * to report -- there is nothing finer-grained in the source data to extract.
 */
export function parseIstanbulSummary(data: Record<string, unknown>): CoverageGapsReport {
  const files: FileCoverageGaps[] = []

  for (const [filePath, entryRaw] of Object.entries(data)) {
    if (filePath === 'total') continue
    if (typeof entryRaw !== 'object' || entryRaw === null) continue
    const entry = entryRaw as Record<string, unknown>
    const lines = (entry['lines'] ?? {}) as SummaryMetric
    const functions = (entry['functions'] ?? {}) as SummaryMetric
    const branches = (entry['branches'] ?? {}) as SummaryMetric

    const linesTotal = num(lines.total)
    const linesHit = num(lines.covered)
    const functionsTotal = num(functions.total)
    const functionsHit = num(functions.covered)
    const branchesTotal = num(branches.total)
    const branchesHit = num(branches.covered)

    files.push({
      filePath,
      linesTotal,
      linesHit,
      functionsTotal,
      functionsHit,
      branchesTotal,
      branchesHit,
      uncoveredLineRanges: [],
      uncoveredLineCount: Math.max(0, linesTotal - linesHit),
      uncoveredFunctions: [],
      uncoveredBranches: [],
      summaryOnly: true,
    })
  }

  return { format: 'istanbul-summary', files: rankAndFilter(files) }
}

// ---- combined parse entry point ------------------------------------------------

/** Detects the format of `text` and parses it into a {@link CoverageGapsReport}. Throws a plain
 * Error (caught and clean-formatted by the CLI layer) when the input is neither valid LCOV nor
 * valid Istanbul JSON. */
export function parseCoverageReport(text: string): CoverageGapsReport {
  text = stripBom(text)
  const format = detectCoverageFormat(text)
  if (format === 'lcov') return parseLcov(text)
  const data = JSON.parse(text) as Record<string, unknown>
  return format === 'istanbul-final' ? parseIstanbulFinal(data) : parseIstanbulSummary(data)
}

// ---- --file filtering -----------------------------------------------------------

// Local copy of read_commands.ts's endsWithPathBoundary rule (suffix match only at a `/`
// segment boundary, so a requested `utils.ts` doesn't false-match an indexed `myutils.ts`) --
// mirrors sqlite_query.ts's quoteCsvCellLocal precedent of a small local copy instead of a
// cross-module dependency for one helper. Operates on already-normalizePath'd (forward-slash)
// strings, so only `/` needs checking here.
function endsWithPathBoundaryLocal(full: string, suffix: string): boolean {
  if (!full.endsWith(suffix)) return false
  if (full.length === suffix.length) return true
  return full[full.length - suffix.length - 1] === '/'
}

/**
 * Filters a report down to the one file matching `filePathQuery`. Both sides are run through
 * `normalizePath` (backslash/forward-slash + drive-letter-case normalization) before comparing,
 * then matched exactly or as a path-boundary suffix in either direction -- a relative query
 * (`src/foo.ts`) matches an absolute report path (`/home/x/project/src/foo.ts`), and vice versa
 * for a report that happens to store relative paths against an absolute `--file` argument.
 */
export function filterCoverageGapsByFile(report: CoverageGapsReport, filePathQuery: string): CoverageGapsReport {
  // normalizePath only lowercases the drive letter, not the rest of the path, so a case-insensitive
  // filesystem (Windows/macOS) match like `C:/Repo/src/Foo.ts` vs `c:/repo/src/foo.ts` needs an
  // explicit fold on top -- reuse util.ts's foldPath, the codebase's established platform-gated
  // case-fold helper (see read_commands.ts's identical foldPath(file)/foldPath(s.filePath) pattern),
  // rather than mutating normalizePath itself, which would change behavior for every other caller.
  const query = foldPath(normalizePath(filePathQuery))
  const files = report.files.filter((f) => {
    const candidate = foldPath(normalizePath(f.filePath))
    return candidate === query || endsWithPathBoundaryLocal(candidate, query) || endsWithPathBoundaryLocal(query, candidate)
  })
  return { format: report.format, files }
}

// ---- formatting -----------------------------------------------------------------

function formatRanges(ranges: readonly LineRange[]): string {
  return ranges.map((r) => (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`)).join(', ')
}

function formatFileGaps(f: FileCoverageGaps): string {
  const lines: string[] = [f.filePath]
  lines.push(`  lines: ${f.linesHit}/${f.linesTotal}  functions: ${f.functionsHit}/${f.functionsTotal}  branches: ${f.branchesHit}/${f.branchesTotal}`)

  if (f.summaryOnly) {
    lines.push('  (summary-only report -- no per-line/function/branch detail available)')
    return lines.join('\n')
  }

  if (f.uncoveredLineRanges.length > 0) {
    lines.push(`  uncovered lines: ${formatRanges(f.uncoveredLineRanges)}`)
  }
  if (f.uncoveredFunctions.length > 0) {
    lines.push('  uncovered functions:')
    for (const fn of f.uncoveredFunctions) lines.push(`    ${fn.name} (line ${fn.line})`)
  }
  if (f.uncoveredBranches.length > 0) {
    const branchLines = [...new Set(f.uncoveredBranches.map((br) => br.line))].sort((a, b) => a - b)
    lines.push(`  uncovered branches at line${branchLines.length === 1 ? '' : 's'}: ${branchLines.join(', ')}`)
  }
  return lines.join('\n')
}

/** Renders a report as one block per file (worst offenders first, per rankAndFilter), or a
 * single clear "no gaps" message when every file is fully covered (or the filtered result is
 * empty). */
export function formatCoverageGaps(report: CoverageGapsReport): string {
  if (report.files.length === 0) return 'No coverage gaps found -- 100% coverage.'
  return report.files.map(formatFileGaps).join('\n\n')
}
