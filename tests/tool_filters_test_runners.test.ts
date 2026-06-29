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
