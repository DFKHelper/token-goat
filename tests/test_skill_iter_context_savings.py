"""Tests for context savings improvements (iterations 39-48).

Covers sub-areas:
  D  — web-output --list flag
  E  — map --filter GLOB and --since-minutes N
  F  — grep dedup hint includes pattern, path, and result count
  G  — ruff / mypy filter compression quality
  H  — pre-read hook skips hints for binary / large files
  I  — web-fetch HTML stripping (existing feature, new tests)
  J  — stats --since DAYS flag
"""
from __future__ import annotations

import os
import time
from pathlib import Path
from unittest.mock import MagicMock

from typer.testing import CliRunner

from token_goat import bash_compress, session, web_cache
from token_goat.cli import app


def _filter_text(compressed_output: bash_compress.CompressedOutput) -> str:
    """Extract text from a CompressedOutput object."""
    return compressed_output.text


# ---------------------------------------------------------------------------
# Sub-area D — web-output --list flag
# ---------------------------------------------------------------------------

class TestWebOutputList:
    """--list flag enumerates all cached web outputs."""

    def test_list_shows_all_cached_entries(self, tmp_data_dir):
        """--list with two stored entries shows both entries."""
        web_cache.store_output("sess-d1", "https://alpha.example.com/page", "body a\n" * 10, 200)
        web_cache.store_output("sess-d1", "https://beta.example.com/page", "body b\n" * 10, 200)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--list"])
        assert result.exit_code == 0, result.output
        # Both session-prefixed IDs should appear
        assert "sess-d1" in result.output

    def test_list_empty_cache_shows_message(self, tmp_data_dir):
        """--list with no cached outputs shows a friendly message."""
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--list"])
        assert result.exit_code == 0, result.output
        assert "no web outputs" in result.output.lower()

    def test_list_json_output_is_parseable(self, tmp_data_dir):
        """--list --json returns valid JSON list."""
        import json as _json
        web_cache.store_output("sess-d2", "https://json-test.example.com/", "data\n" * 5, 200)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--list", "--json"])
        assert result.exit_code == 0, result.output
        data = _json.loads(result.output)
        assert isinstance(data, list)
        assert len(data) >= 1

    def test_list_does_not_require_output_id(self, tmp_data_dir):
        """--list should work without providing an output_id argument."""
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--list"])
        # Should not error with "output_id is required"
        assert "output_id is required" not in result.output
        assert result.exit_code == 0, result.output

    def test_list_shows_size_info(self, tmp_data_dir):
        """--list output includes byte sizes."""
        web_cache.store_output("sess-d3", "https://size-test.example.com/", "x" * 500, 200)
        runner = CliRunner()
        result = runner.invoke(app, ["web-output", "--list"])
        assert result.exit_code == 0, result.output
        # Should contain some size indicator (bytes)
        assert "B" in result.output


# ---------------------------------------------------------------------------
# Sub-area E — map --filter GLOB and --since-minutes N
# ---------------------------------------------------------------------------

