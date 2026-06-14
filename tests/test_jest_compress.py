"""Tests for jest/vitest post-bash detection and compression helpers."""
from __future__ import annotations

import textwrap

from token_goat import bash_compress as bc

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

JEST_PASS_ONLY = textwrap.dedent("""\
 PASS src/components/Button.test.js
   Button
     ✓ renders without errors (3 ms)
     ✓ handles click events (5 ms)
 PASS src/utils/format.test.js
   format
     ✓ formats date correctly (2 ms)
Test Suites: 2 passed, 2 total
Tests:       3 passed, 3 total
Snapshots:   0 total
Time:        1.234 s
Ran all test suites.
""")

JEST_MIXED = textwrap.dedent("""\
 PASS src/components/Button.test.js
   Button
     ✓ renders without errors (3 ms)
 FAIL src/api/client.test.js
   ● ClientAPI › should handle errors

     expect(received).toBe(expected)

     Expected: "ok"
     Received: "error"

       5 | test('should handle errors', () => {
       6 |   expect(client.get()).toBe('ok');
         |                        ^
       7 | });

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 1 passed, 2 total
Snapshots:   0 total
Time:        2.534 s
Ran all test suites.
""")

VITEST_OUTPUT = textwrap.dedent("""\
 ✓ src/utils.test.ts (3 tests)
 ✓ src/api.test.ts (5 tests)
 × src/client.test.ts (1 test)
   → Client > handles errors

Test Files  1 failed | 2 passed (3)
Tests       1 failed | 8 passed (9)
Duration    1.23s
""")

VITEST_PASS_ONLY = textwrap.dedent("""\
 ✓ src/utils.test.ts (3 tests)
 ✓ src/api.test.ts (5 tests)
 ✓ src/helpers.test.ts (2 tests)

Test Files  3 passed (3)
Tests       10 passed (10)
Duration    0.89s
""")


def _post_bash(cmd: str, stdout: str, *, exit_code: int = 0) -> dict:
    """Run post_bash with a minimal sessionless payload."""
    from token_goat.hooks_read import post_bash
    return post_bash({
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_input": {"command": cmd},
        "tool_response": {"stdout": stdout, "stderr": "", "exit_code": exit_code},
    })


# ---------------------------------------------------------------------------
# _is_jest_cmd
# ---------------------------------------------------------------------------

class TestIsJestCmd:
    def test_jest_binary(self) -> None:
        assert bc._is_jest_cmd(["jest"])

    def test_jest_binary_with_args(self) -> None:
        assert bc._is_jest_cmd(["jest", "--coverage", "src/"])

    def test_vitest_binary(self) -> None:
        assert bc._is_jest_cmd(["vitest"])

    def test_react_scripts(self) -> None:
        assert bc._is_jest_cmd(["react-scripts"])

    def test_npx_jest(self) -> None:
        assert bc._is_jest_cmd(["npx", "jest"])

    def test_npx_vitest(self) -> None:
        assert bc._is_jest_cmd(["npx", "vitest"])

    def test_yarn_test(self) -> None:
        assert bc._is_jest_cmd(["yarn", "test"])

    def test_npm_test(self) -> None:
        assert bc._is_jest_cmd(["npm", "test"])

    def test_pnpm_test(self) -> None:
        assert bc._is_jest_cmd(["pnpm", "test"])

    def test_npm_run_build_false(self) -> None:
        assert not bc._is_jest_cmd(["npm", "run", "build"])

    def test_python_false(self) -> None:
        assert not bc._is_jest_cmd(["python", "script.py"])

    def test_empty_argv_false(self) -> None:
        assert not bc._is_jest_cmd([])

    def test_windows_exe_suffix(self) -> None:
        assert bc._is_jest_cmd(["jest.exe"])

    def test_windows_cmd_suffix(self) -> None:
        assert bc._is_jest_cmd(["vitest.cmd"])

    def test_cargo_false(self) -> None:
        assert not bc._is_jest_cmd(["cargo", "test"])

    def test_npx_yes_jest(self) -> None:
        assert bc._is_jest_cmd(["npx", "--yes", "jest"])

    def test_npx_legacy_peer_deps_jest(self) -> None:
        assert bc._is_jest_cmd(["npx", "--legacy-peer-deps", "jest"])


