// Bespoke pytest output filter — a faithful port of the Python `PytestFilter`.
//
// Pytest output is highly structured, so this filter does NOT fit the Node test-runner family in `families.ts`: it strips pytest-xdist `[gwN]` worker prefixes, collapses pytest-cov coverage tables to their TOTAL line, trims the `slowest N durations` section to the first five entries, and deduplicates the warnings-summary section — none of which the jest/vitest family models.
//
// Compression model (verbatim from the Python docstring): * Keep — FAILURES / ERRORS blocks, short-test-summary, warnings summary, the final `= N failed, M passed in Xs =` tally, and the `collected N items` line (first three). * Drop — the dots/percent progress line, constant banner lines (platform/cachedir/rootdir/plugins/configfile/bringing-up/ cacheprovider), `collecting …` preamble, the constant `= test session starts =` header, and every PASSED line (kept as a count, in both default and verbose mode). * xdist — strip the `[gw0]` worker prefix from every line. * cov — collapse per-file coverage rows to a single TOTAL line. * slow — keep the section header + first five entries; collapse the rest. * warn — dedupe repeated warning messages; drop `-- Docs:` footers.

import { ToolFilter } from './base.js'
import { trimRepeatedPrefix } from './helpers.js'

// pytest-xdist worker prefix: `[gw0]`, `[gw1] [ 50%]`, … — noise on every line.
const XDIST_PREFIX_RE = /^\[gw\d+\]\s*(?:\[\s*\d+%\]\s*)?/
// Pure progress line: `....F..s....    [ 50%]`.
const DOTS_RE = /^[.FxXEsS]+\s*(\[\s*\d+%\])?\s*$/
// Constant banner lines (also xdist "bringing up nodes" + cacheprovider).
const BANNER_RE =
  /^(?:platform\s|cachedir:\s|rootdir:\s|plugins:\s|configfile:\s|bringing up\s|cacheprovider-)/
// `collecting …` preamble before the session header.
const PREAMBLE_RE = /^collecting\s/
// Section headers (`= FAILURES =`, `= short test summary info =`, final tally …).
const HEADER_RE =
  /^=+\s*(?:test session starts|FAILURES|ERRORS|short test summary info|warnings summary|slowest \d+ durations|\d+ failed|\d+ passed|\d+ error)\b/
// Coverage summary line — keep so the agent sees the overall %.
const COV_TOTAL_RE = /^TOTAL\s+\d/
// A `--- Docs: https://…` warnings footer (always the same URL).
const WARN_DOCS_RE = /^\s*--\s+Docs:\s+https?:\/\//
// A warning message line inside the warnings summary section.
const WARN_MSG_RE = /^\s+\S.*:\d+:\s+\S.*Warning\b/
// Slow-test duration line: `0.12s call tests/test_foo.py::test_bar`.
const SLOW_DURATION_RE = /^\d+\.\d+s\s+(?:call|setup|teardown)\s+\S/
// Status-first result line: `FAILED tests/test_x.py::test_one`.
const FAIL_LINE_RE = /^(FAILED|ERROR|PASSED|SKIPPED|XFAIL|XPASS)\s+\S/
// Verbose-mode per-test line: `tests/foo.py::test_bar PASSED [ 1%]` (status last).
const VERBOSE_LINE_RE = /^\S.+::\S+[ \t]+(PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)(?:[ \t]|$)/
// `collected N items` — collapse all but the first three.
const COLLECT_RE = /^collected \d+ items?/
// Coverage table separator (`---` / `===`) and a per-file coverage row.
const COV_SEP_RE = /^[-=]+\s*$/
const COV_ROW_RE = /^\S.*\s+\d+\s+\d+\s+\d+%?\s*$/

const MAX_SLOW_KEPT = 5

export class PytestFilter extends ToolFilter {
  readonly name = 'pytest'
  override readonly binaries: ReadonlySet<string> = new Set(['pytest', 'py.test'])