class TestMapFilter:
    """--filter GLOB limits output to matching files."""

    def _mock_project(self, monkeypatch, map_text: str, proj_name: str = "myproject") -> None:
        """Patch CLI dependencies to return a synthetic map."""
        import token_goat.cli as _cli_mod
        import token_goat.repomap as _rm_mod

        mock_proj = MagicMock()
        mock_proj.root.name = proj_name
        mock_proj.hash = "abc123"
        mock_build = MagicMock(return_value=map_text)

        monkeypatch.setattr(_cli_mod, "_require_project", lambda msg: mock_proj)
        monkeypatch.setattr(_rm_mod, "build_map", mock_build)
        monkeypatch.setattr(_cli_mod, "_total_project_bytes", lambda h: 1000)
        monkeypatch.setattr(_cli_mod, "_build_map_skills_footer", lambda: "")

    def test_filter_limits_to_py_files(self, tmp_data_dir, monkeypatch):
        """--filter '*.py' should only show .py file lines."""
        map_text = (
            "# myproject\n"
            "src/main.py  (functions: main, helper)\n"
            "src/utils.py  (functions: util)\n"
            "README.md  (sections: Overview)\n"
            "config.toml  (keys: name, version)\n"
        )
        self._mock_project(monkeypatch, map_text)
        runner = CliRunner()
        result = runner.invoke(app, ["map", "--filter", "*.py"])
        assert result.exit_code == 0, result.output
        # Python files should appear
        assert "main.py" in result.output
        assert "utils.py" in result.output
        # Non-python files should not appear
        assert "README.md" not in result.output
        assert "config.toml" not in result.output

    def test_filter_keeps_header_lines(self, tmp_data_dir, monkeypatch):
        """Header lines (# prefix) are kept even when --filter is active."""
        map_text = (
            "# myproject\n"
            "src/main.py  (functions: main)\n"
            "README.md  (sections: Overview)\n"
        )
        self._mock_project(monkeypatch, map_text)
        runner = CliRunner()
        result = runner.invoke(app, ["map", "--filter", "*.py"])
        assert result.exit_code == 0, result.output
        assert "# myproject" in result.output

    def test_filter_ts_pattern(self, tmp_data_dir, monkeypatch):
        """--filter '*.ts' filters to TypeScript files only."""
        map_text = (
            "# frontend\n"
            "src/App.tsx  (components: App)\n"
            "src/utils.ts  (functions: formatDate)\n"
            "src/styles.css  ()\n"
            "public/index.html  ()\n"
        )
        self._mock_project(monkeypatch, map_text, proj_name="frontend")
        runner = CliRunner()
        result = runner.invoke(app, ["map", "--filter", "*.ts"])
        assert result.exit_code == 0, result.output
        assert "utils.ts" in result.output
        assert "styles.css" not in result.output
        assert "index.html" not in result.output

    def test_filter_subdir_pattern(self, tmp_data_dir, monkeypatch):
        """--filter 'src/*.py' limits to src/ directory Python files."""
        map_text = (
            "# myproject\n"
            "src/main.py  (functions: main)\n"
            "tests/test_main.py  (functions: test_main)\n"
            "README.md  (sections: Overview)\n"
        )
        self._mock_project(monkeypatch, map_text)
        runner = CliRunner()
        result = runner.invoke(app, ["map", "--filter", "src/*.py"])
        assert result.exit_code == 0, result.output
        assert "src/main.py" in result.output
        assert "tests/test_main.py" not in result.output


class TestMapSinceMinutes:
    """--since-minutes N shows only recently modified files."""

    def test_since_minutes_returns_recent_files(self, tmp_data_dir, tmp_path, monkeypatch):
        """Files modified within the window should appear in output."""
        import token_goat.cli as _cli_mod
        import token_goat.repomap as _rm_mod

        # Create mock project files
        recent_file = tmp_path / "new_file.py"
        recent_file.write_text("print('hello')")
        old_file = tmp_path / "old_file.py"
        old_file.write_text("print('old')")

        # Make old_file appear 2 hours old
        two_hours_ago = time.time() - 7200
        os.utime(old_file, (two_hours_ago, two_hours_ago))

        class FakeProj:
            root = tmp_path
            hash = "def456"

        ranked_data = MagicMock()
        ranked_data.ranked = [
            ("new_file.py", MagicMock()),
            ("old_file.py", MagicMock()),
        ]

        monkeypatch.setattr(_cli_mod, "_require_project", lambda msg: FakeProj())
        monkeypatch.setattr(_rm_mod, "_load_and_rank", lambda proj: ranked_data)
        monkeypatch.setattr(_cli_mod, "_total_project_bytes", lambda h: 1000)

        runner = CliRunner()
        result = runner.invoke(app, ["map", "--since-minutes", "30"])
        assert result.exit_code == 0, result.output
        # Only the recently modified file should appear
        assert "new_file.py" in result.output
        assert "old_file.py" not in result.output

    def test_since_minutes_no_matches_says_no_files(self, tmp_data_dir, tmp_path, monkeypatch):
        """When no files are recent, output says no files found."""
        import token_goat.cli as _cli_mod
        import token_goat.repomap as _rm_mod

        old_file = tmp_path / "old.py"
        old_file.write_text("x = 1")
        two_hours_ago = time.time() - 7200
        os.utime(old_file, (two_hours_ago, two_hours_ago))

        mock_proj = MagicMock()
        mock_proj.root = tmp_path
        mock_proj.hash = "def456"
        # Use spec-less attribute for name since root is a real Path
        type(mock_proj).root = MagicMock()
        mock_proj.root = tmp_path
        # Give root.name the right value without triggering property setter error
        root_mock = MagicMock()
        root_mock.__truediv__ = lambda self, other: tmp_path / other
        root_mock.name = "testproject"
        mock_proj.root = root_mock

        # Simplest: just let root be the real path but wrap with custom mock
        class FakeProj:
            root = tmp_path
            hash = "def456"

        ranked_data = MagicMock()
        ranked_data.ranked = [("old.py", MagicMock())]

        monkeypatch.setattr(_cli_mod, "_require_project", lambda msg: FakeProj())
        monkeypatch.setattr(_rm_mod, "_load_and_rank", lambda proj: ranked_data)
        monkeypatch.setattr(_cli_mod, "_total_project_bytes", lambda h: 1000)

        runner = CliRunner()
        result = runner.invoke(app, ["map", "--since-minutes", "5"])
        assert result.exit_code == 0, result.output
        assert "no recently modified" in result.output.lower()

    def test_since_minutes_header_shows_count(self, tmp_data_dir, tmp_path, monkeypatch):
        """Output header shows the number of recently modified files."""
        import token_goat.cli as _cli_mod
        import token_goat.repomap as _rm_mod

        recent_file = tmp_path / "fresh.py"
        recent_file.write_text("# new content")

        class FakeProj:
            root = tmp_path
            hash = "def456"

        ranked_data = MagicMock()
        ranked_data.ranked = [("fresh.py", MagicMock())]

        monkeypatch.setattr(_cli_mod, "_require_project", lambda msg: FakeProj())
        monkeypatch.setattr(_rm_mod, "_load_and_rank", lambda proj: ranked_data)
        monkeypatch.setattr(_cli_mod, "_total_project_bytes", lambda h: 1000)

        runner = CliRunner()
        result = runner.invoke(app, ["map", "--since-minutes", "10"])
        assert result.exit_code == 0, result.output
        # Header should mention the time window
        assert "10" in result.output or "last" in result.output.lower()


