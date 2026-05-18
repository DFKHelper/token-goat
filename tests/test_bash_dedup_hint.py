"""Integration tests: pre-Bash dedup hint via the pre_read hook."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import bash_cache, hooks_read, session


def _seed_history(session_id: str, command: str, *, output_bytes: int = 8000) -> None:
    """Helper: emulate a prior post_bash invocation to populate history."""
    big_out = "X" * output_bytes
    payload = {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "tool_response": {"stdout": big_out, "stderr": "", "exit_code": 0},
    }
    hooks_read.post_bash(payload)


class TestBashDedupHintFiresOnRepeat:
    def test_repeat_command_triggers_hint(self, tmp_data_dir):
        _seed_history("dedup-1", "pytest -v tests/")
        # Pre-read fires for the same command in the same session.
        payload = {
            "session_id": "dedup-1",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest -v tests/"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "token-goat bash-output" in ctx
        assert "pytest -v tests/" in ctx

    def test_distinct_command_no_hint(self, tmp_data_dir):
        _seed_history("dedup-2", "pytest -v tests/")
        payload = {
            "session_id": "dedup-2",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest -v src/"},  # different command
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_tiny_prior_output_no_hint(self, tmp_data_dir):
        """A small previous output is not worth deduplicating."""
        _seed_history("dedup-3", "ls", output_bytes=20)
        payload = {
            "session_id": "dedup-3",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        # No history entry was even recorded (output below cache threshold),
        # so no hint can fire.
        assert "hookSpecificOutput" not in result

    def test_old_history_entry_suppressed(self, tmp_data_dir, monkeypatch):
        """A prior run older than the stale-age threshold is suppressed."""
        from token_goat import hints

        # First simulate a normal recording.
        _seed_history("dedup-4", "make build")
        sha = bash_cache.command_hash("make build")
        entry = session.lookup_bash_entry("dedup-4", sha)
        assert entry is not None

        # Push the timestamp far into the past so the staleness check fires.
        cache = session.load("dedup-4")
        cache.bash_history[sha].ts -= hints.STALE_READ_AGE_SECONDS + 100
        session.save(cache)

        payload = {
            "session_id": "dedup-4",
            "tool_name": "Bash",
            "tool_input": {"command": "make build"},
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        # Stale entry → no dedup hint, even though command matches.
        assert "hookSpecificOutput" not in result
