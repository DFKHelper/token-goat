// Batch C — linter filters.
//
// Faithfully ported from the Python `bash_compress.py` linter family.
// Filter dispatch order matches the Python FILTERS list (see CLAUDE.arch.md):
// tsc → ruff → mypy → pylint → oxlint → eslint → biome → linter (generic) →
// golangci-lint → phpstan → swiftlint → black-isort → prettier → ktlint →
// cppcheck → clang-tidy.
//
// `swiftlintFilter` is produced by the `makeLinterFilter` factory in
// families.ts — it shares the simple "per-rule warning dedup + always-keep
// error" loop with any future filter that fits that model.

import { ToolFilter } from './base.js'
import { makeLinterFilter } from './families.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, positionalArgs, squeezeBlankLines } from './helpers.js'

// ---------------------------------------------------------------------------
// Shared helper: ESLint-stanza compression (reused by generic LinterFilter)
// ---------------------------------------------------------------------------

// ESLint location line: "  12:8  error   msg   rule"
const _ESLINT_LOC_RE = /^\s+\d+:\d+\s+(error|warning|info)\s/

// ESLint / stylelint file header: starts with abs-path or known JS extension
const _ESLINT_FILE_RE = /^(?:\/|[A-Z]:|[a-zA-Z0-9_./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|vue))/

// ESLint summary footer: "✖ 47 problems …"
const _ESLINT_SUMMARY_RE = /^[✖✗✘x×]\s+\d+\s+problem/

function _emitEslintRules(perRule: Map<string, string[]>): string[] {
  const out: string[] = []
  for (const [rule, entries] of [...perRule.entries()].sort()) {
    out.push(...entries.slice(0, 3))
    if (entries.length > 3) out.push(`  [token-goat: +${entries.length - 3} more ${rule} violations]`)
  }
  return out
}

function _compressEslintStanza(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let currentFile: string[] = []

  function flushFile(): void {
    if (!currentFile.length) return
    const header = currentFile[0]!
    const body = currentFile.slice(1)
    const perRule = new Map<string, string[]>()
    const nonIssues: string[] = []
    for (const line of body) {
      if (!_ESLINT_LOC_RE.test(line)) {
        // Not an issue line; flush accumulated rules then keep
        if (perRule.size) {
          out.push(header)
          out.push(..._emitEslintRules(perRule))
          perRule.clear()
        }
        nonIssues.push(line)
        continue
      }
      const rule = line.trimEnd().split(/\s+/).pop() ?? '__unknown__'
      const bucket = perRule.get(rule) ?? []
      bucket.push(line)
      perRule.set(rule, bucket)
    }
    if (perRule.size) {
      out.push(header)
      out.push(..._emitEslintRules(perRule))
    }
    out.push(...nonIssues)
    currentFile = []
  }

  for (const line of lines) {
    if (_ESLINT_FILE_RE.test(line)) {
      flushFile()
      currentFile = [line]
    } else if (currentFile.length) {
      currentFile.push(line)
    } else {
      out.push(line)
    }
  }
  flushFile()
  return squeezeBlankLines(out.join('\n'))
}

// ---------------------------------------------------------------------------
// RuffFilter
// ---------------------------------------------------------------------------

const _RUFF_LINE_RE = /^(?<file>.+?):(?<line>\d+):(?<col>\d+):\s+(?<code>[A-Z]+\d+)\s/
const _RUFF_FOOTER_RE = /^Found \d+ error/
const _RUFF_SUCCESS_RE = /^(?:All checks passed!|No errors found\.?)\s*$/
const _RUFF_FORMAT_REFORMATTED_RE = /^reformatted\s+\S/
const _RUFF_FORMAT_WOULD_REFORMAT_RE = /^would reformat\s+\S/i

class RuffFilter extends ToolFilter {
  readonly name = 'ruff'
  override readonly binaries = new Set(['ruff'])

  override compress(stdout: string, stderr: string, exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const positionals = positionalArgs(argv.slice(1))
    const subcommand = (positionals[0] ?? 'check').toLowerCase()
    if (subcommand === 'format') return this._compressFormat(merged, exitCode)

    // Fast path: clean run with no remaining content
    if (exitCode === 0) {
      const stripped = merged
        .split('\n')
        .filter((ln) => !_RUFF_SUCCESS_RE.test(ln))
        .join('\n')
        .trim()
      if (!stripped) return ''
    }

    const lines = merged.split('\n')

    // First pass: group violation lines by rule code
    const byCode = new Map<string, Array<{ file: string; line: string }>>()
    const indexed: Array<{ isViol: boolean; line: string }> = []

    for (const line of lines) {
      if (_RUFF_FOOTER_RE.test(line)) {
        indexed.push({ isViol: false, line })
        continue
      }
      const m = _RUFF_LINE_RE.exec(line)
      if (m?.groups) {
        const code = m.groups['code']!
        const file = m.groups['file']!
        const bucket = byCode.get(code) ?? []
        bucket.push({ file, line })
        byCode.set(code, bucket)
        indexed.push({ isViol: true, line })
      } else {
        indexed.push({ isViol: false, line })
      }
    }

    // Decide which codes get summarised (>= 3 occurrences across >= 2 files)
    const summarised = new Map<string, string>()
    for (const [code, entries] of byCode) {
      const files = new Set(entries.map((e) => e.file))
      if (entries.length >= 3 && files.size >= 2) {
        const example = entries[0]!.line
        summarised.set(code, `${code}: ${entries.length} occurrences in ${files.size} files (example: ${example})`)
      }
    }

    // Second pass: emit lines
    const out: string[] = []
    const emittedSummary = new Set<string>()
    const footerLines: string[] = []

    for (const { isViol, line } of indexed) {
      if (_RUFF_FOOTER_RE.test(line)) {
        footerLines.push(line)
        continue
      }
      if (!isViol) {
        out.push(line)
        continue
      }
      const m = _RUFF_LINE_RE.exec(line)
      const code = m?.groups?.['code'] ?? ''
      if (summarised.has(code)) {
        if (!emittedSummary.has(code)) {
          out.push(summarised.get(code)!)
          emittedSummary.add(code)
        }
      } else {
        out.push(line)
      }
    }
    out.push(...footerLines)
    return squeezeBlankLines(out.join('\n'))
  }

