/**
 * Unresolved git merge-conflict marker extraction (`token-goat conflicts`).
 *
 * Parses two-way (`<<<<<<< / ======= / >>>>>>>`) and diff3 three-way
 * (`<<<<<<< / ||||||| / ======= / >>>>>>>`) conflict markers out of a file's
 * text, plus the labels git writes on the marker lines themselves (branch
 * names, `merged common ancestors`, etc). Mirrors coverage_query.ts /
 * openapi_query.ts's shape: pure parse/extract/format functions, no file IO
 * -- callers (read_commands.ts's runConflicts) own reading files off disk and
 * walking directories.
 */

const OURS_RE = /^<{7}(?:\s+(.*))?$/
const BASE_RE = /^\|{7}(?:\s+(.*))?$/
// Trailing whitespace is tolerated, as it already is on the other three markers: their
// `(?:\s+(.*))?` tail matches a run of spaces with an empty label. Only the separator demanded an
// exact match, so `=======` with one trailing space -- easily left by an editor or a merge tool --
// took the whole region down with it: the conflict was not reported at all, and the file was
// flagged "reached end of file without a matching '>>>>>>>'" even though the `>>>>>>>` was right
// there. Deliberately `\s*` and not a label capture like the others: a content line reading
// `======= notes` inside the ours section would then be taken for the separator, which is a worse
// failure than the one being fixed. More than seven `=` (a markdown heading rule) still does not
// match, which is the point of the exact `{7}`.
const SEP_RE = /^={7}\s*$/
const THEIRS_RE = /^>{7}(?:\s+(.*))?$/

/** One side of a conflict region: the label git wrote on its marker line (often a ref/branch
 * name, or empty), and the literal lines between that marker and the next one. */
export interface ConflictSide {
  label: string
  content: string
}

/** One `<<<<<<< ... >>>>>>>` conflict region. `base` is present only for diff3-style conflicts
 * (a `|||||||` section was seen); `null` for a plain two-way conflict. */
export interface ConflictRegion {
  filePath: string
  /** 1-indexed, inclusive: the `<<<<<<<` line through the `>>>>>>>` line. */
  lineStart: number
  lineEnd: number
  ours: ConflictSide
  base: ConflictSide | null
  theirs: ConflictSide
}

/** A malformed/unbalanced marker sequence -- e.g. a `<<<<<<<` with no matching `=======`/
 * `>>>>>>>` before EOF or before the next `<<<<<<<` -- surfaced as data instead of a thrown
 * error, so one bad file doesn't abort a multi-file scan and a partial parse never gets
 * silently reported as "no conflicts". */
export interface ConflictWarning {
  filePath: string
  /** Line where the unterminated region started (the offending `<<<<<<<`). */
  line: number
  message: string
}

export interface FileConflicts {
  filePath: string
  regions: ConflictRegion[]
  warnings: ConflictWarning[]
}

/** Parse every conflict region (and any malformed marker sequence) out of one file's text. */
export function parseConflicts(filePath: string, text: string): FileConflicts {
  const lines = text.split(/\r?\n/)
  const regions: ConflictRegion[] = []
  const warnings: ConflictWarning[] = []

  type State = 'none' | 'ours' | 'base' | 'theirs'
  let state: State = 'none'
  let startLine = 0
  let oursLabel = ''
  let oursLines: string[] = []
  let baseLabel = ''
  let baseLines: string[] = []
  let sawBase = false
  let theirsLines: string[] = []

  const resetRegion = (): void => {
    state = 'none'
    oursLabel = ''
    oursLines = []
    baseLabel = ''
    baseLines = []
    sawBase = false
    theirsLines = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const lineNo = i + 1

    const oursMatch = OURS_RE.exec(line)
    if (oursMatch !== null) {
      if (state !== 'none') {
        warnings.push({
          filePath,
          line: startLine,
          message: `Unterminated conflict marker starting at line ${startLine} -- found a new '<<<<<<<' at line ${lineNo} before a matching '=======' / '>>>>>>>'`,
        })
      }
      startLine = lineNo
      oursLabel = (oursMatch[1] ?? '').trim()
      oursLines = []
      baseLabel = ''
      baseLines = []
      sawBase = false
      theirsLines = []
      state = 'ours'
      continue
    }

    if (state === 'none') continue

    if (state === 'ours') {
      const baseMatch = BASE_RE.exec(line)
      if (baseMatch !== null) {
        baseLabel = (baseMatch[1] ?? '').trim()
        baseLines = []
        sawBase = true
        state = 'base'
        continue
      }
    }

    if ((state === 'ours' || state === 'base') && SEP_RE.test(line)) {
      theirsLines = []
      state = 'theirs'
      continue
    }

    if (state === 'theirs') {
      const theirsMatch = THEIRS_RE.exec(line)
      if (theirsMatch !== null) {
        const theirsLabel = (theirsMatch[1] ?? '').trim()
        regions.push({
          filePath,
          lineStart: startLine,
          lineEnd: lineNo,
          ours: { label: oursLabel, content: oursLines.join('\n') },
          base: sawBase ? { label: baseLabel, content: baseLines.join('\n') } : null,
          theirs: { label: theirsLabel, content: theirsLines.join('\n') },
        })
        resetRegion()
        continue
      }
    }

    if (state === 'ours') oursLines.push(line)
    else if (state === 'base') baseLines.push(line)
    else if (state === 'theirs') theirsLines.push(line)
  }

  if (state !== 'none') {
    warnings.push({
      filePath,
      line: startLine,
      message: `Unterminated conflict marker starting at line ${startLine} -- reached end of file without a matching '>>>>>>>'`,
    })
  }

  return { filePath, regions, warnings }
}

