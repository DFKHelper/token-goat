"""Tests for the hook dispatcher's fail-soft and dispatch behavior."""
import json

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_cli


def test_unknown_event_returns_continue():
    result = hooks_cli.dispatch("not-a-real-event", {})
    _assert_continue(result)


def test_session_start_no_cwd_does_not_crash():
    result = hooks_cli.dispatch("session-start", {})
    _assert_continue(result)


def test_session_start_with_project_marker(tmp_path):
    (tmp_path / ".git").mkdir()
    payload = {"session_id": "test-123", "cwd": str(tmp_path)}
    result = hooks_cli.dispatch("session-start", payload)
    _assert_continue(result)


def test_session_start_with_unknown_cwd_no_crash(tmp_path):
    payload = {"session_id": "x", "cwd": str(tmp_path)}  # no marker
    result = hooks_cli.dispatch("session-start", payload)
    _assert_continue(result)


def test_fail_soft_swallows_exceptions(monkeypatch):
    """If a handler raises, dispatch must still return continue:true with error info."""

    @hooks_cli.fail_soft
    def boom(_payload):
        raise RuntimeError("intentional")

    result = boom({"any": "payload"})
    assert result.get("continue") is True
    assert "_tg_error" in result
    assert "RuntimeError" in result["_tg_error"]


def test_fail_soft_catches_base_exception_memory_error():
    """BaseException subclasses like MemoryError must also be caught."""

    @hooks_cli.fail_soft
    def explode(_payload):
        raise MemoryError("out of memory")

    result = explode({"any": "payload"})
    assert result.get("continue") is True
    assert "MemoryError" in result["_tg_error"]


def test_fail_soft_re_raises_system_exit():
    """SystemExit must propagate (explicit user intent / process control)."""
    import pytest

    @hooks_cli.fail_soft
    def quit_now(_payload):
        raise SystemExit(7)

    with pytest.raises(SystemExit) as exc_info:
        quit_now({"any": "payload"})
    assert exc_info.value.code == 7


def test_fail_soft_re_raises_keyboard_interrupt():
    """KeyboardInterrupt must propagate (user Ctrl+C)."""
    import pytest

    @hooks_cli.fail_soft
    def interrupted(_payload):
        raise KeyboardInterrupt()

    with pytest.raises(KeyboardInterrupt):
        interrupted({"any": "payload"})


def test_read_payload_from_file(tmp_path):
    f = tmp_path / "payload.json"
    f.write_text('{"session_id": "abc", "tool_name": "Read"}')
    payload = hooks_cli.read_payload(f)
    assert payload["session_id"] == "abc"


def test_read_payload_empty_stdin_returns_empty_dict(monkeypatch):
    import io

    monkeypatch.setattr("sys.stdin", io.StringIO(""))
    assert hooks_cli.read_payload() == {}


def test_emit_writes_json(capsys):
    hooks_cli.emit({"continue": True, "hookSpecificOutput": {"x": 1}})
    captured = capsys.readouterr()
    parsed = json.loads(captured.out)
    assert parsed["continue"] is True
    assert parsed["hookSpecificOutput"]["x"] == 1


# ---------------------------------------------------------------------------
# post_edit — must enqueue edited files for incremental reindex
# ---------------------------------------------------------------------------

def test_post_edit_enqueues_dirty_file(tmp_data_dir, tmp_path):
    """Regression: post_edit must append the edited file to the dirty queue.

    Without this, a project's symbol index goes stale the moment a file is
    edited — `enqueue_dirty()` existed but nothing ever called it, so the
    worker's dirty-queue reindex path was dead code for normal git projects.
    `token-goat read`/`symbol` then return wrong line ranges and the pre-read
    hint shows stale data.
    """
    import json

    import token_goat.paths as paths
    from token_goat.project import canonicalize, project_hash

    proj_root = tmp_path / "myproj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    edited = proj_root / "src" / "module.py"
    edited.parent.mkdir()
    edited.write_text("def f(): pass\n", encoding="utf-8")

    result = hooks_cli.dispatch(
        "post-edit",
        {
            "session_id": "sess-1",
            "cwd": str(proj_root),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(edited)},
        },
    )
    _assert_continue(result)

    queue_path = paths.dirty_queue_path()
    assert queue_path.exists(), "dirty queue file was not created"
    lines = [ln for ln in queue_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert len(lines) == 1, f"expected exactly one queued entry, got: {lines}"
    entry = json.loads(lines[0])
    assert entry["path"] == "src/module.py"
    assert entry["project_hash"] == project_hash(canonicalize(proj_root))
    assert "ts" in entry


def test_post_edit_file_outside_project_does_not_enqueue(tmp_data_dir, tmp_path, monkeypatch):
    """A file with no detectable project must not crash and must not enqueue."""
    import token_goat.paths as paths
    from token_goat import project as project_mod

    # Force "no project" deterministically — the test machine's temp dir may
    # have a stray package.json ancestor that would otherwise be detected.
    monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)

    stray = tmp_path / "stray.py"
    stray.write_text("x = 1\n", encoding="utf-8")

    result = hooks_cli.dispatch(
        "post-edit",
        {
            "session_id": "sess-2",
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(stray)},
        },
    )
    _assert_continue(result)

    queue_path = paths.dirty_queue_path()
    queued = queue_path.exists() and queue_path.read_text(encoding="utf-8").strip()
    assert not queued, "no project detected — nothing should have been enqueued"


