"""Reliability tests for the hooks pipeline.

Covers:
1. normalize_payload — schema validation against malformed payloads
2. emit() — JSON serialization safety for non-serializable values
3. dispatch() watchdog — verify _tg_watchdog_budget_ms is present on trip
4. Concurrent update_session — CAS correctness under parallel writes
5. roll_log_if_oversized — boundary and .prev.log-already-exists behaviour
"""
from __future__ import annotations

import io
import json
import threading
import time
from datetime import datetime
from unittest.mock import patch

from token_goat import hooks_cli, paths
from token_goat.hooks_cli import denormalize_response, emit, normalize_payload
from token_goat.hooks_common import CONTINUE

# ---------------------------------------------------------------------------
# 1. normalize_payload — schema validation
# ---------------------------------------------------------------------------


class TestNormalizePayload:
    """normalize_payload must validate inbound payloads and return empty dict on bad input."""

    def test_non_dict_payload_returns_empty(self):
        result = normalize_payload(None)  # type: ignore[arg-type]
        assert result == {}

    def test_list_payload_returns_empty(self):
        result = normalize_payload(["session_id", "cwd"])  # type: ignore[arg-type]
        assert result == {}

    def test_string_payload_returns_empty(self):
        result = normalize_payload("Read")  # type: ignore[arg-type]
        assert result == {}

    def test_empty_dict_returns_empty(self):
        result = normalize_payload({})
        assert result == {}

    def test_missing_tool_name_returns_empty(self):
        """Payload without tool_name key must be rejected."""
        result = normalize_payload({"session_id": "s1", "cwd": "/tmp"})
        assert result == {}

    def test_none_tool_name_returns_empty(self):
        result = normalize_payload({"tool_name": None, "session_id": "s1"})
        assert result == {}

    def test_integer_tool_name_returns_empty(self):
        result = normalize_payload({"tool_name": 42})
        assert result == {}

    def test_whitespace_only_tool_name_returns_empty(self):
        result = normalize_payload({"tool_name": "   ", "session_id": "s1"})
        assert result == {}

    def test_empty_string_tool_name_returns_empty(self):
        result = normalize_payload({"tool_name": "", "session_id": "s1"})
        assert result == {}

    def test_valid_payload_passes_through_unchanged(self):
        """A well-formed payload must be returned as-is."""
        payload = {
            "tool_name": "Read",
            "session_id": "abc123",
            "cwd": "/projects/foo",
            "tool_input": {"file_path": "/projects/foo/main.py"},
        }
        result = normalize_payload(payload)
        assert result == payload

    def test_valid_payload_with_minimal_keys(self):
        """tool_name alone (plus any extra keys) is sufficient for a valid payload."""
        payload = {"tool_name": "Bash"}
        result = normalize_payload(payload)
        assert result == payload

    def test_codex_harness_passes_through_unchanged(self):
        """Codex harness currently shares inbound field names — no transformation applied."""
        payload = {"tool_name": "Read", "session_id": "s2", "cwd": "/projects"}
        result = normalize_payload(payload, harness="codex")
        assert result == payload

    def test_normalized_empty_payload_causes_dispatch_to_continue(self):
        """dispatch() must return continue:True even when normalize_payload returns {}."""
        # When normalize_payload rejects the payload, dispatch receives {} and
        # the handler should still return a safe CONTINUE response.
        result = hooks_cli.dispatch("session-start", {})
        assert result.get("continue") is True


# ---------------------------------------------------------------------------
# 2. emit() — JSON serialization safety for non-serializable values
# ---------------------------------------------------------------------------


class _FakeStdout:
    """Fake sys.stdout that has a writable .buffer attribute.

    sys.stdout.buffer is a C-level read-only attribute on Windows; we can't
    use patch.object on it directly.  Replace sys.stdout wholesale instead with
    a thin wrapper that delegates writes to a BytesIO buffer so emit() tests can
    capture output without spawning subprocesses.
    """

    def __init__(self) -> None:
        self.buffer = io.BytesIO()

    def write(self, s: str) -> int:  # noqa: D102 — minimal shim
        return self.buffer.write(s.encode("utf-8"))

    def flush(self) -> None:  # noqa: D102
        pass


