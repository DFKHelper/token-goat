// Python linter and formatter filters (Batch C): ruff (check and format), mypy, pylint, and black with isort. Each is a faithful TypeScript port of its Python counterpart in bash_compress.py, and LINTER_FILTERS in linters.ts sets its dispatch position.

import { countNoun } from '../util.js'
import { ToolFilter } from './base.js'
import { plural } from './families.js'
import { ERROR_SIGNAL_RE, maybeNote, pathStem, positionalArgs, squeezeBlankLines } from './helpers.js'

// --------------------------------------------------------------------------- RuffFilter ---------------------------------------------------------------------------

const _RUFF_LINE_RE = /^(?<file>.+?):(?<line>\d+):(?<col>\d+):\s+(?<code>[A-Z]+\d+)\s/
const _RUFF_FOOTER_RE = /^Found \d+ error/
const _RUFF_SUCCESS_RE = /^(?:All checks passed!|No errors found\.?)\s*$/
const _RUFF_FORMAT_REFORMATTED_RE = /^reformatted\s+\S/
const _RUFF_FORMAT_WOULD_REFORMAT_RE = /^would reformat\s+\S/i
// ruff's DEFAULT ("full") output trails each violation header with an optional context block: a bare "   |" separator, a numbered source line ("12 | import os"), a caret-annotation line, and/or a help line. These must be consumed together with their header so collapsing a violation also drops its context instead of leaving it behind unfiltered.
const _RUFF_CONTEXT_LINE_RE = /^\s*(?:\d+\s*)?\|/
const _RUFF_HELP_LINE_RE = /^\s*(?:=\s*)?help:/i
// Since ruff 0.9 the "full" format leads with the rule code and puts the location on a following arrow line, so the concise-format _RUFF_LINE_RE matches none of it: a header is only a header when the very next line is its arrow location.
const _RUFF_FULL_HEADER_RE = /^(?<code>[A-Z]+\d+)(?:\s+\[\*\])?\s+\S/
const _RUFF_FULL_LOCATION_RE = /^\s*-->\s*(?<file>.+?):\d+:\d+\s*$/

