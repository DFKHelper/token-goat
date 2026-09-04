// Batch A golden tests — Node test-runner filters (jest/mocha/ava/tap, vitest). Ported faithfully from the Python suite (tests/test_bash_compress.py: TestJestFilter, TestJestFilterVerboseFeatures, TestVitestFilter). These are the regression spec for the family factory in src/tool_filters/families.ts.

import { describe, expect, it } from 'vitest'

import {
  detectFromCommand,
  jestFilter,
  selectFilter,
  TOOL_FILTERS,
  vitestFilter,
} from '../src/tool_filters/index.js'

describe('jest filter (family factory)', () => {
  it('collapses repeated PASS file headers to a count, keeps the summary', () => {
    let text = Array.from({ length: 10 }, () => 'PASS  src/foo.test.js').join('\n')
    text += '\nTests: 50 passed\n'
    const result = jestFilter.apply(text, '', 0, ['jest'])
    expect(result.text).not.toContain('PASS  src/foo.test.js')
    expect(result.text).toContain('collapsed 10 PASS files')
    expect(result.text).toContain('Tests: 50 passed')
  })

  it('keeps a FAIL block verbatim', () => {
    const text = 'FAIL src/foo.test.js\n  expected: 1\n  received: 2\n\nTests: 1 failed\n'
    const result = jestFilter.apply(text, '', 1, ['jest'])
    expect(result.text).toContain('FAIL src/foo.test.js')
    expect(result.text).toContain('expected: 1')
  })

  it('drops the --verbose duplicate "Failures:" section but keeps the inline block and summary', () => {
    const text =
      'FAIL src/foo.test.js\n' +
      '  ● describe > test name\n' +
      '    Expected: 1\n' +
      '    Received: 2\n' +
      '\n' +
      'Failures:\n' +
      '  1. describe > test name\n' +
      '     Expected: 1\n' +
      '     Received: 2\n' +
      '\n' +
      'Test Suites: 1 failed, 1 total\n' +
      'Tests:       1 failed, 1 total\n' +
      'Time:        1.234 s\n'
    const result = jestFilter.apply(text, '', 1, ['jest', '--verbose'])
    // Inline FAIL block survives.
    expect(result.text).toContain('FAIL src/foo.test.js')
    expect(result.text).toContain('Expected: 1')
    // Failure details appear exactly once (inline), not duplicated by the section.
    expect(result.text.split('Expected: 1').length - 1).toBe(1)
    // A note explains the collapse.
    expect(result.text).toMatch(/duplicate|Failures:|collapsed/)
    // Summary lines preserved.
    expect(result.text).toContain('Test Suites: 1 failed')
    expect(result.text).toContain('Tests:       1 failed')
  })

  it('keeps summary lines following the "Failures:" section and collapses the PASS file', () => {
    const text =
      'PASS src/bar.test.js\n' +
      'FAIL src/foo.test.js\n' +
      '  ● test fails\n' +
      '\n' +
      'Failures:\n' +
      '  1. test fails\n' +
      '     Expected true but got false\n' +
      '\n' +
      'Test Suites: 1 failed, 2 total\n' +
      'Tests:       1 failed, 5 total\n'
    const result = jestFilter.apply(text, '', 1, ['jest', '--verbose'])
    expect(result.text).toContain('Test Suites: 1 failed, 2 total')
    expect(result.text).toContain('Tests:       1 failed, 5 total')
    expect(result.text).not.toContain('PASS src/bar.test.js')
  })

  it('passes through output with no "Failures:" section, collapsing PASS files', () => {
    const text = 'PASS src/a.test.js\nPASS src/b.test.js\nTests: 10 passed, 10 total\n'
    const result = jestFilter.apply(text, '', 0, ['jest'])
    expect(result.text).toContain('Tests: 10 passed')
    expect(result.text).toContain('collapsed 2 PASS files')
  })
})

describe('vitest filter (family factory)', () => {
  it('collapses file-level pass lines, keeps the summary', () => {
    const lines = Array.from({ length: 8 }, (_, i) => ` ✓ src/module${i}.test.ts (12ms)`)
    lines.push('Test Files  8 passed (8)', 'Tests       32 passed (32)', 'Duration    1.23s')
    const result = vitestFilter.apply(lines.join('\n'), '', 0, ['vitest'])
    expect(result.text).not.toContain('module0.test.ts')
    expect(result.text).toContain('collapsed 8 passing')
    expect(result.text).toContain('Test Files  8 passed')
  })

  it('keeps a failing file block verbatim, collapses the passing file', () => {
    const text =
      ' ✓ src/passing.test.ts (5ms)\n' +
      ' × src/broken.test.ts (3ms)\n' +
      '   AssertionError: expected 1 to equal 2\n' +
      '   at Object.<anonymous> (src/broken.test.ts:10:5)\n' +
      'Test Files  1 failed | 1 passed (2)\n'
    const result = vitestFilter.apply(text, '', 1, ['vitest'])
    expect(result.text).toContain('broken.test.ts')
    expect(result.text).toContain('AssertionError')
    expect(result.text).not.toContain('passing.test.ts')
    expect(result.text).toContain('Test Files')
  })

  it('collapses indented per-test pass ticks', () => {
    const lines = ['Tests']
    for (let i = 0; i < 20; i++) lines.push(`  ✓ should pass case ${i}`)
    lines.push('Tests       20 passed (20)')
    const result = vitestFilter.apply(lines.join('\n'), '', 0, ['vitest', '--reporter=verbose'])
    expect(result.text).not.toContain('should pass case 0')
    expect(result.text).toContain('collapsed')
  })

  it('always keeps Test Files / Tests / Duration summary lines', () => {
    const text =
      ' ✓ src/a.test.ts (1ms)\n' +
      ' ✓ src/b.test.ts (2ms)\n' +
      'Test Files  2 passed (2)\n' +
      'Tests       10 passed (10)\n' +
      'Duration    0.50s\n'
    const result = vitestFilter.apply(text, '', 0, ['vitest'])
    expect(result.text).toContain('Test Files  2 passed')
    expect(result.text).toContain('Tests       10 passed')
    expect(result.text).toContain('Duration    0.50s')
  })

  it('reduces size on a large all-pass run', () => {
    const lines = Array.from({ length: 50 }, (_, i) => ` ✓ src/module${i}.test.ts (10ms)`)
    lines.push('Test Files  50 passed (50)')
    const text = lines.join('\n')
    const result = vitestFilter.apply(text, '', 0, ['vitest'])
    expect(result.compressedBytes).toBeLessThan(Buffer.byteLength(text, 'utf8'))
  })
})