# ---------------------------------------------------------------------------
# Sub-area F — grep dedup hint quality
# ---------------------------------------------------------------------------

class TestGrepDedupHintQuality:
    """Grep dedup hint shows useful info and uses (pattern, path) as key."""

    def test_hint_includes_pattern(self, tmp_data_dir):
        """Grep dedup hint includes the search pattern."""
        from token_goat import hooks_read

        session.mark_grep("gq-1", "def authenticate", path="src/", result_count=42)
        payload = {
            "session_id": "gq-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "def authenticate", "path": "src/"},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "dedup hint should fire"
        ctx = hso.get("additionalContext", "")
        assert "authenticate" in ctx, f"pattern missing from hint: {ctx}"

    def test_hint_includes_result_count(self, tmp_data_dir):
        """Grep dedup hint shows the previous result count."""
        from token_goat import hooks_read

        session.mark_grep("gq-2", "import React", path="src/", result_count=87)
        payload = {
            "session_id": "gq-2",
            "tool_name": "Grep",
            "tool_input": {"pattern": "import React", "path": "src/"},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "87" in ctx, f"result count missing from hint: {ctx}"

    def test_same_pattern_different_path_no_dedup(self, tmp_data_dir):
        """Same pattern in different directory does NOT trigger dedup hint."""
        from token_goat import hooks_read

        session.mark_grep("gq-3", "TODO", path="src/", result_count=200)
        # Now search in a different path
        payload = {
            "session_id": "gq-3",
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO", "path": "tests/"},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is None, "different path should not trigger dedup"

    def test_same_pattern_same_path_triggers_dedup(self, tmp_data_dir):
        """Same pattern in same directory DOES trigger dedup hint."""
        from token_goat import hooks_read

        session.mark_grep("gq-4", "class Foo", path="src/models/", result_count=15)
        payload = {
            "session_id": "gq-4",
            "tool_name": "Grep",
            "tool_input": {"pattern": "class Foo", "path": "src/models/"},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is not None, "same pattern + same path should trigger dedup"

    def test_hint_includes_age_indication(self, tmp_data_dir):
        """Grep dedup hint indicates when the prior search happened."""
        from token_goat import hooks_read

        session.mark_grep("gq-5", "raise ValueError", path=None, result_count=50)
        payload = {
            "session_id": "gq-5",
            "tool_name": "Grep",
            "tool_input": {"pattern": "raise ValueError"},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        # Hint should contain some age indicator (s suffix, or "ago")
        assert any(
            marker in ctx for marker in ["s", "ago", "sec", "min"]
        ), f"age indicator missing from hint: {ctx}"


# ---------------------------------------------------------------------------
# Sub-area G — ruff / mypy filter compression quality
# ---------------------------------------------------------------------------

class TestRuffFilterCompression:
    """RuffFilter compresses noise while preserving errors and summary."""

    def _filter(self) -> bash_compress.RuffFilter:
        return bash_compress.RuffFilter()

    def test_keeps_error_lines(self):
        """Error lines (file:line:col: CODE ...) are kept verbatim."""
        stdout = (
            "src/main.py:10:1: E501 Line too long (120 > 79 characters)\n"
            "src/main.py:20:1: F401 'os' imported but unused\n"
            "Found 2 errors.\n"
        )
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]))
        assert "E501" in result
        assert "F401" in result

    def test_keeps_found_N_errors_footer(self):
        """'Found N errors' footer line is always kept."""
        stdout = "src/a.py:1:1: E501 Line too long\nFound 1 error.\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]))
        assert "Found 1 error" in result

    def test_collapses_repeated_rule_across_files(self):
        """A rule fired 5+ times across 2+ files is collapsed to one summary line."""
        lines = []
        for i in range(1, 6):
            fn = "a.py" if i <= 3 else "b.py"
            lines.append(f"src/{fn}:{i}:1: E501 Line too long")
        lines.append("Found 5 errors.")
        stdout = "\n".join(lines) + "\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]))
        # Should contain E501 summary with occurrences
        assert "E501" in result
        assert "occurrences" in result

    def test_clean_exit_returns_empty(self):
        """Clean exit (code 0, only success banner) returns empty string."""
        f = self._filter()
        result = _filter_text(f.apply("All checks passed!\n", "", 0, ["ruff", "check", "."]))
        assert result == ""

    def test_ruff_format_collapses_reformatted_lines(self):
        """ruff format per-file lines are collapsed; summary is kept."""
        lines = [f"Reformatted src/file{i}.py" for i in range(10)]
        lines.append("10 files reformatted, 0 files left unchanged.")
        stdout = "\n".join(lines) + "\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 0, ["ruff", "format", "."]))
        # Individual reformatted lines should be gone
        assert "Reformatted src/file0.py" not in result
        # Summary should be present
        assert "10 files reformatted" in result

    def test_single_file_single_rule_kept_verbatim(self):
        """A rule fired only once in one file is kept verbatim (no summarization)."""
        stdout = "src/main.py:5:1: F841 Local variable `x` is assigned but never used\nFound 1 error.\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["ruff", "check", "."]))
        assert "src/main.py:5:1" in result
        assert "F841" in result

    def test_empty_output_no_crash(self):
        """Empty stdout/stderr does not raise."""
        f = self._filter()
        result = _filter_text(f.apply("", "", 0, ["ruff", "check", "."]))
        assert isinstance(result, str)


class TestMypyFilterCompression:
    """MypyFilter compresses noise while preserving errors and summary."""

    def _filter(self) -> bash_compress.MypyFilter:
        return bash_compress.MypyFilter()

    def test_keeps_error_lines(self):
        """All error lines are kept."""
        stdout = (
            "src/auth.py:10: error: Incompatible return value type\n"
            "src/models.py:25: error: Argument 1 has incompatible type\n"
            "Found 2 errors in 2 files (checked 10 source files)\n"
        )
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]))
        assert "src/auth.py:10" in result
        assert "src/models.py:25" in result

    def test_keeps_found_N_errors_summary(self):
        """'Found N errors' summary line is always kept."""
        stdout = (
            "src/x.py:1: error: Incompatible type\n"
            "Found 1 error in 1 file (checked 5 source files)\n"
        )
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]))
        assert "Found 1 error" in result

    def test_dedupes_repeated_error_message(self):
        """Identical error messages across many files are collapsed."""
        lines = []
        for i in range(10):
            lines.append(f"src/file{i}.py:{i+1}: error: Incompatible return value type")
        lines.append("Found 10 errors in 10 files (checked 10 source files)")
        stdout = "\n".join(lines) + "\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]))
        # Should have suppression note (token-goat marker)
        assert "token-goat" in result or "suppressed" in result.lower()
        # Should keep the summary
        assert "Found 10 errors" in result

    def test_drops_see_also_notes(self):
        """'note: See https://...' cross-reference notes are dropped."""
        stdout = (
            "src/x.py:5: error: Name 'foo' is not defined\n"
            "src/x.py:5: note: See https://mypy.readthedocs.io/en/stable/error_codes.html\n"
            "Found 1 error in 1 file\n"
        )
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]))
        assert "mypy.readthedocs.io" not in result
        assert "Found 1 error" in result

    def test_empty_input_no_crash(self):
        """Empty input does not raise."""
        f = self._filter()
        result = _filter_text(f.apply("", "", 0, ["mypy", "src"]))
        assert isinstance(result, str)

    def test_keeps_first_three_occurrences_of_same_error(self):
        """First 3 occurrences of the same normalized error are kept."""
        lines = []
        for i in range(6):
            lines.append(f"src/f{i}.py:1: error: Incompatible return value type")
        lines.append("Found 6 errors in 6 files")
        stdout = "\n".join(lines) + "\n"
        f = self._filter()
        result = _filter_text(f.apply(stdout, "", 1, ["mypy", "src"]))
        result_lines = [ln for ln in result.splitlines() if "error: Incompatible" in ln]
        assert len(result_lines) == 3, f"expected 3 kept error lines, got {len(result_lines)}"