// True when lines[i] starts a new full-format violation record, i.e. a code header immediately followed by its arrow location line
function _isRuffFullHeader(lines: string[], i: number): boolean {
  return _RUFF_FULL_HEADER_RE.test(lines[i] ?? '') && _RUFF_FULL_LOCATION_RE.test(lines[i + 1] ?? '')
}

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

    // First pass: group lines into records. A record is either a single violation header (compact/concise formats) or a header plus its trailing "full" format context block, consumed greedily so the whole block travels together through the keep/collapse decision below.
    type Segment =
      | { kind: 'footer'; line: string }
      | { kind: 'other'; line: string }
      | { kind: 'viol'; code: string; file: string; text: string[]; headerLines: number }
    const indexed: Segment[] = []
    const byCode = new Map<string, Array<{ file: string; text: string[] }>>()

    let i = 0
    while (i < lines.length) {
      const line = lines[i]!
      if (_RUFF_FOOTER_RE.test(line)) {
        indexed.push({ kind: 'footer', line })
        i++
        continue
      }
      const m = _RUFF_LINE_RE.exec(line)
      if (m?.groups) {
        const code = m.groups['code']!
        const file = m.groups['file']!
        const text = [line]
        i++
        while (
          i < lines.length &&
          (_RUFF_CONTEXT_LINE_RE.test(lines[i]!) || _RUFF_HELP_LINE_RE.test(lines[i]!))
        ) {
          text.push(lines[i]!)
          i++
        }
        const bucket = byCode.get(code) ?? []
        bucket.push({ file, text })
        byCode.set(code, bucket)
        indexed.push({ kind: 'viol', code, file, text, headerLines: 1 })
        continue
      }
      const fullHeader = _RUFF_FULL_HEADER_RE.exec(line)
      const fullLoc = fullHeader?.groups ? _RUFF_FULL_LOCATION_RE.exec(lines[i + 1] ?? '') : null
      if (fullHeader?.groups && fullLoc?.groups) {
        const code = fullHeader.groups['code']!
        const file = fullLoc.groups['file']!
        const text = [line, lines[i + 1]!]
        i += 2
        while (i < lines.length && lines[i]!.trim() !== '' && !_RUFF_FOOTER_RE.test(lines[i]!) && !_isRuffFullHeader(lines, i)) {
          text.push(lines[i]!)
          i++
        }
        const bucket = byCode.get(code) ?? []
        bucket.push({ file, text })
        byCode.set(code, bucket)
        indexed.push({ kind: 'viol', code, file, text, headerLines: 2 })
      } else {
        indexed.push({ kind: 'other', line })
        i++
      }
    }

    // Decide which codes get summarised (>= 3 occurrences across >= 2 files)
    const summarised = new Map<string, string>()
    // Codes repeated within a single file are not summarised, because the whole point of a one-file report is its line numbers and the summary keeps only one of them. They still get their repeated source-context/caret/help blocks dropped after the first occurrence, which is where nearly all the bytes are: without this, "ruff check one_file.py" was a guaranteed pass-through no matter how long the report.
    const contextCollapsed = new Set<string>()
    for (const [code, entries] of byCode) {
      const files = new Set(entries.map((e) => e.file))
      if (entries.length >= 3 && files.size >= 2) {
        const example = entries[0]!.text[0]
        summarised.set(code, `${code}: ${entries.length} occurrences in ${files.size} files (example: ${example})`)
      } else if (entries.length >= 3 && entries.some((e) => e.text.length > 1)) {
        contextCollapsed.add(code)
      }
    }

    // Second pass: emit records — a summarised code contributes exactly one summary line total, dropping every occurrence's context/caret/help block along with its header; everything else (including full-format context for kept violations) passes through unchanged.
    const out: string[] = []
    const emittedSummary = new Set<string>()
    const footerLines: string[] = []
    const seenPerCode = new Map<string, number>()
    let contextBlocksDropped = 0

    for (const seg of indexed) {
      if (seg.kind === 'footer') {
        footerLines.push(seg.line)
        continue
      }
      if (seg.kind === 'other') {
        out.push(seg.line)
        continue
      }
      if (summarised.has(seg.code)) {
        if (!emittedSummary.has(seg.code)) {
          out.push(summarised.get(seg.code)!)
          emittedSummary.add(seg.code)
        }
      } else if (contextCollapsed.has(seg.code)) {
        const seen = seenPerCode.get(seg.code) ?? 0
        seenPerCode.set(seg.code, seen + 1)
        if (seen === 0 || seg.text.length <= seg.headerLines) {
          out.push(...seg.text)
        } else {
          out.push(...seg.text.slice(0, seg.headerLines))
          contextBlocksDropped++
        }
      } else {
        out.push(...seg.text)
      }
    }
    out.push(...footerLines)
    const notes: string[] = []
    maybeNote(
      notes,
      contextBlocksDropped,
      `dropped ${contextBlocksDropped} repeated source-context blocks (locations kept)`,
    )
    this.emitNotes(out, notes)
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

// --------------------------------------------------------------------------- MypyFilter ---------------------------------------------------------------------------

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

// --------------------------------------------------------------------------- PylintFilter ---------------------------------------------------------------------------

