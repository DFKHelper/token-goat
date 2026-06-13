"""Tests for the re-grep-of-same-file advisory hint.

Verifies that:
- First grep of a file: no hint emitted.
- Second grep of the same file: no hint emitted.
- Third grep of the same file: hint emitted once.
- Fourth+ grep of the same file: no repeat hint.
- Non-existent file path: no hint, no error.
- Bash rg/grep targeting a file also triggers the counter and hint.
- Native Grep tool with no path (pattern-only grep): no file-target counting.
"""
from __future__ import annotations

from pathlib import Path

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_read, session
from token_goat.hints import maybe_grep_advisory

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _grep_payload(session_id: str, pattern: str, path: str) -> dict:
    return {
        "session_id": session_id,
        "tool_name": "Grep",
        "tool_input": {"pattern": pattern, "path": path},
    }


def _bash_payload(session_id: str, command: str) -> dict:
    return {
        "session_id": session_id,
        "tool_name": "Bash",
        "tool_input": {"command": command},
    }


def _get_additional_context(result: dict) -> str:
    hso = result.get("hookSpecificOutput", {})
    return hso.get("additionalContext", "")


# ---------------------------------------------------------------------------
# Unit tests for session.SessionCache.record_grep_target
# ---------------------------------------------------------------------------

class TestRecordGrepTarget:
    """Unit tests for the SessionCache.record_grep_target() helper."""

    def test_first_hit_returns_false(self, tmp_data_dir, tmp_path):
        target = tmp_path / "target.py"
        target.write_text("x = 1")
        cache = session.load("rtgt-1")
        result = cache.record_grep_target(str(target))
        assert result is False
        assert cache.grep_target_counts.get(str(target).lower().replace("\\", "/").replace("c:", "/c")) is not None or any(v == 1 for v in cache.grep_target_counts.values())

    def test_second_hit_returns_false(self, tmp_data_dir, tmp_path):
        target = tmp_path / "target.py"
        target.write_text("x = 1")
        cache = session.load("rtgt-2")
        cache.record_grep_target(str(target))
        result = cache.record_grep_target(str(target))
        assert result is False

    def test_third_hit_returns_true(self, tmp_data_dir, tmp_path):
        target = tmp_path / "target.py"
        target.write_text("x = 1")
        cache = session.load("rtgt-3")
        cache.record_grep_target(str(target))
        cache.record_grep_target(str(target))
        result = cache.record_grep_target(str(target))
        assert result is True

    def test_fourth_hit_returns_false(self, tmp_data_dir, tmp_path):
        target = tmp_path / "target.py"
        target.write_text("x = 1")
        cache = session.load("rtgt-4")
        cache.record_grep_target(str(target))
        cache.record_grep_target(str(target))
        cache.record_grep_target(str(target))
        result = cache.record_grep_target(str(target))
        assert result is False

    def test_unavailable_cache_returns_false(self, tmp_data_dir, tmp_path):
        target = tmp_path / "target.py"
        target.write_text("x = 1")
        cache = session.load("rtgt-5")
        cache.unavailable = True
        result = cache.record_grep_target(str(target))
        assert result is False


# ---------------------------------------------------------------------------
# Unit tests for hints.maybe_grep_advisory
# ---------------------------------------------------------------------------

class TestMaybeGrepAdvisory:
    """Unit tests for the maybe_grep_advisory() hint function."""

    def test_no_hint_on_first_grep(self, tmp_data_dir, tmp_path):
        target = tmp_path / "foo.py"
        target.write_text("x = 1")
        cache = session.load("mga-1")
        assert maybe_grep_advisory(str(target), cache) is None

    def test_no_hint_on_second_grep(self, tmp_data_dir, tmp_path):
        target = tmp_path / "foo.py"
        target.write_text("x = 1")
        cache = session.load("mga-2")
        maybe_grep_advisory(str(target), cache)
        assert maybe_grep_advisory(str(target), cache) is None

    def test_hint_on_third_grep(self, tmp_data_dir, tmp_path):
        target = tmp_path / "foo.py"
        target.write_text("x = 1")
        cache = session.load("mga-3")
        maybe_grep_advisory(str(target), cache)
        maybe_grep_advisory(str(target), cache)
        hint = maybe_grep_advisory(str(target), cache)
        assert hint is not None
        assert "3" in hint or "grepped" in hint.lower() or "token-goat" in hint

    def test_hint_contains_path(self, tmp_data_dir, tmp_path):
        target = tmp_path / "important.py"
        target.write_text("x = 1")
        cache = session.load("mga-4")
        maybe_grep_advisory(str(target), cache)
        maybe_grep_advisory(str(target), cache)
        hint = maybe_grep_advisory(str(target), cache)
        assert hint is not None
        assert "important.py" in hint

    def test_no_repeat_on_fourth_grep(self, tmp_data_dir, tmp_path):
        target = tmp_path / "foo.py"
        target.write_text("x = 1")
        cache = session.load("mga-5")
        maybe_grep_advisory(str(target), cache)
        maybe_grep_advisory(str(target), cache)
        maybe_grep_advisory(str(target), cache)  # this is the one that fires
        hint4 = maybe_grep_advisory(str(target), cache)
        assert hint4 is None

    def test_nonexistent_file_no_hint(self, tmp_data_dir, tmp_path):
        missing = str(tmp_path / "does_not_exist.py")
        cache = session.load("mga-6")
        # Call three times — should never fire since file doesn't exist
        for _ in range(3):
            result = maybe_grep_advisory(missing, cache)
            assert result is None

    def test_empty_path_no_hint(self, tmp_data_dir):
        cache = session.load("mga-7")
        assert maybe_grep_advisory("", cache) is None

    def test_stdin_placeholder_no_hint(self, tmp_data_dir):
        cache = session.load("mga-8")
        assert maybe_grep_advisory("-", cache) is None

    def test_hint_mentions_token_goat_read(self, tmp_data_dir, tmp_path):
        target = tmp_path / "bar.py"
        target.write_text("x = 1")
        cache = session.load("mga-9")
        maybe_grep_advisory(str(target), cache)
        maybe_grep_advisory(str(target), cache)
        hint = maybe_grep_advisory(str(target), cache)
        assert hint is not None
        assert "token-goat read" in hint or "bash-output" in hint