class TestEmitSerializationSafety:
    """emit() must never raise or produce empty output when result has non-serializable values."""

    def _capture_emit(self, result: dict) -> str:
        """Replace sys.stdout with a _FakeStdout to capture emit() output."""
        fake = _FakeStdout()
        with patch("sys.stdout", fake):
            emit(result)
        return fake.buffer.getvalue().decode("utf-8")

    def test_emit_standard_dict_produces_valid_json(self):
        out = self._capture_emit({"continue": True, "_tg_elapsed_ms": 1.5})
        parsed = json.loads(out)
        assert parsed["continue"] is True

    def test_emit_with_datetime_value_falls_back_to_str(self):
        """A datetime value in the result dict must not raise TypeError."""
        dt = datetime(2026, 1, 1, 12, 0, 0)
        out = self._capture_emit({"continue": True, "_debug_ts": dt})
        parsed = json.loads(out)
        # The datetime is serialized as its str() representation.
        assert "2026" in str(parsed["_debug_ts"])

    def test_emit_with_set_value_falls_back_to_str(self):
        """A set value in the result dict must not raise TypeError."""
        out = self._capture_emit({"continue": True, "_ids": {1, 2, 3}})
        parsed = json.loads(out)
        assert parsed["continue"] is True
        # The set is coerced to string; exact representation may vary.
        assert "_ids" in parsed

    def test_emit_with_bytes_value_falls_back_to_str(self):
        """A bytes value in the result dict must not raise TypeError."""
        out = self._capture_emit({"continue": True, "_raw": b"\xff\xfe"})
        parsed = json.loads(out)
        assert parsed["continue"] is True
        assert "_raw" in parsed

    def test_emit_with_nested_non_serializable_falls_back_gracefully(self):
        """Nested non-serializable values (in hookSpecificOutput) must not crash emit."""
        result = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "_extra": datetime.now(),
            },
        }
        out = self._capture_emit(result)
        parsed = json.loads(out)
        assert parsed["continue"] is True
        assert parsed["hookSpecificOutput"]["hookEventName"] == "PreToolUse"

    def test_emit_always_writes_continue_true_even_after_fallback(self):
        """After the fallback to default=str, the continue key must be present and True."""
        out = self._capture_emit({"continue": True, "bad": {1, 2}})
        parsed = json.loads(out)
        assert parsed.get("continue") is True


# ---------------------------------------------------------------------------
# 3. dispatch() watchdog — budget metadata on trip
# ---------------------------------------------------------------------------