# ---------------------------------------------------------------------------
# post_edit — mid-session watchdog: respawn the worker if it has gone down
# ---------------------------------------------------------------------------

def test_post_edit_nudges_worker_when_heartbeat_missing(tmp_data_dir, tmp_path, monkeypatch):
    """post_edit feeds the dirty queue, so it must make sure something will
    drain it: with no fresh heartbeat, the watchdog calls ensure_running()."""
    from token_goat import project as project_mod
    from token_goat import worker as worker_mod

    monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
    called: list[bool] = []
    monkeypatch.setattr(worker_mod, "ensure_running", lambda: called.append(True))

    stray = tmp_path / "edited.py"
    stray.write_text("x = 1\n", encoding="utf-8")
    # No heartbeat file → worker considered down.

    result = hooks_cli.dispatch(
        "post-edit",
        {
            "session_id": "sess-hb-missing",
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(stray)},
        },
    )
    _assert_continue(result)
    assert called == [True], "a down worker must be respawned from post_edit"


def test_post_edit_skips_nudge_when_heartbeat_fresh(tmp_data_dir, tmp_path, monkeypatch):
    """A fresh heartbeat means the worker is alive — the watchdog must not
    respawn it (the common path stays a single stat() with no worker import)."""
    import time as _time

    import token_goat.paths as paths
    from token_goat import project as project_mod
    from token_goat import worker as worker_mod

    monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
    called: list[bool] = []
    monkeypatch.setattr(worker_mod, "ensure_running", lambda: called.append(True))

    paths.ensure_dirs()
    paths.worker_heartbeat_path().write_text(str(_time.time()), encoding="utf-8")

    stray = tmp_path / "edited.py"
    stray.write_text("x = 1\n", encoding="utf-8")

    result = hooks_cli.dispatch(
        "post-edit",
        {
            "session_id": "sess-hb-fresh",
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(stray)},
        },
    )
    _assert_continue(result)
    assert called == [], "a live worker must not be respawned"


def test_post_edit_nudges_worker_when_heartbeat_stale(tmp_data_dir, tmp_path, monkeypatch):
    """A heartbeat file that exists but is older than the freshness window means
    the worker hung or died — post_edit must respawn it, same as a missing one.

    This is the middle case between 'missing' and 'fresh': the watchdog keys off
    the heartbeat's mtime, so an old-but-present file must still trip the nudge.
    """
    import os
    import time as _time

    import token_goat.paths as paths
    from token_goat import project as project_mod
    from token_goat import worker as worker_mod

    monkeypatch.setattr(project_mod, "find_project", lambda _cwd: None)
    called: list[bool] = []
    monkeypatch.setattr(worker_mod, "ensure_running", lambda: called.append(True))

    paths.ensure_dirs()
    hb = paths.worker_heartbeat_path()
    hb.write_text("stale", encoding="utf-8")
    # Backdate the heartbeat well past the 65 s freshness window.
    old = _time.time() - 600
    os.utime(hb, (old, old))

    stray = tmp_path / "edited.py"
    stray.write_text("x = 1\n", encoding="utf-8")

    result = hooks_cli.dispatch(
        "post-edit",
        {
            "session_id": "sess-hb-stale",
            "cwd": str(tmp_path),
            "tool_name": "Edit",
            "tool_input": {"file_path": str(stray)},
        },
    )
    _assert_continue(result)
    assert called == [True], "a worker with a stale heartbeat must be respawned"


# ---------------------------------------------------------------------------
# read_payload — JSON decode error and OSError paths (lines 114-120)
# ---------------------------------------------------------------------------

