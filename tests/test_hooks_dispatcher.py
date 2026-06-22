"""Tests for the hook dispatcher's fail-soft and dispatch behavior."""
import json
import threading

import pytest
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
        # safe_run with harness=codex: camelCase preserved, _tg_* stripped.
        import json

        from token_goat import hooks_cli as hc

        def patched_dispatch(event, payload):
            return {
                "continue": True,
                "_tg_elapsed_ms": 5,
                "hookSpecificOutput": {"additionalContext": "hello", "updatedInput": {"x": 1}},
            }

        monkeypatch.setattr(hc, "dispatch", patched_dispatch)

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "z"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file, harness="codex")
        out = capsys.readouterr().out
        parsed = json.loads(out)
        assert "_tg_elapsed_ms" not in parsed
        hso = parsed.get("hookSpecificOutput", {})
        assert hso["additionalContext"] == "hello"
        assert hso["updatedInput"] == {"x": 1}
        assert "additional_context" not in hso

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
        # Also redirect the crash-sink override (set by the autouse fixture) to
        # this test's expected location so safe_run writes here, not to the
        # fixture's tmp path.
        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)

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
        # Redirect the crash-sink override to this test's expected location.
        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)

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
        # normalize_payload stamps _tg_harness; original keys must survive
        assert result.get("session_id") == "s"
        assert result.get("tool_name") == "Read"
        assert result.get("_tg_harness") == "claude"

    def test_codex_harness_returns_payload_unchanged(self):
        """Codex payload is structurally identical; normalize_payload stamps _tg_harness."""
        payload = {"session_id": "s", "tool_name": "Read", "turn_id": "t1"}
        result = hooks_cli.normalize_payload(payload, harness="codex")
        assert result.get("session_id") == "s"
        assert result.get("tool_name") == "Read"
        assert result.get("_tg_harness") == "codex"


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
        timeout=30,
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

    @pytest.fixture(autouse=True)
    def _patch_data_dir(self, tmp_path, monkeypatch):
        """Redirect paths.data_dir to tmp_path for every test in this class.

        Replaces the repeated ``monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)``
        that appeared in every test method.  tmp_path is still accessible via
        ``self._tmp_path`` for tests that need to construct paths explicitly.
        """
        import token_goat.paths as paths

        monkeypatch.setattr(paths, "data_dir", lambda: tmp_path)
        self._tmp_path = tmp_path

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

        session_id = "sentinel_test_stale"
        sentinel = paths.compact_skip_sentinel_path(session_id)
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.touch()
        stale_mtime = time.time() - 361  # 6 min ago
        os.utime(sentinel, (stale_mtime, stale_mtime))

        # The stale sentinel must return False from the check.
        assert hc._check_compact_skip_sentinel(session_id) is False

    def test_missing_sentinel_returns_false(self, monkeypatch):
        """No sentinel file → _check_compact_skip_sentinel returns False."""
        from token_goat import hooks_cli as hc

        assert hc._check_compact_skip_sentinel("no_such_session") is False

    def test_write_sentinel_creates_file(self, tmp_path, monkeypatch):
        """_write_compact_skip_sentinel creates the sentinel file."""
        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "sentinel_write_test"
        hc._write_compact_skip_sentinel(session_id)

        sentinel = paths.compact_skip_sentinel_path(session_id)
        assert sentinel.exists(), "sentinel file was not created by _write_compact_skip_sentinel"

    def test_check_sentinel_returns_true_for_fresh(self, tmp_path, monkeypatch):
        """_check_compact_skip_sentinel returns True for a just-written sentinel."""
        from token_goat import hooks_cli as hc
        session_id = "sentinel_fresh_check"
        hc._write_compact_skip_sentinel(session_id)
        assert hc._check_compact_skip_sentinel(session_id) is True

    def test_pre_compact_no_session_id_no_crash(self, monkeypatch):
        """pre_compact with no session_id must not crash and must return continue."""
        from token_goat import hooks_cli as hc

        result = hc.pre_compact({"trigger": "auto"})
        assert result.get("continue") is True

    # ----- Activity-floor: session activity busts the sentinel ----------------

    def test_sentinel_busted_by_session_activity(self, tmp_path, monkeypatch):
        """Sentinel must be invalidated when the session JSON mtime is newer.

        Regression for iter 60 activity floor: without it, a fresh sentinel
        suppresses the manifest for the full TTL even when the user has
        generated dozens of edits/reads in the interim.
        """
        import os
        import time

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "sentinel_activity_floor"
        # Write the sentinel first…
        hc._write_compact_skip_sentinel(session_id)
        sentinel = paths.compact_skip_sentinel_path(session_id)
        sentinel_mtime = sentinel.stat().st_mtime

        # …then write a session file with a clearly-newer mtime (simulating
        # post-Edit / post-Read activity after the sentinel was laid down).
        session_file = paths.session_cache_path(session_id)
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.write_text("{}", encoding="utf-8")
        newer = sentinel_mtime + 60.0  # 1 min of activity
        os.utime(session_file, (newer, newer))

        # Sanity: sentinel is otherwise "fresh" (mtime within TTL).
        assert time.time() - sentinel_mtime < hc._COMPACT_SKIP_TTL_SECS

        assert hc._check_compact_skip_sentinel(session_id) is False, (
            "compact-skip sentinel must be invalidated when the session JSON "
            "mtime is newer (activity floor)"
        )

    def test_sentinel_holds_when_no_session_activity(self, tmp_path, monkeypatch):
        """No session file → sentinel stays valid (no activity to compare against).

        Preserves the original fast-path behaviour for sessions that have
        never persisted state (Codex startup, fresh session_id with no tool
        calls between hook fires).
        """
        from token_goat import hooks_cli as hc

        session_id = "sentinel_no_session_file"
        hc._write_compact_skip_sentinel(session_id)
        # Deliberately do NOT create the session JSON.
        assert hc._check_compact_skip_sentinel(session_id) is True

    def test_sentinel_holds_when_session_older_than_sentinel(self, tmp_path, monkeypatch):
        """Session file older than sentinel → sentinel still valid.

        The activity floor only triggers when *new* activity has occurred
        since the sentinel was written.  A session file that was last touched
        before the sentinel does not invalidate it — that's exactly the case
        the fast-path is designed for (one no-op pre-compact, then idle).
        """
        import os

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "sentinel_session_older"
        # Write the session file FIRST, then back-date its mtime by 10 min.
        session_file = paths.session_cache_path(session_id)
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.write_text("{}", encoding="utf-8")
        old_mtime = paths.session_cache_path(session_id).stat().st_mtime - 600.0
        os.utime(session_file, (old_mtime, old_mtime))

        # Then write the sentinel (mtime = now, well after session mtime).
        hc._write_compact_skip_sentinel(session_id)

        assert hc._check_compact_skip_sentinel(session_id) is True

    # ----- Negative-age defence (clock skew / NTP step / manual edit) --------

    def test_future_dated_sentinel_returns_false(self, tmp_path, monkeypatch):
        """Sentinel mtime in the future → check returns False (mirrors sidecar)."""
        import os
        import time

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "sentinel_future_dated"
        hc._write_compact_skip_sentinel(session_id)
        sentinel = paths.compact_skip_sentinel_path(session_id)

        # Push mtime 1 hour into the future (clock skew / manually copied file).
        future = time.time() + 3600.0
        os.utime(sentinel, (future, future))

        assert hc._check_compact_skip_sentinel(session_id) is False, (
            "future-dated sentinel must not short-circuit the slow path"
        )

    # ----- Configurable TTL --------------------------------------------------

    def test_compact_skip_ttl_respects_config(self, tmp_path, monkeypatch):
        """[compact_assist] compact_skip_ttl_secs overrides the default TTL.

        At ttl=10s a sentinel written 30s ago must be stale even though
        the hardcoded default (300s) would still consider it fresh.
        """
        import os
        import time
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "sentinel_short_ttl"
        hc._write_compact_skip_sentinel(session_id)
        sentinel = paths.compact_skip_sentinel_path(session_id)
        # Make it 30s old — fresh under default 300s TTL, stale under 10s TTL.
        backdated = time.time() - 30.0
        os.utime(sentinel, (backdated, backdated))

        fake_cfg = MagicMock()
        fake_cfg.compact_assist.compact_skip_ttl_secs = 10.0
        with patch("token_goat.config.load", return_value=fake_cfg):
            assert hc._check_compact_skip_sentinel(session_id) is False

        # Bypass the config: with default TTL (300s) the same sentinel is fresh.
        with patch.object(hc, "_compact_skip_ttl_secs", return_value=300.0):
            assert hc._check_compact_skip_sentinel(session_id) is True

    def test_compact_skip_ttl_helper_clamps_invalid_values(self, monkeypatch):
        """_compact_skip_ttl_secs() falls back to default for NaN / zero / huge values."""
        import math
        from unittest.mock import MagicMock, patch

        from token_goat import hooks_cli as hc

        # Negative / zero / out-of-range values fall back to default
        for bad in (-1.0, 0.0, 4000.0, math.nan, math.inf):
            fake_cfg = MagicMock()
            fake_cfg.compact_assist.compact_skip_ttl_secs = bad
            with patch("token_goat.config.load", return_value=fake_cfg):
                assert hc._compact_skip_ttl_secs() == hc._COMPACT_SKIP_TTL_SECS, (
                    f"_compact_skip_ttl_secs() did not fall back to default for {bad!r}"
                )

    def test_compact_skip_ttl_helper_survives_config_failure(self, monkeypatch):
        """_compact_skip_ttl_secs() must never raise even if config.load explodes."""
        from unittest.mock import patch

        from token_goat import hooks_cli as hc

        with patch("token_goat.config.load", side_effect=RuntimeError("boom")):
            # Must not raise; must return the hardcoded default.
            assert hc._compact_skip_ttl_secs() == hc._COMPACT_SKIP_TTL_SECS

    def test_sentinel_fat32_mtime_grace_1_5s_does_not_bust(self, tmp_path, monkeypatch):
        """Session mtime 1.5s after sentinel should NOT bust (grace is 2.0s).

        Regression: with grace=0.5s, FAT32's 2s mtime resolution could cause
        a false-negative where a session write 1.5s after the sentinel appeared
        to have the same mtime, incorrectly skipping manifest injection.  With
        grace=2.0s, a 1.5s delta correctly keeps the sentinel valid.
        """
        import os

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "fat32_grace_1_5s"
        hc._write_compact_skip_sentinel(session_id)
        sentinel = paths.compact_skip_sentinel_path(session_id)
        sentinel_mtime = sentinel.stat().st_mtime

        # Write session file 1.5s after sentinel (less than the 2.0s grace).
        session_file = paths.session_cache_path(session_id)
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.write_text("{}", encoding="utf-8")
        session_mtime_1_5s = sentinel_mtime + 1.5
        os.utime(session_file, (session_mtime_1_5s, session_mtime_1_5s))

        # The sentinel should still be valid (1.5s < 2.0s grace).
        assert hc._check_compact_skip_sentinel(session_id) is True

    def test_sentinel_fat32_mtime_grace_2_5s_does_bust(self, tmp_path, monkeypatch):
        """Session mtime 2.5s after sentinel SHOULD bust (grace is 2.0s).

        With grace=2.0s, a session write 2.5s after the sentinel (exceeding the
        grace) correctly invalidates the sentinel.
        """
        import os

        from token_goat import hooks_cli as hc
        from token_goat import paths

        session_id = "fat32_grace_2_5s"
        hc._write_compact_skip_sentinel(session_id)
        sentinel = paths.compact_skip_sentinel_path(session_id)
        sentinel_mtime = sentinel.stat().st_mtime

        # Write session file 2.5s after sentinel (more than the 2.0s grace).
        session_file = paths.session_cache_path(session_id)
        session_file.parent.mkdir(parents=True, exist_ok=True)
        session_file.write_text("{}", encoding="utf-8")
        session_mtime_2_5s = sentinel_mtime + 2.5
        os.utime(session_file, (session_mtime_2_5s, session_mtime_2_5s))

        # The sentinel should be invalidated (2.5s > 2.0s grace).
        assert hc._check_compact_skip_sentinel(session_id) is False


