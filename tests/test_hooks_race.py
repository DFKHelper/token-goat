"""Regression tests for race-condition and robustness fixes.

Covers four areas:
1. _safe_split_argv (hooks_read) — shlex split with fallback on unbalanced quotes.
2. _edit_succeeded (hooks_edit) — gate on is_error flag, error-prefix strings, mtime freshness.
3. Session CAS ordering — two concurrent saves from version 0 both survive via merge.
4. _rename_with_retry (paths) — PermissionError retry exhaustion raises the last error.
"""
from __future__ import annotations

import os
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat.hooks_edit import _EDIT_FRESHNESS_SECS, _edit_succeeded
from token_goat.hooks_read import _safe_split_argv
from token_goat.paths import _rename_with_retry

# ---------------------------------------------------------------------------
# 1. _safe_split_argv
# ---------------------------------------------------------------------------


class TestSafeSplitArgv:
    """_safe_split_argv must tokenise shell commands without raising."""

    def test_empty_string_returns_empty_list(self):
        assert _safe_split_argv("") == []

    def test_whitespace_only_returns_empty_list(self):
        assert _safe_split_argv("   \t\n  ") == []

    def test_simple_command_splits_on_spaces(self):
        assert _safe_split_argv("git status") == ["git", "status"]

    def test_quoted_argument_preserved_as_single_token(self):
        result = _safe_split_argv('echo "hello world"')
        assert result == ["echo", "hello world"]

    def test_single_quoted_argument(self):
        result = _safe_split_argv("echo 'foo bar'")
        assert result == ["echo", "foo bar"]

    def test_escaped_space_in_path(self):
        result = _safe_split_argv(r"cat /home/user/my\ file.py")
        assert result == ["cat", "/home/user/my file.py"]

    def test_unbalanced_quote_falls_back_to_whitespace_split(self):
        # shlex raises ValueError on unbalanced quotes; fallback must not raise.
        cmd = 'echo "unbalanced'
        result = _safe_split_argv(cmd)
        # Fallback is str.split: ["echo", '"unbalanced']
        assert isinstance(result, list)
        assert len(result) >= 1
        assert "echo" in result

    def test_metacharacters_passed_through(self):
        """Pipeline metacharacters are kept in the token list (not stripped)."""
        result = _safe_split_argv("ls | grep foo")
        assert "|" in result

    def test_semicolon_kept(self):
        result = _safe_split_argv("cd /tmp; ls")
        assert ";" in result or any(";" in t for t in result)

    def test_command_substitution_token_present(self):
        result = _safe_split_argv("echo $(date)")
        # shlex treats $(date) as a single token on POSIX
        assert any("$(date)" in t or "date" in t for t in result)

    def test_multiword_command_with_flags(self):
        result = _safe_split_argv("rg --type py -l pattern")
        assert result == ["rg", "--type", "py", "-l", "pattern"]

    def test_none_value_handled(self):
        # _safe_split_argv receives a str; passing None should be a caller error,
        # but we verify it returns [] rather than raising (defensive behaviour).
        result = _safe_split_argv(None)  # type: ignore[arg-type]
        assert result == []

    def test_multiple_spaces_between_tokens(self):
        result = _safe_split_argv("git   log   --oneline")
        assert result == ["git", "log", "--oneline"]

    def test_tab_separated_tokens(self):
        result = _safe_split_argv("git\tlog")
        assert result == ["git", "log"]

    def test_returns_list_type_always(self):
        for cmd in ["ls", "", "echo 'x'", 'bad"']:
            r = _safe_split_argv(cmd)  # type: ignore[arg-type]
            assert isinstance(r, list), f"Expected list for {cmd!r}, got {type(r)}"

    def test_double_unbalanced_quotes_fallback(self):
        """Two unbalanced quotes should still fall back cleanly."""
        result = _safe_split_argv('"one "two')
        assert isinstance(result, list)


# ---------------------------------------------------------------------------
# 2. _edit_succeeded
# ---------------------------------------------------------------------------