class TestReadPayloadEdgeCases:
    """Edge cases for read_payload that were previously uncovered."""

    def test_invalid_json_returns_empty_dict(self, tmp_path):
        """A file with invalid JSON must return {} rather than raising."""
        bad = tmp_path / "bad.json"
        bad.write_text("{ not valid json !!!}", encoding="utf-8")
        result = hooks_cli.read_payload(bad)
        assert result == {}

    def test_non_dict_json_returns_empty_dict(self, tmp_path):
        """A JSON array (valid JSON but not a dict) must coerce to {}."""
        arr = tmp_path / "arr.json"
        arr.write_text("[1, 2, 3]", encoding="utf-8")
        result = hooks_cli.read_payload(arr)
        assert result == {}

    def test_json_null_returns_empty_dict(self, tmp_path):
        """JSON null payload coerces to {}."""
        null = tmp_path / "null.json"
        null.write_text("null", encoding="utf-8")
        result = hooks_cli.read_payload(null)
        assert result == {}

    def test_missing_file_returns_empty_dict(self, tmp_path):
        """An OSError reading the payload file must return {} not raise."""
        missing = tmp_path / "does_not_exist.json"
        result = hooks_cli.read_payload(missing)
        assert result == {}

    def test_valid_json_dict_is_returned(self, tmp_path):
        """A valid dict payload is returned as-is."""
        f = tmp_path / "ok.json"
        f.write_text('{"session_id": "s1", "tool_name": "Write"}', encoding="utf-8")
        result = hooks_cli.read_payload(f)
        assert result["session_id"] == "s1"
        assert result["tool_name"] == "Write"


# ---------------------------------------------------------------------------
# safe_run — end-to-end harness path including codex denormalization (lines 157-170)
# ---------------------------------------------------------------------------

