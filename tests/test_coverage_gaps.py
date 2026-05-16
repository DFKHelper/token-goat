"""Tests covering previously untested code paths identified by coverage analysis.

Targets:
- cli_stats._write_raw and cli_stats.stats (0% coverage)
- bash_parser: missing-path errors, --regexp= flag, grep with no pattern, glob with no pattern
- compact._short_path long-path truncation; build_manifest exception branch
- hooks_common.get_tool_input with non-dict tool_input value
- hooks_session._auto_index_if_needed and _ensure_worker_running exception branches
"""
from __future__ import annotations

import io
import sys
from unittest.mock import patch

# ---------------------------------------------------------------------------
# cli_stats
# ---------------------------------------------------------------------------


class TestWriteRaw:
    """Tests for cli_stats._write_raw."""

    def test_write_raw_plain_to_tty(self, capsys):
        """_write_raw writes text + newline to stdout."""
        from token_goat.cli_stats import _write_raw

        # Redirect via capsys — stdout is not a tty in pytest, so ANSI is stripped.
        _write_raw("hello world")
        captured = capsys.readouterr()
        assert "hello world" in captured.out

    def test_write_raw_strips_ansi_when_no_color(self, monkeypatch, capsys):
        """_write_raw strips ANSI codes when NO_COLOR env var is set."""
        from token_goat.cli_stats import _write_raw

        monkeypatch.setenv("NO_COLOR", "1")
        _write_raw("\x1b[31mred text\x1b[0m")
        captured = capsys.readouterr()
        assert "\x1b" not in captured.out
        assert "red text" in captured.out

    def test_write_raw_strips_ansi_when_not_tty(self, monkeypatch, capsys):
        """_write_raw strips ANSI codes when stdout is not a tty (pytest default)."""
        from token_goat.cli_stats import _write_raw

        monkeypatch.delenv("NO_COLOR", raising=False)
        # In pytest, sys.stdout.isatty() is False, so stripping should apply.
        _write_raw("\x1b[32mgreen\x1b[0m plain")
        captured = capsys.readouterr()
        assert "\x1b" not in captured.out
        assert "green" in captured.out
        assert "plain" in captured.out

    def test_write_raw_fallback_stream_without_buffer(self, monkeypatch):
        """_write_raw falls back to stream.write() when buffer is absent."""
        from token_goat.cli_stats import _write_raw

        output = io.StringIO()
        monkeypatch.setattr(sys, "stdout", output)
        _write_raw("no-buffer path")
        assert "no-buffer path" in output.getvalue()

    def test_write_raw_unwraps_stream_wrapper(self, monkeypatch):
        """_write_raw unwraps _StreamWrapper__wrapped attributes."""
        from token_goat.cli_stats import _write_raw

        inner = io.StringIO()

        class FakeWrapper:
            _StreamWrapper__wrapped = inner

            def isatty(self):
                return False

        monkeypatch.setattr(sys, "stdout", FakeWrapper())
        _write_raw("wrapper test")
        assert "wrapper test" in inner.getvalue()


class TestStatsFunction:
    """Tests for cli_stats.stats (the Typer command body)."""

    def test_stats_json_output(self, tmp_data_dir):
        """stats() with json_output=True emits valid JSON with expected keys."""
        import json

        from token_goat import db
        from token_goat.cli_stats import stats

        db.record_stat(None, "image_shrink", bytes_saved=500, tokens_saved=125)

        captured_output = []

        with patch("typer.echo", side_effect=lambda s: captured_output.append(s)):
            stats(window=30, json_output=True)

        assert len(captured_output) == 1
        data = json.loads(captured_output[0])
        assert "total_events" in data
        assert "total_bytes_saved" in data
        assert "total_tokens_saved" in data
        assert "by_kind" in data
        assert "by_day" in data
        assert "by_project" in data
        assert "window_days" in data
        assert data["total_events"] == 1
        assert data["total_bytes_saved"] == 500

    def test_stats_plain_output(self, tmp_data_dir, capsys):
        """stats() without --json calls _write_raw with the rendered text."""
        from token_goat import db
        from token_goat.cli_stats import stats

        db.record_stat(None, "read_replacement", bytes_saved=200, tokens_saved=50)

        write_raw_calls = []
        with patch("token_goat.cli_stats._write_raw", side_effect=lambda t: write_raw_calls.append(t)):
            stats(window=30, json_output=False)

        assert len(write_raw_calls) == 1
        rendered = write_raw_calls[0]
        assert isinstance(rendered, str)
        assert len(rendered) > 0

    def test_stats_json_zero_window_all_time(self, tmp_data_dir):
        """stats() with window=0 passes window_days=0 to summarize (all-time)."""
        import json

        from token_goat.cli_stats import stats

        captured_output = []
        with patch("typer.echo", side_effect=lambda s: captured_output.append(s)):
            stats(window=0, json_output=True)

        data = json.loads(captured_output[0])
        assert data["window_days"] == 0