# ---------------------------------------------------------------------------
# Item D: dispatch top-level continue-field sanitization
# ---------------------------------------------------------------------------


class TestDispatchContinueGuard:
    """dispatch() must always return a response with {"continue": True},
    even when the handler returns a dict that is missing the key."""

    def test_handler_returning_empty_dict_gets_continue_injected(self, monkeypatch):
        """A handler that returns {} (missing 'continue') must still produce continue:true."""

        from token_goat import hooks_cli as hc

        # Register a one-shot handler that returns an empty dict.
        original_cache = dict(hc._HANDLER_CACHE)
        try:
            hc._HANDLER_CACHE["pre-read"] = lambda payload: {}  # type: ignore[assignment]
            result = hc.dispatch("pre-read", {"tool_name": "Other"})
        finally:
            hc._HANDLER_CACHE.clear()
            hc._HANDLER_CACHE.update(original_cache)

        assert result.get("continue") is True, (
            f"dispatch() did not inject 'continue' for empty-dict handler response: {result}"
        )

    def test_handler_returning_only_extra_keys_gets_continue_injected(self, monkeypatch):
        """A handler returning a non-continue dict still gets continue:true appended."""
        from token_goat import hooks_cli as hc

        original_cache = dict(hc._HANDLER_CACHE)
        try:
            hc._HANDLER_CACHE["pre-read"] = lambda payload: {"extra": "value"}  # type: ignore[assignment]
            result = hc.dispatch("pre-read", {"tool_name": "Other"})
        finally:
            hc._HANDLER_CACHE.clear()
            hc._HANDLER_CACHE.update(original_cache)

        assert result.get("continue") is True

    def test_handler_returning_continue_true_is_unchanged(self, monkeypatch):
        """A handler already returning continue:true must not have it overwritten."""
        from token_goat import hooks_cli as hc

        original_cache = dict(hc._HANDLER_CACHE)
        try:
            hc._HANDLER_CACHE["pre-read"] = lambda payload: {"continue": True, "extra": "x"}  # type: ignore[assignment]
            result = hc.dispatch("pre-read", {"tool_name": "Other"})
        finally:
            hc._HANDLER_CACHE.clear()
            hc._HANDLER_CACHE.update(original_cache)

        assert result.get("continue") is True
        assert result.get("extra") == "x"