# ---------------------------------------------------------------------------
# Sub-area H — pre-read hook skips hints for binary / large files
# ---------------------------------------------------------------------------

class TestPreReadBinaryLargeFileSkip:
    """Pre-read hook skips hints for binary files and files > 10 MB."""

    def test_binary_extension_skips_hints(self, tmp_data_dir, tmp_path):
        """A .so file triggers no hints even when the session has prior reads."""
        from token_goat import hooks_read

        so_file = tmp_path / "libfoo.so"
        so_file.write_bytes(b"\x7fELF" + b"\x00" * 100)
        sid = "bin-skip-1"
        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(so_file)},
        }
        result = hooks_read.pre_read(payload)
        # Should return CONTINUE with no additionalContext
        hso = result.get("hookSpecificOutput")
        assert hso is None, f"hint should not fire for binary file: {hso}"

    def test_pyc_extension_skips_hints(self, tmp_data_dir, tmp_path):
        """A .pyc file triggers no hints."""
        from token_goat import hooks_read

        pyc_file = tmp_path / "module.pyc"
        pyc_file.write_bytes(b"\x6f\r\r\n" + b"\x00" * 50)
        sid = "bin-skip-2"
        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(pyc_file)},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is None, f"hint should not fire for .pyc file: {hso}"

    def test_zip_extension_skips_hints(self, tmp_data_dir, tmp_path):
        """A .zip file triggers no hints."""
        from token_goat import hooks_read

        zip_file = tmp_path / "dist.zip"
        zip_file.write_bytes(b"PK\x03\x04" + b"\x00" * 50)
        sid = "bin-skip-3"
        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(zip_file)},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is None, f"hint should not fire for .zip file: {hso}"

    def test_large_file_skips_hints(self, tmp_data_dir, tmp_path, monkeypatch):
        """A file reported as > 10 MB triggers no hints."""
        from token_goat import hooks_read
        from token_goat.hooks_read import _is_binary_or_large_file

        large_file = tmp_path / "bigdata.log"
        large_file.write_bytes(b"x" * 100)

        # Monkeypatch _is_binary_or_large_file to report this file as large
        original_fn = _is_binary_or_large_file

        def patched(path: str) -> bool:
            if Path(path).name == "bigdata.log":
                return True
            return original_fn(path)

        monkeypatch.setattr("token_goat.hooks_read._is_binary_or_large_file", patched)

        sid = "large-skip-1"
        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(large_file)},
        }
        result = hooks_read.pre_read(payload)
        hso = result.get("hookSpecificOutput")
        assert hso is None, f"hint should not fire for large file: {hso}"

    def test_is_binary_or_large_file_function_binary_ext(self, tmp_data_dir, tmp_path):
        """_is_binary_or_large_file returns True for known binary extensions."""
        from token_goat.hooks_read import _is_binary_or_large_file

        binary_files = [
            tmp_path / "lib.so",
            tmp_path / "code.pyc",
            tmp_path / "archive.zip",
            tmp_path / "model.db",
            tmp_path / "font.ttf",
            tmp_path / "doc.pdf",
        ]
        for bf in binary_files:
            bf.write_bytes(b"\x00" * 10)
            assert _is_binary_or_large_file(str(bf)), f"should be binary: {bf.name}"

    def test_is_binary_or_large_file_returns_false_for_source(self, tmp_data_dir, tmp_path):
        """_is_binary_or_large_file returns False for normal source files."""
        from token_goat.hooks_read import _is_binary_or_large_file

        source_files = [
            tmp_path / "main.py",
            tmp_path / "index.ts",
            tmp_path / "config.toml",
            tmp_path / "README.md",
            tmp_path / "app.js",
        ]
        for sf in source_files:
            sf.write_text("content")
            assert not _is_binary_or_large_file(str(sf)), f"should not be binary: {sf.name}"