class TestWatchdogMetadata:
    """dispatch() must attach budget metadata when the watchdog trips."""

    def test_watchdog_trip_includes_budget_ms_key(self, monkeypatch):
        """_tg_watchdog_budget_ms must be present in the watchdog-trip response."""
        import token_goat.hooks_cli as _cli

        budget_ms = 80
        monkeypatch.setattr(_cli, "_HOOK_WATCHDOG_MS", budget_ms)

        # Install a handler that blocks longer than the budget.
        def _hang(payload):
            threading.Event().wait(5)
            return CONTINUE()

        with patch.dict(_cli.EVENTS, {"session-start": _hang}):
            result = _cli.dispatch("session-start", {"session_id": "watchdog-meta"})

        assert result.get("_tg_watchdog_tripped") is True
        assert "_tg_watchdog_budget_ms" in result, (
            f"_tg_watchdog_budget_ms missing from watchdog result: {result!r}"
        )
        assert result["_tg_watchdog_budget_ms"] == budget_ms

    def test_watchdog_trip_preserves_continue_true(self, monkeypatch):
        """A watchdog-trip response must still carry continue:True."""
        import token_goat.hooks_cli as _cli

        monkeypatch.setattr(_cli, "_HOOK_WATCHDOG_MS", 60)

        def _hang(payload):
            threading.Event().wait(5)
            return CONTINUE()

        with patch.dict(_cli.EVENTS, {"session-start": _hang}):
            result = _cli.dispatch("session-start", {"session_id": "watchdog-cont"})

        assert result.get("continue") is True

    def test_watchdog_trip_returns_within_budget_plus_grace(self, monkeypatch):
        """dispatch() must return within budget_ms + 300ms grace (not block indefinitely)."""
        import token_goat.hooks_cli as _cli

        budget_ms = 80
        monkeypatch.setattr(_cli, "_HOOK_WATCHDOG_MS", budget_ms)

        def _hang(payload):
            threading.Event().wait(10)
            return CONTINUE()

        with patch.dict(_cli.EVENTS, {"session-start": _hang}):
            t0 = time.monotonic()
            _cli.dispatch("session-start", {"session_id": "watchdog-time"})
            elapsed_ms = (time.monotonic() - t0) * 1000

        assert elapsed_ms < budget_ms + 300, (
            f"dispatch took {elapsed_ms:.0f}ms, expected < {budget_ms + 300}ms"
        )


# ---------------------------------------------------------------------------
# 4. Concurrent update_session — CAS correctness
# ---------------------------------------------------------------------------


class TestConcurrentSessionUpdate:
    """update_session() must not lose mutations under concurrent access."""

    def test_two_threads_both_edits_committed(self, tmp_data_dir):
        """Two threads calling update_session on the same session must both commit."""
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "cas-test-concurrent"
        # Create the initial session.
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)

        barrier = threading.Barrier(2)
        errors: list[str] = []

        def add_edit(path: str) -> None:
            try:
                barrier.wait()  # both threads start simultaneously

                def mutate(cache: session.SessionCache) -> None:
                    cache.edited_files[path] = cache.edited_files.get(path, 0) + 1

                update_session(sid, mutate)
            except Exception as exc:
                errors.append(str(exc))

        t1 = threading.Thread(target=add_edit, args=("/file_a.py",))
        t2 = threading.Thread(target=add_edit, args=("/file_b.py",))
        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert not errors, f"Threads raised: {errors}"

        # Both files must be present in the final session.
        final = session.load(sid)
        assert final is not None, "Session not found after concurrent writes"
        assert "/file_a.py" in final.edited_files, (
            f"file_a.py missing from edited_files: {dict(final.edited_files)}"
        )
        assert "/file_b.py" in final.edited_files, (
            f"file_b.py missing from edited_files: {dict(final.edited_files)}"
        )

    def test_ten_threads_hints_seen_not_lost(self, tmp_data_dir):
        """Ten threads each marking a unique hint fingerprint must all survive."""
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "cas-test-hints-10"
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)

        barrier = threading.Barrier(10)
        errors: list[str] = []

        def mark_fp(fp: str) -> None:
            try:
                barrier.wait()

                def mutate(cache: session.SessionCache) -> None:
                    cache.mark_hint_seen(fp)

                update_session(sid, mutate)
            except Exception as exc:
                errors.append(str(exc))

        threads = [
            threading.Thread(target=mark_fp, args=(f"fp-{i}",))
            for i in range(10)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=15)

        assert not errors, f"Threads raised: {errors}"

        final = session.load(sid)
        assert final is not None
        # All 10 fingerprints must be present after concurrent CAS merges.
        missing = [f"fp-{i}" for i in range(10) if f"fp-{i}" not in final.hints_seen]
        assert not missing, f"Fingerprints lost in concurrent merge: {missing}"

    def test_update_session_mutation_fn_exception_returns_false(self, tmp_data_dir):
        """update_session must return False (not raise) when the mutation fn raises."""
        from token_goat import session
        from token_goat.hooks_common import update_session

        sid = "cas-test-fn-exc"
        initial = session.SessionCache(
            session_id=sid,
            started_ts=time.time(),
            last_activity_ts=time.time(),
        )
        session.save(initial)

        def bad_mutate(cache: session.SessionCache) -> None:
            raise RuntimeError("intentional mutation failure")

        result = update_session(sid, bad_mutate)
        assert result is False

    def test_update_session_invalid_session_id_returns_false(self, tmp_data_dir):
        """update_session must return False when session_id is invalid (raises ValueError).

        session.load() creates a fresh cache for non-existent sessions.  The
        only way to get None from load_session_safe is an invalid session_id
        (path traversal, empty string, etc.) that causes validate_session_id
        to raise ValueError — which load_session_safe catches and converts to None.
        """
        from token_goat.hooks_common import update_session

        called = []

        def mutate(cache) -> None:
            called.append(True)

        # An invalid session_id (path traversal) raises ValueError → load returns None → False
        result = update_session("../evil/traversal", mutate)
        assert result is False
        assert not called, "Mutation function must not be called for invalid session_id"