const _PYLINT_MODULE_RE = /^\*{10,}\s+Module\s/
const _PYLINT_ISSUE_RE = /^[^\s].*:\d+:\d+:\s+[CWEFR]\d{4}/
// pylint's default text format writes the message id followed by a colon ("a.py:1:0: C0114: Missing module docstring"), so the trailing boundary must accept ":" as well as whitespace or end-of-line; requiring whitespace on both sides matched no real pylint line, leaving every issue bucketed as "__unknown__".
const _PYLINT_CODE_RE = /\s([CWEFR]\d{4})(?=[\s:]|$)/
// Pylint's symbolic message name, always the last parenthesised token on an issue line ("... (consider-using-f-string)"). It is the half of the identity a reader can act on, so the over-cap placeholder quotes it instead of a slice of the numeric code.
const _PYLINT_SYMBOL_RE = /\(([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\)\s*$/
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
    const pendingPlaceholders: { index: number; code: string; key: string }[] = []
    const codeSymbols = new Map<string, string>()
    let deduplicated = 0
    let droppedSeparators = 0
    let droppedConfig = 0
    let pendingModule: string | null = null
    let currentModule: string | null = null
    let moduleHasKeptIssue = false

    for (const line of lines) {
      if (_PYLINT_RATING_RE.test(line)) { kept.push(line); continue }
      if (_PYLINT_SEPARATOR_RE.test(line)) { droppedSeparators++; continue }
      if (_PYLINT_CONFIG_RE.test(line)) { droppedConfig++; continue }
      if (_PYLINT_MODULE_RE.test(line)) {
        // Flush previous pending header only if it had kept issues
        if (pendingModule !== null && moduleHasKeptIssue) kept.push(pendingModule)
        pendingModule = line
        currentModule = line
        moduleHasKeptIssue = false
        continue
      }
      if (_PYLINT_ISSUE_RE.test(line)) {
        const m = _PYLINT_CODE_RE.exec(line)
        const code = m ? m[1]! : '__unknown__'
        const severity = code[0] ?? '?'
        const key = `${currentModule ?? ''}\x00${code}`
        const symM = _PYLINT_SYMBOL_RE.exec(line)
        if (symM && !codeSymbols.has(key)) codeSymbols.set(key, symM[1]!)
        const count = codeCounts.get(key) ?? 0
        codeCounts.set(key, count + 1)
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
            // Flush pending module header before the over-cap placeholder too, otherwise a module whose issues are entirely over-cap vanishes.
            if (pendingModule !== null) {
              kept.push(pendingModule)
              pendingModule = null
            }
            pendingPlaceholders.push({ index: kept.length, code, key })
            kept.push('')
            moduleHasKeptIssue = true
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

    // Patch placeholders now that codeCounts holds each code's final total, so the elided count reflects reality instead of a literal "+?".
    for (const { index, code, key } of pendingPlaceholders) {
      const elided = (codeCounts.get(key) ?? 0) - PylintFilter._KEEP_PER_CODE
      const symbol = codeSymbols.get(key)
      const label = symbol !== undefined ? `${code} (${symbol})` : code
      kept[index] = `[token-goat: +${elided} more ${label}; disable via TOKEN_GOAT_BASH_COMPRESS]`
    }

    const notes: string[] = []
    maybeNote(notes, deduplicated, `deduplicated ${deduplicated} repeated-code issue line${plural(deduplicated)}`)
    maybeNote(notes, droppedSeparators, `dropped ${droppedSeparators} separator line${plural(droppedSeparators)}`)
    maybeNote(notes, droppedConfig, `dropped ${droppedConfig} config-loading line${plural(droppedConfig)}`)
    this.emitNotes(kept, notes)
    return this.finalize(kept)
  }
}

// --------------------------------------------------------------------------- BlackIsortFilter ---------------------------------------------------------------------------

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
      out.push(`[token-goat: +${countNoun(reformatExtra, 'more reformatted file')}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
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
      out.push(`[token-goat: +${countNoun(fixExtra, 'more fixed file')}; disable via TOKEN_GOAT_BASH_COMPRESS for full list]`)
    }
    out.push(...kept)
    return this.finalize(out)
  }
}

export const ruffFilter = new RuffFilter()
export const mypyFilter = new MypyFilter()
export const pylintFilter = new PylintFilter()
export const blackIsortFilter = new BlackIsortFilter()
