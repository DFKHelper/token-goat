/** scripts/test-durations.mjs turns a vitest log into the slowest-files table the pre-push hook prints for each leg. The lines below are copied from real pre-push logs, one with colour codes (the WSL leg) and one without (the Windows leg). */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { formatTable, parseDurations, parseFailedFiles, parseFailedRun, slowest } from '../scripts/test-durations.mjs'

const SCRIPT = path.join(fileURLToPath(new URL('..', import.meta.url)), 'scripts', 'test-durations.mjs')
const ESC = '\u001b'

// CAPTURE: lines copied from the Windows leg's tests.log of a pre-push run (token-goat-pre-push.Zg19t1/tests.log, 2026-10-15), plain text. The two `×`/`❯` sub-test lines are indented deeper and must not count as files.
const WINDOWS_LOG = [
  ' ✓ tests/tool_filters_git.test.ts (140 tests) 1285ms',
  ' ✓ tests/cli.test.ts (108 tests | 6 skipped) 25112ms',
  ' ❯ tests/hooks_stop.test.ts (239 tests | 1 failed) 4933ms',
  '   ❯ the built hook entry, per host (2)',
  '     × codex: a test run that reported no status, then an edit, then a stop names the file and the run 1162ms',
].join('\n')

// CAPTURE: lines copied from the WSL leg's wsl-test.log of the same run (token-goat-pre-push.Zg19t1/wsl-test.log), colour codes included; the skipped file has no duration and is not a timing.
const WSL_LOG = [
  ` ${ESC}[32m✓${ESC}[39m tests/cli_cached_output_redact_before_clip.test.ts ${ESC}[2m(${ESC}[22m${ESC}[2m2 tests${ESC}[22m${ESC}[2m)${ESC}[22m${ESC}[32m 46${ESC}[2mms${ESC}[22m${ESC}[39m`,
  ` ${ESC}[32m✓${ESC}[39m tests/worker_launcher_priority.test.ts ${ESC}[2m(${ESC}[22m${ESC}[2m1 test${ESC}[22m${ESC}[2m)${ESC}[22m${ESC}[32m 24${ESC}[2mms${ESC}[22m${ESC}[39m`,
  ` ${ESC}[2m${ESC}[90m↓${ESC}[39m${ESC}[22m tests/cli_doctor_process.test.ts ${ESC}[2m(${ESC}[22m${ESC}[2m1 test${ESC}[22m${ESC}[2m | ${ESC}[22m${ESC}[33m1 skipped${ESC}[39m${ESC}[2m)${ESC}[22m`,
].join('\n')

describe('parseDurations', () => {
  it('reads plain per-file lines, failed files included, and ignores sub-test lines', () => {
    const got = parseDurations(WINDOWS_LOG)
    expect(got.map((e) => [e.file, e.ms])).toEqual([
      ['tests/tool_filters_git.test.ts', 1285],
      ['tests/cli.test.ts', 25112],
      ['tests/hooks_stop.test.ts', 4933],
    ])
  })

  it('reads coloured lines and drops a skipped file that has no duration', () => {
    const got = parseDurations(WSL_LOG)
    expect(got.map((e) => [e.file, e.ms])).toEqual([
      ['tests/cli_cached_output_redact_before_clip.test.ts', 46],
      ['tests/worker_launcher_priority.test.ts', 24],
    ])
  })

  it('keeps the longest run when a file is listed twice and tolerates CRLF', () => {
    const got = parseDurations(' ✓ tests/a.test.ts (1 test) 10ms\r\n ✓ tests/a.test.ts (1 test) 30ms\r\n')
    expect(got).toEqual([{ file: 'tests/a.test.ts', ms: 30, detail: '1 test' }])
  })
})

describe('slowest and formatTable', () => {
  it('orders by duration and cuts to N', () => {
    const top = slowest(parseDurations(`${WINDOWS_LOG}\n${WSL_LOG}`), 2)
    expect(top.map((e) => e.file)).toEqual(['tests/cli.test.ts', 'tests/hooks_stop.test.ts'])
    expect(formatTable(top).split('\n')[0]).toBe('   25112ms  tests/cli.test.ts  (108 tests | 6 skipped)')
  })
})

describe('command line', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('prints the table for a log and says so when it finds no timings', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'tg-durations-'))
    const log = path.join(dir, 'tests.log')
    writeFileSync(log, WINDOWS_LOG)
    const out = execFileSync(process.execPath, [SCRIPT, log, '--top', '1'], { encoding: 'utf8' })
    expect(out).toBe('   25112ms  tests/cli.test.ts  (108 tests | 6 skipped)\n')
    writeFileSync(log, 'nothing here\n')
    expect(execFileSync(process.execPath, [SCRIPT, log], { encoding: 'utf8' })).toContain('no per-file timings found')
  })
})