# ---------------------------------------------------------------------------
# Item B: crash-sink surrogate safety
# ---------------------------------------------------------------------------


class TestCrashSinkSurrogateSafety:
    """safe_run's crash-sink log write must survive surrogate chars in msg/traceback.

    Tests verify that sanitize_surrogates is called at the right boundary in
    safe_run so that UnicodeEncodeError in the crash log write never silently
    swallows a crash record.  Direct use of surrogate codepoints in test
    function scope is avoided because xdist/execnet cannot serialize strings
    with lone surrogates across its communication channel — instead we verify
    the sanitization boundary is wired correctly via monkeypatching.
    """

    def test_crash_sink_calls_sanitize_surrogates_on_msg_and_tb(
        self, tmp_path, capsys, monkeypatch
    ):
        """safe_run must apply sanitize_surrogates to both msg and tb before
        writing to the crash sink.  This is the boundary that prevents a
        UnicodeEncodeError from silently swallowing a crash when the exception
        or its traceback contains Windows surrogate-escape chars."""
        import json

        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        monkeypatch.setattr(hc, "dispatch", lambda event, payload: (_ for _ in ()).throw(RuntimeError("boom")))

        sanitize_calls: list[str] = []

        original = hc.sanitize_surrogates

        def recording_sanitize(text: str) -> str:
            sanitize_calls.append(text)
            return original(text)

        monkeypatch.setattr(hc, "sanitize_surrogates", recording_sanitize)

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "sanitize-call-test"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        # Fail-soft contract: continue:true still emitted
        out = capsys.readouterr().out
        parsed = json.loads(out)
        assert parsed["continue"] is True

        # sanitize_surrogates must have been called at least twice:
        # once for msg and at least once for tb (the traceback).
        assert len(sanitize_calls) >= 2, (
            f"expected sanitize_surrogates called >=2 times (msg + tb), got {len(sanitize_calls)}"
        )

    def test_crash_sink_is_valid_utf8_after_write(self, tmp_path, capsys, monkeypatch):
        """The crash-sink file must always be readable as valid UTF-8 after a crash.

        This is the outcome guarantee: whatever sanitization runs, the resulting
        file must not contain invalid UTF-8 sequences.
        """

        from token_goat import hooks_cli as hc
        from token_goat import paths

        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        monkeypatch.setattr(hc, "dispatch", lambda event, payload: (_ for _ in ()).throw(RuntimeError("normal message")))
        # Redirect the crash-sink override to this test's expected location.
        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "utf8-test"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        sink = tmp_path / "logs" / "hooks-stderr.log"
        assert sink.exists(), "hooks-stderr.log was not created"
        # This read must not raise — file must be valid UTF-8.
        content = sink.read_text(encoding="utf-8")
        assert "pre-read" in content
        assert "RuntimeError" in content