  override compress(stdout: string, stderr: string, _exitCode: number, _argv: string[]): string {
    const text = this.combineOutput(stdout, stderr)
    const lines = text.split('\n')
    let kept: string[] = []
    let passedCount = 0
    let inFailures = false
    let inErrors = false
    let inSlowSection = false
    let inWarningsSection = false
    let slowKept = 0
    let slowDropped = 0
    let inCovTable = false
    let covTableRowsDropped = 0
    const warnMsgSeen = new Map<string, number>()
    let warningsDropped = 0

    for (let line of lines) {
      // Strip the pytest-xdist worker prefix so downstream logic sees clean lines.
      if (XDIST_PREFIX_RE.test(line)) line = line.replace(XDIST_PREFIX_RE, '')

      // Drop the dots/percent progress line entirely.
      if (DOTS_RE.test(line)) continue
      // Drop constant banner lines (platform/cachedir/rootdir/…), zero signal.
      if (BANNER_RE.test(line)) continue
      // Drop `collecting …` preamble lines before the session starts.
      if (PREAMBLE_RE.test(line)) continue

      // Section transitions: re-evaluate which block we're in.
      if (HEADER_RE.test(line)) {
        inFailures = line.includes('FAILURES')
        inErrors = line.includes('ERRORS') || line.includes('short test summary')
        inSlowSection = line.includes('slowest') && line.includes('durations')
        inWarningsSection = line.includes('warnings summary')
        inCovTable = false
        // Drop the constant `= test session starts =` header — no signal. All other section headers are preserved verbatim.
        if (line.includes('test session starts')) continue
        kept.push(line)
        continue
      }

      // --- pytest-cov coverage table ---
      if (line.startsWith('Name') && line.includes('Stmts') && line.includes('Miss')) {
        inCovTable = true
        kept.push(line)
        continue
      }
      if (inCovTable) {
        if (COV_TOTAL_RE.test(line)) {
          if (covTableRowsDropped) {
            kept.push(`[token-goat: collapsed ${covTableRowsDropped} coverage table rows]`)
            covTableRowsDropped = 0
          }
          kept.push(line)
          inCovTable = false
          continue
        }
        // Separator lines (--- or ===): keep.
        if (COV_SEP_RE.test(line)) {
          kept.push(line)
          continue
        }
        // Per-file coverage row: drop (covered by TOTAL).
        if (COV_ROW_RE.test(line)) {
          covTableRowsDropped += 1
          continue
        }
        // Anything else exits the table context and falls through.
        inCovTable = false
      }

      // --- warnings summary section ---
      if (inWarningsSection) {
        // Docs-reference line: always drop.
        if (WARN_DOCS_RE.test(line)) {
          warningsDropped += 1
          continue
        }
        // Warning message line: dedupe by normalised message text.
        if (WARN_MSG_RE.test(line)) {
          // Key off the warning text with its leading `path:line:` location stripped, so the SAME warning fired from many call sites collapses but two DIFFERENT warning types or messages never do. The earlier lastIndexOf('Warning') discarded the type name, so e.g. "UserWarning: deprecated" and "FutureWarning: deprecated" produced the same key ("Warning: deprecated") and one was wrongly dropped.
          const normKey = line.replace(/^\s*\S.*?:\d+:\s*/, '').trim() || line.trim()
          const count = warnMsgSeen.get(normKey) ?? 0
          warnMsgSeen.set(normKey, count + 1)
          if (count === 0) kept.push(line)
          else warningsDropped += 1
          continue
        }
        // Everything else in the warnings section is kept verbatim (low-volume context that helps locate the issue) by falling through.
      }

      // --- slowest durations section ---
      if (inSlowSection) {
        if (SLOW_DURATION_RE.test(line)) {
          if (slowKept < MAX_SLOW_KEPT) {
            kept.push(line)
            slowKept += 1
          } else {
            slowDropped += 1
          }
          continue
        }
        // Blank line or new section header exits the slow section.
        if (!line.trim() || HEADER_RE.test(line)) {
          if (slowDropped) {
            kept.push(`[token-goat: collapsed ${slowDropped} slow-test duration lines]`)
            slowDropped = 0
          }
          inSlowSection = false
          if (!line.trim()) continue // drop blank padding
          // Fall through to process the new header line.
          if (HEADER_RE.test(line)) {
            inFailures = line.includes('FAILURES')
            inErrors = line.includes('ERRORS') || line.includes('short test summary')
            inWarningsSection = line.includes('warnings summary')
            kept.push(line)
            continue
          }
        } else {
          // Non-duration line inside slow section — keep as context.
          kept.push(line)
          continue
        }
      }

      // PASSED entries (status-first): count, don't keep — unless inside a failure/error block (captured output may legitimately contain them).
      if (!inFailures && !inErrors && FAIL_LINE_RE.test(line)) {
        const tag = line.split(/\s+/, 1)[0]
        if (tag === 'PASSED') {
          passedCount += 1
          continue
        }
        kept.push(line)
        continue
      }
      // Verbose-mode progress lines (status follows the node ID).
      if (!inFailures && !inErrors) {
        const m = VERBOSE_LINE_RE.exec(line)
        if (m) {
          if (m[1] === 'PASSED') {
            passedCount += 1
            continue
          }
          kept.push(line)
          continue
        }
      }
      kept.push(line)
    }

    // Flush any trailing slow-section counter.
    if (slowDropped) kept.push(`[token-goat: collapsed ${slowDropped} slow-test duration lines]`)
    // Flush any trailing coverage table counter.
    if (covTableRowsDropped)
      kept.push(`[token-goat: collapsed ${covTableRowsDropped} coverage table rows]`)
    // Trim collected-files spam to first three.
    kept = trimRepeatedPrefix(kept, COLLECT_RE, 3)
    if (passedCount) kept.push(`[token-goat: collapsed ${passedCount} PASSED lines]`)
    if (warningsDropped)
      kept.push(`[token-goat: collapsed ${warningsDropped} duplicate/docs warning lines]`)
    return this.finalize(kept)
  }
}

export const pytestFilter: ToolFilter = new PytestFilter()