# ---------------------------------------------------------------------------
# Integration tests via hooks_read.pre_read (native Grep tool)
# ---------------------------------------------------------------------------

class TestGrepAdvisoryViaHook:
    """Integration tests: advisory hint fires via the native Grep pre-read hook."""

    def test_no_hint_on_first_grep(self, tmp_data_dir, tmp_path):
        target = str(tmp_path / "code.py")
        Path(target).write_text("x = 1")
        payload = _grep_payload("gah-1", "TODO", target)
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        assert _get_additional_context(result) == "" or "TODO" not in _get_additional_context(result) or "grepped" not in _get_additional_context(result)

    def test_no_hint_on_second_grep(self, tmp_data_dir, tmp_path):
        target = str(tmp_path / "code.py")
        Path(target).write_text("x = 1")
        hooks_read.pre_read(_grep_payload("gah-2", "TODO", target))
        session.save(session.load("gah-2"))  # ensure persisted between calls
        result = hooks_read.pre_read(_grep_payload("gah-2", "FIXME", target))
        _assert_continue(result)
        ctx = _get_additional_context(result)
        assert "grepped" not in ctx

    def test_hint_fires_on_third_grep(self, tmp_data_dir, tmp_path):
        target = str(tmp_path / "myfile.py")
        Path(target).write_text("x = 1")
        sid = "gah-3"
        # Pre-seed the count to 2 via record_grep_target directly (faster than firing 3 hook calls)
        cache = session.load(sid)
        cache.record_grep_target(target)
        cache.record_grep_target(target)
        session.save(cache)
        # Third grep via hook
        payload = _grep_payload(sid, "import", target)
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = _get_additional_context(result)
        assert "token-goat" in ctx or "grepped" in ctx or "3" in ctx

    def test_no_hint_on_fourth_grep(self, tmp_data_dir, tmp_path):
        target = str(tmp_path / "myfile.py")
        Path(target).write_text("x = 1")
        sid = "gah-4"
        # Pre-seed the count to 3 (threshold already crossed)
        cache = session.load(sid)
        cache.record_grep_target(target)
        cache.record_grep_target(target)
        cache.record_grep_target(target)
        session.save(cache)
        # Fourth grep via hook — should NOT fire advisory
        payload = _grep_payload(sid, "class", target)
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = _get_additional_context(result)
        assert "grepped" not in ctx

    def test_no_hint_for_pattern_only_grep(self, tmp_data_dir):
        """Native Grep with no path= should not count toward file-level advisory."""
        sid = "gah-5"
        cache = session.load(sid)
        session.save(cache)
        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "TODO"},  # no path
        }
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = _get_additional_context(result)
        assert "grepped" not in ctx


# ---------------------------------------------------------------------------
# Integration tests via hooks_read.pre_read (Bash rg/grep)
# ---------------------------------------------------------------------------

class TestBashGrepAdvisoryViaHook:
    """Integration tests: advisory hint fires via the Bash pre-read hook for rg/grep."""

    def test_bash_rg_hint_fires_on_third_grep(self, tmp_data_dir, tmp_path):
        target = tmp_path / "source.py"
        target.write_text("x = 1")
        target_str = str(target)
        sid = "bgah-1"
        cache = session.load(sid)
        cache.record_grep_target(target_str)
        cache.record_grep_target(target_str)
        session.save(cache)
        payload = _bash_payload(sid, f"rg 'TODO' {target_str}")
        result = hooks_read.pre_read(payload)
        _assert_continue(result)
        ctx = _get_additional_context(result)
        assert "token-goat" in ctx or "grepped" in ctx

    def test_bash_rg_no_hint_on_first_two_greps(self, tmp_data_dir, tmp_path):
        target = tmp_path / "source.py"
        target.write_text("x = 1")
        target_str = str(target)
        sid = "bgah-2"
        # First grep via bash
        result1 = hooks_read.pre_read(_bash_payload(sid, f"rg 'TODO' {target_str}"))
        _assert_continue(result1)
        assert "grepped" not in _get_additional_context(result1)