// CAPTURE: failure lines from the same two logs. Windows: tests.log lines 8523, 8536 and 2142 (plain); WSL: wsl-test.log line 825 (colour codes, cut after the test title). A file with several failing tests and a file listed by both a FAIL line and a counted line must appear once.
const FAILED_WINDOWS = [
  ' FAIL  tests/embed_gates_asset_and_chunk_count.test.ts > indexFileEmbeddings refuses files with no embeddable text > keeps embedding a file just under the ceiling, so the gate is a ceiling and no',
  ' FAIL  tests/hooks_stop.test.ts > the built hook entry, per host > codex: a test run that reported no status, then an edit, then a stop names the file and the run',
  ' ❯ tests/hooks_stop.test.ts (239 tests | 1 failed) 4933ms',
  ' ✓ tests/cli.test.ts (108 tests | 6 skipped) 25112ms',
].join('\n')
const FAILED_WSL = `${ESC}[41m${ESC}[1m FAIL ${ESC}[22m${ESC}[49m tests/parser_fingerprint_gate.test.ts${ESC}[2m > ${ESC}[22mparser fingerprint freshness gate${ESC}[2m > ${ESC}[22mhas a checked-in fingerprint that still matches the extraction sourc`

describe('parseFailedFiles', () => {
  it('lists each failing file once and leaves passing and skipped files out', () => {
    expect(parseFailedFiles(FAILED_WINDOWS)).toEqual(['tests/embed_gates_asset_and_chunk_count.test.ts', 'tests/hooks_stop.test.ts'])
  })

  it('reads a coloured FAIL line', () => {
    expect(parseFailedFiles(FAILED_WSL)).toEqual(['tests/parser_fingerprint_gate.test.ts'])
  })

  it('finds nothing in a green log', () => {
    expect(parseFailedFiles(WINDOWS_LOG.split('\n')[0] + '\n' + WSL_LOG)).toEqual([])
  })
})

// CAPTURE: a Windows pre-push log (token-goat-pre-push tests.log). Line 4515 is the worker-timeout line, lines 8913 and 8929 are FAIL lines, and line 9034 is the summary of that run (8 failed files).
const WORKER_TIMEOUT = '[vitest-pool]: Timeout terminating forks worker for test files C:/tgwt/flk-d/tests/semantic_foreground_defers_download.test.ts.'
const FAIL_A = ' FAIL  tests/ref_blindness.test.ts > refs: the all-or-nothing ref-blind probe must not sample a truncated prefix'
const FAIL_B = ' FAIL  tests/brief_caller_count_scope.test.ts > brief caller count is scoped to the resolved definition > counts only the callers of THIS widget, not the same-named widget in another file'
const SUMMARY_2 = ' Test Files  2 failed | 1352 passed | 5 skipped (1365)'
const SUMMARY_1 = ' Test Files  1 failed | 1352 passed (1365)'
const SUMMARY_8 = ' Test Files  8 failed | 1352 passed | 5 skipped (1365)'

describe('parseFailedRun', () => {
  it('trusts a log whose summary count equals the parsed files', () => {
    expect(parseFailedRun([FAIL_A, FAIL_B, SUMMARY_2].join('\n'))).toEqual({ files: ['tests/ref_blindness.test.ts', 'tests/brief_caller_count_scope.test.ts'], trusted: true, reason: '' })
  })

  it('distrusts a summary that counts more failed files than were parsed', () => {
    const run = parseFailedRun([FAIL_A, FAIL_B, SUMMARY_8].join('\n'))
    expect(run.trusted).toBe(false)
    expect(run.reason).toContain('counts 8 failed file(s) but 2 were parsed')
  })

  it('distrusts a log with a worker timeout line even when the counts agree', () => {
    const run = parseFailedRun([WORKER_TIMEOUT, FAIL_A, FAIL_B, SUMMARY_2].join('\n'))
    expect(run.trusted).toBe(false)
    expect(run.reason).toContain('vitest-pool')
  })

  it.each(['⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯', 'Error: Worker exited unexpectedly', 'Unhandled Rejection: boom'])('distrusts the marker %s', (marker) => {
    // HAND-DERIVED: vitest prints these markers at the start of a line; the worker-timeout capture above is the only captured marker.
    expect(parseFailedRun([FAIL_A, marker, SUMMARY_1].join('\n')).trusted).toBe(false)
  })

  it('does not take a passing test title that mentions an unhandled exception for a marker', () => {
    const title = '     ✓ parses a bare .NET exception (no "Unhandled exception." prefix) and filters out a frame 424ms'
    expect(parseFailedRun([title, FAIL_A, SUMMARY_1].join('\n')).trusted).toBe(true)
  })

  it('distrusts failures with no summary line and accepts a green log', () => {
    expect(parseFailedRun(FAIL_A).trusted).toBe(false)
    expect(parseFailedRun(' Test Files  3 passed (3)').trusted).toBe(true)
  })
})