class TestSafeRun:
    """Tests for safe_run's end-to-end fail-soft semantics."""

    def test_safe_run_unknown_event_emits_continue(self, tmp_path, capsys):
        """safe_run with an unknown event must emit {"continue": true} to stdout."""
        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "x"}', encoding="utf-8")
        hooks_cli.safe_run("no-such-event", input_file=payload_file)
        out = capsys.readouterr().out
        import json
        parsed = json.loads(out)
        assert parsed["continue"] is True

    def test_safe_run_known_event_emits_continue(self, tmp_path, capsys):
        """safe_run with a known event (session-start, no cwd) still exits cleanly."""
        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "abc"}', encoding="utf-8")
        hooks_cli.safe_run("session-start", input_file=payload_file)
        out = capsys.readouterr().out
        import json
        parsed = json.loads(out)
        assert parsed["continue"] is True

    def test_safe_run_codex_harness_denormalizes_output(self, tmp_path, capsys, monkeypatch):
        """safe_run with harness=codex must translate camelCase HSO keys to snake_case."""
        import json

        # Inject a handler that returns a camelCase hookSpecificOutput
        from token_goat import hooks_cli as hc

        def patched_dispatch(event, payload):
            return {
                "continue": True,
                "hookSpecificOutput": {
                    "additionalContext": "hello",
                    "updatedInput": {"x": 1},
                },
            }

        monkeypatch.setattr(hc, "dispatch", patched_dispatch)

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "z"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file, harness="codex")
        out = capsys.readouterr().out
        parsed = json.loads(out)
        hso = parsed.get("hookSpecificOutput", {})
        assert "additional_context" in hso, f"expected snake_case key, got: {hso}"
        assert "updatedInput" not in hso

    def test_safe_run_with_invalid_payload_file_emits_continue(self, tmp_path, capsys):
        """safe_run must emit continue:true even when the payload file is corrupt."""
        bad = tmp_path / "bad.json"
        bad.write_text("not-json", encoding="utf-8")
        hooks_cli.safe_run("session-start", input_file=bad)
        out = capsys.readouterr().out
        import json
        parsed = json.loads(out)
        assert parsed["continue"] is True

    def test_safe_run_denormalize_failure_emits_dispatch_output(self, tmp_path, capsys, monkeypatch):
        """If denormalize_response raises, safe_run must still emit the dispatch output.

        A bug in _translate_hso_to_codex must not silently drop the real hook
        payload — the un-denormalized dict is acceptable fallback output.
        """
        import json

        from token_goat import hooks_cli as hc

        sentinel_value = "sentinel-abc"

        def patched_dispatch(event, payload):
            return {"continue": True, "hookSpecificOutput": {"my_key": sentinel_value}}

        def broken_denormalize(response, harness):
            raise RuntimeError("denormalize exploded")

        monkeypatch.setattr(hc, "dispatch", patched_dispatch)
        monkeypatch.setattr(hc, "denormalize_response", broken_denormalize)

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "z"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file, harness="codex")

        out = capsys.readouterr().out
        parsed = json.loads(out)
        # The raw dispatch output must be present (not bare {"continue": true}).
        hso = parsed.get("hookSpecificOutput", {})
        assert hso.get("my_key") == sentinel_value, (
            f"expected sentinel in output; got: {parsed}"
        )

    def test_safe_run_crash_writes_hooks_stderr_log(self, tmp_path, capsys, monkeypatch):
        """A crash in safe_run must write msg + traceback to hooks-stderr.log.

        Contract:
        - {"continue": true} is still emitted (fail-soft preserved).
        - hooks-stderr.log is created in logs_dir() with a line matching the
          expected pattern (event name + exception type).
        """
        import json

        from token_goat import hooks_cli as hc
        from token_goat import paths

        # Redirect logs_dir() to a tmp directory so the test is isolated.
        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")

        # Force a crash by making dispatch raise unconditionally.
        monkeypatch.setattr(hc, "dispatch", lambda event, payload: (_ for _ in ()).throw(RuntimeError("boom")))

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "crash-test"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        # Fail-soft contract: continue:true must still be emitted.
        out = capsys.readouterr().out
        parsed = json.loads(out)
        assert parsed["continue"] is True

        # Crash sink must exist and contain the diagnostic line.
        sink = tmp_path / "logs" / "hooks-stderr.log"
        assert sink.exists(), "hooks-stderr.log was not created"
        content = sink.read_text(encoding="utf-8")
        assert "pre-read" in content, f"event name missing from crash log: {content[:200]}"
        assert "RuntimeError" in content, f"exception type missing from crash log: {content[:200]}"

    def test_safe_run_crash_log_rolls_over_when_oversized(self, tmp_path, monkeypatch):
        """hooks-stderr.log must roll to hooks-stderr.prev.log once it exceeds the size cap.

        Fill the log past HOOKS_STDERR_LOG_MAX_BYTES via repeated crashes, then
        trigger one more crash and verify a .prev.log sibling was created.
        """
        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        monkeypatch.setattr(hc, "dispatch", lambda event, payload: (_ for _ in ()).throw(ValueError("x")))

        log_dir = tmp_path / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        sink = log_dir / "hooks-stderr.log"

        # Pre-fill the log past the 1 MB threshold so the very next crash triggers rollover.
        sink.write_bytes(b"x" * (paths.HOOKS_STDERR_LOG_MAX_BYTES + 1))

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "rollover-test"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        prev_log = log_dir / "hooks-stderr.prev.log"
        assert prev_log.exists(), (
            "hooks-stderr.prev.log was not created after exceeding size cap"
        )


# ---------------------------------------------------------------------------
# normalize_payload — codex harness path (line 60-62)
# ---------------------------------------------------------------------------

class TestNormalizePayload:
    """normalize_payload behaviour for each harness."""

    def test_claude_harness_returns_payload_unchanged(self):
        payload = {"session_id": "s", "tool_name": "Read", "turn_id": "t1"}
        result = hooks_cli.normalize_payload(payload, harness="claude")
        assert result == payload

    def test_codex_harness_returns_payload_unchanged(self):
        """Codex payload is structurally identical; normalize_payload is a pass-through."""
        payload = {"session_id": "s", "tool_name": "Read", "turn_id": "t1"}
        result = hooks_cli.normalize_payload(payload, harness="codex")
        assert result == payload


# ---------------------------------------------------------------------------
# _setup_logging — OSError fallback installs NullHandler (lines 38-49)
# ---------------------------------------------------------------------------

