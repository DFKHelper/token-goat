"""Tests for hooks_edit — post-edit hook: session mark, queue enqueue, worker nudge."""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import patch

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_edit, paths, session

# ---------------------------------------------------------------------------
# _nudge_worker_if_down
# ---------------------------------------------------------------------------


class TestNudgeWorkerIfDown:
    def test_fresh_heartbeat_skips_respawn(self, tmp_data_dir):
        """Worker with a fresh heartbeat file must not trigger ensure_running."""
        paths.ensure_dirs()
        hb = paths.worker_heartbeat_path()
        hb.write_text("x", encoding="utf-8")

        with patch("token_goat.worker.ensure_running") as mock_ensure:
            hooks_edit._nudge_worker_if_down()
        mock_ensure.assert_not_called()

    def test_stale_heartbeat_calls_ensure_running(self, tmp_data_dir):
        """Stale heartbeat triggers ensure_running."""
        paths.ensure_dirs()
        hb = paths.worker_heartbeat_path()
        hb.write_text("x", encoding="utf-8")

        import os

        old_time = 0.0  # epoch — ancient mtime
        os.utime(hb, (old_time, old_time))

        with patch("token_goat.worker.ensure_running", return_value=12345) as mock_ensure:
            hooks_edit._nudge_worker_if_down()
        mock_ensure.assert_called_once()

    def test_stale_heartbeat_no_pid_logs_warning(self, tmp_data_dir):
        """When ensure_running returns 0/None, the warning branch is hit (line 31)."""
        paths.ensure_dirs()
        hb = paths.worker_heartbeat_path()
        hb.write_text("x", encoding="utf-8")

        import os

        os.utime(hb, (0.0, 0.0))

        with patch("token_goat.worker.ensure_running", return_value=0):
            hooks_edit._nudge_worker_if_down()  # must not raise

    def test_exception_in_nudge_is_swallowed(self, tmp_data_dir):
        """Any exception inside _nudge_worker_if_down must be swallowed (fail-soft)."""
        with patch.object(paths, "worker_heartbeat_path", side_effect=RuntimeError("boom")):
            hooks_edit._nudge_worker_if_down()  # must not raise


# ---------------------------------------------------------------------------
# _enqueue_for_reindex
# ---------------------------------------------------------------------------