  private _compressFormat(merged: string, exitCode: number): string {
    const lines = merged.split('\n')
    const kept: string[] = []
    let droppedReformatted = 0
    let droppedWouldReformat = 0

    for (const line of lines) {
      if (_RUFF_FORMAT_REFORMATTED_RE.test(line)) {
        droppedReformatted++
        continue
      }
      if (_RUFF_FORMAT_WOULD_REFORMAT_RE.test(line)) {
        droppedWouldReformat++
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, droppedReformatted, `collapsed ${droppedReformatted} 'Reformatted …' per-file lines`)
    maybeNote(notes, droppedWouldReformat, `collapsed ${droppedWouldReformat} 'Would reformat:' per-file lines`)
    this.emitNotes(kept, notes)
    const result = squeezeBlankLines(kept.join('\n')).trim()
    if (exitCode === 0 && !result) return ''
    return result
  }
}

// ---------------------------------------------------------------------------
// TscFilter
// ---------------------------------------------------------------------------

const _TSC_WATCH_INIT_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Starting compilation in watch mode\.\.\.$/
const _TSC_WATCH_CYCLE_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] (?:File change detected\. )?Starting incremental compilation\.\.\.$/
const _TSC_BUILD_PROJECTS_HDR_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Projects in this build:$/
const _TSC_BUILD_PROJECT_ITEM_RE = /^\s+\*\s+\S/
const _TSC_BUILD_UPTODATE_RE = /^\[\d{1,2}:\d{2}:\d{2} [AP]M\] Project '.+' is up to date/
const _TSC_ERROR_OLD_RE = /^\S+\.tsx?\(\d+,\d+\): (?:error|warning|message) TS\d+:/
const _TSC_ERROR_NEW_RE = /^\S+\.tsx?:\d+:\d+ - (?:error|warning|message) TS\d+:/
const _TSC_ERROR_CODE_RE = /\bTS(\d+)\b/

function _isTscCmd(argv: string[]): boolean {
  if (!argv.length) return false
  function base(s: string): string {
    let b = s.replace(/\\/g, '/').split('/').pop()!.toLowerCase()
    for (const ext of ['.exe', '.cmd']) {
      if (b.endsWith(ext)) { b = b.slice(0, -ext.length); break }
    }
    return b
  }
  const b0 = base(argv[0]!)
  if (b0 === 'tsc') return true
  if (b0 === 'npx' || b0 === 'yarn' || b0 === 'pnpm') {
    let i = 1
    while (i < argv.length) {
      const tok = argv[i]!
      if (tok.startsWith('-')) {
        if (tok === '--package' || tok === '-p') i += 2
        else i++
      } else {
        if (b0 === 'pnpm' && tok === 'exec') { i++; continue }
        return base(tok) === 'tsc'
      }
    }
    return false
  }
  return false
}

function _isTscContextLine(line: string): boolean {
  if (!line.trim()) return true
  if (/^\d+\s/.test(line)) return true
  const stripped = line.trim()
  if (stripped && /^[~^ ]+$/.test(stripped)) return true
  return line.startsWith('  ') && !_TSC_ERROR_OLD_RE.test(line.trimStart()) && !_TSC_ERROR_NEW_RE.test(line.trimStart())
}

class TscFilter extends ToolFilter {
  readonly name = 'tsc'
  override readonly binaries = new Set(['tsc'])
  private static readonly _MAX_PER_CODE = 3