# ---------------------------------------------------------------------------
# Structured crash-sink header
# ---------------------------------------------------------------------------


class TestCrashSinkStructuredHeader:
    """Each crash-sink entry must begin with a JSON header line.

    The header makes entries machine-parseable (``grep '^{' hooks-stderr.log | jq``)
    while preserving the human-readable msg + traceback on the lines that follow.
    """

    def test_crash_sink_entry_starts_with_json_header(self, tmp_path, monkeypatch):
        """First line of each crash entry must be a valid JSON object with ts, event, err."""
        import json as _json

        from token_goat import hooks_cli as hc
        from token_goat import paths

        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)
        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        monkeypatch.setattr(hc, "dispatch", lambda ev, pl: (_ for _ in ()).throw(RuntimeError("structured-test")))

        payload_file = tmp_path / "payload.json"
        payload_file.write_text('{"session_id": "sess-structured-01"}', encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        content = sink_path.read_text(encoding="utf-8")
        first_line = content.splitlines()[0]
        header = _json.loads(first_line)

        assert "ts" in header and isinstance(header["ts"], float)
        assert header["event"] == "pre-read"
        assert "RuntimeError" in header["err"]
        assert "structured-test" in header["err"]

    def test_crash_sink_header_includes_session_id(self, tmp_path, monkeypatch):
        """The JSON header sid field must reflect the session_id from the payload."""
        import json as _json

        from token_goat import hooks_cli as hc
        from token_goat import paths

        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)
        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        monkeypatch.setattr(hc, "dispatch", lambda ev, pl: (_ for _ in ()).throw(ValueError("boom")))

        sid = "ses-1234-abcd-5678"
        payload_file = tmp_path / "payload.json"
        payload_file.write_text(_json.dumps({"session_id": sid}), encoding="utf-8")
        hc.safe_run("post-edit", input_file=payload_file)

        first_line = sink_path.read_text(encoding="utf-8").splitlines()[0]
        header = _json.loads(first_line)
        assert header["sid"] == sid[:16]

    def test_crash_sink_header_present_when_read_payload_fails(self, tmp_path, monkeypatch):
        """JSON header must appear even when the crash occurs before payload is parsed."""
        import json as _json

        from token_goat import hooks_cli as hc
        from token_goat import paths

        sink_path = tmp_path / "logs" / "hooks-stderr.log"
        monkeypatch.setattr(paths, "_hooks_stderr_log_override", sink_path)
        monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
        # Make read_payload itself raise so payload is never set.
        monkeypatch.setattr(hc, "read_payload", lambda _: (_ for _ in ()).throw(OSError("payload gone")))

        payload_file = tmp_path / "payload.json"
        payload_file.write_text("{}", encoding="utf-8")
        hc.safe_run("pre-read", input_file=payload_file)

        first_line = sink_path.read_text(encoding="utf-8").splitlines()[0]
        header = _json.loads(first_line)
        assert header["event"] == "pre-read"
        assert "OSError" in header["err"]
        assert header["sid"] == ""  # no payload was parsed