/** Region summary: line range and side labels only, no ours/base/theirs content. */
export interface ConflictRegionSummary {
  lineStart: number
  lineEnd: number
  oursLabel: string
  baseLabel: string | null
  theirsLabel: string
}

export interface FileConflictsSummary {
  filePath: string
  conflictCount: number
  regions: ConflictRegionSummary[]
  warnings: ConflictWarning[]
}

/** Drop the full ours/base/theirs content, keeping only file, conflict count, line ranges, and
 * labels -- the `--summary` counterpart to {@link parseConflicts}' full result. */
export function summarizeFileConflicts(result: FileConflicts): FileConflictsSummary {
  return {
    filePath: result.filePath,
    conflictCount: result.regions.length,
    regions: result.regions.map((r) => ({
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      oursLabel: r.ours.label,
      baseLabel: r.base !== null ? r.base.label : null,
      theirsLabel: r.theirs.label,
    })),
    warnings: result.warnings,
  }
}

function indentBlock(content: string): string {
  if (content === '') return ''
  return content
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n')
}

function formatSingleFileConflicts(result: FileConflicts): string {
  const lines: string[] = []
  if (result.regions.length > 0) {
    lines.push(`${result.filePath} -- ${result.regions.length} conflict${result.regions.length === 1 ? '' : 's'}`)
    for (const r of result.regions) {
      lines.push(`  lines ${r.lineStart}-${r.lineEnd}`)
      lines.push(`    <<<<<<< ${r.ours.label || '(ours)'}`)
      lines.push(indentBlock(r.ours.content))
      if (r.base !== null) {
        lines.push(`    ||||||| ${r.base.label || '(base)'}`)
        lines.push(indentBlock(r.base.content))
      }
      lines.push('    =======')
      lines.push(indentBlock(r.theirs.content))
      lines.push(`    >>>>>>> ${r.theirs.label || '(theirs)'}`)
    }
  } else {
    lines.push(`${result.filePath} -- no conflicts`)
  }
  if (result.warnings.length > 0) {
    lines.push('  warnings:')
    for (const w of result.warnings) lines.push(`    line ${w.line}: ${w.message}`)
  }
  return lines.join('\n')
}

/** Format the full (non-summary) view for one or more files. Files with zero regions and zero
 * warnings are dropped -- there's nothing to show for a clean file. Zero conflicts across every
 * file given prints one clear message instead of empty/confusing output. */
export function formatConflicts(results: FileConflicts[]): string {
  const withData = results.filter((r) => r.regions.length > 0 || r.warnings.length > 0)
  if (withData.length === 0) return 'No conflicts found.'
  return withData.map(formatSingleFileConflicts).join('\n\n')
}

function formatSingleFileSummary(summary: FileConflictsSummary): string {
  const lines: string[] = []
  if (summary.conflictCount > 0) {
    lines.push(`${summary.filePath} -- ${summary.conflictCount} conflict${summary.conflictCount === 1 ? '' : 's'}`)
    for (const r of summary.regions) {
      const baseText = r.baseLabel !== null ? ` base=${r.baseLabel || '(unlabeled)'}` : ''
      lines.push(`  lines ${r.lineStart}-${r.lineEnd}  ours=${r.oursLabel || '(unlabeled)'}${baseText} theirs=${r.theirsLabel || '(unlabeled)'}`)
    }
  } else {
    lines.push(`${summary.filePath} -- no conflicts`)
  }
  if (summary.warnings.length > 0) {
    lines.push('  warnings:')
    for (const w of summary.warnings) lines.push(`    line ${w.line}: ${w.message}`)
  }
  return lines.join('\n')
}

/** Format the `--summary` view (line ranges + labels only) for one or more files. Same
 * clean-file-omission and zero-conflicts behavior as {@link formatConflicts}. */
export function formatConflictSummaries(summaries: FileConflictsSummary[]): string {
  const withData = summaries.filter((s) => s.conflictCount > 0 || s.warnings.length > 0)
  if (withData.length === 0) return 'No conflicts found.'
  return withData.map(formatSingleFileSummary).join('\n')
}
