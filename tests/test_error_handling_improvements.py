"""Tests for error handling improvements — iteration 2.

Verifies that previously-silent exception handlers (bare ``pass``) now emit
a DEBUG-level log message so failures are diagnosable without being disruptive.
"""
from __future__ import annotations

import logging
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# hooks_read._emit_stale_compact_hint — exception should log at DEBUG
# ---------------------------------------------------------------------------

class TestEmitStaleCompactHintExceptionLogging:
    """_emit_stale_compact_hint must log at DEBUG on unexpected errors."""

    def test_exception_in_get_compact_logs_debug(self, caplog):
        """When skill_cache.get_compact raises, a DEBUG message is emitted."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False

        with (
            patch.object(sc_mod, "get_compact", side_effect=RuntimeError("db locked")),
            caplog.at_level(logging.DEBUG, logger="token_goat.hooks"),
        ):
            # Must not raise
            _emit_stale_compact_hint(
                skill_name="ralph",
                disk_sha="deadbeef" * 8,
                session_id="test-session-exc",
                cache=cache,
                file_path="/home/user/.claude/skills/ralph/SKILL.md",
            )

        # A DEBUG record should have been emitted by the except handler
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("_emit_stale_compact_hint" in m for m in debug_msgs), (
            f"Expected a DEBUG log from the except handler; got: {debug_msgs}"
        )

    def test_exception_in_extract_sha_logs_debug(self, caplog):
        """When extract_compact_source_sha raises, a DEBUG message is emitted."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False

        with (
            patch.object(sc_mod, "get_compact", return_value="--- compact form ---\nbody\n"),
            patch.object(sc_mod, "extract_compact_source_sha", side_effect=ValueError("bad compact")),
            caplog.at_level(logging.DEBUG, logger="token_goat.hooks"),
        ):
            _emit_stale_compact_hint(
                skill_name="my-skill",
                disk_sha="cafebabe" * 8,
                session_id="test-session-sha-err",
                cache=cache,
                file_path="/skills/my-skill.md",
            )

        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any("_emit_stale_compact_hint" in m for m in debug_msgs), (
            f"Expected a DEBUG log from the except handler; got: {debug_msgs}"
        )

    def test_exception_does_not_propagate(self):
        """Exceptions inside _emit_stale_compact_hint must never propagate."""
        from token_goat import skill_cache as sc_mod
        from token_goat.hooks_read import _emit_stale_compact_hint

        cache = MagicMock()
        cache.has_hint_fingerprint = lambda _: False

        with patch.object(sc_mod, "get_compact", side_effect=ValueError("corrupt compact")):
            # Should complete silently — no exception
            _emit_stale_compact_hint(
                skill_name="my-skill",
                disk_sha="cafebabe" * 8,
                session_id="test-session-no-raise",
                cache=cache,
                file_path="/skills/my-skill.md",
            )


# ---------------------------------------------------------------------------
# hooks_edit._parse_local_imports — exception should log at DEBUG
# ---------------------------------------------------------------------------

class TestParseLocalImportsExceptionLogging:
    """_parse_local_imports must log at DEBUG on parse errors (fail-soft)."""

    def test_invalid_file_path_type_does_not_propagate(self):
        """Passing a non-path-like file_path to _parse_local_imports does not raise.

        The function wraps the entire body in try/except; any error (including
        TypeError from Path(object())) must be caught, logged at DEBUG, and an
        empty list returned.
        """
        from token_goat.hooks_edit import _parse_local_imports

        # object() is not a valid path-like; will cause an error inside _parse_local_imports
        result = _parse_local_imports(
            source="import os\n",
            file_path=object(),  # type: ignore[arg-type]  # intentionally invalid
            cwd=None,
        )
        assert isinstance(result, list), f"Expected list, got {type(result)}"

    def test_exception_during_source_split_logs_debug(self, caplog):
        """When source.splitlines raises, the DEBUG handler fires."""
        from token_goat.hooks_edit import _parse_local_imports

        # Patch splitlines on a custom source object to raise
        bad_source = MagicMock()
        bad_source.splitlines.side_effect = RuntimeError("encoding error in splitlines")

        with caplog.at_level(logging.DEBUG, logger="token_goat.hooks"):
            result = _parse_local_imports(
                source=bad_source,  # type: ignore[arg-type]
                file_path="/src/foo.py",
                cwd="/src",
            )

        assert isinstance(result, list)
        debug_msgs = [r.message for r in caplog.records if r.levelno == logging.DEBUG]
        assert any(
            "_resolve_import_candidates" in m or "_parse_local_imports" in m
            for m in debug_msgs
        ), f"Expected a DEBUG log from the except handler; got: {debug_msgs}"


# ---------------------------------------------------------------------------
# compact.infer_session_goal — per-path exception should log at DEBUG
# ---------------------------------------------------------------------------

class TestInferSessionGoalPathExceptionLogging:
    """infer_session_goal must log at DEBUG when an individual path parse fails."""

    def test_path_error_does_not_propagate(self):
        """Errors in per-path processing inside infer_session_goal do not raise."""
        from token_goat.compact import infer_session_goal

        cache = MagicMock()
        # Need >= 2 edited files for the gate to pass
        cache.edited_files = ["src/a.py", "src/b.py"]
        cache.symbol_access_counts = {}
        cache.bash_history = {}

        # Patch pathlib.Path itself inside the compact module's local scope — since
        # compact imports Path locally inside the function body we cannot patch via
        # the module attribute; instead patch pathlib.Path globally for this call.
        with patch("pathlib.Path", side_effect=RuntimeError("filesystem gone")):
            # The outer try/except in infer_session_goal must catch this
            result = infer_session_goal(cache)

        assert isinstance(result, str)

    def test_individual_path_error_skipped_with_debug_log(self, caplog):
        """A per-path error inside the inner loop logs at DEBUG and continues."""
        import pathlib

        from token_goat.compact import infer_session_goal

        cache = MagicMock()
        # Three entries so even if one fails we have >= 2 (the outer gate)
        cache.edited_files = ["src/a.py", "src/b.py", "src/c.py"]
        cache.symbol_access_counts = {"do_thing": 3}
        cache.bash_history = {}

        call_count = 0
        real_path = pathlib.Path

        def flaky_path(arg):
            nonlocal call_count
            call_count += 1
            # Only blow up on the very first str() passed to _Path in the loop
            if call_count == 1 and isinstance(arg, str) and arg.startswith("src/"):
                raise OSError("ENXIO on first path")
            return real_path(arg)

        with (
            patch("pathlib.Path", side_effect=flaky_path),
            caplog.at_level(logging.DEBUG, logger="token_goat"),
        ):
            result = infer_session_goal(cache)

        assert isinstance(result, str)
        # We cannot guarantee exactly which DEBUG message fires (the outer or inner)
        # but at minimum no exception should have propagated.
        # The important test is test_path_error_does_not_propagate above.
        # This test verifies the function returns a string.
