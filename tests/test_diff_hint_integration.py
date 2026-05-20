"""End-to-end: post_read snapshots, post_edit invalidates, pre_read emits diff."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_edit, hooks_read, session


class TestDiffHintEndToEnd:
    def test_read_then_edit_then_reread_emits_diff(self, tmp_data_dir, tmp_path):
        """A read followed by an edit and a re-read should yield a diff hint."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        # Generously large file so the saving easily clears the min threshold.
        body = "".join(f"def fn_{i}():\n    return {i}\n" for i in range(200))
        original = "VERSION = 1\n" + body
        src.write_text(original, encoding="utf-8")

        sid = "diff-e2e-1"

        # 1. Read — populates snapshot.
        _assert_continue(hooks_read.post_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
        }))

        # 2. Edit — bumps last_edit_ts so the pre_read invalidates the dedup hint.
        src.write_text("VERSION = 2\n" + body, encoding="utf-8")
        _assert_continue(hooks_edit.post_edit({
            "session_id": sid,
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        }))

        # 3. Re-read — should produce a diff-based hint.
        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src)},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "```diff" in ctx
        assert "VERSION = 1" in ctx
        assert "VERSION = 2" in ctx

    def test_no_snapshot_falls_back_to_session_hint(self, tmp_data_dir, tmp_path):
        """When no snapshot exists, pre_read uses the regular cache hint path."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        src.write_text("x = 1\n", encoding="utf-8")

        sid = "diff-e2e-2"
        # Mark file as already read (line range) but skip the snapshot step.
        session.mark_file_read(sid, str(src), offset=0, limit=200)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(src), "offset": 0, "limit": 200},
            "cwd": str(tmp_path),
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        # The standard cache hint mentions "cached" / "already read" — distinct from
        # the diff hint's "edited in this session" wording.
        assert "cached" in ctx or "already read" in ctx or "previously read" in ctx
        assert "```diff" not in ctx