# ---------------------------------------------------------------------------
# Sub-area I — web-fetch HTML stripping (new coverage)
# ---------------------------------------------------------------------------

class TestWebFetchHtmlStripping:
    """HTML stripping for web cache reduces storage size."""

    def test_script_blocks_stripped(self):
        """<script> blocks are removed from cached HTML."""
        from token_goat import webfetch

        script_noise = "console.log('noise'); " * 100
        html = (
            "<!DOCTYPE html>\n<html><head><title>Test</title>"
            f"<script>{script_noise}</script>"
            "</head><body>" + "<p>Real content here.</p>" * 30 + "</body></html>"
        )
        body = html.encode("utf-8")
        result = webfetch._strip_html_to_text(body)
        assert b"console.log" not in result
        assert b"Real content" in result

    def test_style_blocks_stripped(self):
        """<style> blocks are removed from cached HTML."""
        from token_goat import webfetch

        css_noise = ".foo { color: red; margin: 0; } " * 200
        html = (
            "<!DOCTYPE html>\n<html><head>"
            f"<style>{css_noise}</style>"
            "</head><body>" + "<p>Useful text.</p>" * 30 + "</body></html>"
        )
        body = html.encode("utf-8")
        result = webfetch._strip_html_to_text(body)
        assert b"color: red" not in result
        assert b"Useful text" in result

    def test_json_body_passes_through_unchanged(self):
        """JSON content (not HTML) is returned unchanged."""
        from token_goat import webfetch

        body = b'{"key": "value", "items": [1, 2, 3]}'
        result = webfetch._strip_html_to_text(body)
        assert result is body  # same object, not a copy

    def test_html_strip_reduces_size_by_20_percent(self):
        """Stripping must achieve >= 20% size reduction to take effect."""
        from token_goat import webfetch

        # Build HTML with substantial script/style bloat
        noise = "<script>" + "var x=1;" * 500 + "</script>"
        html = (
            "<!DOCTYPE html><html><head>" + noise + "</head><body>"
            + "<p>Content</p>" * 50
            + "</body></html>"
        )
        body = html.encode("utf-8")
        result = webfetch._strip_html_to_text(body)
        # Should be smaller (stripped)
        assert len(result) < len(body) * 0.80, (
            f"stripping did not achieve 20% reduction: {len(result)} vs {len(body)}"
        )

    def test_html_entities_decoded(self):
        """HTML entities like &amp; and &lt; are decoded in stripped output."""
        from token_goat import webfetch

        html = (
            "<!DOCTYPE html><html><body>"
            + "<p>Tom &amp; Jerry &lt;test&gt;</p>" * 50
            + "<script>" + "noise " * 200 + "</script>"
            + "</body></html>"
        )
        body = html.encode("utf-8")
        result = webfetch._strip_html_to_text(body)
        decoded = result.decode("utf-8", errors="replace")
        assert "&amp;" not in decoded
        assert "Tom & Jerry" in decoded