  override matches(argv: string[]): boolean {
    return _isTscCmd(argv)
  }

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const argvFlags = new Set(argv.slice(1).map((a) => a.toLowerCase()))
    const isWatch = argvFlags.has('-w') || argvFlags.has('--watch')
    const isBuild = argvFlags.has('-b') || argvFlags.has('--build')
    const combined = this.combineOutput(stdout, stderr)
    if (isWatch) return this._compressWatch(combined)
    if (isBuild) return this._compressBuild(combined)
    return this._compressTypecheck(combined)
  }

  private _compressTypecheck(combined: string): string {
    const lines = combined.split('\n')
    const kept: string[] = []
    const codeKept = new Map<string, number>()
    const codeDropped = new Map<string, number>()
    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (_TSC_ERROR_OLD_RE.test(line) || _TSC_ERROR_NEW_RE.test(line)) {
        const m = _TSC_ERROR_CODE_RE.exec(line)
        const code = m ? m[1]! : ''
        const stanza = [line]
        let j = i + 1
        while (j < lines.length && _isTscContextLine(lines[j]!)) {
          stanza.push(lines[j]!)
          j++
        }
        const n = codeKept.get(code) ?? 0
        if (n < TscFilter._MAX_PER_CODE) {
          kept.push(...stanza)
          if (code) codeKept.set(code, n + 1)
        } else {
          codeDropped.set(code, (codeDropped.get(code) ?? 0) + 1)
        }
        i = j
      } else {
        kept.push(line)
        i++
      }
    }
    for (const code of [...codeDropped.keys()].sort((a, b) => (Number(a) || 0) - (Number(b) || 0))) {
      const n = codeDropped.get(code)!
      const pl = n > 1 ? 's' : ''
      kept.push(`[token-goat: dropped ${n} more TS${code} error${pl} (kept first ${TscFilter._MAX_PER_CODE})]`)
    }
    return squeezeBlankLines(kept.join('\n'))
  }

  private _compressWatch(combined: string): string {
    const lines = combined.split('\n')
    const cycles: string[][] = []
    let current: string[] = []
    for (const line of lines) {
      if (_TSC_WATCH_INIT_RE.test(line) || _TSC_WATCH_CYCLE_RE.test(line)) {
        if (current.length) cycles.push(current)
        current = [line]
      } else {
        current.push(line)
      }
    }
    if (current.length) cycles.push(current)
    if (cycles.length <= 2) return squeezeBlankLines(combined)
    const dropped = cycles.length - 2
    const pl = dropped > 1 ? 's' : ''
    const keptLines: string[] = [...cycles[0]!]
    keptLines.push(`[token-goat: dropped ${dropped} intermediate watch cycle${pl}]`)
    keptLines.push(...cycles[cycles.length - 1]!)
    return squeezeBlankLines(keptLines.join('\n'))
  }

  private _compressBuild(combined: string): string {
    const lines = combined.split('\n')
    const kept: string[] = []
    let upToDateCount = 0
    let inProjectsHdr = false
    for (const line of lines) {
      if (_TSC_BUILD_PROJECTS_HDR_RE.test(line)) { inProjectsHdr = true; continue }
      if (inProjectsHdr) {
        if (_TSC_BUILD_PROJECT_ITEM_RE.test(line) || !line.trim()) continue
        inProjectsHdr = false
      }
      if (_TSC_BUILD_UPTODATE_RE.test(line)) { upToDateCount++; continue }
      kept.push(line)
    }
    const notes: string[] = []
    if (upToDateCount) {
      const pl = upToDateCount > 1 ? 's' : ''
      notes.push(`dropped ${upToDateCount} up-to-date project line${pl}`)
    }
    this.emitNotes(kept, notes)
    return squeezeBlankLines(kept.join('\n'))
  }
}

// ---------------------------------------------------------------------------
// ESLintFilter
// ---------------------------------------------------------------------------

// ESLint issue line: "  12:8  error   msg   rule-name"
const _ESLINT_ISSUE_RE = /^\s+\d+:\d+\s+(error|warning|info)\s+.+\S\s+\S+$/

class ESLintFilter extends ToolFilter {
  readonly name = 'eslint'
  override readonly binaries = new Set(['eslint'])

  override compress(stdout: string, stderr: string, exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)

    // Fast path: clean exit
    if (exitCode === 0) {
      const summary = merged.split('\n').find((ln) => _ESLINT_SUMMARY_RE.test(ln.trim()))
      return summary ?? 'ESLint: no errors'
    }

    const lines = merged.split('\n')
    const out: string[] = []
    let currentFileHeader: string | null = null
    let currentIssues: string[] = []
    let currentHasIssues = false

    function flushFile(): void {
      if (currentFileHeader === null) {
        currentIssues = []
        currentHasIssues = false
        return
      }
      if (!currentHasIssues) {
        currentFileHeader = null
        currentIssues = []
        currentHasIssues = false
        return
      }
      out.push(currentFileHeader)
      // Group warnings by rule; errors always kept
      const warnByRule = new Map<string, string[]>()
      for (const issue of currentIssues) {
        const m = _ESLINT_ISSUE_RE.exec(issue)
        if (m && m[1] === 'warning') {
          const rule = issue.trimEnd().split(/\s+/).pop() ?? '__unknown__'
          const bucket = warnByRule.get(rule) ?? []
          bucket.push(issue)
          warnByRule.set(rule, bucket)
        } else {
          out.push(issue)
        }
      }
      // Emit deduplicated warnings
      for (const [rule, entries] of [...warnByRule.entries()].sort()) {
        out.push(...entries.slice(0, 3))
        if (entries.length > 3) out.push(`  [token-goat: +${entries.length - 3} more ${rule} warnings]`)
      }
      currentFileHeader = null
      currentIssues = []
      currentHasIssues = false
    }

    for (const line of lines) {
      if (_ESLINT_SUMMARY_RE.test(line.trim())) {
        flushFile()
        out.push(line)
        continue
      }
      if (_ESLINT_FILE_RE.test(line)) {
        flushFile()
        currentFileHeader = line
        currentIssues = []
        currentHasIssues = false
        continue
      }
      if (currentFileHeader !== null && _ESLINT_ISSUE_RE.test(line)) {
        currentIssues.push(line)
        currentHasIssues = true
        continue
      }
      if (currentFileHeader === null) {
        out.push(line)
      } else {
        // Non-issue line inside stanza (blank separator, etc.)
        currentIssues.push(line)
      }
    }
    flushFile()
    return squeezeBlankLines(out.join('\n'))
  }
}