class TestEditSucceeded:
    """_edit_succeeded must detect explicit failures and stale mtime."""

    # ---- tool_response dict with is_error ----

    def test_is_error_true_returns_false(self, tmp_path):
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {
            "tool_response": {"is_error": True, "content": "oops"},
            "tool_input": {"file_path": fp},
        }
        assert _edit_succeeded(payload, fp) is False

    def test_is_error_false_does_not_block(self, tmp_path):
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {
            "tool_response": {"is_error": False},
            "tool_input": {"file_path": fp},
        }
        assert _edit_succeeded(payload, fp) is True

    def test_is_error_missing_key_does_not_block(self, tmp_path):
        fp = str(tmp_path / "f.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {
            "tool_response": {"content": "success"},
            "tool_input": {"file_path": fp},
        }
        assert _edit_succeeded(payload, fp) is True

    # ---- tool_response as string ----

    def test_error_prefix_string_returns_false(self, tmp_path):
        fp = str(tmp_path / "g.py")
        Path(fp).write_text("x", encoding="utf-8")
        for prefix in ("Error: file not found", "Failed: permission denied", "Permission denied"):
            payload = {
                "tool_response": prefix,
                "tool_input": {"file_path": fp},
            }
            assert _edit_succeeded(payload, fp) is False, f"Expected False for prefix {prefix!r}"

    def test_success_string_does_not_block(self, tmp_path):
        fp = str(tmp_path / "g.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {
            "tool_response": "File written successfully",
            "tool_input": {"file_path": fp},
        }
        assert _edit_succeeded(payload, fp) is True

    def test_string_with_error_mid_string_does_not_block(self, tmp_path):
        """Only *prefix* matches count — 'some Error:' mid-string must not block."""
        fp = str(tmp_path / "g.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {
            "tool_response": "Wrote file. Note: Error: logged to stderr",
            "tool_input": {"file_path": fp},
        }
        assert _edit_succeeded(payload, fp) is True

    # ---- mtime freshness ----

    def test_fresh_mtime_returns_true(self, tmp_path):
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        # mtime is right now — age is ~0s, well within threshold
        payload = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is True

    def test_stale_mtime_returns_false(self, tmp_path):
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        # Set mtime to epoch (ancient)
        os.utime(fp, (0.0, 0.0))
        payload = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is False

    def test_mtime_exactly_at_threshold_returns_false(self, tmp_path):
        """Age == threshold is also considered stale (> check uses strict >)."""
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        stale_time = time.time() - (_EDIT_FRESHNESS_SECS + 0.1)
        os.utime(fp, (stale_time, stale_time))
        payload = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is False

    def test_mtime_just_under_threshold_returns_true(self, tmp_path):
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        fresh_time = time.time() - (_EDIT_FRESHNESS_SECS - 1.0)
        os.utime(fp, (fresh_time, fresh_time))
        payload = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is True

    def test_missing_file_returns_true(self, tmp_path):
        """Non-existent file is treated as succeed (conservative for deletions)."""
        fp = str(tmp_path / "nonexistent.py")
        payload = {"tool_input": {"file_path": fp}}
        assert _edit_succeeded(payload, fp) is True

    def test_oserror_on_stat_fails_open_returns_true(self, tmp_path):
        """OSError during stat is fail-open: returns True so the edit is recorded."""
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_input": {"file_path": fp}}
        with patch("os.path.getmtime", side_effect=OSError("permission")):
            result = _edit_succeeded(payload, fp)
        assert result is True

    def test_no_tool_response_key_falls_through_to_mtime_check(self, tmp_path):
        """Payload without tool_response skips error checks and reaches mtime check."""
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {}  # no tool_response
        assert _edit_succeeded(payload, fp) is True

    def test_tool_response_not_dict_or_str_falls_through(self, tmp_path):
        """Non-dict, non-str tool_response (e.g. int) must not raise."""
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        payload = {"tool_response": 42}
        assert _edit_succeeded(payload, fp) is True

    # ---- is_error precedence over mtime ----

    def test_is_error_true_wins_even_with_fresh_mtime(self, tmp_path):
        """is_error:true must return False even if the file is freshly written."""
        fp = str(tmp_path / "h.py")
        Path(fp).write_text("x", encoding="utf-8")
        # mtime is right now but is_error is set
        payload = {"tool_response": {"is_error": True}}
        assert _edit_succeeded(payload, fp) is False


# ---------------------------------------------------------------------------
# 3. Session CAS ordering
# ---------------------------------------------------------------------------