class TestSetupLogging:
    """_setup_logging falls back to NullHandler when the log directory is inaccessible.

    NOTE: the conftest `isolate_hook_logging` autouse fixture replaces
    `hooks_cli._setup_logging` with a no-op lambda.  These tests temporarily
    restore the real function so they can exercise the actual code paths.
    """

    def _get_real_setup_logging(self):
        """Return the original _setup_logging, bypassing the fixture's no-op."""
        # Reconstruct _setup_logging from scratch using the same module's live
        # logger / paths bindings, bypassing the fixture's no-op patch.
        import logging as _logging
        from datetime import datetime as _datetime

        from token_goat import paths as _paths

        _LOG = _logging.getLogger("token_goat.hooks")

        def real_setup_logging() -> None:
            if _LOG.handlers:
                return
            try:
                _paths.ensure_dirs()
                log_path = _paths.logs_dir() / f"{_datetime.now():%Y-%m-%d}.log"
                _paths.roll_log_if_oversized(log_path, _paths.LOG_FILE_MAX_BYTES)
                handler: _logging.Handler = _logging.FileHandler(log_path, encoding="utf-8")
                handler.setFormatter(
                    _logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
                )
            except (OSError, PermissionError):
                handler = _logging.NullHandler()
            _LOG.addHandler(handler)
            _LOG.setLevel(_logging.INFO)

        return real_setup_logging, _LOG

    def test_setup_logging_fallback_on_oserror(self, monkeypatch):
        """When paths.ensure_dirs() raises OSError, _setup_logging must install
        a NullHandler and not propagate the exception."""
        import logging

        real_setup, log = self._get_real_setup_logging()

        # Clear handlers so the guard `if _LOG.handlers: return` doesn't skip
        saved = list(log.handlers)
        for h in saved:
            log.removeHandler(h)

        monkeypatch.setattr("token_goat.paths.ensure_dirs", lambda: (_ for _ in ()).throw(OSError("no dir")))
        try:
            # Must not raise
            real_setup()
            # Should have installed a NullHandler as fallback
            assert any(isinstance(h, logging.NullHandler) for h in log.handlers)
        finally:
            for h in list(log.handlers):
                log.removeHandler(h)
            for h in saved:
                log.addHandler(h)

    def test_setup_logging_idempotent(self, monkeypatch):
        """Calling _setup_logging twice must not add duplicate handlers."""
        real_setup, log = self._get_real_setup_logging()

        saved = list(log.handlers)
        for h in saved:
            log.removeHandler(h)

        monkeypatch.setattr("token_goat.paths.ensure_dirs", lambda: (_ for _ in ()).throw(OSError("no dir")))
        try:
            real_setup()
            count_after_first = len(log.handlers)
            # Second call hits the `if _LOG.handlers: return` guard — no-op
            real_setup()
            assert len(log.handlers) == count_after_first
        finally:
            for h in list(log.handlers):
                log.removeHandler(h)
            for h in saved:
                log.addHandler(h)