# ---------------------------------------------------------------------------
# _has_jest_output / _has_vitest_output
# ---------------------------------------------------------------------------

class TestHasJestOutput:
    def test_pass_line_detected(self) -> None:
        assert bc._has_jest_output(" PASS src/foo.test.js\nTest Suites: 1 passed\n")

    def test_fail_line_detected(self) -> None:
        assert bc._has_jest_output(" FAIL src/foo.test.js\nTest Suites: 1 failed\n")

    def test_mixed_detected(self) -> None:
        assert bc._has_jest_output(JEST_MIXED)

    def test_plain_text_false(self) -> None:
        assert not bc._has_jest_output("hello world\nno jest here\n")

    def test_empty_false(self) -> None:
        assert not bc._has_jest_output("")

    def test_vitest_output_false(self) -> None:
        # Vitest-only output has no PASS/FAIL headers
        assert not bc._has_jest_output(VITEST_OUTPUT)


class TestHasVitestOutput:
    def test_pass_line_detected(self) -> None:
        assert bc._has_vitest_output(" ✓ src/utils.test.ts (3 tests)\n")

    def test_fail_line_detected(self) -> None:
        assert bc._has_vitest_output(" × src/client.test.ts (1 test)\n")

    def test_mixed_vitest_detected(self) -> None:
        assert bc._has_vitest_output(VITEST_OUTPUT)

    def test_plain_text_false(self) -> None:
        assert not bc._has_vitest_output("hello world\nno vitest here\n")

    def test_empty_false(self) -> None:
        assert not bc._has_vitest_output("")


# ---------------------------------------------------------------------------
# compress_jest_output — Jest mode
# ---------------------------------------------------------------------------

class TestCompressJestOutput:
    def test_pass_only_all_pass_lines_removed(self) -> None:
        compressed, pass_ct, fail_ct = bc.compress_jest_output(JEST_PASS_ONLY)
        assert " PASS src/components/Button.test.js" not in compressed
        assert " PASS src/utils/format.test.js" not in compressed

    def test_pass_only_tick_lines_removed(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_PASS_ONLY)
        assert "✓ renders without errors" not in compressed
        assert "✓ handles click events" not in compressed

    def test_pass_only_summary_kept(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_PASS_ONLY)
        assert "Test Suites: 2 passed" in compressed
        assert "Tests:       3 passed" in compressed
        assert "Ran all test suites." in compressed

    def test_pass_only_pass_count(self) -> None:
        _, pass_ct, fail_ct = bc.compress_jest_output(JEST_PASS_ONLY)
        assert pass_ct == 2
        assert fail_ct == 0

    def test_mixed_pass_suppressed(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_MIXED)
        assert " PASS src/components/Button.test.js" not in compressed

    def test_mixed_fail_kept(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_MIXED)
        assert " FAIL src/api/client.test.js" in compressed

    def test_mixed_failure_detail_kept(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_MIXED)
        assert "expect(received).toBe(expected)" in compressed
        assert 'Expected: "ok"' in compressed

    def test_mixed_counts(self) -> None:
        _, pass_ct, fail_ct = bc.compress_jest_output(JEST_MIXED)
        assert pass_ct == 1
        assert fail_ct == 1

    def test_mixed_summary_kept(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_MIXED)
        assert "Test Suites: 1 failed" in compressed

    def test_no_jest_output_passthrough(self) -> None:
        plain = "hello\nworld\nno jest\n"
        compressed, pass_ct, fail_ct = bc.compress_jest_output(plain)
        assert compressed == plain
        assert pass_ct == 0
        assert fail_ct == 0

    def test_returns_string_not_bytes(self) -> None:
        compressed, _, _ = bc.compress_jest_output(JEST_PASS_ONLY)
        assert isinstance(compressed, str)


# ---------------------------------------------------------------------------
# compress_jest_output — Vitest mode
# ---------------------------------------------------------------------------