# ---------------------------------------------------------------------------
# bash_parser — uncovered branches
# ---------------------------------------------------------------------------


class TestBashParserMissingPaths:
    """Covers lines 119-123: missing file path for scripted read bins."""

    def test_cat_no_path_returns_unknown(self):
        """cat with only flags and no path returns unknown with reason."""
        from token_goat.bash_parser import parse

        intent = parse("cat -n")
        assert intent.kind == "unknown"
        assert intent.reason is not None
        assert "missing a file path" in intent.reason

    def test_sed_single_arg_script_only_returns_unknown(self):
        """sed with script but no target file returns unknown."""
        from token_goat.bash_parser import parse

        # sed needs: sed script file — if only one non-flag arg, missing target
        # 'sed script' has 1 path (the script), but SCRIPTED_READ_BINS needs >=2
        intent = parse("sed 's/a/b/'")
        assert intent.kind == "unknown"
        assert intent.reason is not None
        # Could be "missing a file path" or "missing a target file"
        assert "missing" in intent.reason

    def test_awk_no_path_returns_unknown(self):
        """awk with only a script and no file path returns unknown."""
        from token_goat.bash_parser import parse

        intent = parse("awk 'BEGIN{print}'")
        assert intent.kind == "unknown"
        assert intent.reason is not None

    def test_head_no_path_returns_unknown(self):
        """head with only flags and no path returns unknown."""
        from token_goat.bash_parser import parse

        intent = parse("head -n 10")
        assert intent.kind == "unknown"
        assert intent.reason is not None
        assert "missing a file path" in intent.reason


class TestBashParserGrepEdgeCases:
    """Covers lines 138-140 and 149: --regexp= flag and no-pattern grep."""

    def test_rg_regexp_equals_flag(self):
        """rg --regexp=pattern is parsed correctly (line 138-140)."""
        from token_goat.bash_parser import parse

        intent = parse("rg --regexp=mypattern src/")
        assert intent.kind == "grep"
        assert intent.pattern == "mypattern"

    def test_grep_no_pattern_returns_unknown(self):
        """grep with only flags and no positional pattern returns unknown (line 149)."""
        from token_goat.bash_parser import parse

        # All args start with '-', so pattern stays None
        intent = parse("grep -r -l --color")
        assert intent.kind == "unknown"

    def test_grep_f_flag_with_pattern(self):
        """grep -f pattern uses the next arg as pattern (lines 133-135)."""
        from token_goat.bash_parser import parse

        intent = parse("grep -f pattern_file.txt src/")
        assert intent.kind == "grep"
        assert intent.pattern == "pattern_file.txt"

    def test_rg_e_equals_not_supported_falls_to_positional(self):
        """rg uses first non-flag arg as pattern when -e is not present."""
        from token_goat.bash_parser import parse

        intent = parse("rg somepattern")
        assert intent.kind == "grep"
        assert intent.pattern == "somepattern"


class TestBashParserGlobNoPattern:
    """Covers line 158: glob fallback when no non-flag arg is found."""

    def test_find_flags_only_returns_glob_without_pattern(self):
        """find with only dash-flags returns glob kind with None pattern (line 158)."""
        from token_goat.bash_parser import parse

        # All args start with '-' so no non-flag arg is found -> pattern=None
        # Use 'ls --all --long' — every token starts with '-', hitting the fallback
        intent = parse("ls --all --long")
        assert intent.kind == "glob"
        assert intent.pattern is None

    def test_fd_no_pattern_returns_glob(self):
        """fd with only type flags returns glob with no pattern."""
        from token_goat.bash_parser import parse

        intent = parse("fd -t f -e py")
        assert intent.kind == "glob"


# ---------------------------------------------------------------------------
# compact._short_path — long path truncation (line 31)
# ---------------------------------------------------------------------------