# ---------------------------------------------------------------------------
# hooks-stderr.log isolation — crash-sink writes must not touch the real log
# ---------------------------------------------------------------------------


def test_safe_run_crash_writes_to_isolated_log_not_real_log(tmp_path, monkeypatch):
    """safe_run crash-sink writes must land in the isolate_hooks_stderr_log override,
    not in the real production logs/hooks-stderr.log.

    The autouse ``isolate_hooks_stderr_log`` fixture in conftest.py redirects
    ``paths.hooks_stderr_log_path()`` to a per-test tmp file.  This test
    verifies that redirect works end-to-end: after a deliberate crash, the
    isolated file has content, and the real log directory has no hooks-stderr.log.
    """
    from token_goat import hooks_cli as hc
    from token_goat import paths

    real_log_dir = tmp_path / "real_logs_dir"
    real_log_dir.mkdir()

    # Point logs_dir() to a separate directory so we can check it stays empty.
    monkeypatch.setattr(paths, "logs_dir", lambda: real_log_dir)

    # The autouse fixture already set the override to tmp_path / "test-hooks-stderr.log".
    # Confirm the override is active.
    override_path = paths.hooks_stderr_log_path()
    assert override_path != real_log_dir / "hooks-stderr.log", (
        "isolate_hooks_stderr_log fixture did not activate the override"
    )

    # Cause a crash in safe_run.
    monkeypatch.setattr(
        hc,
        "dispatch",
        lambda event, payload: (_ for _ in ()).throw(RuntimeError("boom-isolation-test")),
    )
    payload_file = tmp_path / "payload.json"
    payload_file.write_text('{"session_id": "isolation-test"}', encoding="utf-8")
    hc.safe_run("pre-read", input_file=payload_file)

    # The isolated log should have the crash.
    assert override_path.exists(), "crash was not written to the isolated log"
    content = override_path.read_text(encoding="utf-8")
    assert "boom-isolation-test" in content

    # The real log directory must NOT have a hooks-stderr.log.
    real_sink = real_log_dir / "hooks-stderr.log"
    assert not real_sink.exists(), (
        "crash was written to the real hooks-stderr.log; isolation fixture did not work"
    )


# ---------------------------------------------------------------------------
# Watchdog: a hung handler must not be able to block dispatch indefinitely.
# signal.alarm is POSIX-only, so the dispatcher uses a daemon thread + join
# with a finite timeout.  These tests exercise that path on every platform.
# ---------------------------------------------------------------------------


def test_dispatch_watchdog_returns_within_budget_on_hung_handler(monkeypatch):
    """A handler that sleeps far past the budget must not stall dispatch.

    The watchdog budget is _HOOK_WATCHDOG_MS.  We shrink it to ~100ms for
    speed, install a handler that sleeps 5x that, and verify dispatch
    returns continue:true within budget + 200ms tolerance.
    """
    import time as _time

    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 100)
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "100")
    budget_s = hooks_cli._HOOK_WATCHDOG_MS / 1000.0
    sleep_s = budget_s * 5

    def slow_handler(_payload):
        threading.Event().wait(sleep_s)
        return {"continue": True}

    monkeypatch.setitem(hooks_cli.EVENTS, "session-start", slow_handler)

    t0 = _time.monotonic()
    result = hooks_cli.dispatch("session-start", {"session_id": "watchdog-hang"})
    elapsed = _time.monotonic() - t0

    _assert_continue(result)
    assert result.get("_tg_watchdog_tripped") is True, (
        f"watchdog flag missing on hung-handler result: {result!r}"
    )
    # Budget + 200ms tolerance for thread join overhead.
    assert elapsed < budget_s + 0.2, (
        f"dispatch took {elapsed:.3f}s, exceeded watchdog budget {budget_s:.3f}s + 200ms"
    )


def test_dispatch_watchdog_does_not_trip_on_fast_handler(monkeypatch):
    """A handler that finishes well within budget must complete normally —
    no watchdog flag, real return value preserved."""

    def fast_handler(_payload):
        return {"continue": True, "_marker": "fast-ok"}

    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 5000)
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "5000")
    monkeypatch.setitem(hooks_cli.EVENTS, "session-start", fast_handler)

    result = hooks_cli.dispatch("session-start", {"session_id": "watchdog-fast"})
    _assert_continue(result)
    assert result.get("_marker") == "fast-ok"
    assert "_tg_watchdog_tripped" not in result