class TestCompressVitestOutput:
    def test_pass_lines_suppressed(self) -> None:
        compressed, pass_ct, _ = bc.compress_jest_output(VITEST_PASS_ONLY)
        assert " ✓ src/utils.test.ts" not in compressed
        assert " ✓ src/api.test.ts" not in compressed
        assert pass_ct == 3

    def test_fail_line_kept(self) -> None:
        compressed, _, fail_ct = bc.compress_jest_output(VITEST_OUTPUT)
        assert " × src/client.test.ts" in compressed
        assert fail_ct == 1

    def test_vitest_summary_kept(self) -> None:
        compressed, _, _ = bc.compress_jest_output(VITEST_OUTPUT)
        assert "Test Files" in compressed
        assert "Tests" in compressed

    def test_vitest_pass_count(self) -> None:
        _, pass_ct, fail_ct = bc.compress_jest_output(VITEST_OUTPUT)
        assert pass_ct == 2
        assert fail_ct == 1

    def test_vitest_pass_only_counts(self) -> None:
        _, pass_ct, fail_ct = bc.compress_jest_output(VITEST_PASS_ONLY)
        assert pass_ct == 3
        assert fail_ct == 0

    def test_vitest_per_test_tick_lines_suppressed(self) -> None:
        """Per-test ✓ lines under a passing vitest file block must be suppressed."""
        verbose = textwrap.dedent("""\
             ✓ src/utils.test.ts (3 tests)
               ✓ formatDate 2ms
               ✓ parseDate 1ms
               ✓ isValid 1ms
             × src/client.test.ts (1 test)
               × Client > handles errors 5ms

            Test Files  1 failed | 1 passed (2)
            """)
        compressed, pass_ct, fail_ct = bc.compress_jest_output(verbose)
        assert "✓ formatDate" not in compressed
        assert "✓ parseDate" not in compressed
        assert "✓ isValid" not in compressed
        assert "× Client > handles errors" in compressed
        assert pass_ct == 1
        assert fail_ct == 1


# ---------------------------------------------------------------------------
# post_bash integration
# ---------------------------------------------------------------------------

class TestPostBashJestIntegration:
    def test_jest_pass_only_compressed(self) -> None:
        result = _post_bash("jest", JEST_PASS_ONLY)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" in msg

    def test_npx_jest_compressed(self) -> None:
        result = _post_bash("npx jest --coverage", JEST_PASS_ONLY)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" in msg

    def test_npm_test_compressed(self) -> None:
        result = _post_bash("npm test", JEST_PASS_ONLY)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" in msg

    def test_non_jest_cmd_not_triggered(self) -> None:
        result = _post_bash("cargo build", JEST_PASS_ONLY)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" not in msg

    def test_exit_code_1_fail_block_compressed(self) -> None:
        # exit_code=1 is normal for test failures; should still compress
        result = _post_bash("jest", JEST_MIXED, exit_code=1)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" in msg
        assert "FAIL" in msg

    def test_exit_code_2_not_triggered(self) -> None:
        # exit_code=2 means jest itself crashed; pass through unchanged
        result = _post_bash("jest", JEST_PASS_ONLY, exit_code=2)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" not in msg

    def test_fewer_than_5_lines_not_triggered(self) -> None:
        short = " PASS a.test.js\nTest Suites: 1 passed\n"
        result = _post_bash("jest", short)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" not in msg

    def test_all_fail_no_pass_not_triggered(self) -> None:
        # no PASS lines → pass_count=0 → no systemMessage replacement
        fail_only = textwrap.dedent("""\
 FAIL src/a.test.js
   ● A › fails

     error here

Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 total
Time:        1.0 s
""")
        result = _post_bash("jest", fail_only)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" not in msg

    def test_vitest_compressed(self) -> None:
        result = _post_bash("vitest", VITEST_OUTPUT)
        msg = result.get("systemMessage", "")
        assert "PASS suite(s) suppressed" in msg

    def test_all_pass_no_summary_no_replacement(self) -> None:
        """All-PASS output with no summary must not produce a systemMessage.

        Regression: compress_jest_output returns ("", N, 0) when every line
        is a PASS header; the empty string must not be substituted as output.
        """
        truncated = textwrap.dedent("""\
 PASS src/a.test.js
 PASS src/b.test.js
 PASS src/c.test.js
 PASS src/d.test.js
 PASS src/e.test.js
""")
        result = _post_bash("jest", truncated)
        msg = result.get("systemMessage", "")
        # Must not replace — compressed output would be blank
        assert "PASS suite(s) suppressed" not in msg
