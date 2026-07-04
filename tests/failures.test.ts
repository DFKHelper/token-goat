import { describe, it, expect } from 'vitest';
import {
  extractFailures,
  formatFailuresText,
  formatFailuresJson,
  getFailureCount,
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
      expect(result.blocks.length).toBeGreaterThan(0);
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
      expect(result.summaryLines.length).toBeGreaterThan(0);
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
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks[0]?.name).toContain('TestExample');
    });

    it('should detect go runner from pattern', () => {
      const output = '--- FAIL: TestFoo\n--- FAIL: TestBar';
      const result = extractFailures(output);
      expect(result.runner).toBe('go');
      expect(result.blocks.length).toBe(2);
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
      expect(result.blocks.length).toBeGreaterThan(0);
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
      expect(result.summaryLines.length).toBeGreaterThan(0);
    });

    it('should find FAILED and ERROR in case-insensitive way', () => {
      const output = `
failed: something
error: another thing
failure: yet another
`;
      const result = extractFailures(output);
      expect(result.summaryLines.length).toBeGreaterThanOrEqual(2);
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
      expect(count).toBeGreaterThan(0);
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
      expect(Array.isArray(parsed.failures)).toBe(true);
      if (parsed.failures.length > 0) {
        expect(parsed.failures[0]).toHaveProperty('name');
        expect(parsed.failures[0]).toHaveProperty('body');
      }
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
      expect(result.blocks.length).toBeGreaterThan(0);
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
      expect(getFailureCount(result)).toBeGreaterThan(0);
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
      expect(result.blocks.length).toBeGreaterThan(0);
      expect(result.blocks[0]?.name).toContain('TestExample');
    });
  });
});