class TestCompactShortPath:
    """Tests for compact._short_path."""

    def test_short_path_truncates_very_long_path(self):
        """_short_path truncates paths longer than max_len with ellipsis prefix."""
        from token_goat.compact import _short_path

        long_path = "/some/deeply/nested/directory/structure/" + "a" * 100 + "/file.py"
        result = _short_path(long_path, max_len=70)
        assert result.startswith("…")
        assert len(result) <= 70

    def test_short_path_strips_src_prefix(self):
        """_short_path strips /src/ prefix."""
        from token_goat.compact import _short_path

        result = _short_path("/project/src/auth/user.py")
        assert result == "src/auth/user.py"

    def test_short_path_strips_tests_prefix(self):
        """_short_path strips /tests/ prefix."""
        from token_goat.compact import _short_path

        result = _short_path("/project/tests/test_auth.py")
        assert result == "tests/test_auth.py"

    def test_short_path_strips_docs_prefix(self):
        """_short_path strips /docs/ prefix."""
        from token_goat.compact import _short_path

        result = _short_path("/project/docs/api.md")
        assert result == "docs/api.md"

    def test_short_path_normalizes_backslashes(self):
        """_short_path converts backslashes to forward slashes."""
        from token_goat.compact import _short_path

        result = _short_path("C:\\project\\src\\main.py")
        # Backslashes become forward slashes before prefix stripping
        assert "\\" not in result

    def test_short_path_within_max_len_unchanged(self):
        """_short_path returns unchanged path if within max_len."""
        from token_goat.compact import _short_path

        short = "/a/b.py"
        result = _short_path(short)
        assert result == short


class TestBuildManifestExceptionBranch:
    """Covers compact.build_manifest lines 67-69: session load exception."""

    def test_build_manifest_returns_empty_on_load_failure(self, tmp_data_dir, monkeypatch):
        """build_manifest returns '' when session.load raises an exception."""
        from token_goat import compact
        from token_goat import session as session_mod

        monkeypatch.setattr(session_mod, "load", lambda sid: (_ for _ in ()).throw(RuntimeError("corrupt")))
        result = compact.build_manifest("any-session-id")
        assert result == ""

    def test_event_count_returns_zero_on_exception(self, tmp_data_dir, monkeypatch):
        """event_count returns 0 when session.load raises (lines 50-52 coverage)."""
        from token_goat import compact
        from token_goat import session as session_mod

        monkeypatch.setattr(session_mod, "load", lambda sid: (_ for _ in ()).throw(OSError("io error")))
        result = compact.event_count("any-session-id")
        assert result == 0


# ---------------------------------------------------------------------------
# hooks_common.get_tool_input — non-dict tool_input value (line 53)
# ---------------------------------------------------------------------------


class TestGetToolInput:
    """Tests for hooks_common.get_tool_input."""

    def test_returns_empty_dict_for_none_payload(self):
        """get_tool_input(None) returns {}."""
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input(None) == {}

    def test_returns_empty_dict_for_missing_tool_input(self):
        """get_tool_input with no tool_input key returns {}."""
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input({"other_key": "value"}) == {}

    def test_returns_empty_dict_when_tool_input_is_string(self):
        """get_tool_input returns {} when tool_input is a string (not a dict)."""
        from token_goat.hooks_common import get_tool_input

        # Line 53: `value if isinstance(value, dict) else {}` — the else branch
        result = get_tool_input({"tool_input": "not a dict"})
        assert result == {}

    def test_returns_empty_dict_when_tool_input_is_list(self):
        """get_tool_input returns {} when tool_input is a list."""
        from token_goat.hooks_common import get_tool_input

        result = get_tool_input({"tool_input": ["a", "b"]})
        assert result == {}

    def test_returns_empty_dict_when_tool_input_is_none(self):
        """get_tool_input returns {} when tool_input is explicitly None."""
        from token_goat.hooks_common import get_tool_input

        result = get_tool_input({"tool_input": None})
        assert result == {}

    def test_returns_empty_dict_when_tool_input_is_integer(self):
        """get_tool_input returns {} when tool_input is an integer."""
        from token_goat.hooks_common import get_tool_input

        result = get_tool_input({"tool_input": 42})
        assert result == {}

    def test_returns_tool_input_when_it_is_a_dict(self):
        """get_tool_input returns the dict when tool_input is a valid dict."""
        from token_goat.hooks_common import get_tool_input

        payload = {"tool_input": {"file_path": "foo.py", "offset": 0}}
        result = get_tool_input(payload)
        assert result == {"file_path": "foo.py", "offset": 0}

    def test_returns_empty_dict_for_non_dict_payload(self):
        """get_tool_input returns {} when payload itself is not a dict."""
        from token_goat.hooks_common import get_tool_input

        assert get_tool_input("string") == {}  # type: ignore[arg-type]
        assert get_tool_input(42) == {}  # type: ignore[arg-type]
        assert get_tool_input([]) == {}  # type: ignore[arg-type]