class TestEnqueueForReindex:
    def test_relative_path_resolved_against_project_root(self, tmp_data_dir, tmp_path):
        """A relative file_path is resolved against the project root before enqueueing."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "src" / "app.py"
        src.parent.mkdir()
        src.write_text("x", encoding="utf-8")

        hooks_edit._enqueue_for_reindex("src/app.py", str(tmp_path))

        queue = paths.dirty_queue_path()
        assert queue.exists()
        entry = json.loads(queue.read_text(encoding="utf-8").strip())
        assert entry["path"] == "src/app.py"

    def test_file_outside_project_root_skipped(self, tmp_data_dir, tmp_path):
        """Relative path resolving outside the project root triggers ValueError → silently skipped."""
        (tmp_path / ".git").mkdir()
        # Pass a relative path with ../ traversal so find_project succeeds (tmp_path has .git)
        # but the resolved abs_path ends up outside the project root → ValueError → return
        hooks_edit._enqueue_for_reindex("../../outside/file.py", str(tmp_path))

        # Nothing should be written to the queue
        assert not paths.dirty_queue_path().exists()

    def test_oserror_on_queue_write_is_logged_not_raised(self, tmp_data_dir, tmp_path):
        """OSError writing to the queue must be caught and logged, not propagated."""
        from pathlib import Path as _Path


        (tmp_path / ".git").mkdir()
        src = tmp_path / "file.py"
        src.write_text("x", encoding="utf-8")

        with patch.object(_Path, "open", side_effect=OSError("disk full")):
            hooks_edit._enqueue_for_reindex(str(src), str(tmp_path))  # must not raise

    def test_no_project_returns_early(self, tmp_data_dir, tmp_path):
        """No project found → nothing enqueued, no error."""
        hooks_edit._enqueue_for_reindex(str(tmp_path / "file.py"), str(tmp_path))
        assert not paths.dirty_queue_path().exists()


# ---------------------------------------------------------------------------
# post_edit
# ---------------------------------------------------------------------------


class TestPostEdit:
    def test_records_session_edit_and_enqueues(self, tmp_data_dir, tmp_path):
        """post_edit marks the file edited in the session and enqueues it."""
        (tmp_path / ".git").mkdir()
        fp = str(tmp_path / "mod.py")
        Path(fp).write_text("x", encoding="utf-8")

        payload = {
            "session_id": "s-edit-1",
            "tool_input": {"file_path": fp},
            "cwd": str(tmp_path),
        }
        result = hooks_edit.post_edit(payload)
        _assert_continue(result)

        cache = session.load("s-edit-1")
        # edited_files is a dict {normalized_path: count}; keys are lowercased
        edited_keys = {k.lower() for k in (cache.edited_files or {})}
        assert fp.lower().replace("\\", "/") in edited_keys or any(
            fp.lower().replace("\\", "/") in k for k in edited_keys
        )

    def test_missing_file_path_returns_continue(self, tmp_data_dir):
        """post_edit with no file_path in tool_input still returns continue:true."""
        result = hooks_edit.post_edit({"session_id": "s-edit-2", "tool_input": {}})
        _assert_continue(result)

    def test_no_session_id_still_returns_continue(self, tmp_data_dir, tmp_path):
        """post_edit without session_id (get_hook_context returns None, None) must not crash."""
        fp = str(tmp_path / "noss.py")
        Path(fp).write_text("x", encoding="utf-8")
        result = hooks_edit.post_edit({"tool_input": {"file_path": fp}, "cwd": str(tmp_path)})
        _assert_continue(result)

    def test_multi_edit_records_all_files(self, tmp_data_dir, tmp_path):
        """MultiEdit payload with edits array records every touched file in the session."""
        (tmp_path / ".git").mkdir()
        fp1 = str(tmp_path / "a.py")
        fp2 = str(tmp_path / "b.py")
        Path(fp1).write_text("x", encoding="utf-8")
        Path(fp2).write_text("y", encoding="utf-8")

        sid = "s-multiedit-1"
        payload = {
            "session_id": sid,
            "tool_name": "MultiEdit",
            "tool_input": {
                "edits": [
                    {"file_path": fp1, "old_string": "x", "new_string": "x2"},
                    {"file_path": fp2, "old_string": "y", "new_string": "y2"},
                ]
            },
            "cwd": str(tmp_path),
        }
        result = hooks_edit.post_edit(payload)
        _assert_continue(result)

        cache = session.load(sid)
        edited_keys = {k.lower().replace("\\", "/") for k in (cache.edited_files or {})}
        assert fp1.lower().replace("\\", "/") in edited_keys
        assert fp2.lower().replace("\\", "/") in edited_keys

    def test_multi_edit_deduplicates_same_file(self, tmp_data_dir, tmp_path):
        """MultiEdit edits array with duplicate file_paths records the file only once."""
        (tmp_path / ".git").mkdir()
        fp = str(tmp_path / "dup.py")
        Path(fp).write_text("x", encoding="utf-8")

        sid = "s-multiedit-dup"
        payload = {
            "session_id": sid,
            "tool_name": "MultiEdit",
            "tool_input": {
                "edits": [
                    {"file_path": fp, "old_string": "x", "new_string": "x2"},
                    {"file_path": fp, "old_string": "x2", "new_string": "x3"},
                ]
            },
            "cwd": str(tmp_path),
        }
        result = hooks_edit.post_edit(payload)
        _assert_continue(result)

        # Dedup: _extract_edited_paths returns [fp] once; session records one entry.
        cache = session.load(sid)
        edited_keys = {k.lower().replace("\\", "/") for k in (cache.edited_files or {})}
        assert fp.lower().replace("\\", "/") in edited_keys

    def test_multi_edit_empty_edits_returns_continue(self, tmp_data_dir):
        """MultiEdit with an empty edits list returns continue:true without error."""
        result = hooks_edit.post_edit({
            "session_id": "s-multiedit-empty",
            "tool_name": "MultiEdit",
            "tool_input": {"edits": []},
        })
        _assert_continue(result)

    def test_multi_edit_malformed_edits_entries_skipped(self, tmp_data_dir, tmp_path):
        """MultiEdit edits array entries that are not dicts are silently skipped."""
        (tmp_path / ".git").mkdir()
        fp = str(tmp_path / "c.py")
        Path(fp).write_text("z", encoding="utf-8")

        sid = "s-multiedit-bad"
        payload = {
            "session_id": sid,
            "tool_name": "MultiEdit",
            "tool_input": {
                "edits": [
                    "not-a-dict",
                    None,
                    {"file_path": fp, "old_string": "z", "new_string": "z2"},
                ]
            },
            "cwd": str(tmp_path),
        }
        result = hooks_edit.post_edit(payload)
        _assert_continue(result)

        cache = session.load(sid)
        edited_keys = {k.lower().replace("\\", "/") for k in (cache.edited_files or {})}
        assert fp.lower().replace("\\", "/") in edited_keys


# ---------------------------------------------------------------------------
# _extract_edited_paths
# ---------------------------------------------------------------------------


class TestExtractEditedPaths:
    def test_single_file_path(self):
        """Edit/Write tool_input returns a list with the single file_path."""
        result = hooks_edit._extract_edited_paths({"file_path": "/src/foo.py"})
        assert result == ["/src/foo.py"]

    def test_empty_tool_input(self):
        """Empty tool_input returns an empty list."""
        result = hooks_edit._extract_edited_paths({})
        assert result == []

    def test_multiedit_edits_array(self):
        """MultiEdit edits array returns all unique file paths in order."""
        result = hooks_edit._extract_edited_paths({
            "edits": [
                {"file_path": "/src/a.py", "old_string": "x", "new_string": "y"},
                {"file_path": "/src/b.py", "old_string": "a", "new_string": "b"},
            ]
        })
        assert result == ["/src/a.py", "/src/b.py"]

    def test_multiedit_deduplicates(self):
        """MultiEdit edits with duplicate file_paths returns each path once."""
        result = hooks_edit._extract_edited_paths({
            "edits": [
                {"file_path": "/src/a.py", "old_string": "x", "new_string": "y"},
                {"file_path": "/src/a.py", "old_string": "y", "new_string": "z"},
            ]
        })
        assert result == ["/src/a.py"]

    def test_multiedit_empty_edits(self):
        """MultiEdit with empty edits list returns empty list."""
        result = hooks_edit._extract_edited_paths({"edits": []})
        assert result == []

    def test_multiedit_non_dict_entries_skipped(self):
        """Non-dict entries in edits array are silently skipped."""
        result = hooks_edit._extract_edited_paths({
            "edits": ["not-a-dict", None, {"file_path": "/src/c.py"}]
        })
        assert result == ["/src/c.py"]

    def test_file_path_takes_precedence_over_edits(self):
        """When file_path is present, it takes precedence over any edits key."""
        # This mirrors Edit/Write behavior (file_path is always singular)
        result = hooks_edit._extract_edited_paths({
            "file_path": "/src/foo.py",
            "edits": [{"file_path": "/src/bar.py"}],
        })
        assert result == ["/src/foo.py"]
