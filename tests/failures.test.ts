import { describe, it, expect } from 'vitest';
import {
  extractFailures,
  formatFailuresText,
  formatFailuresJson,
  getFailureCount,
  failureSignatures,
  computeFailureDelta,
  formatFailureDeltaText,
  formatFailureDeltaJson,
} from '../src/failures.js';

describe('failures', () => {
  describe('extractFailures - pytest', () => {
    it('should extract pytest failures from output', () => {
      const output = `
=== FAILURES ===
______ test_example _______
def test_example():
    assert False
E   AssertionError

tests/test_foo.py:5: AssertionError
==== 1 failed in 0.12s ====
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('pytest');
      expect(result.blocks.length).toBe(1);
      expect(result.blocks[0]?.name).toContain('test_example');
    });

    it('should detect pytest from FAILURES header', () => {
      const output = '=== FAILURES ===\nsome content';
      const result = extractFailures(output);
      expect(result.runner).toBe('pytest');
    });

    it('should handle ERRORS section', () => {
      const output = '=== ERRORS ===\nsome error content';
      const result = extractFailures(output);
      expect(result.runner).toBe('pytest');
    });

    it('should extract summary lines from pytest', () => {
      const output = `
short test summary info
FAILED tests/test_a.py::test_foo - assertion error
FAILED tests/test_b.py::test_bar - timeout
`;
      const result = extractFailures(output);
      // Pin the exact two FAILED lines, not just "at least one line was captured" -- a
      // regression that stopped after the first match would still satisfy length > 0.
      expect(result.summaryLines).toEqual([
        'FAILED tests/test_a.py::test_foo - assertion error',
        'FAILED tests/test_b.py::test_bar - timeout',
      ]);
    });
  });

  describe('extractFailures - jest', () => {
    it('should extract jest failures', () => {
      const output = `
  ● Test suite failed to compile

  Tests:  1 failed, 2 passed (3 total)
  FAIL src/app.test.ts
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('jest');
    });

    it('should handle jest block markers', () => {
      const output = `
  ● some test description
    at path/to/file.ts:10

FAIL src/module.test.ts
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('jest');
    });

    it('should populate statsLine from the Tests: summary line', () => {
      const output = `
  ● some test description
    at path/to/file.ts:10

Tests:  1 failed, 2 passed (3 total)
FAIL src/module.test.ts
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('jest');
      expect(result.statsLine).toBe('Tests:  1 failed, 2 passed (3 total)');
    });
  });

  describe('extractFailures - go', () => {
    it('should extract go test failures', () => {
      const output = `
--- FAIL: TestExample (0.00s)
        main_test.go:15: assertion failed
FAIL
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.blocks.length).toBe(1);
      expect(result.blocks[0]?.name).toContain('TestExample');
      expect(result.blocks[0]?.body).toContain('main_test.go:15: assertion failed');
    });

    it('should detect go runner from pattern', () => {
      const output = '--- FAIL: TestFoo\n--- FAIL: TestBar';
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.blocks.length).toBe(2);
    });

    it('should capture multi-line bodies for multiple go failures', () => {
      const output = `
--- FAIL: TestOne (0.00s)
        one_test.go:10: message one
--- FAIL: TestTwo (0.00s)
        two_test.go:20: message two
FAIL
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.blocks.length).toBe(2);

      const one = result.blocks.find((b) => b.name === 'TestOne');
      const two = result.blocks.find((b) => b.name === 'TestTwo');

      expect(one?.body).toContain('one_test.go:10: message one');
      expect(one?.body).not.toContain('two_test.go:20: message two');

      expect(two?.body).toContain('two_test.go:20: message two');
      expect(two?.body).not.toContain('one_test.go:10: message one');
    });

    it('should populate statsLine from the package-summary FAIL line', () => {
      const output = `
--- FAIL: TestExample (0.00s)
        main_test.go:15: assertion failed
FAIL
exit status 1
FAIL\texample.com/pkg\t0.003s
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.statsLine).toContain('example.com/pkg');
    });

    it('should not populate statsLine from a bare FAIL line with no package summary', () => {
      const output = `
--- FAIL: TestExample (0.00s)
        main_test.go:15: assertion failed
FAIL
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.statsLine).toBe('');
    });
  });

  describe('extractFailures - cargo', () => {
    it('should extract cargo test failures', () => {
      const output = `
test result: FAILED. 1 passed; 1 failed; 0 ignored
test tests::example_test ... FAILED
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('cargo');
      // Pin the exact block and its name, matching the parity check the go extractor's
      // equivalent smoke test already does -- length > 0 alone would pass even with the wrong
      // test name captured or extra spurious blocks.
      expect(result.blocks).toHaveLength(1);
      expect(result.blocks[0]?.name).toBe('tests::example_test');
    });

    it('should pull panic detail out of the separate ---- name stdout ---- section', () => {
      const output = `
running 2 tests
test tests::foo ... FAILED
test tests::bar ... ok

failures:

---- tests::foo stdout ----
thread 'tests::foo' panicked at src/lib.rs:10:5:
assertion \`left == right\` failed
  left: 2
  right: 3
note: run with \`RUST_BACKTRACE=1\` environment variable to display a backtrace


failures:
    tests::foo

test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('cargo');

      const foo = result.blocks.find((b) => b.name === 'tests::foo');
      expect(foo).toBeDefined();
      expect(foo?.body).toContain('assertion `left == right` failed');
      expect(foo?.body).toContain('left: 2');
      expect(foo?.body).toContain('right: 3');
      expect(foo?.body).not.toBe('test tests::foo ... FAILED');
    });

    it('should populate statsLine from the test result line', () => {
      const output = `
running 1 test
test tests::example_test ... FAILED

failures:

---- tests::example_test stdout ----
thread 'tests::example_test' panicked at src/lib.rs:5:5:
assertion failed

failures:
    tests::example_test

test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
`;
      const result = extractFailures(output);
      expect(result.statsLine).toContain('test result: FAILED');
    });
  });

  describe('extractFailures - generic', () => {
    it('should fall back to generic parser for unknown runners', () => {
      const output = `
Some random output
ERROR in module: something went wrong
FAILED component initialization
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('unknown');
      // Pin the exact two matching lines (ERROR + FAILED), not just "at least one" -- the
      // non-matching "Some random output" line must also be correctly excluded.
      expect(result.summaryLines).toEqual([
        'ERROR in module: something went wrong',
        'FAILED component initialization',
      ]);
    });

    it('should find FAILED and ERROR in case-insensitive way', () => {
      const output = `
failed: something
error: another thing
failure: yet another
`;
      const result = extractFailures(output);
      expect(result.summaryLines).toEqual(['failed: something', 'error: another thing', 'failure: yet another']);
    });
  });

  describe('extractFailures - runner override', () => {
    it('should use explicit runner if provided', () => {
      const output = 'some output';
      const result = extractFailures(output, { runner: 'jest' });
      expect(result.runner).toBe('jest');
    });

    it('should force detection to given runner', () => {
      const pytestOutput = '=== FAILURES ===\nFAILED test';
      const result = extractFailures(pytestOutput, { runner: 'go' });
      expect(result.runner).toBe('go');
    });
  });

  describe('getFailureCount', () => {
    it('should count blocks', () => {
      const output = `
--- FAIL: Test1
--- FAIL: Test2
FAIL
`;
      const result = extractFailures(output);
      expect(getFailureCount(result)).toBe(2);
    });

    it('should count summary lines if no blocks', () => {
      const output = 'FAILED test1\nFAILED test2';
      const result = extractFailures(output);
      const count = getFailureCount(result);
      // Pin the exact count of 2 -- length > 0 alone would still pass if the fallback
      // undercounted (e.g. deduped or stopped early).
      expect(count).toBe(2);
    });

    it('should return 0 for no failures', () => {
      const result = extractFailures('no failures here');
      expect(getFailureCount(result)).toBe(0);
    });
  });

  describe('formatFailuresText', () => {
    it('should format with separators', () => {
      const result = extractFailures(`
=== FAILURES ===
______ test_foo _______
assertion failed
====
`);
      const text = formatFailuresText(result);
      expect(text).toContain('─');
      expect(text).toContain('FAIL');
    });

    it('should include runner name', () => {
      const result = extractFailures('=== FAILURES ===\n______ test _______\ntest body\n====');
      const text = formatFailuresText(result);
      expect(text).toContain('[pytest]');
    });

    it('should show count of failures', () => {
      const result = extractFailures(`
--- FAIL: Test1
--- FAIL: Test2
FAIL
`);
      const text = formatFailuresText(result);
      expect(text).toMatch(/2 failure\(s\)/);
    });

    it('should show message when no failures', () => {
      const result = extractFailures('no failures');
      const text = formatFailuresText(result);
      expect(text).toContain('No failures found');
    });

    it('should include summary lines', () => {
      const output = `short test summary
FAILED tests/test_a.py::test - error`;
      const result = extractFailures(output);
      const text = formatFailuresText(result);
      expect(text).toContain('FAILED');
    });
  });

  describe('formatFailuresJson', () => {
    it('should produce valid JSON', () => {
      const result = extractFailures(`
--- FAIL: TestExample
FAIL
`);
      const json = formatFailuresJson(result);
      const parsed = JSON.parse(json);
      expect(parsed).toBeDefined();
      expect(parsed.runner).toBe('go');
    });

    it('should include count', () => {
      const result = extractFailures(`
--- FAIL: Test1
--- FAIL: Test2
FAIL
`);
      const json = formatFailuresJson(result);
      const parsed = JSON.parse(json);
      expect(parsed.count).toBe(2);
    });

    it('should include failures array', () => {
      const result = extractFailures(`
--- FAIL: TestExample
FAIL
`);
      const json = formatFailuresJson(result);
      const parsed = JSON.parse(json);
      expect(parsed.failures).toEqual([{ name: 'TestExample', body: '--- FAIL: TestExample' }]);
    });

    it('should have proper indentation', () => {
      const result = extractFailures('ERROR in test');
      const json = formatFailuresJson(result);
      expect(json).toContain('\n  ');
    });

    it('should include runner and stats', () => {
      const result = extractFailures('=== FAILURES ===\ntest\n=== 1 failed ===');
      const json = formatFailuresJson(result);
      const parsed = JSON.parse(json);
      expect(parsed).toHaveProperty('runner');
      expect(parsed).toHaveProperty('stats');
    });
  });

  describe('edge cases', () => {
    it('should handle empty input', () => {
      const result = extractFailures('');
      expect(result).toBeDefined();
      expect(getFailureCount(result)).toBe(0);
    });

    it('should handle very long failure blocks', () => {
      const longBody = 'x'.repeat(10000);
      const output = `
=== FAILURES ===
______ test_big _______
${longBody}
====
`;
      const result = extractFailures(output);
      expect(result.blocks[0]?.body).toContain('x');
    });

    it('should handle mixed line endings', () => {
      const output = '--- FAIL: Test1\r\n--- FAIL: Test2\n';
      const result = extractFailures(output);
      expect(result.blocks.length).toBe(2);
    });

    it('should handle unicode in failure names', () => {
      const output = '--- FAIL: Test_ñ_中文_🚀\nFAIL';
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
    });
  });

  describe('ANSI-colorized output', () => {
    it('should detect and count colorized pytest FAILED lines (ANSI-wrapped)', () => {
      // Real `pytest --color=yes` output colors the FAILED token itself. Without
      // stripping ANSI codes first, the escape sequence right before "FAILED"
      // breaks the fallback `line.startsWith('FAILED ')` check, and the escape
      // codes touching "FAILED" also break detectRunner's `\bFAILED\b` boundary,
      // so real failures were silently reported as zero.
      const output = `
short test summary info
\x1b[31mFAILED\x1b[0m tests/test_a.py::test_foo - assertion error
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('pytest');
      expect(getFailureCount(result)).toBe(1);
    });

    it('should detect and extract colorized Go --- FAIL: blocks (ANSI-wrapped)', () => {
      // Real colorized `go test` output wraps the whole "--- FAIL: ..." line in an
      // escape sequence, so it no longer starts with the literal "-" the anchored
      // GO_FAIL/detectRunner regexes require.
      const output = `
\x1b[31m--- FAIL: TestExample (0.00s)\x1b[0m
        main_test.go:15: assertion failed
\x1b[31mFAIL\x1b[0m
`;
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.blocks.length).toBe(1);
      expect(result.blocks[0]?.name).toContain('TestExample');
    });
  });

  describe('failureSignatures', () => {
    it('uses block names when blocks exist', () => {
      const result = extractFailures('--- FAIL: TestA\n--- FAIL: TestB\nFAIL');
      expect(failureSignatures(result)).toEqual(['TestA', 'TestB']);
    });

    it('falls back to summary lines when there are no blocks', () => {
      const output = 'short test summary info\nFAILED tests/test_a.py::test_foo - assertion error';
      const result = extractFailures(output);
      expect(result.blocks.length).toBe(0);
      const sigs = failureSignatures(result);
      expect(sigs.length).toBe(1);
      expect(sigs[0]).toContain('test_foo');
    });

    it('deduplicates repeated signatures', () => {
      const result = extractFailures('--- FAIL: TestA\n--- FAIL: TestA\nFAIL');
      expect(failureSignatures(result)).toEqual(['TestA']);
    });

    it('does not treat line-number-only differences as different tests (pytest block names carry no line number)', () => {
      const runA = extractFailures('=== FAILURES ===\n______ test_foo _______\ntest_module.py:12: assert 1 == 2\n=== 1 failed ===');
      const runB = extractFailures('=== FAILURES ===\n______ test_foo _______\ntest_module.py:99: assert 1 == 2\n=== 1 failed ===');
      expect(failureSignatures(runA)).toEqual(failureSignatures(runB));
    });
  });

  describe('computeFailureDelta', () => {
    it('reports everything as newlyFailing when there is no prior baseline', () => {
      const delta = computeFailureDelta(null, ['TestA', 'TestB']);
      expect(delta.hasBaseline).toBe(false);
      expect(delta.newlyFailing).toEqual(['TestA', 'TestB']);
      expect(delta.newlyFixed).toEqual([]);
      expect(delta.stillFailing).toEqual([]);
    });

    it('splits into newlyFailing/newlyFixed/stillFailing against a prior baseline', () => {
      const prev = ['TestA', 'TestB', 'TestC'];
      const curr = ['TestB', 'TestD'];
      const delta = computeFailureDelta(prev, curr);
      expect(delta.hasBaseline).toBe(true);
      expect(delta.newlyFailing).toEqual(['TestD']);
      expect(delta.newlyFixed).toEqual(['TestA', 'TestC']);
      expect(delta.stillFailing).toEqual(['TestB']);
    });

    it('reports no changes when current matches the prior baseline exactly', () => {
      const set = ['TestA', 'TestB'];
      const delta = computeFailureDelta(set, set);
      expect(delta.newlyFailing).toEqual([]);
      expect(delta.newlyFixed).toEqual([]);
      expect(delta.stillFailing).toEqual(['TestA', 'TestB']);
    });

    it('reports all fixed when current is empty', () => {
      const delta = computeFailureDelta(['TestA', 'TestB'], []);
      expect(delta.newlyFailing).toEqual([]);
      expect(delta.newlyFixed).toEqual(['TestA', 'TestB']);
      expect(delta.stillFailing).toEqual([]);
    });
  });

  describe('formatFailureDeltaText', () => {
    it('shows the no-baseline message on first run', () => {
      const delta = computeFailureDelta(null, ['TestA']);
      const text = formatFailureDeltaText(delta, 'go');
      expect(text).toContain('No baseline yet');
      expect(text).toContain('+ TestA');
      expect(text).toContain('[go]');
    });

    it('shows newly failing, newly fixed, and a still-failing count (not a full list)', () => {
      const delta = computeFailureDelta(['TestA', 'TestC'], ['TestA', 'TestB']);
      const text = formatFailureDeltaText(delta, 'pytest');
      expect(text).toContain('Newly failing (1)');
      expect(text).toContain('+ TestB');
      expect(text).toContain('Newly fixed (1)');
      expect(text).toContain('- TestC');
      expect(text).toContain('Still failing (unchanged): 1');
      // TestA is still-failing (unchanged) and must not appear as a bulleted detail line.
      expect(text).not.toMatch(/[+-] TestA/);
    });
  });

  describe('formatFailureDeltaJson', () => {
    it('produces valid JSON with a stillFailingCount, not a full stillFailing list', () => {
      const delta = computeFailureDelta(['TestA', 'TestC'], ['TestA', 'TestB']);
      const json = formatFailureDeltaJson(delta, 'pytest');
      const parsed = JSON.parse(json);
      expect(parsed.runner).toBe('pytest');
      expect(parsed.hasBaseline).toBe(true);
      expect(parsed.newlyFailing).toEqual(['TestB']);
      expect(parsed.newlyFixed).toEqual(['TestC']);
      expect(parsed.stillFailingCount).toBe(1);
      expect(parsed.stillFailing).toBeUndefined();
    });

    it('reflects hasBaseline:false on the first invocation', () => {
      const delta = computeFailureDelta(null, ['TestA']);
      const json = formatFailureDeltaJson(delta, 'go');
      const parsed = JSON.parse(json);
      expect(parsed.hasBaseline).toBe(false);
      expect(parsed.newlyFailing).toEqual(['TestA']);
    });
  });
});