class TestContinueFactory:
    """Tests for hooks_common.CONTINUE factory."""

    def test_continue_returns_dict_with_continue_true(self):
        """CONTINUE() returns {'continue': True}."""
        from token_goat.hooks_common import CONTINUE

        result = CONTINUE()
        assert result == {"continue": True}

    def test_continue_returns_independent_objects(self):
        """Each CONTINUE() call returns a distinct dict object."""
        from token_goat.hooks_common import CONTINUE

        a = CONTINUE()
        b = CONTINUE()
        a["extra"] = "mutated"
        assert "extra" not in b


class TestDenyRedirect:
    """Tests for hooks_common.deny_redirect."""

    def test_deny_redirect_structure(self):
        """deny_redirect returns the canonical interception shape."""
        from token_goat.hooks_common import deny_redirect

        result = deny_redirect("reason text", "context text")
        assert result["continue"] is True
        hso = result["hookSpecificOutput"]
        assert hso["hookEventName"] == "PreToolUse"
        assert hso["permissionDecision"] == "deny"
        assert hso["permissionDecisionReason"] == "reason text"
        assert hso["additionalContext"] == "context text"

    def test_deny_redirect_independent_calls(self):
        """Two deny_redirect calls produce independent dicts."""
        from token_goat.hooks_common import deny_redirect

        r1 = deny_redirect("r1", "c1")
        r2 = deny_redirect("r2", "c2")
        assert r1["hookSpecificOutput"]["permissionDecisionReason"] == "r1"
        assert r2["hookSpecificOutput"]["permissionDecisionReason"] == "r2"


# ---------------------------------------------------------------------------
# hooks_session exception branches (lines 44-45 and 56-57)
# ---------------------------------------------------------------------------


class TestHooksSessionExceptionBranches:
    """Cover _auto_index_if_needed and _ensure_worker_running exception paths."""

    def test_auto_index_exception_is_absorbed(self, tmp_data_dir, tmp_path, monkeypatch):
        """_auto_index_if_needed swallows exceptions and does not re-raise."""
        from token_goat import db
        from token_goat.hooks_session import _auto_index_if_needed
        from token_goat.project import find_project

        proj_root = tmp_path / "proj_exc"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        proj = find_project(proj_root)
        assert proj is not None

        # Make db.project_has_files raise to hit the except branch (lines 44-45)
        monkeypatch.setattr(db, "project_has_files", lambda *_: (_ for _ in ()).throw(RuntimeError("db boom")))

        # Should not raise — exception must be absorbed
        _auto_index_if_needed(proj)

    def test_ensure_worker_running_exception_is_absorbed(self, tmp_data_dir, monkeypatch):
        """_ensure_worker_running swallows exceptions and does not re-raise."""
        from token_goat import worker
        from token_goat.hooks_session import _ensure_worker_running

        # Make worker.ensure_running raise to hit the except branch (lines 56-57)
        monkeypatch.setattr(worker, "ensure_running", lambda: (_ for _ in ()).throw(OSError("worker boom")))

        # Should not raise
        _ensure_worker_running()

    def test_session_start_continues_even_if_auto_index_raises(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start returns continue:True even if _auto_index_if_needed raises."""
        from token_goat import db, hooks_session, worker

        proj_root = tmp_path / "proj_start_exc"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()

        monkeypatch.setattr(db, "project_has_files", lambda *_: (_ for _ in ()).throw(RuntimeError("fail")))
        monkeypatch.setattr(db, "touch_project_last_seen", lambda *_: None)
        monkeypatch.setattr(worker, "ensure_running", lambda: 1234)

        payload = {"session_id": "exc-test-session", "cwd": str(proj_root)}
        result = hooks_session.session_start(payload)
        assert result.get("continue") is True

    def test_session_start_continues_even_if_ensure_worker_raises(self, tmp_data_dir, tmp_path, monkeypatch):
        """session_start returns continue:True even if _ensure_worker_running raises."""
        from token_goat import db, hooks_session, worker

        proj_root = tmp_path / "proj_worker_exc"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()

        monkeypatch.setattr(db, "project_has_files", lambda *_: True)
        monkeypatch.setattr(db, "touch_project_last_seen", lambda *_: None)
        monkeypatch.setattr(worker, "ensure_running", lambda: (_ for _ in ()).throw(RuntimeError("worker gone")))

        payload = {"session_id": "worker-exc-session", "cwd": str(proj_root)}
        result = hooks_session.session_start(payload)
        assert result.get("continue") is True