def test_dispatch_watchdog_logs_warning_on_trip(monkeypatch, caplog):
    """When the watchdog trips, the dispatcher must log a WARNING."""
    import logging as _logging

    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 50)
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "50")

    def hung(_payload):
        threading.Event().wait(0.5)
        return {"continue": True}

    monkeypatch.setitem(hooks_cli.EVENTS, "session-start", hung)

    with caplog.at_level(_logging.WARNING, logger="token_goat.hooks"):
        hooks_cli.dispatch("session-start", {"session_id": "watchdog-log"})

    msgs = [r.getMessage() for r in caplog.records if r.levelno >= _logging.WARNING]
    assert any("watchdog tripped" in m for m in msgs), (
        f"expected a 'watchdog tripped' warning, got: {msgs!r}"
    )


# ---------------------------------------------------------------------------
# Watchdog budget: operator-tunable via TOKEN_GOAT_HOOK_WATCHDOG_MS env var.
# Slow Windows boxes (cold sqlite-vec import, lock contention) need a wider
# budget; CI may want a tighter one.  These tests pin the contract: env var
# overrides the default, invalid values fall back fail-soft, and clamping
# keeps the budget in a safe band.
# ---------------------------------------------------------------------------


def test_resolved_watchdog_ms_unset_uses_config_layer(monkeypatch, tmp_data_dir):
    """No env var → Layer 2: reads per-project config value before falling back to constant."""
    monkeypatch.delenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", raising=False)
    from unittest.mock import MagicMock

    import token_goat.config as _cfg_mod
    mock_cfg = MagicMock()
    mock_cfg.hooks.watchdog_ms = 3500
    monkeypatch.setattr(_cfg_mod, "load", lambda: mock_cfg)
    assert hooks_cli._resolved_watchdog_ms() == 3500


def test_resolved_watchdog_ms_blank_uses_config_layer(monkeypatch, tmp_data_dir):
    """Blank/whitespace env value is treated as unset; config layer still applies."""
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "   ")
    from unittest.mock import MagicMock

    import token_goat.config as _cfg_mod
    mock_cfg = MagicMock()
    mock_cfg.hooks.watchdog_ms = 4200
    monkeypatch.setattr(_cfg_mod, "load", lambda: mock_cfg)
    assert hooks_cli._resolved_watchdog_ms() == 4200


def test_resolved_watchdog_ms_config_failure_falls_back_to_constant(monkeypatch):
    """When config.load() raises, the hardcoded constant is the terminal fallback."""
    monkeypatch.delenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", raising=False)
    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 7777)
    import token_goat.config as _cfg_mod
    def _raise():
        raise RuntimeError("simulated config failure")
    monkeypatch.setattr(_cfg_mod, "load", _raise)
    assert hooks_cli._resolved_watchdog_ms() == 7777


def test_resolved_watchdog_ms_valid_in_band(monkeypatch):
    """An in-band integer overrides the compiled default."""
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "5000")
    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 100)
    assert hooks_cli._resolved_watchdog_ms() == 5000


def test_resolved_watchdog_ms_clamps_too_low(monkeypatch):
    """A value below the floor is clamped to the floor, not rejected.

    Rationale: a hook firing on every tool call must never crash on a bad
    env value.  Clamping preserves fail-soft semantics while still nudging
    behavior toward the operator's intent.
    """
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "1")
    assert hooks_cli._resolved_watchdog_ms() == hooks_cli._HOOK_WATCHDOG_MS_FLOOR


def test_resolved_watchdog_ms_clamps_too_high(monkeypatch):
    """A value above the ceiling is clamped, capping the worst-case agent stall."""
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "999999999")
    assert hooks_cli._resolved_watchdog_ms() == hooks_cli._HOOK_WATCHDOG_MS_CEIL


def test_resolved_watchdog_ms_garbage_returns_default(monkeypatch):
    """Non-numeric garbage falls back to the default rather than raising."""
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "definitely-not-a-number")
    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 3333)
    assert hooks_cli._resolved_watchdog_ms() == 3333


def test_resolved_watchdog_ms_negative_returns_default(monkeypatch):
    """A negative or zero value falls back to the default (no infinite-loop risk)."""
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "-50")
    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 4444)
    assert hooks_cli._resolved_watchdog_ms() == 4444
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "0")
    assert hooks_cli._resolved_watchdog_ms() == 4444


def test_dispatch_respects_env_watchdog_budget(monkeypatch):
    """End-to-end: env var widens the watchdog so a slow handler still completes.

    With the default monkeypatched to a tiny 50ms, a 200ms handler would
    normally trip the watchdog.  Setting the env var to 1000ms must let it
    finish normally — proves the env override is wired into dispatch.
    """
    monkeypatch.setattr(hooks_cli, "_HOOK_WATCHDOG_MS", 50)
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "1000")

    def slowish(_payload):
        threading.Event().wait(0.2)
        return {"continue": True, "_marker": "completed"}

    monkeypatch.setitem(hooks_cli.EVENTS, "session-start", slowish)
    result = hooks_cli.dispatch("session-start", {"session_id": "env-widened"})

    _assert_continue(result)
    assert result.get("_marker") == "completed"
    assert "_tg_watchdog_tripped" not in result


