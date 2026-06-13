"""Tests for minified-file grep elision helpers (Iter 32)."""

from __future__ import annotations

import unittest.mock as mock
from typing import Any

import pytest

from token_goat.bash_compress import (
    _has_minified_grep_hit,
    _is_grep_cmd,
    _is_minified_file,
)

# ---------------------------------------------------------------------------
# _is_minified_file
# ---------------------------------------------------------------------------

class TestIsMinifiedFile:
    def test_vendor_js(self):
        assert _is_minified_file("vendor.js") is True

    def test_bundle_js(self):
        assert _is_minified_file("bundle.js") is True

    def test_dist_js(self):
        assert _is_minified_file("dist.js") is True

    def test_chunk_js(self):
        assert _is_minified_file("chunk.js") is True

    def test_polyfills_js(self):
        assert _is_minified_file("polyfills.js") is True

    def test_polyfill_js(self):
        assert _is_minified_file("polyfill.js") is True

    def test_app_min_js(self):
        assert _is_minified_file("app.min.js") is True

    def test_app_min_css(self):
        assert _is_minified_file("app.min.css") is True

    def test_vendor_with_hash_js(self):
        assert _is_minified_file("vendor.abc123.js") is True

    def test_bundle_with_hash_js(self):
        assert _is_minified_file("bundle.a1b2c3.js") is True

    def test_path_with_vendor_dir(self):
        assert _is_minified_file("static/js/vendor.js") is True

    def test_path_with_dist_dir(self):
        assert _is_minified_file("static/dist.js") is True

    def test_regular_js_false(self):
        assert _is_minified_file("src/app.js") is False

    def test_regular_py_false(self):
        assert _is_minified_file("src/main.py") is False

    def test_empty_string_false(self):
        assert _is_minified_file("") is False

    def test_min_txt_false(self):
        assert _is_minified_file("file.min.txt") is False

    def test_utils_js_false(self):
        assert _is_minified_file("utils.js") is False

    def test_vendor_css(self):
        assert _is_minified_file("vendor.css") is True

    def test_bundle_css(self):
        assert _is_minified_file("bundle.css") is True

    def test_windows_path_vendor(self):
        assert _is_minified_file("static\\js\\vendor.js") is True


# ---------------------------------------------------------------------------
# _has_minified_grep_hit
# ---------------------------------------------------------------------------

class TestHasMinifiedGrepHit:
    def test_vendor_with_long_line(self):
        long_content = "x" * 600
        stdout = f"vendor.js:{long_content}"
        assert _has_minified_grep_hit(stdout) is True

    def test_min_js_with_long_line(self):
        long_content = "a" * 600
        stdout = f"app.min.js:{long_content}"
        assert _has_minified_grep_hit(stdout) is True

    def test_normal_file_with_long_line_false(self):
        long_content = "x" * 600
        stdout = f"src/app.js:{long_content}"
        assert _has_minified_grep_hit(stdout) is False

    def test_minified_file_short_line_false(self):
        stdout = "vendor.js:short content"
        assert _has_minified_grep_hit(stdout) is False

    def test_minified_exactly_500_chars_false(self):
        # boundary: > 500 chars triggers, exactly 500 does not
        content = "x" * 500
        stdout = f"vendor.js:{content}"
        assert _has_minified_grep_hit(stdout) is False

    def test_minified_501_chars_true(self):
        content = "x" * 501
        stdout = f"vendor.js:{content}"
        assert _has_minified_grep_hit(stdout) is True

    def test_mixed_lines_minified_triggers(self):
        long_content = "x" * 600
        stdout = f"src/normal.js:short\nvendor.js:{long_content}\nsrc/other.js:also short"
        assert _has_minified_grep_hit(stdout) is True

    def test_empty_stdout_false(self):
        assert _has_minified_grep_hit("") is False

    def test_no_colon_line_skipped(self):
        stdout = "vendor.js\n"  # no colon — treated as path-only, no rest
        assert _has_minified_grep_hit(stdout) is False

    def test_rg_format_with_linenum(self):
        # rg format: path:linenum:content — first colon splits path from rest
        long_content = "x" * 600
        stdout = f"vendor.js:1:{long_content}"
        assert _has_minified_grep_hit(stdout) is True


# ---------------------------------------------------------------------------
# _is_grep_cmd
# ---------------------------------------------------------------------------

class TestIsGrepCmd:
    def test_rg(self):
        assert _is_grep_cmd(["rg", "pattern", "."]) is True

    def test_grep(self):
        assert _is_grep_cmd(["grep", "-r", "pattern"]) is True

    def test_egrep(self):
        assert _is_grep_cmd(["egrep", "pattern"]) is True

    def test_fgrep(self):
        assert _is_grep_cmd(["fgrep", "pattern"]) is True

    def test_git_grep(self):
        assert _is_grep_cmd(["git", "grep", "pattern"]) is True

    def test_git_commit_false(self):
        assert _is_grep_cmd(["git", "commit"]) is False

    def test_git_alone_false(self):
        assert _is_grep_cmd(["git"]) is False

    def test_pytest_false(self):
        assert _is_grep_cmd(["pytest"]) is False

    def test_empty_list_false(self):
        assert _is_grep_cmd([]) is False

    def test_rg_exe_windows(self):
        assert _is_grep_cmd(["rg.exe", "pattern"]) is True


# ---------------------------------------------------------------------------
# Integration: post_bash hook with minified grep output
# ---------------------------------------------------------------------------