# ---------------------------------------------------------------------------
# 5. roll_log_if_oversized — boundary behaviour and .prev.log overwrite
# ---------------------------------------------------------------------------


class TestRollLogIfOversized:
    """roll_log_if_oversized must handle boundary sizes and existing .prev.log files."""

    def test_file_under_limit_not_rolled(self, tmp_path):
        """A file smaller than max_bytes must not be renamed."""
        log = tmp_path / "test.log"
        log.write_text("short content", encoding="utf-8")
        max_bytes = 1000
        paths.roll_log_if_oversized(log, max_bytes)
        assert log.exists(), "Log file must not be renamed when under the limit"
        assert not (tmp_path / "test.prev.log").exists()

    def test_file_exactly_at_limit_not_rolled(self, tmp_path):
        """A file whose size equals max_bytes exactly must not be rolled (> threshold)."""
        log = tmp_path / "test.log"
        content = "x" * 100
        log.write_bytes(content.encode("utf-8"))
        paths.roll_log_if_oversized(log, len(content))
        # size == max_bytes → condition is size <= max_bytes → no roll
        assert log.exists(), "File at exact limit must not be rolled"

    def test_file_one_byte_over_limit_is_rolled(self, tmp_path):
        """A file one byte over max_bytes must be renamed to .prev.log."""
        log = tmp_path / "test.log"
        content = "x" * 101
        log.write_bytes(content.encode("utf-8"))
        paths.roll_log_if_oversized(log, 100)
        prev = tmp_path / "test.prev.log"
        assert prev.exists(), ".prev.log must be created when file exceeds limit"
        # Original file must be gone (os.replace moves it).
        assert not log.exists(), "Original log must not exist after rolling"

    def test_existing_prev_log_is_overwritten(self, tmp_path):
        """When .prev.log already exists, os.replace must overwrite it without error."""
        log = tmp_path / "test.log"
        prev = tmp_path / "test.prev.log"
        log.write_bytes(b"x" * 200)
        prev.write_text("stale previous content", encoding="utf-8")
        # Must not raise even though .prev.log already exists.
        paths.roll_log_if_oversized(log, 100)
        assert prev.exists()
        # The previous .prev.log content should now be replaced by the rolled log.
        assert prev.read_bytes() == b"x" * 200, "Rolled content must replace stale .prev.log"

    def test_missing_log_file_is_a_noop(self, tmp_path):
        """roll_log_if_oversized must be a no-op when the log file does not exist."""
        log = tmp_path / "nonexistent.log"
        # Should not raise.
        paths.roll_log_if_oversized(log, 1000)
        assert not log.exists()

    def test_roll_preserves_full_file_content(self, tmp_path):
        """The rolled .prev.log must contain exactly the bytes of the original log."""
        log = tmp_path / "hooks.log"
        data = b"line1\nline2\nlast line\n"
        log.write_bytes(data)
        paths.roll_log_if_oversized(log, len(data) - 1)
        prev = tmp_path / "hooks.prev.log"
        assert prev.read_bytes() == data, "Rolled file content must match original"

    def test_hooks_stderr_log_rolls_when_oversized(self, tmp_path, monkeypatch):
        """hooks-stderr.log must roll correctly using HOOKS_STDERR_LOG_MAX_BYTES as the cap."""
        fake_log = tmp_path / "hooks-stderr.log"
        # Write content larger than the cap.
        fake_log.write_bytes(b"x" * (paths.HOOKS_STDERR_LOG_MAX_BYTES + 1))
        paths.roll_log_if_oversized(fake_log, paths.HOOKS_STDERR_LOG_MAX_BYTES)
        prev = tmp_path / "hooks-stderr.prev.log"
        assert prev.exists(), ".prev.log must be created for hooks-stderr.log overflow"
        assert not fake_log.exists()