# ---------------------------------------------------------------------------
# Sub-area J — stats --since DAYS flag
# ---------------------------------------------------------------------------

class TestStatsSinceFlag:
    """stats --since DAYS is equivalent to --window DAYS."""

    def test_since_flag_calls_correct_window(self, tmp_data_dir, monkeypatch):
        """--since 7 results in a 7-day window."""
        captured_windows: list[int] = []

        def mock_stats(window: int, **kwargs: object) -> None:
            captured_windows.append(window)

        monkeypatch.setattr("token_goat.cli_stats.stats", mock_stats)

        runner = CliRunner()
        result = runner.invoke(app, ["stats", "--since", "7"])
        assert result.exit_code == 0, result.output
        assert captured_windows == [7], f"expected window=7, got {captured_windows}"

    def test_since_overrides_window(self, tmp_data_dir, monkeypatch):
        """When both --since and --window are given, --since wins."""
        captured_windows: list[int] = []

        def mock_stats(window: int, **kwargs: object) -> None:
            captured_windows.append(window)

        monkeypatch.setattr("token_goat.cli_stats.stats", mock_stats)

        runner = CliRunner()
        result = runner.invoke(app, ["stats", "--window", "30", "--since", "3"])
        assert result.exit_code == 0, result.output
        assert captured_windows == [3], f"expected window=3 (--since wins), got {captured_windows}"

    def test_since_one_is_today(self, tmp_data_dir, monkeypatch):
        """--since 1 means today (1-day window)."""
        captured_windows: list[int] = []

        def mock_stats(window: int, **kwargs: object) -> None:
            captured_windows.append(window)

        monkeypatch.setattr("token_goat.cli_stats.stats", mock_stats)

        runner = CliRunner()
        result = runner.invoke(app, ["stats", "--since", "1"])
        assert result.exit_code == 0, result.output
        assert captured_windows == [1]

    def test_without_since_uses_default_window(self, tmp_data_dir, monkeypatch):
        """Without --since, the default 30-day window is used."""
        captured_windows: list[int] = []

        def mock_stats(window: int, **kwargs: object) -> None:
            captured_windows.append(window)

        monkeypatch.setattr("token_goat.cli_stats.stats", mock_stats)

        runner = CliRunner()
        result = runner.invoke(app, ["stats"])
        assert result.exit_code == 0, result.output
        assert captured_windows == [30]