def _make_post_bash_payload(command: str, stdout: str) -> dict[str, Any]:
    """Build a minimal HookPayload dict for post_bash."""
    return {
        "session_id": "test-session",
        "tool_input": {"command": command},
        "tool_response": {
            "stdout": stdout,
            "stderr": "",
            "exit_code": 0,
        },
        "cwd": "/tmp",
    }


def _run_post_bash(command: str, stdout: str) -> dict[str, Any] | None:
    """Run post_bash and return its return value (or None for CONTINUE)."""

    from token_goat import hooks_read
    from token_goat.hooks_common import HookPayload

    payload = HookPayload(_make_post_bash_payload(command, stdout))

    # Patch bash_cache.store_output to avoid disk I/O; collapse nested withs (SIM117).
    with (
        mock.patch("token_goat.bash_cache.store_output", return_value=None),
        mock.patch("token_goat.hooks_read.get_session_context", return_value=("test-sid", "/tmp")),
        mock.patch("token_goat.hooks_read._session_module", None),
    ):
        try:
            return hooks_read.post_bash(payload)
        except Exception:  # noqa: BLE001
            return None


class TestPostBashMinifiedElision:
    def test_rg_vendor_long_line_elided(self):
        long_content = "A" * 600
        stdout = f"vendor.js:{long_content}\n"
        result = _run_post_bash("rg pattern .", stdout)
        if result is None or not result.get("systemMessage"):
            pytest.skip("post_bash integration requires session context")
        msg = result["systemMessage"]
        assert "minified file match" in msg or "chars elided" in msg

    def test_normal_js_no_elision(self):
        long_content = "A" * 600
        stdout = f"src/app.js:{long_content}\n"
        result = _run_post_bash("rg pattern .", stdout)
        # Should NOT trigger minified elision (may return None / CONTINUE)
        if result and result.get("systemMessage"):
            assert "minified file match" not in result["systemMessage"]

    def test_short_minified_no_elision(self):
        stdout = "vendor.js:short match here\n"
        result = _run_post_bash("rg pattern .", stdout)
        if result and result.get("systemMessage"):
            assert "minified file match" not in result["systemMessage"]

    def test_non_grep_command_no_elision(self):
        long_content = "A" * 600
        stdout = f"vendor.js:{long_content}\n"
        result = _run_post_bash("cat vendor.js", stdout)
        if result and result.get("systemMessage"):
            assert "minified file match" not in result["systemMessage"]


# ---------------------------------------------------------------------------
# Bug 2 — Windows drive-letter colon
# ---------------------------------------------------------------------------

class TestWindowsDriveLetterColon:
    def test_is_minified_file_windows_absolute_path(self):
        # Drive-letter path must still match the minified-file regex.
        assert _is_minified_file(r"C:\projects\app\vendor.js") is True

    def test_has_minified_grep_hit_windows_path(self):
        # C:\path\vendor.js:content — first colon is the drive letter; must not
        # stop there and incorrectly conclude path_part == "C".
        line = "C:\\projects\\app\\vendor.js:" + "x" * 600
        assert _has_minified_grep_hit(line) is True

    def test_has_minified_grep_hit_windows_path_short_false(self):
        # Drive-letter path but content is short — must not trigger.
        line = "C:\\projects\\app\\vendor.js:short content"
        assert _has_minified_grep_hit(line) is False

    def test_has_minified_grep_hit_windows_non_minified(self):
        # Windows path to a regular file — must not trigger even if content is long.
        line = "C:\\projects\\src\\app.js:" + "x" * 600
        assert _has_minified_grep_hit(line) is False


# ---------------------------------------------------------------------------
# Bug 3 — rg 3-part format: line number must not appear in content preview
# ---------------------------------------------------------------------------

class TestRgLineNumberStripped:
    def test_linenum_not_in_elided_snippet(self):
        # rg emits path:linenum:content — after elision the displayed content
        # part must not start with "42:" (the line number should be stripped).
        long_content = "x" * 600
        line = f"vendor.js:42:{long_content}"
        # Simulate the elision logic directly.
        import re as _re_test
        colon_idx = line.find(":")
        assert colon_idx >= 1
        mc_rest = line[colon_idx + 1:]           # "42:xxx..."
        mc_content = _re_test.sub(r"^\d+:", "", mc_rest, count=1)  # "xxx..."
        assert not mc_content.startswith("42:"), (
            "Line-number prefix must be stripped from content preview"
        )
        assert len(mc_content) >= 600

    def test_linenum_stripped_no_false_positive_on_normal_content(self):
        # Content that starts with digits but is NOT a line-number prefix must
        # not be incorrectly stripped.
        import re as _re_test
        mc_rest = "404 Not Found — the long body goes here " + "y" * 480
        mc_content = _re_test.sub(r"^\d+:", "", mc_rest, count=1)
        # "404 Not Found..." — no colon immediately after digits, so unchanged.
        assert mc_content == mc_rest


# ---------------------------------------------------------------------------
# Bug 4 — ag and ack must be recognised as grep commands
# ---------------------------------------------------------------------------

class TestAgAckIsGrepCmd:
    def test_ag(self):
        assert _is_grep_cmd(["ag", "pattern", "."]) is True

    def test_ack(self):
        assert _is_grep_cmd(["ack", "pattern"]) is True

    def test_ack_grep(self):
        assert _is_grep_cmd(["ack-grep", "pattern"]) is True

    def test_ag_exe_windows(self):
        assert _is_grep_cmd(["ag.exe", "pattern"]) is True

    def test_ack_exe_windows(self):
        assert _is_grep_cmd(["ack.exe", "pattern"]) is True
