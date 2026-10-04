// Linter filter family (Batch C): golangci-lint, phpstan and psalm, swiftlint, ktlint, cppcheck and clang-tidy here, with the JavaScript and TypeScript tools in linters_js.ts and the Python ones in linters_python.ts. LINTER_FILTERS below orders all sixteen for dispatch.
//
// Faithfully ported from the Python `bash_compress.py` linter family. Filter dispatch order matches the Python FILTERS list (see CLAUDE.arch.md): tsc → ruff → mypy → pylint → oxlint → eslint → biome → linter (generic) → golangci-lint → phpstan → swiftlint → black-isort → prettier → ktlint → cppcheck → clang-tidy.
//
// `swiftlintFilter` is produced by the `makeLinterFilter` factory in families.ts — it shares the simple "per-rule warning dedup + always-keep error" loop with any future filter that fits that model.

import { countNoun } from '../util.js'
import { ToolFilter } from './base.js'
import { makeLinterFilter } from './families.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem } from './helpers.js'
import { biomeFilter, eslintFilter, linterFilter, oxlintFilter, prettierFilter, tscFilter } from './linters_js.js'
import { blackIsortFilter, mypyFilter, pylintFilter, ruffFilter } from './linters_python.js'

// --------------------------------------------------------------------------- GolangciLintFilter ---------------------------------------------------------------------------

const _GOLANGCI_ISSUE_RE =
  /^(?<file>[^:\s][^:]*\.go):(?<line>\d+)(?::\d+)?:\s+(?<msg>.+?)\s+\((?<linter>[^)]+)\)\s*$/
const _GOLANGCI_SUMMARY_RE =
  /^(?:Found \d+ issues?\.|Issues? found\.|Run with --fix)|^(?:ERRO\s|WARN\s)/i
const _GOLANGCI_NOISE_RE =
  /^(?:golangci-lint\s+version|time=|level=(?:info|debug)|msg="(?:Running|Starting|Finishing))/i
// golangci-lint runs with --print-issued-lines=true by default, echoing the offending source line and a caret line under every issue.
const _GOLANGCI_CARET_RE = /^\s*\^[~^]*\s*$/

class GolangciLintFilter extends ToolFilter {
  readonly name = 'golangci-lint'
  override readonly binaries = new Set(['golangci-lint'])
  private static readonly _KEEP_FIRST_N = 3

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem === 'golangci-lint') return true
    return (stem === 'npx' || stem === 'pnpx') && argv.length > 1 && argv[1]!.includes('golangci-lint')
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const issueCounts = new Map<string, number>()
    const kept: string[] = []
    let noiseDropped = 0
    let issuesCollapsed = 0
    let contextDropped = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      if (_GOLANGCI_NOISE_RE.test(line)) { noiseDropped++; continue }
      if (_GOLANGCI_SUMMARY_RE.test(line)) { kept.push(line); continue }

      const m = _GOLANGCI_ISSUE_RE.exec(line)
      if (m?.groups) {
        // Consume the issued-lines block so it travels with its issue instead of being left orphaned when the issue is collapsed.
        const next = lines[i + 1] ?? ''
        let source: string | null = null
        let caret: string | null = null
        if (
          !_GOLANGCI_ISSUE_RE.test(next) &&
          !_GOLANGCI_SUMMARY_RE.test(next) &&
          _GOLANGCI_CARET_RE.test(lines[i + 2] ?? '')
        ) {
          source = next
          caret = lines[i + 2]!
          i += 2
        } else if (_GOLANGCI_CARET_RE.test(next)) {
          caret = next
          i += 1
        }
        const filePath = m.groups['file']!
        const linter = m.groups['linter']!
        const key = `${filePath}\x00${linter}`
        const count = issueCounts.get(key) ?? 0
        issueCounts.set(key, count + 1)
        if (count < GolangciLintFilter._KEEP_FIRST_N) {
          kept.push(line)
          // The echo restates source the reader already has at file:line:col, and the caret restates the column, so both go even for a kept issue.
          if (source !== null) contextDropped++
          if (caret !== null) contextDropped++
        } else {
          if (count === GolangciLintFilter._KEEP_FIRST_N) {
            kept.push(`[token-goat: __placeholder__${filePath}__${linter}__]`)
            issuesCollapsed++
          }
          if (source !== null) contextDropped++
          if (caret !== null) contextDropped++
        }
        continue
      }
      kept.push(line)
    }

    // Replace placeholders with actual counts
    const final: string[] = []
    const _PH_RE = /^\[token-goat: __placeholder__(.+)__(.+)__\]$/
    for (const line of kept) {
      const mPh = _PH_RE.exec(line)
      if (mPh) {
        const fp = mPh[1]!
        const lnt = mPh[2]!
        const total = issueCounts.get(`${fp}\x00${lnt}`) ?? GolangciLintFilter._KEEP_FIRST_N + 1
        const extra = total - GolangciLintFilter._KEEP_FIRST_N
        final.push(`[token-goat: +${countNoun(extra, `more ${lnt} issue`)} in ${fp} omitted]`)
      } else {
        final.push(line)
      }
    }

    const notes: string[] = []
    maybeNote(notes, noiseDropped, `dropped ${noiseDropped} structured-log noise lines`)
    maybeNote(notes, contextDropped, `dropped ${contextDropped} redundant source-context/caret lines`)
    if (issuesCollapsed) {
      const totalIssues = [...issueCounts.values()].reduce((a, b) => a + b, 0)
      const keptIssues = [...issueCounts.values()].reduce(
        (a, v) => a + Math.min(v, GolangciLintFilter._KEEP_FIRST_N),
        0,
      )
      notes.push(
        `collapsed ${totalIssues - keptIssues} issues (${issuesCollapsed} file/linter groups exceeded ${GolangciLintFilter._KEEP_FIRST_N})`,
      )
    }
    this.emitNotes(final, notes)
    return this.finalize(final)
  }
}