/**
 * `--reporter=verbose` output, which the ported golden suite above never saw.
 *
 * Fixture provenance: CAPTURE. Every line here is copied byte for byte out of
 * tests/fixtures/bench/vitest-run.txt, which is the redirected output of
 * `npx vitest run tests/paths.test.ts tests/config.test.ts --reporter=verbose` in this repo.
 * That distinction is the whole reason this describe exists: the golden tests above write their
 * summary lines flush against the left margin (`'Test Files  8 passed (8)'`), which is what
 * `summaryRe` required and what vitest has never actually printed -- it right-aligns the labels.
 * A fixture shaped by the regex agrees with the regex, so three separate mismatches sat here
 * behind a green suite, and `token-goat bench` scored a real verbose run at 2 bytes saved out of
 * 22,684.
 */
describe('vitest filter on --reporter=verbose output', () => {
  const TICKS = [
    ' ✓ tests/paths.test.ts > safeJoin > joins normally when no part contains a colon 28ms',
    ' ✓ tests/paths.test.ts > safeJoin > throws when any part contains a colon (drive-letter escape) 1ms',
    ' ✓ tests/paths.test.ts > normalizePath > converts backslashes to forward slashes 0ms',
    // A test NAME ending in something shaped like a file-header duration. This one was counted as
    // a passing FILE rather than a passing test.
    ' ✓ tests/config.test.ts > loadConfig > clamps a below-range env var override for TOKEN_GOAT_HOOK_WATCHDOG_MS to the documented min (100ms) 1ms',
  ]
  const SUMMARY = [
    ' Test Files  2 passed (2)',
    '      Tests  140 passed (140)',
    '   Start at  08:16:18',
    '   Duration  1.64s (transform 1.05s, setup 58ms, import 1.24s, tests 144ms, environment 0ms)',
  ]

  it('collapses the per-test lines and keeps every summary line', () => {
    const text = [' RUN  v4.1.11 C:/Projects/token-goat', '', ...TICKS, '', ...SUMMARY].join('\n')
    const result = vitestFilter.apply(text, '', 0, ['vitest', '--reporter=verbose'])
    for (const tick of TICKS) expect(result.text).not.toContain(tick)
    // Must-not-drop: these four lines are the entire reason someone reads a passing run's output.
    for (const line of SUMMARY) expect(result.text).toContain(line)
    expect(result.compressedBytes).toBeLessThan(Buffer.byteLength(text, 'utf8'))
  })

  it('counts a test whose name ends in a duration as a test, not as a file', () => {
    const result = vitestFilter.apply([...TICKS, ...SUMMARY].join('\n'), '', 0, ['vitest', '--reporter=verbose'])
    expect(result.text).toContain(`collapsed ${TICKS.length} passing ticks`)
    expect(result.text).not.toContain('passing file')
  })

  it('keeps a summary line that follows a stdout block, rather than counting it into the block', () => {
    // The collapse loop drops any indented line inside an open output block. Vitest indents its
    // summary, so before summaryRe allowed leading whitespace, a run whose last test printed to
    // stdout lost its counts entirely -- the one part of a run's output nobody can do without.
    const text = [' stdout | tests/a.test.ts > logs', '   some logged line', ...SUMMARY].join('\n')
    const result = vitestFilter.apply(text, '', 0, ['vitest', '--reporter=verbose'])
    for (const line of SUMMARY) expect(result.text).toContain(line)
    expect(result.text).not.toContain('some logged line')
  })
})

describe('dispatch: test runners are registered and selected', () => {
  it('routes vitest / jest / mocha to their filters', () => {
    expect(selectFilter(['vitest'])?.name).toBe('vitest')
    expect(selectFilter(['jest'])?.name).toBe('jest')
    expect(selectFilter(['mocha'])?.name).toBe('jest')
    expect(selectFilter(['npx', 'jest'])?.name).toBe('jest')
  })

  it('detectFromCommand resolves a runner command end to end', () => {
    const det = detectFromCommand('npx vitest run')
    expect(det?.filter.name).toBe('vitest')
  })

  it('registers exactly the batch-A runners at the head of TOOL_FILTERS', () => {
    expect(TOOL_FILTERS.map((f) => f.name)).toEqual(
      expect.arrayContaining(['jest', 'vitest']),
    )
  })
})
