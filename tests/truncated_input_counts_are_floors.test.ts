/**
 * A count computed over a clamped stream is a floor, not a total.
 *
 * Two filters printed a figure about the INPUT (how many rows the query returned, how many commits
 * the log held) as a flat fact. Both compute it from whatever survived `apply()`'s pre-filter clamp,
 * so on a clamped stream the number is a lower bound and the reader has no way to tell it apart from
 * a complete one. Same defect and same repair as the grep match-count line in shell_file.ts, which
 * is where the `CompressContext.inputTruncated` seam came from.
 *
 * Each case asserts BOTH halves: the honest form is present AND the flat form is absent. Asserting
 * only presence passes trivially, since the honest string contains the flat string's own words.
 *
 * The last case in each pair drives the real `apply()` pipeline with a small
 * TOKEN_GOAT_FILTER_MAX_BYTES rather than handing `compress()` a context object, because a test that
 * supplies the very dependency the shipping path is supposed to supply proves nothing about the
 * shipping path.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { sqlite3Filter } from '../src/tool_filters/misc.js'
import { GitLogFilter } from '../src/tool_filters/git.js'

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'tool_output')

// Provenance: CAPTURE. Real stdout of sqlite3 3.44.4 (2025-02-19, 32-bit Windows build) run as
// `sqlite3 tgrows.db ".mode column" ".headers on" "select * from t;"` against a throwaway two-column
// table of 40 rows, on 2026-09-06. Verbatim apart from CRLF normalised to LF, which .gitattributes
// enforces for this whole fixture directory anyway.
const SQLITE_ROWS = readFileSync(join(FIXTURES, 'sqlite3-3.44.4-mode-column-40-rows.txt'), 'utf8')

// Provenance: CAPTURE. Real stdout of `git log --oneline -n 120` (git 2.53.0.windows.1) run in this
// repository on 2026-09-06, verbatim.
const GIT_ONELINE = readFileSync(join(FIXTURES, 'git-2.53.0-log-oneline-120.txt'), 'utf8')

const ENV_KEY = 'TOKEN_GOAT_FILTER_MAX_BYTES'
const previousMaxBytes = process.env[ENV_KEY]

afterEach(() => {
  if (previousMaxBytes === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = previousMaxBytes
})

// The shape the defect printed: "[token-goat: <n> rows (showing first 5)]" with nothing marking it
// as partial. Anchored on the digit right after the colon so the honest "at least <n>" form cannot
// satisfy it.
const SQLITE_FLAT_COUNT = /\[token-goat: \d+ rows \(showing first \d+, last \d+\)\]/
const SQLITE_FLOOR_COUNT = /\[token-goat: at least \d+ rows \(counted over a truncated input; showing first \d+, last \d+\)\]/

const GIT_FLAT_COUNT = /\[token-goat: \+\d+ more commits\]/
const GIT_FLOOR_COUNT = /\[token-goat: at least \d+ more commits \(counted over a truncated input\)\]/

describe('sqlite3 filter row count', () => {
  it('prints the exact row count when nothing was clamped away', () => {
    const out = sqlite3Filter.compress(SQLITE_ROWS, '', 0, ['sqlite3', 'tgrows.db'])
    // 40 rows counted by hand off the capture: the fixture is a header row, a dash separator, then
    // ids 1..40. Nothing was dropped upstream, so the exact figure is the honest one here.
    expect(out).toContain('[token-goat: 40 rows (showing first 5, last 5)]')
    expect(out).not.toContain('at least')
  })

  it('prints the row count as a floor when the clamp already dropped part of stdout', () => {
    const out = sqlite3Filter.compress(SQLITE_ROWS, '', 0, ['sqlite3', 'tgrows.db'], { inputTruncated: true })
    expect(out).toMatch(SQLITE_FLOOR_COUNT)
    expect(out).not.toMatch(SQLITE_FLAT_COUNT)
  })

  it('carries the floor through the real apply() clamp, not just a hand-passed context', () => {
    // 300 of the capture's 462 bytes, so clampKeepingEnds really fires and the surviving text still
    // holds well over the 20-row threshold that triggers the count line at all.
    process.env[ENV_KEY] = '300'
    const result = sqlite3Filter.apply(SQLITE_ROWS, '', 0, ['sqlite3', 'tgrows.db'])
    expect(result.text).toMatch(SQLITE_FLOOR_COUNT)
    expect(result.text).not.toMatch(SQLITE_FLAT_COUNT)
  })
})

describe('git log --oneline elided-commit count', () => {
  it('prints the exact elided count when nothing was clamped away', () => {
    const out = new GitLogFilter().compress(GIT_ONELINE, '', 0, ['git', 'log', '--oneline'])
    // 120 captured commits minus the filter's 50-commit cap = 70, computed off the capture rather
    // than read back out of the filter.
    expect(out).toContain('[token-goat: +70 more commits]')
    expect(out).not.toContain('at least')
  })

  it('prints the elided count as a floor when the clamp already dropped part of stdout', () => {
    const out = new GitLogFilter().compress(GIT_ONELINE, '', 0, ['git', 'log', '--oneline'], { inputTruncated: true })
    expect(out).toMatch(GIT_FLOOR_COUNT)
    expect(out).not.toMatch(GIT_FLAT_COUNT)
  })

  it('carries the floor through the real apply() clamp, not just a hand-passed context', () => {
    // 6000 of the capture's 9785 bytes: the clamp fires, and what survives still exceeds the
    // 50-commit cap so the count line is reached.
    process.env[ENV_KEY] = '6000'
    const result = new GitLogFilter().apply(GIT_ONELINE, '', 0, ['git', 'log', '--oneline'])
    expect(result.text).toMatch(GIT_FLOOR_COUNT)
    expect(result.text).not.toMatch(GIT_FLAT_COUNT)
  })
})