// ---------------------------------------------------------------------------
// MypyFilter
// ---------------------------------------------------------------------------

const _MYPY_LINE_RE = /^(?<file>.+?):(?<line>\d+):(?:\d+:)?\s+(?<level>error|note|warning):/
const _MYPY_SUMMARY_RE = /^Found \d+ error/
const _MYPY_STANDALONE_ERROR_CODE_RE = /^\s+\[[a-z][a-z0-9-]*\]\s*$/
const _MYPY_TRAILING_ERROR_CODE_RE = /\s+\[[a-z][a-z0-9-]*\]\s*$/

class MypyFilter extends ToolFilter {
  readonly name = 'mypy'
  override readonly binaries = new Set(['mypy', 'dmypy'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const errorMsgCounts = new Map<string, number>()
    const noteMsgCounts = new Map<string, number>()
    let droppedErrors = 0
    let droppedNotes = 0

    for (const line of lines) {
      if (_MYPY_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_MYPY_STANDALONE_ERROR_CODE_RE.test(line)) { droppedNotes++; continue }

      const m = _MYPY_LINE_RE.exec(line)
      if (!m?.groups) { kept.push(line); continue }

      const level = m.groups['level']!

      if (level === 'error') {
        const msgStart = line.indexOf('error:') + 'error:'.length
        const msg = line.slice(msgStart).trim()
        if (msg.startsWith('(errors prevented further checking)')) continue
        let normalised = msg.replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'")
        normalised = normalised.replace(_MYPY_TRAILING_ERROR_CODE_RE, '').trim()
        const count = errorMsgCounts.get(normalised) ?? 0
        errorMsgCounts.set(normalised, count + 1)
        if (count < 3) kept.push(line)
        else droppedErrors++
      } else if (level === 'note') {
        if (line.includes('See https://') || line.includes('See http://')) { droppedNotes++; continue }
        const msgStart = line.indexOf('note:') + 'note:'.length
        const msg = line.slice(msgStart).trim()
        const normalised = msg.replace(/"[^"]*"/g, '"…"').replace(/'[^']*'/g, "'…'")
        const count = noteMsgCounts.get(normalised) ?? 0
        noteMsgCounts.set(normalised, count + 1)
        if (count < 3) kept.push(line)
        else droppedNotes++
      } else {
        kept.push(line)
      }
    }

    if (droppedErrors) {
      kept.push(
        `[token-goat: suppressed ${droppedErrors} duplicate error lines (kept first 3 per unique message); disable via TOKEN_GOAT_BASH_COMPRESS for the full list]`,
      )
    }
    if (droppedNotes) {
      kept.push(`[token-goat: suppressed ${droppedNotes} duplicate/cross-reference note lines]`)
    }
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// GolangciLintFilter
// ---------------------------------------------------------------------------

const _GOLANGCI_ISSUE_RE =
  /^(?<file>[^:\s][^:]*\.go):(?<line>\d+)(?::\d+)?:\s+(?<msg>.+?)\s+\((?<linter>[^)]+)\)\s*$/
const _GOLANGCI_SUMMARY_RE =
  /^(?:Found \d+ issues?\.|Issues? found\.|Run with --fix)|^(?:ERRO\s|WARN\s)/i
const _GOLANGCI_NOISE_RE =
  /^(?:golangci-lint\s+version|time=|level=(?:info|debug)|msg="(?:Running|Starting|Finishing))/i

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

    for (const line of lines) {
      if (_GOLANGCI_NOISE_RE.test(line)) { noiseDropped++; continue }
      if (_GOLANGCI_SUMMARY_RE.test(line)) { kept.push(line); continue }

      const m = _GOLANGCI_ISSUE_RE.exec(line)
      if (m?.groups) {
        const filePath = m.groups['file']!
        const linter = m.groups['linter']!
        const key = `${filePath}\x00${linter}`
        const count = issueCounts.get(key) ?? 0
        issueCounts.set(key, count + 1)
        if (count < GolangciLintFilter._KEEP_FIRST_N) {
          kept.push(line)
        } else if (count === GolangciLintFilter._KEEP_FIRST_N) {
          kept.push(`[token-goat: __placeholder__${filePath}__${linter}__]`)
          issuesCollapsed++
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
        final.push(`[token-goat: +${extra} more ${lnt} issues in ${fp} omitted]`)
      } else {
        final.push(line)
      }
    }

    const notes: string[] = []
    maybeNote(notes, noiseDropped, `dropped ${noiseDropped} structured-log noise lines`)
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

// ---------------------------------------------------------------------------
// PylintFilter
// ---------------------------------------------------------------------------

const _PYLINT_MODULE_RE = /^\*{10,}\s+Module\s/
const _PYLINT_ISSUE_RE = /^[^\s].*:\d+:\d+:\s+[CWEFR]\d{4}/
const _PYLINT_CODE_RE = /\s([CWEFR]\d{4})\s/
const _PYLINT_RATING_RE = /^Your code has been rated at/
const _PYLINT_SEPARATOR_RE = /^-{10,}$/
const _PYLINT_CONFIG_RE = /^(?:Using config file|Loading plugin|No config file found)/

class PylintFilter extends ToolFilter {
  readonly name = 'pylint'
  override readonly binaries = new Set(['pylint'])
  private static readonly _KEEP_PER_CODE = 3

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const codeCounts = new Map<string, number>()
    let deduplicated = 0
    let droppedSeparators = 0
    let droppedConfig = 0
    let pendingModule: string | null = null
    let moduleHasKeptIssue = false

    for (const line of lines) {
      if (_PYLINT_RATING_RE.test(line)) { kept.push(line); continue }
      if (_PYLINT_SEPARATOR_RE.test(line)) { droppedSeparators++; continue }
      if (_PYLINT_CONFIG_RE.test(line)) { droppedConfig++; continue }
      if (_PYLINT_MODULE_RE.test(line)) {
        // Flush previous pending header only if it had kept issues
        if (pendingModule !== null && moduleHasKeptIssue) kept.push(pendingModule)
        pendingModule = line
        moduleHasKeptIssue = false
        continue
      }
      if (_PYLINT_ISSUE_RE.test(line)) {
        const m = _PYLINT_CODE_RE.exec(line)
        const code = m ? m[1]! : '__unknown__'
        const severity = code[0] ?? '?'
        const count = codeCounts.get(code) ?? 0
        codeCounts.set(code, count + 1)
        const alwaysKeep = severity === 'E' || severity === 'F'
        if (alwaysKeep || count < PylintFilter._KEEP_PER_CODE) {
          // Flush pending module header before first kept issue
          if (pendingModule !== null) {
            kept.push(pendingModule)
            pendingModule = null
          }
          kept.push(line)
          moduleHasKeptIssue = true
        } else {
          if (count === PylintFilter._KEEP_PER_CODE) {
            const codeName = code.slice(1)
            kept.push(
              `[token-goat: +? more ${code} (${codeName}); disable via TOKEN_GOAT_BASH_COMPRESS]`,
            )
          }
          deduplicated++
        }
        continue
      }
      // Non-issue line
      if (pendingModule !== null) {
        kept.push(pendingModule)
        pendingModule = null
        moduleHasKeptIssue = false
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-code issue lines`)
    maybeNote(notes, droppedSeparators, `dropped ${droppedSeparators} separator lines`)
    maybeNote(notes, droppedConfig, `dropped ${droppedConfig} config-loading lines`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// OxlintFilter
// ---------------------------------------------------------------------------

const _OXLINT_FILE_HEADER_RE = /^\s{2,}\S+\.\w{1,10}\s*$/
const _OXLINT_ISSUE_RE = /^\s{4,}[×✖✗!]\s/
const _OXLINT_LOCATION_RE = /^\s*(?:╭─\[|│\s|╰─)/
const _OXLINT_SUMMARY_RE = /^\s*(?:Found \d+|Finished in \d+|oxlint v\d)/i
const _OXLINT_RULE_RE = /\(([a-zA-Z0-9/_-]+)\)\s*$/

class OxlintFilter extends ToolFilter {
  readonly name = 'oxlint'
  override readonly binaries = new Set(['oxlint', 'oxc_linter'])
  private static readonly _KEEP_PER_RULE = 3

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    let deduplicated = 0
    let droppedLocation = 0
    let currentFile: string | null = null
    const ruleCounts = new Map<string, number>()
    let suppressBlock = false

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); suppressBlock = false; continue }
      if (_OXLINT_SUMMARY_RE.test(line)) { kept.push(line); currentFile = null; ruleCounts.clear(); continue }
      if (_OXLINT_FILE_HEADER_RE.test(line)) {
        currentFile = line.trim()
        ruleCounts.clear()
        suppressBlock = false
        kept.push(line)
        continue
      }
      if (_OXLINT_ISSUE_RE.test(line)) {
        const m = _OXLINT_RULE_RE.exec(line)
        const rule = m ? m[1]! : '__unknown__'
        const count = (ruleCounts.get(rule) ?? 0) + 1
        ruleCounts.set(rule, count)
        if (count <= OxlintFilter._KEEP_PER_RULE) {
          kept.push(line)
          suppressBlock = false
        } else {
          if (count === OxlintFilter._KEEP_PER_RULE + 1) {
            kept.push(
              `  [token-goat: +? more ${JSON.stringify(rule)} in ${currentFile ?? 'file'}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
            )
          }
          deduplicated++
          suppressBlock = true
        }
        continue
      }
      if (_OXLINT_LOCATION_RE.test(line)) {
        if (suppressBlock) { droppedLocation++; continue }
        kept.push(line)
        continue
      }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule issue lines`)
    maybeNote(notes, droppedLocation, `dropped ${droppedLocation} location-pointer lines for deduped issues`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// BiomeFilter
// ---------------------------------------------------------------------------

const _BIOME_RULE_LINE_RE = /^\s+[×✖✕]\s+\S+\/\S+\s+(?:━+|─+)/
const _BIOME_SOURCE_LINE_RE = /^\s+\d+\s+[│|]\s/
const _BIOME_HINT_RE = /^\s+(?:[iℹ]|ℹ️|Note:)\s+/
const _BIOME_ANNOTATION_RE = /^\s+(?:Caution:|note:|help:|suggestion:)\s+/i
const _BIOME_SUMMARY_RE =
  /^Found\s+\d+\s+diagnostic|^Checked\s+\d+\s+file|^Formatted\s+\d+\s+file|^\d+\s+(?:error|warning|info)/i

class BiomeFilter extends ToolFilter {
  readonly name = 'biome'
  override readonly binaries = new Set(['biome', '@biomejs/biome'])

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem === 'npx' || stem === 'pnpx') {
      return argv.length > 1 && (argv[1]!.toLowerCase() === 'biome' || argv[1]!.toLowerCase() === '@biomejs/biome')
    }
    return stem === 'biome'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const nonEmpty = lines.filter((ln) => ln.trim())

    if (nonEmpty.length <= 40) return merged.trimEnd()

    const kept: string[] = []
    const ruleCount = new Map<string, number>()
    const ruleCollapsed = new Map<string, number>()
    let inStanza = false
    let currentRule = ''
    let stanzaLines: string[] = []
    let sourceLinesInStanza = 0
    const _MAX_STANZAS_PER_RULE = 3
    const _MAX_SOURCE_LINES = 2

    function flushStanza(): void {
      if (!stanzaLines.length) return
      const rule = currentRule
      const keptCount = ruleCount.get(rule) ?? 0
      if (keptCount < _MAX_STANZAS_PER_RULE) {
        ruleCount.set(rule, keptCount + 1)
        kept.push(...stanzaLines)
      } else {
        ruleCollapsed.set(rule, (ruleCollapsed.get(rule) ?? 0) + 1)
      }
      stanzaLines = []
      sourceLinesInStanza = 0
    }

    for (const line of lines) {
      if (_BIOME_SUMMARY_RE.test(line)) {
        flushStanza()
        inStanza = false
        kept.push(line)
        continue
      }
      if (ERROR_SIGNAL_RE.test(line) && !_BIOME_SOURCE_LINE_RE.test(line)) {
        flushStanza()
        inStanza = false
        kept.push(line)
        continue
      }
      if (_BIOME_RULE_LINE_RE.test(line)) {
        flushStanza()
        const m = /(\S+\/\S+)/.exec(line)
        currentRule = m ? m[1]! : 'unknown'
        inStanza = true
        stanzaLines = [line]
        sourceLinesInStanza = 0
        continue
      }
      if (!inStanza) { kept.push(line); continue }
      // Inside a stanza
      if (_BIOME_HINT_RE.test(line) || _BIOME_ANNOTATION_RE.test(line)) continue
      if (_BIOME_SOURCE_LINE_RE.test(line)) {
        if (sourceLinesInStanza < _MAX_SOURCE_LINES) {
          stanzaLines.push(line)
          sourceLinesInStanza++
        }
        continue
      }
      stanzaLines.push(line)
    }
    flushStanza()

    if (ruleCollapsed.size) {
      for (const [rule, cnt] of [...ruleCollapsed.entries()].sort()) {
        kept.push(
          `[token-goat: +${cnt} more ${rule} diagnostic(s) elided; run \`biome check\` for full output]`,
        )
      }
    }

    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// Generic LinterFilter (pyright / stylelint / rome — after specific filters)
// ---------------------------------------------------------------------------

const _LINTER_DIAG_KEY_RE = /\b([A-Z][A-Z0-9]+\d+|error|warning|note)\b/

class LinterFilter extends ToolFilter {
  readonly name = 'linter'
  override readonly binaries = new Set(['pyright', 'pylint', 'stylelint', 'rome'])

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const merged = this.combineOutput(stdout, stderr)
    const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : ''

    if (binary === 'pyright' || binary === 'pylint') {
      // dedupe_by_key: group lines by first regex match key, keep first 3 per group
      const seen = new Map<string, number>()
      const summaries = new Map<string, number>()
      const out: string[] = []
      for (const line of merged.split('\n')) {
        const m = _LINTER_DIAG_KEY_RE.exec(line)
        if (!m) { out.push(line); continue }
        const bucket = m[1]!
        const count = (seen.get(bucket) ?? 0) + 1
        seen.set(bucket, count)
        if (count <= 3) out.push(line)
        else summaries.set(bucket, (summaries.get(bucket) ?? 0) + 1)
      }
      for (const [bucket, count] of [...summaries.entries()].sort()) {
        out.push(`[token-goat: +${count} more matching ${bucket}]`)
      }
      return squeezeBlankLines(out.join('\n'))
    }

    // stylelint / rome: stanza-style like ESLint
    return _compressEslintStanza(merged)
  }
}

// ---------------------------------------------------------------------------
// KtlintFilter
// ---------------------------------------------------------------------------

const _KTLINT_ISSUE_RE = /^(.+\.kt):(\d+):(\d+):\s+(error|warning):\s+(.+)\s+\(([^)]+)\)$/i
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
            kept.push(
              `  [token-goat: +? more ${rule} violations; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
            )
          }
          deduplicated++
        }
        continue
      }

      // Plain-text issue line
      const m = _KTLINT_ISSUE_RE.exec(line)
      if (m) {
        const severity = m[4]!.toLowerCase()
        const rule = m[6]!
        const count = (ruleCounts.get(rule) ?? 0) + 1
        ruleCounts.set(rule, count)
        const alwaysKeep = severity === 'error'
        if (alwaysKeep || count <= KtlintFilter._KEEP_PER_RULE) {
          kept.push(line)
        } else {
          if (count === KtlintFilter._KEEP_PER_RULE + 1) {
            kept.push(
              `[token-goat: +? more ${rule} warnings; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`,
            )
          }
          deduplicated++
        }
        continue
      }

      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      kept.push(line)
    }

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-rule violation lines`)
    maybeNote(notes, droppedXmlTags, `dropped ${droppedXmlTags} checkstyle XML wrapper tags`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// ---------------------------------------------------------------------------
// SwiftLintFilter (produced by the makeLinterFilter factory)
// ---------------------------------------------------------------------------

const _SWIFTLINT_VIOLATION_RE =
  /^(.+\.swift):(\d+)(?::\d+)?: (warning|error|serious): (.+?) \(([a-z_]+)\)\s*$/i
const _SWIFTLINT_PROGRESS_RE =
  /^(Linting Swift files|Loading configuration|Linting '|Done linting!|Resolved \d|warning: .+ is deprecated|Ignoring '.+' in '|\s*$)/i
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

// ---------------------------------------------------------------------------
// PhpStanFilter
// ---------------------------------------------------------------------------

const _PHPSTAN_SEP_RE = /^\s*-{3,}/
const _PHPSTAN_FILE_HEADER_RE = /^\s+Line\s+\S.*\.php\s*$/
const _PHPSTAN_ROW_RE = /^\s+(\d+)\s+(.+)$/
const _PHPSTAN_SUMMARY_RE = /^\s*\[(ERROR|OK|WARNING|NOTE)\]/i
const _PSALM_ERROR_RE = /^(ERROR|INFO|FATAL): \w+ - .+\.php:\d+/i
const _PSALM_PROGRESS_RE =
  /^(Scanning|Analyzing|Checking|Parsing|Caching|Target PHP|Psalm|PHP version|Running Psalm|No errors|Checked \d|INFO:|Found \d+ error)/i
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
        kept.push(line)
        continue
      }
      if (_PHPSTAN_SEP_RE.test(line) && !_PHPSTAN_ROW_RE.test(line)) { droppedSep++; continue }
      if (_PHPSTAN_FILE_HEADER_RE.test(line)) {
        if (currentFile) flushFileDedup(currentFile)
        const parts = line.trim().split(/\s+/, 2)
        currentFile = parts.length > 1 ? parts[1]!.trim() : line.trim()
        if (!fileMsgs.has(currentFile)) fileMsgs.set(currentFile, new Map())
        kept.push(line)
        continue
      }
      const m = _PHPSTAN_ROW_RE.exec(line)
      if (m && currentFile) {
        const msg = m[2]!.trim()
        const counts = fileMsgs.get(currentFile)!
        const count = (counts.get(msg) ?? 0) + 1
        counts.set(msg, count)
        if (count <= 3) kept.push(line)
        continue
      }
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

// ---------------------------------------------------------------------------
// BlackIsortFilter
// ---------------------------------------------------------------------------

const _BLACK_REFORMATTED_RE = /^reformatted\s+\S/
const _BLACK_WOULD_REFORMAT_RE = /^would reformat\s+\S/i
const _BLACK_SUMMARY_RE = /^All done!|^\d+ files? (?:reformatted|left unchanged|would be reformatted)/
const _BLACK_ERROR_RE = /^Oh no!|^error:|^cannot format/i
const _BLACK_CANNOT_FORMAT_RE = /^error: cannot format\s+\S/i
const _ISORT_FIXING_RE = /^Fixing\s+\S/
const _ISORT_SKIPPED_RE = /^Skipped\s+\d+\s+files?/i

class BlackIsortFilter extends ToolFilter {
  readonly name = 'black-isort'
  override readonly binaries = new Set(['black', 'isort'])
  private static readonly _SAMPLE_SIZE = 5

  override compress(stdout: string, stderr: string, _exitCode: number, argv: string[]): string {
    const binary = argv.length ? pathStem(argv[0]!).toLowerCase() : 'black'
    if (binary === 'isort') return this._compressIsort(stdout, stderr)
    return this._compressBlack(stdout, stderr)
  }

  private _compressBlack(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const reformatSample: string[] = []
    let reformatExtra = 0

    for (const line of lines) {
      if (_BLACK_ERROR_RE.test(line) || _BLACK_CANNOT_FORMAT_RE.test(line)) { kept.push(line); continue }
      if (_BLACK_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_BLACK_REFORMATTED_RE.test(line) || _BLACK_WOULD_REFORMAT_RE.test(line)) {
        if (reformatSample.length < BlackIsortFilter._SAMPLE_SIZE) reformatSample.push(line)
        else reformatExtra++
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...reformatSample]
    if (reformatExtra) {
      out.push(`[token-goat: +${reformatExtra} more reformatted files; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    }
    out.push(...kept)
    return this.finalize(out)
  }

  private _compressIsort(stdout: string, stderr: string): string {
    const merged = this.combineOutput(stdout, stderr)
    const lines = merged.split('\n')
    const kept: string[] = []
    const fixSample: string[] = []
    let fixExtra = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_ISORT_SKIPPED_RE.test(line)) { kept.push(line); continue }
      if (_ISORT_FIXING_RE.test(line)) {
        if (fixSample.length < BlackIsortFilter._SAMPLE_SIZE) fixSample.push(line)
        else fixExtra++
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...fixSample]
    if (fixExtra) {
      out.push(`[token-goat: +${fixExtra} more fixed files; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    }
    out.push(...kept)
    return this.finalize(out)
  }
}

// ---------------------------------------------------------------------------
// PrettierFilter
// ---------------------------------------------------------------------------

const _PRETTIER_FILE_RE = /^(?!\[)\s*\S+[./]\S*\s*(?:\d+ms)?\s*(?:\(unchanged\))?\s*$/
const _PRETTIER_SUMMARY_RE =
  /^(?:All matched files|Code style issues found|Checking formatting|Pretty-Format:|prettier \[warn\]|prettier \[error\]|\[warn\]|\[error\])/i
const _PRETTIER_UNCHANGED_RE = /\(unchanged\)\s*$/

class PrettierFilter extends ToolFilter {
  readonly name = 'prettier'
  override readonly binaries = new Set(['prettier', 'npx', 'pnpx'])
  private static readonly _SAMPLE_SIZE = 5

  override matches(argv: string[]): boolean {
    if (!argv.length) return false
    const stem = pathStem(argv[0]!).toLowerCase()
    if (stem === 'prettier') return true
    return (stem === 'npx' || stem === 'pnpx') && argv.length > 1 && argv[1]!.toLowerCase() === 'prettier'
  }

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const combined = this.combineOutput(stdout, stderr)
    const lines = combined.split('\n')
    const kept: string[] = []
    const changedSample: string[] = []
    let changedExtra = 0
    let droppedUnchanged = 0

    for (const line of lines) {
      if (ERROR_SIGNAL_RE.test(line)) { kept.push(line); continue }
      if (_PRETTIER_SUMMARY_RE.test(line)) { kept.push(line); continue }
      if (_PRETTIER_FILE_RE.test(line) && _PRETTIER_UNCHANGED_RE.test(line)) { droppedUnchanged++; continue }
      if (_PRETTIER_FILE_RE.test(line)) {
        if (changedSample.length < PrettierFilter._SAMPLE_SIZE) changedSample.push(line)
        else changedExtra++
        continue
      }
      kept.push(line)
    }

    const out: string[] = [...changedSample]
    if (changedExtra) {
      out.push(`[token-goat: +${changedExtra} more formatted files; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    }
    out.push(...kept)
    const notes: string[] = []
    maybeNote(notes, droppedUnchanged, `dropped ${droppedUnchanged} unchanged-file lines`)
    this.emitNotes(out, notes)
    return this.finalize(out)
  }
}

// ---------------------------------------------------------------------------
// CppcheckFilter
// ---------------------------------------------------------------------------

const _CPPCHECK_CHECKING_RE = /^Checking\s+\S.*\.\.\./
const _CPPCHECK_PROGRESS_RE = /^\d+\/\d+\s+files\s+checked\s+\d+%\s+done/
const _CPPCHECK_DIAGNOSTIC_RE = /^\[.+\.(?:c|cpp|cxx|cc|h|hpp|hxx):\d+\]:/
const _CPPCHECK_DIAG_NOLINE_RE = /^\[.+\]:\s*\((?:error|warning|style|performance|portability|information)\)/i
const _CPPCHECK_CONFIG_RE =
  /^(?:Checking\s+configuration|Active\s+checkers:|Enabled\s+checkers:|cppcheck:\s+(?:error:|warning:|note:))/i
const _CPPCHECK_SUMMARY_RE =
  /^(?:\d+\s+(?:error|warning|style|performance|portability)s?(?:\s+(?:found|detected))?|No\s+errors\s+found|Done\s+processing|cppcheck:\s+.*(?:done|finished)|\d+\s+unique\s+error)/i

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

// ---------------------------------------------------------------------------
// ClangTidyFilter
// ---------------------------------------------------------------------------

const _CLANG_TIDY_WARNINGS_GENERATED_RE = /^\d+\s+warning(?:s)?\s+generated\./
const _CLANG_TIDY_PROCESSING_RE = /^clang-tidy:\s+Processing\s+\d+/i
const _CLANG_TIDY_DIAG_RE =
  /^.+\.(?:c|cpp|cxx|cc|h|hpp|hxx):\d+:\d+:\s+(?:error|warning|note|remark):/
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

// ---------------------------------------------------------------------------
// Instantiate and export
// ---------------------------------------------------------------------------

const ruffFilter = new RuffFilter()
const tscFilter = new TscFilter()
const eslintFilter = new ESLintFilter()
const mypyFilter = new MypyFilter()
const golangciLintFilter = new GolangciLintFilter()
const linterFilter = new LinterFilter()
const pylintFilter = new PylintFilter()
const oxlintFilter = new OxlintFilter()
const biomeFilter = new BiomeFilter()
const ktlintFilter = new KtlintFilter()
const phpstanFilter = new PhpStanFilter()
const blackIsortFilter = new BlackIsortFilter()
const prettierFilter = new PrettierFilter()
const cppcheckFilter = new CppcheckFilter()
const clangTidyFilter = new ClangTidyFilter()

/**
 * Ordered linter filter registry.
 * Dispatch order mirrors Python FILTERS registration: more specific filters
 * (tsc, ruff, mypy, pylint, oxlint, eslint, biome) precede the generic
 * LinterFilter that also claims pylint/pyright/stylelint/rome.  golangci-lint,
 * phpstan, swiftlint, black-isort, prettier, ktlint, cppcheck, and clang-tidy
 * follow in the same order as the Python FILTERS list.
 */
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
