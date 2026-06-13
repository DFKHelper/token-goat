"""Tests for Claude task-output temp-file detection and bash-output redirect.

Covers:
- _task_output_id path matching (Windows, Unix, edge cases)
- _handle_task_output_read: first-read hint injection
- _handle_task_output_read: subsequent-read deny
- _handle_task_output_read: non-task-output path falls through (returns None)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

from token_goat.bash_compress import _task_output_id

# ---------------------------------------------------------------------------
# _task_output_id — path matching
# ---------------------------------------------------------------------------


class TestTaskOutputId:
    """Unit tests for the path-matching helper."""

    def test_windows_typical(self) -> None:
        path = r"C:\Users\alice\AppData\Local\Temp\claude\my-project\sess123\tasks\abc123def.output"
        assert _task_output_id(path) == "abc123def"

    def test_windows_backslashes_only(self) -> None:
        path = r"C:\Temp\claude\proj\sess\tasks\deadbeef.output"
        assert _task_output_id(path) == "deadbeef"

    def test_unix_typical(self) -> None:
        path = "/tmp/claude/my-project/session-xyz/tasks/feedcafe01.output"
        assert _task_output_id(path) == "feedcafe01"

    def test_unix_deep_temp(self) -> None:
        path = "/var/folders/ab/cdef/T/claude/project/session/tasks/11223344.output"
        assert _task_output_id(path) == "11223344"

    def test_mixed_separators(self) -> None:
        # Windows paths sometimes get forward slashes from Python's Path.as_posix()
        path = "C:/Users/bob/AppData/Local/Temp/claude/proj/sess/tasks/a1b2c3.output"
        assert _task_output_id(path) == "a1b2c3"

    def test_uppercase_extension_matches(self) -> None:
        # re.IGNORECASE covers .OUTPUT
        path = "/tmp/claude/p/s/tasks/aabbccdd.OUTPUT"
        assert _task_output_id(path) == "aabbccdd"

    def test_path_with_spaces_in_project(self) -> None:
        path = r"C:\Users\alice\AppData\Local\Temp\claude\my project\sess\tasks\abc.output"
        assert _task_output_id(path) == "abc"

    def test_deeply_nested_session(self) -> None:
        # Session segment may itself contain hyphens/dots — captured by [^\\/]+
        path = "/tmp/claude/repo-name/sess-2026-06-13-abcd1234/tasks/ff00ff00.output"
        assert _task_output_id(path) == "ff00ff00"

    def test_wrong_extension_dot_log(self) -> None:
        path = "/tmp/claude/proj/sess/tasks/abc123.log"
        assert _task_output_id(path) is None

    def test_wrong_extension_no_extension(self) -> None:
        path = "/tmp/claude/proj/sess/tasks/abc123"
        assert _task_output_id(path) is None

    def test_missing_tasks_segment(self) -> None:
        # Must have 'tasks' as the parent directory
        path = "/tmp/claude/proj/sess/abc123.output"
        assert _task_output_id(path) is None

    def test_not_under_claude(self) -> None:
        path = "/tmp/other/proj/sess/tasks/abc123.output"
        assert _task_output_id(path) is None

    def test_empty_string(self) -> None:
        assert _task_output_id("") is None

    def test_just_filename(self) -> None:
        assert _task_output_id("abc123.output") is None

    def test_returns_none_for_regular_source_file(self) -> None:
        assert _task_output_id("src/token_goat/hooks_read.py") is None

    def test_returns_none_for_windows_source_path(self) -> None:
        assert _task_output_id(r"C:\Projects\token-goat\src\token_goat\session.py") is None


# ---------------------------------------------------------------------------
# _handle_task_output_read — hook behaviour
# ---------------------------------------------------------------------------


def _make_cache(stored: dict[str, str] | None = None) -> MagicMock:
    """Build a minimal fake SessionCache with stored_task_outputs (task_id → output_id)."""
    cache = MagicMock()
    cache.stored_task_outputs = {} if stored is None else stored
    return cache


def _make_meta(output_id: str = "out001") -> MagicMock:
    meta = MagicMock()
    meta.output_id = output_id
    return meta


_TASK_PATH_WIN = (
    r"C:\Users\alice\AppData\Local\Temp\claude\proj\sess\tasks\abc123.output"
)
_TASK_PATH_UNIX = "/tmp/claude/proj/sess/tasks/abc123.output"
_TASK_ID = "abc123"
_NON_TASK_PATH = "src/token_goat/hooks_read.py"


class TestHandleTaskOutputRead:
    """Integration-level tests for _handle_task_output_read."""

    def _import_handler(self) -> Any:
        from token_goat.hooks_read import _handle_task_output_read  # noqa: PLC0415

        return _handle_task_output_read

    # --- Non-task path falls through ---

    def test_non_task_path_returns_none(self) -> None:
        handler = self._import_handler()
        result = handler(_NON_TASK_PATH, "sess-001")
        assert result is None

    def test_no_session_id_returns_none(self) -> None:
        handler = self._import_handler()
        result = handler(_TASK_PATH_UNIX, None)
        assert result is None

    def test_empty_session_id_returns_none(self) -> None:
        handler = self._import_handler()
        result = handler(_TASK_PATH_UNIX, "")
        assert result is None

    # --- Session cache load failure → fall through ---

    def test_cache_load_failure_returns_none(self) -> None:
        handler = self._import_handler()
        with patch("token_goat.hooks_read._get_session") as mock_get_sess:
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = None
            mock_get_sess.return_value = sess_mod
            result = handler(_TASK_PATH_UNIX, "sess-001")
        assert result is None

    # --- First read: hint injected, continue ---

    def test_first_read_returns_context_hint(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("line1\nline2\nline3\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()
        meta = _make_meta("stored001")

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", return_value=meta),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is not None
        # First read must be a continue (context hint), never a deny.
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"

    def test_first_read_stores_task_id_in_cache(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("hello world\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()
        meta = _make_meta("stored001")

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", return_value=meta),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            handler(path, "sess-001")

        assert "abc123" in cache.stored_task_outputs

    def test_first_read_saves_session_after_store(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()
        meta = _make_meta("stored001")

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", return_value=meta),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            handler(path, "sess-001")

            sess_mod.save.assert_called_once_with(cache)

    def test_first_read_hint_contains_output_id(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()
        meta = _make_meta("myoutputid99")

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", return_value=meta),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is not None
        result_str = str(result)
        assert "myoutputid99" in result_str

    # --- Subsequent read: deny ---

    def test_subsequent_read_returns_deny(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache(stored={"abc123": "output-id-xyz"})

        with patch("token_goat.hooks_read._get_session") as mock_get_sess:
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is not None
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") == "deny"

    def test_subsequent_read_does_not_call_store_output(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache(stored={"abc123": "output-id-xyz"})

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output") as mock_store,
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            handler(path, "sess-001")

        mock_store.assert_not_called()

    def test_subsequent_read_deny_mentions_output_id(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache(stored={"abc123": "output-id-xyz"})

        with patch("token_goat.hooks_read._get_session") as mock_get_sess:
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is not None
        result_str = str(result)
        # The deny hint must reference the blob output_id, not the raw task_id,
        # so the recall command is actually valid.
        assert "output-id-xyz" in result_str

    # --- store_output failure → fall through ---

    def test_store_output_failure_returns_none(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", return_value=None),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is None
        # Task ID must NOT be added when store_output returns None (failed silently).
        assert "abc123" not in cache.stored_task_outputs

    def test_store_output_exception_returns_none(self, tmp_path: Path) -> None:
        actual_dir = tmp_path / "claude" / "proj" / "sess" / "tasks"
        actual_dir.mkdir(parents=True)
        (actual_dir / "abc123.output").write_text("data\n", encoding="utf-8")
        path = str(actual_dir / "abc123.output")

        handler = self._import_handler()
        cache = _make_cache()

        with (
            patch("token_goat.hooks_read._get_session") as mock_get_sess,
            patch("token_goat.bash_cache.store_output", side_effect=OSError("disk full")),
        ):
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is None
        # Task ID must NOT be added when store_output raises (exception swallowed).
        assert "abc123" not in cache.stored_task_outputs

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        path = str(tmp_path / "claude" / "proj" / "sess" / "tasks" / "abc123.output")
        # File does not exist
        handler = self._import_handler()
        cache = _make_cache()

        with patch("token_goat.hooks_read._get_session") as mock_get_sess:
            sess_mod = MagicMock()
            sess_mod.safe_load.return_value = cache
            mock_get_sess.return_value = sess_mod

            result = handler(path, "sess-001")

        assert result is None

    # --- Session cache persistence for stored_task_outputs ---

    def test_stored_task_outputs_empty_by_default(self) -> None:
        """Freshly constructed SessionCache has an empty stored_task_outputs set."""
        import time  # noqa: PLC0415

        from token_goat.session import SessionCache  # noqa: PLC0415

        cache = SessionCache(
            session_id="test-session",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        assert isinstance(cache.stored_task_outputs, dict)
        assert len(cache.stored_task_outputs) == 0

    def test_stored_task_outputs_round_trips_via_json(self) -> None:
        """stored_task_outputs survives to_dict/from_dict serialization."""
        import time  # noqa: PLC0415

        from token_goat.session import SessionCache  # noqa: PLC0415

        cache = SessionCache(
            session_id="test-session",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        cache.stored_task_outputs["aabbccdd"] = "blob-aabb"
        cache.stored_task_outputs["11223344"] = "blob-1122"

        d = cache.to_dict()
        assert d["stored_task_outputs"] == {"aabbccdd": "blob-aabb", "11223344": "blob-1122"}

        restored = SessionCache.from_dict(d)
        assert restored.stored_task_outputs == {"aabbccdd": "blob-aabb", "11223344": "blob-1122"}

    def test_stored_task_outputs_missing_from_legacy_json(self) -> None:
        """from_dict handles older session JSONs that lack stored_task_outputs."""
        import time  # noqa: PLC0415

        from token_goat.session import SessionCache  # noqa: PLC0415

        cache = SessionCache(
            session_id="test-session",
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        d = cache.to_dict()
        # Simulate legacy JSON that predates this field
        del d["stored_task_outputs"]

        restored = SessionCache.from_dict(d)
        assert isinstance(restored.stored_task_outputs, dict)
        assert len(restored.stored_task_outputs) == 0