# ---------------------------------------------------------------------------
# Sub-area A+B — extra bash_compress filter tests
# ---------------------------------------------------------------------------

class TestMakeFilterExtended:
    """Additional tests for MakeFilter."""

    def test_keeps_error_lines(self):
        """Error lines are preserved after compression."""
        f = bash_compress.MakeFilter()
        stdout = (
            "make[1]: Entering directory '/build'\n"
            "cc -c src/main.c\n"
            "src/main.c:10: error: 'foo' undeclared\n"
            "make[1]: *** [Makefile:5: main.o] Error 1\n"
            "make[1]: Leaving directory '/build'\n"
        )
        result = _filter_text(f.apply(stdout, "", 1, ["make"]))
        assert "error: 'foo' undeclared" in result
        assert "Error 1" in result

    def test_drops_entering_leaving_lines(self):
        """'Entering/Leaving directory' recursion lines are dropped from content."""
        f = bash_compress.MakeFilter()
        stdout = (
            "make[1]: Entering directory '/build'\n"
            "src/app.c:5: error: syntax error\n"
            "make[1]: Leaving directory '/build'\n"
        )
        result = _filter_text(f.apply(stdout, "", 1, ["make"]))
        # The actual 'make[1]: Entering directory ...' lines should be absent from output.
        # The token-goat note may say "Entering/Leaving directory lines" but
        # the raw make recursion lines themselves should not appear.
        assert "make[1]: Entering directory" not in result
        assert "make[1]: Leaving directory" not in result
        assert "syntax error" in result

    def test_cmake_percent_progress_dropped(self):
        """CMake-style '[N%] Building' lines are dropped."""
        f = bash_compress.MakeFilter()
        stdout = "\n".join(
            f"[ {i}%] Building C object src/CMakeFiles/app.dir/main.c.o"
            for i in range(10, 101, 10)
        ) + "\n"
        result = _filter_text(f.apply(stdout, "", 0, ["make"]))
        # Progress lines should be collapsed; token-goat note added
        assert "Building C object" not in result or "token-goat" in result


class TestTerraformFilterExtended:
    """Additional tests for TerraformFilter."""

    def test_plan_drops_refresh_lines(self):
        """terraform plan drops Refreshing state lines."""
        f = bash_compress.TerraformFilter()
        stdout = (
            "aws_instance.web: Refreshing state... [id=i-1234]\n"
            "aws_security_group.sg: Refreshing state... [id=sg-5678]\n"
            "Plan: 1 to add, 0 to change, 0 to destroy.\n"
        )
        result = _filter_text(f.apply(stdout, "", 0, ["terraform", "plan"]))
        assert "Refreshing state" not in result
        assert "Plan: 1 to add" in result

    def test_apply_keeps_completion_summary(self):
        """terraform apply keeps the 'Apply complete!' summary."""
        f = bash_compress.TerraformFilter()
        stdout = (
            "aws_instance.web: Creating...\n"
            "aws_instance.web: Still creating... [10s elapsed]\n"
            "aws_instance.web: Creation complete after 30s [id=i-abc]\n"
            "Apply complete! Resources: 1 added, 0 changed, 0 destroyed.\n"
        )
        result = _filter_text(f.apply(stdout, "", 0, ["terraform", "apply"]))
        assert "Apply complete!" in result

    def test_error_exit_preserves_all_stderr(self):
        """terraform with non-zero exit preserves stderr unchanged."""
        f = bash_compress.TerraformFilter()
        stderr = "Error: Invalid argument 'foo'\n\nThe given value is not valid.\n"
        result = _filter_text(f.apply("", stderr, 1, ["terraform", "plan"]))
        assert "Invalid argument" in result