// --------------------------------------------------------------------------- KtlintFilter ---------------------------------------------------------------------------

// ktlint's default `plain` reporter prints `<file>:<line>:<col>: <message> (<rule-id>)` with no severity token at all (see PlainReporter.onLintError and the pinned expectation in PlainReporterTest), so the severity group is optional and an unlabelled violation is dedupable like a warning; the labelled spelling is kept for wrappers such as Gradle that prefix `error:`/`warning:`. `.kts` scripts are linted too.
const _KTLINT_ISSUE_RE = /^(.+\.kts?):(\d+):(\d+):\s+(?:(error|warning):\s+)?(.+)\s+\(([^)]+)\)$/i
const _KTLINT_CHECKSTYLE_TAG_RE = /^\s*<(?:\?xml|checkstyle|file)\b/i
const _KTLINT_CHECKSTYLE_ERROR_RE = /^\s*<error\b.*\bsource="([^"]+)"/i
const _KTLINT_SUMMARY_RE =
  /^\s*(?:\d+\s+lint\s+error|ktlint\s+\d+\.\d+|Kotlin\s+style\s+guide|No\s+lint\s+errors|Resolving|Checking|Formatting)/i
const _KTLINT_RULESET_HEADER_RE = /^\s*\[ktlint(?::\S+)?\]/i

class KtlintFilter extends ToolFilter {
  readonly name = 'ktlint'
  override readonly binaries = new Set(['ktlint'])
  private static readonly _KEEP_PER_RULE = 3

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    const ruleCounts = new Map<string, number>()
    const pendingPlaceholders: { index: number; rule: string; suffix: string; indent: string }[] = []
    let deduplicated = 0
    let droppedXmlTags = 0

    for (const line of lines) {
      if (_KTLINT_SUMMARY_RE.test(line) || _KTLINT_RULESET_HEADER_RE.test(line)) {
        kept.push(line)
        continue
      }
      if (_KTLINT_CHECKSTYLE_TAG_RE.test(line)) { droppedXmlTags++; continue }
      if (line.trim().startsWith('</')) { droppedXmlTags++; continue }

      // Checkstyle <error> line — must precede ERROR_SIGNAL_RE
      const mCs = _KTLINT_CHECKSTYLE_ERROR_RE.exec(line)
      if (mCs) {
        const rule = mCs[1]!
        const count = (ruleCounts.get(rule) ?? 0) + 1
        ruleCounts.set(rule, count)
        if (count <= KtlintFilter._KEEP_PER_RULE) {
          kept.push(line)
        } else {
          if (count === KtlintFilter._KEEP_PER_RULE + 1) {
            pendingPlaceholders.push({ index: kept.length, rule, suffix: 'violation', indent: '  ' })
            kept.push('')
          }
          deduplicated++
        }
        continue
      }

      // Plain-text issue line
      const m = _KTLINT_ISSUE_RE.exec(line)
      if (m) {
        const severity = (m[4] ?? '').toLowerCase()
        const rule = m[6]!
        const count = (ruleCounts.get(rule) ?? 0) + 1
        ruleCounts.set(rule, count)
        const alwaysKeep = severity === 'error'
        if (alwaysKeep || count <= KtlintFilter._KEEP_PER_RULE) {
          kept.push(line)
        } else {
          if (count === KtlintFilter._KEEP_PER_RULE + 1) {
            pendingPlaceholders.push({
              index: kept.length,
              rule,
              suffix: severity === 'warning' ? 'warning' : 'violation',
              indent: '',
            })
            kept.push('')
          }
          deduplicated++
        }
        continue
      }

      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }

    // ruleCounts is never cleared for ktlint (single global tally across the whole run), so patching after the loop yields each rule's real final elided count.
    for (const { index, rule, suffix, indent } of pendingPlaceholders) {
      const elided = (ruleCounts.get(rule) ?? 0) - KtlintFilter._KEEP_PER_RULE
      kept[index] =
        `${indent}[token-goat: +${countNoun(elided, `more ${rule} ${suffix}`)}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`
    }

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule violation lines`)
    maybeNote(notes, droppedXmlTags, `dropped ${droppedXmlTags} checkstyle XML wrapper tags`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- SwiftLintFilter (produced by the makeLinterFilter factory) ---------------------------------------------------------------------------

const _SWIFTLINT_VIOLATION_RE =
  /^(.+\.swift):(\d+)(?::\d+)?: (warning|error|serious): (.+?) \(([a-z_]+)\)\s*$/i
const _SWIFTLINT_PROGRESS_RE =
  /^(?:Linting Swift files|Loading configuration|Linting '|Done linting!|Resolved \d|warning: [^\r\n]+ is deprecated|Ignoring '[^']+' in '|\s*$)/i
const _SWIFTLINT_SUMMARY_RE = /^Done linting!/i

const swiftlintFilter = makeLinterFilter({
  name: 'swiftlint',
  binaries: ['swiftlint'],
  summaryLast: _SWIFTLINT_SUMMARY_RE,
  dropRe: _SWIFTLINT_PROGRESS_RE,
  dropLabel: (n) => `dropped ${n} progress/info lines`,
  parseDiagnostic: (line) => {
    const m = _SWIFTLINT_VIOLATION_RE.exec(line)
    if (!m) return null
    return { severity: m[3]!.toLowerCase(), ruleId: m[5]!.toLowerCase() }
  },
  alwaysKeepSeverities: ['error', 'serious'],
  collapseNote: (ruleId, extra) => `[token-goat: +${extra} more ${ruleId} warning(s) elided]`,
})

// --------------------------------------------------------------------------- PhpStanFilter ---------------------------------------------------------------------------

const _PHPSTAN_SEP_RE = /^\s*-{3,}/
const _PHPSTAN_FILE_HEADER_RE = /^\s+Line\s+(\S.*\.php)\s*$/
const _PHPSTAN_ROW_RE = /^\s+(\d+)\s+(.+)$/
const _PHPSTAN_SUMMARY_RE = /^\s*\[(ERROR|OK|WARNING|NOTE)\]/i
// An indented line inside a file block that is not a numbered row. PHPStan's table formatter appends the error identifier, and any tip or editor link, into the SAME table cell as the message (`$message .= "\n" . '🪪  ' . $error->getIdentifier()` in TableErrorFormatter), and Symfony's Table helper renders that embedded newline as a continuation row with an empty Line column. Such a line belongs to the row above it and has to share that row's fate.
const _PHPSTAN_ROW_CONTINUATION_RE = /^\s{2,}\S/
const _PSALM_ERROR_RE = /^(ERROR|INFO|FATAL): \w+ - .+\.php:\d+/i
// Progress chatter only. `No errors` and `Found N errors` are deliberately absent: those are the verdict of the run, the one line the reader invoked psalm to see, and routing them here discarded a clean result entirely and replaced a failing one with an anonymous "dropped N progress/info lines" note. `INFO:` is absent for the same reason from the other direction: `_PSALM_ERROR_RE` below lists INFO as a diagnostic severity alongside ERROR and FATAL, so matching a leading `INFO:` here shadowed every INFO diagnostic before the diagnostic branch could dedupe it, and made that branch's INFO alternative unreachable. A genuinely non-diagnostic `INFO:` line fails `_PSALM_ERROR_RE` and falls through to the keep-verbatim branch, which is the safe direction.
const _PSALM_PROGRESS_RE =
  /^(Scanning|Analyzing|Checking|Parsing|Caching|Target PHP|Psalm|PHP version|Running Psalm|Checked \d)/i
const _PHPSTAN_INFO_RE =
  /^(Note: |Loading config|Found cached|Autoload|Bootstrapping|PHPStan - PHP Static|Psalm is running)/i

class PhpStanFilter extends ToolFilter {
  readonly name = 'phpstan'
  override readonly binaries = new Set(['phpstan', 'psalm', 'psalm.phar', 'phpstan.phar'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    let binary = argv.length ? pathStem(argv[0]!).toLowerCase() : 'phpstan'
    // psalm.phar → "psalm", phpstan.phar → "phpstan"
    if (binary.endsWith('.phar')) binary = binary.slice(0, -5)
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    if (binary === 'psalm') return this._compressPsalm(lines)
    return this._compressPhpstan(lines)
  }

  private _compressPhpstan(lines: string[]): string {
    const kept: string[] = []
    let droppedSep = 0
    let droppedInfo = 0
    let currentFile = ''
    // Whether the most recent numbered row survived dedup, so its continuation lines can follow it. Deduping a row while keeping its identifier line stacked four identical `🪪 method.notFound` stamps under one line number: harder to read than the raw output the filter exists to shrink.
    let lastRowKept = true
    // file → {msg: count}
    const fileMsgs = new Map<string, Map<string, number>>()

    const flushFileDedup = (file: string): void => {
      const msgs = fileMsgs.get(file)
      if (!msgs) return
      const extraCount = [...msgs.values()].reduce((a, c) => a + Math.max(0, c - 3), 0)
      if (extraCount) kept.push(`  [token-goat: +${extraCount} more duplicate error(s) in ${file}]`)
    }

    for (const line of lines) {
      if (_PHPSTAN_INFO_RE.test(line)) { droppedInfo++; continue }
      if (_PHPSTAN_SUMMARY_RE.test(line)) {
        if (currentFile) { flushFileDedup(currentFile); currentFile = '' }
        lastRowKept = true
        kept.push(line)
        continue
      }
      // A separator closes the table cell, so nothing after it continues the row before it. Without this reset, a row deduped as the last row of one table made the whole next section -- PHPStan prints warnings in a table of their own, with no Line column and so no numbered row to re-arm on -- read as its continuation and vanish, while the summary went on counting it.
      if (_PHPSTAN_SEP_RE.test(line) && !_PHPSTAN_ROW_RE.test(line)) { droppedSep++; lastRowKept = true; continue }
      if (_PHPSTAN_FILE_HEADER_RE.test(line)) {
        if (currentFile) flushFileDedup(currentFile)
        const headerMatch = _PHPSTAN_FILE_HEADER_RE.exec(line)
        currentFile = headerMatch?.[1] ? headerMatch[1].trim() : line.trim()
        if (!fileMsgs.has(currentFile)) fileMsgs.set(currentFile, new Map())
        lastRowKept = true
        kept.push(line)
        continue
      }
      const m = _PHPSTAN_ROW_RE.exec(line)
      if (m && currentFile) {
        const msg = m[2]!.trim()
        const counts = fileMsgs.get(currentFile)!
        const count = (counts.get(msg) ?? 0) + 1
        counts.set(msg, count)
        lastRowKept = count <= 3
        if (lastRowKept) kept.push(line)
        continue
      }
      if (currentFile && !lastRowKept && _PHPSTAN_ROW_CONTINUATION_RE.test(line)) continue
      kept.push(line)
    }
    if (currentFile) flushFileDedup(currentFile)

    const notes: string[] = []
    maybeNote(notes, droppedSep, `dropped ${droppedSep} table-separator lines`)
    maybeNote(notes, droppedInfo, `dropped ${droppedInfo} info/banner lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }

  private _compressPsalm(lines: string[]): string {
    const kept: string[] = []
    let droppedProgress = 0
    const errorTypeCounts = new Map<string, number>()

    for (const line of lines) {
      if (_PSALM_PROGRESS_RE.test(line)) { droppedProgress++; continue }
      const m = _PSALM_ERROR_RE.exec(line)
      if (m) {
        const parts = line.split(':', 2)
        const errorType = parts.length >= 2 ? parts[1]!.trim().split('-')[0]!.trim() : '?'
        const count = (errorTypeCounts.get(errorType) ?? 0) + 1
        errorTypeCounts.set(errorType, count)
        if (count <= 3) kept.push(line)
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedProgress, `dropped ${droppedProgress} progress/info lines`)
    const collapsed = [...errorTypeCounts.entries()].filter(([, v]) => v > 3)
    for (const [etype, extra] of collapsed.sort()) {
      notes.push(`collapsed +${extra - 3} more ${etype} occurrence(s)`)
    }
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- CppcheckFilter ---------------------------------------------------------------------------

const _CPPCHECK_CHECKING_RE = /^Checking\s+\S.*\.\.\./
const _CPPCHECK_PROGRESS_RE = /^\d+\/\d+\s+files\s+checked\s+\d+%\s+done/
// Legacy-only by decision, not by oversight. This matches the pre-2.0 `[file.c:12]: (error) msg` layout; the default template since cppcheck 2.0 is `{file}:{line}:{column}: {severity}: {message} [{id}]` followed by a source line and a caret line (the old layout is now only reachable via --template=cppcheck1). Widening the matcher alone would change nothing: this filter never dedups, so an unmatched diagnostic already falls through to the keep branch, and a modern-format report round-trips byte for byte. Verified against the built bundle, not inferred: a modern-format report through `token-goat compress -f cppcheck` came back identical, and with the report scaled past bash_compress.min_net_savings_bytes the only lines removed were the Checking/percentage/Active-checkers noise, never a diagnostic, a source line, or a caret. The real gap is that nothing collapses the source+caret pair the way _CLANG_TIDY_CONTEXT_RE does for clang-tidy, which is new compression behaviour rather than a matcher repair, and building it needs a real cppcheck capture for tests/fixtures/tool_output/ (cppcheck is not installed here, and this corpus exists precisely because filters written against invented output shipped broken).
const _CPPCHECK_DIAGNOSTIC_RE = /^\[.+\.(?:c|cpp|cxx|cc|h|hpp|hxx):\d+\]:/
const _CPPCHECK_DIAG_NOLINE_RE = /^\[.+\]:\s*\((?:error|warning|style|performance|portability|information)\)/i
const _CPPCHECK_CONFIG_RE =
  /^(?:Checking\s+configuration|Active\s+checkers:|Enabled\s+checkers:|cppcheck:\s+(?:error:|warning:|note:))/i
const _CPPCHECK_SUMMARY_RE =
  /^(?:\d+\s+(?:error|warning|style|performance|portability)s?(?:\s+(?:found|detected))?|No\s+errors\s+found|Done\s+processing|cppcheck:\s+[^\r\n]*(?:done|finished)|\d+\s+unique\s+error)/i

class CppcheckFilter extends ToolFilter {
  readonly name = 'cppcheck'
  override readonly binaries = new Set(['cppcheck'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let checkingCount = 0
    let progressCount = 0
    let configCount = 0

    for (const line of lines) {
      if (_CPPCHECK_DIAGNOSTIC_RE.test(line) || _CPPCHECK_DIAG_NOLINE_RE.test(line)) { kept.push(line); continue }
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_CPPCHECK_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_CPPCHECK_CHECKING_RE.test(line)) { checkingCount++; continue }
      if (_CPPCHECK_PROGRESS_RE.test(line)) { progressCount++; continue }
      if (_CPPCHECK_CONFIG_RE.test(line)) { configCount++; continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, checkingCount, `collapsed ${checkingCount} 'Checking <file>...' progress lines`)
    maybeNote(notes, progressCount, `dropped ${progressCount} file-progress percentage lines`)
    maybeNote(notes, configCount, `collapsed ${configCount} configuration-check lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- ClangTidyFilter ---------------------------------------------------------------------------

const _CLANG_TIDY_WARNINGS_GENERATED_RE = /^\d+\s+warning(?:s)?\s+generated\./
const _CLANG_TIDY_PROCESSING_RE = /^clang-tidy:\s+Processing\s+\d+/i
// clang-tidy runs on every translation unit clang itself accepts, which is wider than the C/C++ core set: CUDA (.cu/.cuh), the two conventional template-implementation suffixes (.tcc/.inl), and Objective-C/C++ (.m/.mm). A diagnostic on one of those files used to miss this matcher, so it never opened a diagnostic context and its source/caret lines were all kept verbatim instead of collapsing to the first.
const _CLANG_TIDY_DIAG_RE =
  /^.+\.(?:c|cpp|cxx|cc|h|hpp|hxx|cuh|cu|tcc|inl|mm|m):\d+:\d+:\s+(?:error|warning|note|remark):/
const _CLANG_TIDY_NOTE_RE = /^.+:\d+:\d+:\s+note:/
const _CLANG_TIDY_CONTEXT_RE = /^\s+(?:\^[~^]*|~+)\s*$|^\s{4,}\S/
const _CLANG_TIDY_INCLUDE_RE = /^In\s+file\s+included\s+from\s+/
const _CLANG_TIDY_SUMMARY_RE =
  /^(?:clang-tidy:\s+\d+|Suppressed\s+\d+|\d+\s+warning[s]?\s+(?:treated\s+as\s+error|and\s+\d+\s+error))/i

class ClangTidyFilter extends ToolFilter {
  readonly name = 'clang-tidy'
  override readonly binaries = new Set(['clang-tidy', 'run-clang-tidy', 'run-clang-tidy.py'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    let warningsGenerated = 0
    let includeChains = 0
    let contextDropped = 0
    let inDiagContext = false
    let contextKeptForCurrent = false

    for (const line of lines) {
      if (_CLANG_TIDY_SUMMARY_RE.test(line)) {
        kept.push(line)
        inDiagContext = false
        contextKeptForCurrent = false
        continue
      }
      if (_CLANG_TIDY_DIAG_RE.test(line)) {
        kept.push(line)
        inDiagContext = true
        contextKeptForCurrent = false
        continue
      }
      if (_CLANG_TIDY_NOTE_RE.test(line) && inDiagContext) {
        kept.push(line)
        continue
      }
      if (ERROR_SIGNAL_RE.test(line)) {
        kept.push(line)
        inDiagContext = false
        continue
      }
      if (_CLANG_TIDY_WARNINGS_GENERATED_RE.test(line)) {
        const m = /^(\d+)/.exec(line)
        if (m) warningsGenerated += parseInt(m[1]!, 10)
        continue
      }
      if (_CLANG_TIDY_PROCESSING_RE.test(line)) continue
      if (_CLANG_TIDY_INCLUDE_RE.test(line)) { includeChains++; continue }
      if (_CLANG_TIDY_CONTEXT_RE.test(line) && inDiagContext) {
        if (!contextKeptForCurrent) {
          kept.push(line)
          contextKeptForCurrent = true
        } else {
          contextDropped++
        }
        continue
      }
      // Any other line resets context state
      inDiagContext = false
      contextKeptForCurrent = false
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(
      notes,
      warningsGenerated,
      `collapsed ${warningsGenerated} total 'N warnings generated' progress lines`,
    )
    maybeNote(notes, includeChains, `collapsed ${includeChains} 'In file included from' chains`)
    maybeNote(notes, contextDropped, `dropped ${contextDropped} redundant source-context/caret lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- Instantiate and export ---------------------------------------------------------------------------

const golangciLintFilter = new GolangciLintFilter()
const ktlintFilter = new KtlintFilter()
const phpstanFilter = new PhpStanFilter()
const cppcheckFilter = new CppcheckFilter()
const clangTidyFilter = new ClangTidyFilter()

/** Ordered linter filter registry. Dispatch order mirrors Python FILTERS registration: more specific filters (tsc, ruff, mypy, pylint, oxlint, eslint, biome) precede the generic LinterFilter that also claims pylint/pyright/stylelint/rome.  golangci-lint, phpstan, swiftlint, black-isort, prettier, ktlint, cppcheck, and clang-tidy follow in the same order as the Python FILTERS list. */
export const LINTER_FILTERS: ToolFilter[] = [
  tscFilter,
  ruffFilter,
  mypyFilter,
  pylintFilter,
  oxlintFilter,
  eslintFilter,
  biomeFilter,
  linterFilter,
  golangciLintFilter,
  phpstanFilter,
  swiftlintFilter,
  blackIsortFilter,
  prettierFilter,
  ktlintFilter,
  cppcheckFilter,
  clangTidyFilter,
]