def test_dispatch_watchdog_records_budget_on_trip(monkeypatch):
    """When the watchdog trips, the effective budget is recorded in the result.

    This is the observability hook the doctor / stats path can read to
    distinguish a 2s default trip from a 500ms env-tightened trip without
    having to read the daily log file.
    """
    monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "120")

    def hung(_payload):
        threading.Event().wait(0.6)
        return {"continue": True}

    monkeypatch.setitem(hooks_cli.EVENTS, "session-start", hung)
    result = hooks_cli.dispatch("session-start", {"session_id": "budget-recorded"})

    _assert_continue(result)
    assert result.get("_tg_watchdog_tripped") is True
    assert result.get("_tg_watchdog_budget_ms") == 120


# ---------------------------------------------------------------------------
# Exit-0 invariant — parametrized across all registered hook events
# ---------------------------------------------------------------------------


def _all_event_names() -> list[str]:
    from token_goat.hook_registry import HOOK_EVENTS
    return [e.name for e in HOOK_EVENTS]


@pytest.mark.parametrize("event", _all_event_names())
def test_exit_zero_invariant_all_events(event, tmp_path, monkeypatch, capsys):
    """CRITICAL: every hook event must return {"continue": true} even when the
    registered handler raises BaseException.

    This parametrized test enforces the fail-soft contract for every event in
    HOOK_EVENTS.  A new event that bypasses fail_soft or has a double-decorator
    stack will show up here before it can reach production.
    """
    import json as _json

    from token_goat import hooks_cli as hc
    from token_goat import paths

    # Redirect crash sink so tests stay isolated.
    monkeypatch.setattr(paths, "_hooks_stderr_log_override", tmp_path / "hooks-stderr.log")
    monkeypatch.setattr(paths, "logs_dir", lambda: tmp_path / "logs")
    # Prevent db.record_stat from opening the global SQLite DB (avoids ~1.7s sqlite-vec load).
    monkeypatch.setattr("token_goat.db.record_stat", lambda *a, **kw: None)

    # Inject a handler that raises RuntimeError for this event.
    def _crashing(_payload):
        raise RuntimeError(f"deliberate crash in {event}")

    monkeypatch.setitem(hc.EVENTS, event, _crashing)

    payload_file = tmp_path / "payload.json"
    payload_file.write_text(
        _json.dumps({"session_id": f"invariant-{event}"}),
        encoding="utf-8",
    )
    hc.safe_run(event, input_file=payload_file)

    out = capsys.readouterr().out
    parsed = _json.loads(out)
    assert parsed.get("continue") is True, (
        f"event {event!r}: expected {{\"continue\": true}}, got {parsed!r}"
    )


# ---------------------------------------------------------------------------
# Thread safety: handler_result data race fix
# ---------------------------------------------------------------------------


def test_dispatch_handler_result_is_thread_safe():
    """Verify that handler_result updates are guarded with a lock.

    Regression: dispatch() created a shared dict that was updated by the worker
    thread and read by the main thread without synchronization. This caused a
    potential data race. The fix guards the update and read with a threading.Lock.

    This test cannot directly observe the lock (it's internal), but it verifies
    that the handler's result is correctly captured even when the handler returns
    a complex dict with multiple keys.
    """
    # Create a handler that returns a dict with multiple keys and a nested structure.
    def multi_key_handler(payload):
        return {
            "continue": True,
            "field1": "value1",
            "field2": {"nested": "data"},
            "field3": [1, 2, 3],
        }

    # Register and dispatch.
    import token_goat.hooks_cli as hc
    original_handler = hc.EVENTS.get("session-start")
    try:
        hc.EVENTS["session-start"] = multi_key_handler
        result = hc.dispatch("session-start", {"session_id": "test"})
        # Verify all fields were correctly transferred from handler_result to result.
        assert result["continue"] is True
        assert result["field1"] == "value1"
        assert result["field2"] == {"nested": "data"}
        assert result["field3"] == [1, 2, 3]
        # Verify timestamp is added by dispatch.
        assert "_tg_elapsed_ms" in result
    finally:
        if original_handler:
            hc.EVENTS["session-start"] = original_handler


def test_get_hook_context_remaining_ms_outside_hook():
    """get_hook_context_remaining_ms() returns a large value outside a hook."""
    from token_goat.hooks_cli import get_hook_context_remaining_ms
    remaining = get_hook_context_remaining_ms()
    assert remaining == 1_000_000, f"expected 1_000_000, got {remaining}"


