"""Tests for the post-compaction recovery hint path in session_start."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_session, session


def _seed_state(sid: str) -> None:
    """Populate a session with a mix of files, bash, and web history."""
    session.mark_file_read(sid, "/proj/src/auth.py", offset=0, limit=200)
    session.mark_file_edited(sid, "/proj/src/auth.py")
    session.mark_bash_run(
        session_id=sid,
        cmd_sha="abc123def4567890",
        cmd_preview="pytest -v tests/",
        output_id=f"{sid[:16]}-0000000000001-abc123def4567890",
        stdout_bytes=8000,
        stderr_bytes=0,
        exit_code=0,
        truncated=False,
    )
    session.mark_web_fetch(
        session_id=sid,
        url_sha="dead00beefca0fe1",
        url_preview="https://docs.example/api",
        output_id=f"{sid[:16]}-0000000000002-dead00beefca0fe1",
        body_bytes=12000,
        status_code=200,
        truncated=False,
    )


class TestSourceDetection:
    def test_compact_source_preserves_cache(self, tmp_data_dir):
        sid = "rec-1"
        _seed_state(sid)
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        }))
        # Cache survives the compact-source SessionStart.
        cache = session.load(sid)
        assert cache.files, "files were wiped despite source=compact"
        assert cache.bash_history, "bash_history was wiped despite source=compact"

    def test_clear_source_resets_cache(self, tmp_data_dir):
        sid = "rec-2"
        _seed_state(sid)
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "source": "clear",
            "cwd": "/proj",
        }))
        cache = session.load(sid)
        assert not cache.files
        assert not cache.bash_history

    def test_missing_source_treated_as_startup(self, tmp_data_dir):
        sid = "rec-3"
        _seed_state(sid)
        # No source field — should reset (default behaviour).
        _assert_continue(hooks_session.session_start({
            "session_id": sid,
            "cwd": "/proj",
        }))
        cache = session.load(sid)
        assert not cache.files


class TestRecoveryHintContent:
    def test_emits_files_bash_web_sections(self, tmp_data_dir):
        sid = "rec-4"
        _seed_state(sid)
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
            "cwd": "/proj",
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "Post-Compact Recovery" in ctx
        assert "/proj/src/auth.py" in ctx
        assert "pytest -v tests/" in ctx
        assert "https://docs.example/api" in ctx
        # The hint references the retrieval commands so the agent has
        # something actionable, not just an inventory.
        assert "token-goat bash-output" in ctx
        assert "token-goat web-output" in ctx

    def test_empty_session_no_hint(self, tmp_data_dir):
        """A compact on a session with no recorded state emits no hint."""
        result = hooks_session.session_start({
            "session_id": "rec-5",
            "source": "compact",
        })
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_tiny_outputs_filtered(self, tmp_data_dir):
        """Bash / web entries below the recovery min-bytes floor are skipped."""
        sid = "rec-6"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="111",
            cmd_preview="ls",
            output_id="rec-6-x-111",
            stdout_bytes=50,  # tiny
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        result = hooks_session.session_start({
            "session_id": sid,
            "source": "compact",
        })
        _assert_continue(result)
        # No file activity, only one tiny bash entry → no hint emitted.
        assert "hookSpecificOutput" not in result