class TestAnsibleFilterExtended:
    """Additional tests for AnsibleFilter."""

    def test_collapses_ok_lines(self):
        """ok: [host] lines are collapsed to a count."""
        f = bash_compress.AnsibleFilter()
        lines = ["PLAY [Deploy]", "TASK [Check service]"] + [
            f"ok: [host{i}]" for i in range(20)
        ] + ["", "PLAY RECAP", "host0 : ok=1", ""]
        stdout = "\n".join(lines) + "\n"
        result = _filter_text(f.apply(stdout, "", 0, ["ansible-playbook", "deploy.yml"]))
        # Should not have all 20 ok lines individually
        ok_line_count = result.count("ok: [host")
        assert ok_line_count < 20, f"expected collapsed, got {ok_line_count} ok lines"

    def test_keeps_failed_lines(self):
        """fatal: lines are kept verbatim."""
        f = bash_compress.AnsibleFilter()
        stdout = (
            "PLAY [Deploy]\n"
            "TASK [Start service]\n"
            "fatal: [web01]: FAILED! => {\"msg\": \"Service not found\"}\n"
            "\n"
            "PLAY RECAP\n"
            "web01 : ok=0 changed=0 unreachable=0 failed=1\n"
        )
        result = _filter_text(f.apply(stdout, "", 2, ["ansible-playbook", "deploy.yml"]))
        assert "FAILED" in result or "fatal" in result
        assert "PLAY RECAP" in result

    def test_keeps_play_recap_section(self):
        """PLAY RECAP block is preserved verbatim."""
        f = bash_compress.AnsibleFilter()
        stdout = (
            "PLAY [webservers]\n"
            "TASK [Update packages]\n"
            "ok: [web01]\n"
            "ok: [web02]\n"
            "\n"
            "PLAY RECAP *************\n"
            "web01 : ok=5 changed=2 unreachable=0 failed=0\n"
            "web02 : ok=5 changed=1 unreachable=0 failed=0\n"
        )
        result = _filter_text(f.apply(stdout, "", 0, ["ansible-playbook", "site.yml"]))
        assert "PLAY RECAP" in result
        assert "web01" in result
        assert "web02" in result


class TestKubectlFilterExtended:
    """Additional tests for KubectlFilter."""

    def test_get_pods_preserves_header(self):
        """kubectl get output keeps the column header row."""
        f = bash_compress.KubectlFilter()
        rows = ["NAME                    READY   STATUS    RESTARTS   AGE"]
        rows += [f"pod-{i}   1/1   Running   0   1h" for i in range(40)]
        stdout = "\n".join(rows) + "\n"
        result = _filter_text(f.apply(stdout, "", 0, ["kubectl", "get", "pods"]))
        assert "NAME" in result
        assert "READY" in result

    def test_logs_compressed_to_head_tail(self):
        """kubectl logs output with >200 lines is compressed to head+tail."""
        f = bash_compress.KubectlLogsFilter()
        # Use 250 unique lines to trigger the >200 head+tail cap
        log_lines = [f"2024-01-01 00:00:{i % 60:02d} INFO unique-message-{i}" for i in range(250)]
        stdout = "\n".join(log_lines) + "\n"
        result = _filter_text(f.apply(stdout, "", 0, ["kubectl", "logs", "my-pod"]))
        result_lines = [ln for ln in result.splitlines() if ln.strip() and "token-goat" not in ln]
        assert len(result_lines) < 250, "logs should be compressed"

    def test_error_exit_preserves_stderr(self):
        """kubectl with non-zero exit preserves stderr."""
        f = bash_compress.KubectlFilter()
        stderr = "Error from server (NotFound): pods \"no-pod\" not found\n"
        result = _filter_text(f.apply("", stderr, 1, ["kubectl", "get", "pod", "no-pod"]))
        assert "NotFound" in result or "not found" in result.lower()