def test_get_hook_context_remaining_ms_inside_hook():
    """get_hook_context_remaining_ms() returns remaining budget inside a hook.

    The hook context is set at the start of _run_handler() and cleared at the
    end. This test verifies that a handler can query the remaining budget.
    """
    from token_goat.hooks_cli import get_hook_context_remaining_ms

    remaining_values = []

    def query_budget_handler(payload):
        remaining = get_hook_context_remaining_ms()
        remaining_values.append(remaining)
        return {"continue": True}

    import token_goat.hooks_cli as hc
    original_handler = hc.EVENTS.get("session-start")
    try:
        hc.EVENTS["session-start"] = query_budget_handler
        result = hc.dispatch("session-start", {"session_id": "budget-test"})
        assert result["continue"] is True
        assert len(remaining_values) == 1
        # The remaining budget should be close to the configured budget (handler runs very fast).
        budget = hc._resolved_watchdog_ms()
        remaining = remaining_values[0]
        assert (budget - 100) <= remaining <= budget, f"expected remaining ~{budget}ms, got {remaining}ms"
    finally:
        if original_handler:
            hc.EVENTS["session-start"] = original_handler


def test_get_hook_context_remaining_ms_after_hook():
    """After a hook completes, get_hook_context_remaining_ms() returns large value."""
    import token_goat.hooks_cli as hc
    from token_goat.hooks_cli import get_hook_context_remaining_ms

    # Dispatch a hook to set the context.
    def simple_handler(payload):
        return {"continue": True}

    original_handler = hc.EVENTS.get("session-start")
    try:
        hc.EVENTS["session-start"] = simple_handler
        result = hc.dispatch("session-start", {"session_id": "cleanup-test"})
        assert result["continue"] is True
    finally:
        if original_handler:
            hc.EVENTS["session-start"] = original_handler

    # After dispatch, the context should be cleared (None).
    remaining = get_hook_context_remaining_ms()
    assert remaining == 1_000_000, "context should be cleared after hook completes"


# ---------------------------------------------------------------------------
# Sub-area A: _resolve_handler import-error hardening
# ---------------------------------------------------------------------------

class TestResolveHandlerImportErrorHardening:
    """_resolve_handler must return None (not raise) on import/attribute failures."""

    def test_resolve_handler_import_error_returns_none(self, monkeypatch):
        """ImportError during submodule import must return None, not propagate."""
        import importlib

        from token_goat import hooks_cli as hc

        original_import = importlib.import_module

        def bad_import(name, *args, **kwargs):
            if "hooks_session" in name:
                raise ImportError("simulated missing module")
            return original_import(name, *args, **kwargs)

        # Clear the cache so _resolve_handler must re-import
        hc._HANDLER_CACHE.pop("session-start", None)
        monkeypatch.setattr(importlib, "import_module", bad_import)

        result = hc._resolve_handler("session-start")
        assert result is None, "import failure must return None not raise"

    def test_resolve_handler_import_error_does_not_cache(self, monkeypatch):
        """A failed import must not be cached; a later retry can succeed."""
        import importlib

        from token_goat import hooks_cli as hc

        call_count = [0]
        original_import = importlib.import_module

        def sometimes_bad(name, *args, **kwargs):
            if "hooks_session" in name:
                call_count[0] += 1
                if call_count[0] == 1:
                    raise ImportError("transient failure")
            return original_import(name, *args, **kwargs)

        hc._HANDLER_CACHE.pop("session-start", None)
        monkeypatch.setattr(importlib, "import_module", sometimes_bad)

        result1 = hc._resolve_handler("session-start")
        assert result1 is None, "first call (import error) should return None"
        assert "session-start" not in hc._HANDLER_CACHE, "failed import must not be cached"

    def test_dispatch_import_error_still_returns_continue(self, monkeypatch):
        """dispatch() must return continue:true even if the submodule fails to import."""
        import importlib

        from token_goat import hooks_cli as hc

        original_import = importlib.import_module

        def bad_import(name, *args, **kwargs):
            if "hooks_session" in name:
                raise ImportError("simulated missing module")
            return original_import(name, *args, **kwargs)

        hc._HANDLER_CACHE.pop("session-start", None)
        monkeypatch.setattr(importlib, "import_module", bad_import)

        result = hc.dispatch("session-start", {"session_id": "test-123"})
        assert result.get("continue") is True, "dispatch must return continue:true on import failure"


# ---------------------------------------------------------------------------
# Hook timing recording in safe_run
# ---------------------------------------------------------------------------

def test_safe_run_records_hook_timing_stat(tmp_path, tmp_data_dir):
    """safe_run must write a hook:* timing row to the global stats DB after emit."""
    from token_goat.db import get_hook_timing_stats

    payload_file = tmp_path / "payload.json"
    payload_file.write_text('{"session_id": "timing-sess"}', encoding="utf-8")
    hooks_cli.safe_run("session-start", input_file=payload_file)

    # window_days=0 → since_ts=0.0 → all rows regardless of age
    stats = get_hook_timing_stats(window_days=0)
    assert "session-start" in stats, (
        f"expected 'session-start' in hook timing stats; got: {list(stats)}"
    )
    assert stats["session-start"]["count"] >= 1
    assert stats["session-start"]["avg_ms"] >= 0