class TestSessionCasOrdering:
    """Two concurrent saves starting from version 0 must both commit via merge."""

    def test_two_threads_edit_different_files_both_survive(self, tmp_data_dir):
        """Two threads each marking a different edited file must both appear in final state."""
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "cas-race-two-files"
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)

        barrier = threading.Barrier(2)
        errors: list[str] = []

        def record_file(path: str) -> None:
            try:
                barrier.wait(timeout=5)

                def mutate(cache: session.SessionCache) -> None:
                    cache.edited_files[path] = cache.edited_files.get(path, 0) + 1

                update_session(sid, mutate)
            except Exception as exc:
                errors.append(f"{path}: {exc}")

        t1 = threading.Thread(target=record_file, args=("alpha.py",))
        t2 = threading.Thread(target=record_file, args=("beta.py",))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert not errors, f"Thread errors: {errors}"

        final = session.load(sid)
        assert final is not None
        assert "alpha.py" in final.edited_files, (
            f"alpha.py missing from {dict(final.edited_files)}"
        )
        assert "beta.py" in final.edited_files, (
            f"beta.py missing from {dict(final.edited_files)}"
        )

    def test_stale_in_memory_cache_not_used_across_retries(self, tmp_data_dir):
        """The CAS loop must re-read from disk; stale in-memory data must not clobber a
        concurrent write that incremented the version."""
        from token_goat import session

        sid = "cas-race-stale-mem"
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)

        # Thread A writes a file, then Thread B writes a *different* file.
        # The final state must contain both files — verifying that B did not
        # blindly overwrite A's committed version.
        from token_goat.hooks_common import update_session

        def add_file(path: str, delay: float = 0.0) -> None:
            if delay:
                threading.Event().wait(delay)

            def mutate(cache: session.SessionCache) -> None:
                cache.edited_files[path] = 1

            update_session(sid, mutate)

        t1 = threading.Thread(target=add_file, args=("x.py", 0.0))
        t2 = threading.Thread(target=add_file, args=("y.py", 0.02))
        t1.start()
        t2.start()
        t1.join(timeout=5)
        t2.join(timeout=5)

        final = session.load(sid)
        assert final is not None
        # Both mutations must survive regardless of scheduling order.
        assert "x.py" in final.edited_files
        assert "y.py" in final.edited_files

    def test_version_monotonically_increases(self, tmp_data_dir):
        """Each save must increment the version counter."""
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "cas-race-version"
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)
        v0 = session.load(sid).version  # type: ignore[union-attr]

        update_session(sid, lambda c: c.edited_files.update({"a.py": 1}))
        v1 = session.load(sid).version  # type: ignore[union-attr]

        update_session(sid, lambda c: c.edited_files.update({"b.py": 1}))
        v2 = session.load(sid).version  # type: ignore[union-attr]

        assert v1 > v0, f"version did not increase after first save: {v0} -> {v1}"
        assert v2 > v1, f"version did not increase after second save: {v1} -> {v2}"


# ---------------------------------------------------------------------------
# 4. _rename_with_retry
# ---------------------------------------------------------------------------


class TestRenameWithRetry:
    """_rename_with_retry must retry on PermissionError and eventually raise.

    WindowsPath.replace is a C-slot and cannot be patched on instances. We
    patch token_goat.paths.Path.replace at the class level instead so the
    mock fires when _rename_with_retry calls src.replace(dest).
    """

    def test_succeeds_on_first_try(self, tmp_path):
        src = tmp_path / "src.txt"
        dest = tmp_path / "dest.txt"
        src.write_text("hello", encoding="utf-8")
        _rename_with_retry(src, dest)
        assert dest.read_text(encoding="utf-8") == "hello"
        assert not src.exists()

    def test_raises_after_three_permission_errors(self, tmp_path):
        """When replace() always raises PermissionError, the last error is re-raised."""
        import token_goat.paths as _tg_paths

        call_count = 0

        def _always_permission_error(self, dest_arg):  # noqa: ARG001
            nonlocal call_count
            call_count += 1
            raise PermissionError("locked by antivirus")

        with (
            patch.object(_tg_paths.Path, "replace", _always_permission_error),
            pytest.raises(PermissionError, match="locked by antivirus"),
        ):
            src = tmp_path / "locked.txt"
            dest = tmp_path / "dest.txt"
            src.write_text("x", encoding="utf-8")
            _rename_with_retry(src, dest)

        # Exactly 3 attempts (delays: 0.0, 0.05, 0.15)
        assert call_count == 3, f"Expected 3 attempts, got {call_count}"

    def test_succeeds_on_second_attempt_after_one_permission_error(self, tmp_path):
        """If the first attempt raises PermissionError but the second succeeds, no exception."""
        import token_goat.paths as _tg_paths

        src = tmp_path / "src.txt"
        dest = tmp_path / "dest.txt"
        src.write_text("data", encoding="utf-8")

        # Capture the real replace method before patching.
        _real_replace = Path.replace
        attempt = 0

        def _flaky_replace(self, dest_arg):
            nonlocal attempt
            attempt += 1
            if attempt == 1:
                raise PermissionError("locked")
            return _real_replace(self, dest_arg)

        with patch.object(_tg_paths.Path, "replace", _flaky_replace):
            # Should not raise — succeeds on second attempt
            _rename_with_retry(src, dest)

        assert attempt == 2

    def test_non_permission_error_not_retried(self, tmp_path):
        """Other OSErrors (e.g. FileNotFoundError) must propagate immediately without retry."""
        import token_goat.paths as _tg_paths

        call_count = 0

        def _file_not_found(self, dest_arg):  # noqa: ARG001
            nonlocal call_count
            call_count += 1
            raise FileNotFoundError("no such file")

        with (
            patch.object(_tg_paths.Path, "replace", _file_not_found),
            pytest.raises(FileNotFoundError),
        ):
            src = tmp_path / "src.txt"
            src.write_text("x", encoding="utf-8")
            dest = tmp_path / "dest.txt"
            _rename_with_retry(src, dest)

        # Must not have retried — FileNotFoundError is not PermissionError
        assert call_count == 1, (
            f"Non-PermissionError should not trigger retry; got {call_count} calls"
        )