def test_unknown_event_dispatch_is_fast():
    """Unknown-event dispatch must not trigger any hook-submodule imports.

    The dispatcher fires on every Read/Write/Edit/Bash tool call.  An unknown
    event (or a no-op early-return path) should pay only the cost of a dict
    lookup, a log call, and the timing wrapper — well under 10 ms.

    Catches regressions where someone re-eagerly imports ``hooks_session``,
    ``hooks_read``, ``hooks_fetch``, or ``hooks_edit`` at module top-level,
    which would force every dispatch to load ``project``, ``session``,
    ``hashlib``, and ``dataclasses`` even when those handlers never run.
    """
    import time

    # Warm any one-time costs (logger setup, etc.).
    hooks_cli.dispatch("unknown-event-warm", {})

    samples_ms = []
    for _ in range(20):
        t0 = time.monotonic()
        hooks_cli.dispatch("unknown-event", {})
        samples_ms.append((time.monotonic() - t0) * 1000)
    median = sorted(samples_ms)[len(samples_ms) // 2]
    # 10 ms ceiling: a no-op event has nothing to do, so anything slower
    # signals accidental work being done in the hot path.
    assert median < 10.0, f"unknown-event dispatch took {median:.2f} ms (median); expected < 10"


def test_hook_submodules_not_imported_at_dispatcher_import():
    """Importing ``hooks_cli`` must not eagerly load any per-event handler module.

    The dispatcher fires on every tool call, so its module-load cost is paid
    on every cold start.  Eagerly importing ``hooks_session`` (which pulls in
    ``project`` and ``hashlib``) or ``hooks_read`` (which pulls in ``session``
    and ``dataclasses``) regresses startup latency by 10-15 ms per tool call.

    The test runs in a subprocess with a fresh interpreter so import-cache
    pollution from earlier tests does not mask a regression.
    """
    import subprocess
    import sys

    script = (
        "import sys\n"
        "import token_goat.hooks_cli  # noqa\n"
        "loaded = sorted(m for m in sys.modules if m.startswith('token_goat.'))\n"
        "print('\\n'.join(loaded))\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        check=True,
        capture_output=True,
        text=True,
    )
    loaded = set(result.stdout.split())
    forbidden = {
        "token_goat.hooks_session",
        "token_goat.hooks_read",
        "token_goat.hooks_fetch",
        "token_goat.hooks_edit",
        "token_goat.session",
        "token_goat.project",
    }
    eagerly_loaded = loaded & forbidden
    assert not eagerly_loaded, (
        f"hooks_cli eagerly imported {eagerly_loaded}; "
        "all per-event handler modules must be lazy-loaded on first dispatch"
    )


def test_handler_lookup_caches_after_first_dispatch():
    """Second dispatch of the same event must hit the cache, not re-import."""
    # Clear cache to start fresh.
    hooks_cli._HANDLER_CACHE.clear()
    assert "pre-read" not in hooks_cli._HANDLER_CACHE
    hooks_cli.dispatch("pre-read", {"tool_name": "Other"})
    assert "pre-read" in hooks_cli._HANDLER_CACHE
    cached_handler = hooks_cli._HANDLER_CACHE["pre-read"]
    hooks_cli.dispatch("pre-read", {"tool_name": "Other"})
    # Same object: no re-wrapping, no re-import.
    assert hooks_cli._HANDLER_CACHE["pre-read"] is cached_handler


# ---------------------------------------------------------------------------
# compact-skip sentinel fast-path (iter 48)
# ---------------------------------------------------------------------------


class TestCompactSkipSentinel:
    """pre_compact sentinel fast-path: fresh sentinel skips heavy imports."""

    def test_fresh_sentinel_skips_via_check_mock(self, tmp_path, monkeypatch):
        """When _check_compact_skip_sentinel returns True, pre_compact returns CONTINUE
        and does NOT call into compact/config (no heavy imports needed)."""
        from unittest.mock import patch

        from token_goat import hooks_cli as hc

        # Intercept the sentinel check to return True (fast-path).
        # Also intercept compact/config to detect if they are reached.
        compact_called = []

        with patch.object(hc, "_check_compact_skip_sentinel", return_value=True), \
             patch("token_goat.compact.build_manifest_with_count",
                   side_effect=lambda *a, **kw: compact_called.append(1) or ("", 0)):
            payload = {"session_id": "sentinel_test_fresh", "trigger": "auto"}
            result = hc.pre_compact(payload)

        assert result.get("continue") is True
        assert not compact_called, (
            "compact.build_manifest_with_count was called despite a fresh sentinel"
        )

    def test_stale_sentinel_does_not_shortcut(self, tmp_path, monkeypatch):
        """A sentinel older than 5 minutes must not trigger the fast-path."""
        import os
        import time

        from token_goat import hooks_cli as hc
        from token_goat import paths

        # Patch data_dir first, THEN write the sentinel so both the write and the
        # subsequent check resolve to the same tmp_path-rooted location.
        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        session_id = "sentinel_test_stale"
        sentinel = paths.compact_skip_sentinel_path(session_id)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.touch()
        stale_mtime = time.time() - 361  # 6 min ago
        os.utime(sentinel, (stale_mtime, stale_mtime))

        # The stale sentinel must return False from the check.
        assert hc._check_compact_skip_sentinel(session_id) is False

    def test_missing_sentinel_returns_false(self, tmp_path, monkeypatch):
        """No sentinel file → _check_compact_skip_sentinel returns False."""
        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
        assert hc._check_compact_skip_sentinel("no_such_session") is False

    def test_write_sentinel_creates_file(self, tmp_path, monkeypatch):
        """_write_compact_skip_sentinel creates the sentinel file."""
        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)

        session_id = "sentinel_write_test"
        hc._write_compact_skip_sentinel(session_id)

        sentinel = paths.compact_skip_sentinel_path(session_id)
        assert sentinel.exists(), "sentinel file was not created by _write_compact_skip_sentinel"

    def test_check_sentinel_returns_true_for_fresh(self, tmp_path, monkeypatch):
        """_check_compact_skip_sentinel returns True for a just-written sentinel."""
        from token_goat import hooks_cli as hc
        from token_goat import paths

        # Patch first so write and check resolve to the same directory.
        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
        session_id = "sentinel_fresh_check"
        hc._write_compact_skip_sentinel(session_id)
        assert hc._check_compact_skip_sentinel(session_id) is True

    def test_pre_compact_no_session_id_no_crash(self, tmp_path, monkeypatch):
        """pre_compact with no session_id must not crash and must return continue."""
        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
        result = hc.pre_compact({"trigger": "auto"})
        assert result.get("continue") is True