# ---------------------------------------------------------------------------
# 6. get_tool_input — degenerate payload safety
# ---------------------------------------------------------------------------


class TestGetToolInput:
    """get_tool_input must return {} for all degenerate payload shapes."""

    def test_none_payload_returns_empty(self):
        from token_goat.hooks_common import get_tool_input
        assert get_tool_input(None) == {}

    def test_missing_tool_input_key_returns_empty(self):
        from token_goat.hooks_common import get_tool_input
        assert get_tool_input({"tool_name": "Read"}) == {}

    def test_none_tool_input_returns_empty(self):
        from token_goat.hooks_common import get_tool_input
        assert get_tool_input({"tool_name": "Read", "tool_input": None}) == {}

    def test_list_tool_input_returns_empty(self):
        from token_goat.hooks_common import get_tool_input
        assert get_tool_input({"tool_name": "Read", "tool_input": [1, 2, 3]}) == {}

    def test_valid_tool_input_returned_as_is(self):
        from token_goat.hooks_common import get_tool_input
        ti = {"file_path": "/foo/bar.py", "limit": 100}
        assert get_tool_input({"tool_name": "Read", "tool_input": ti}) == ti


# ---------------------------------------------------------------------------
# 7. denormalize_response — non-dict hookSpecificOutput is left unchanged
# ---------------------------------------------------------------------------


class TestDenormalizeResponse:
    """denormalize_response must tolerate missing or non-dict hookSpecificOutput."""

    def test_no_hso_key_returned_unchanged(self):
        resp = {"continue": True}
        assert denormalize_response(resp, harness="codex") == resp

    def test_hso_none_returned_unchanged(self):
        resp = {"continue": True, "hookSpecificOutput": None}
        result = denormalize_response(resp, harness="codex")
        assert result["hookSpecificOutput"] is None

    def test_claude_harness_not_translated(self):
        """Claude harness (default) must be returned as-is, no key renaming."""
        resp = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": "hint",
            },
        }
        result = denormalize_response(resp, harness="claude")
        assert result["hookSpecificOutput"]["additionalContext"] == "hint"

    def test_codex_harness_translates_camel_to_snake(self):
        """Codex harness must translate additionalContext → additional_context."""
        resp = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "additionalContext": "you already read this file",
            },
        }
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert "additional_context" in hso, f"Expected snake_case key, got: {hso}"
        assert "additionalContext" not in hso

    def test_codex_harness_translates_nested_updated_input(self):
        """updatedInput nested inside hookSpecificOutput must also be translated."""
        resp = {
            "continue": True,
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {"file_path": "/shrunken.jpg"},
                "additionalContext": "shrunk",
            },
        }
        result = denormalize_response(resp, harness="codex")
        hso = result["hookSpecificOutput"]
        assert "updated_input" in hso
        assert "updatedInput" not in hso
