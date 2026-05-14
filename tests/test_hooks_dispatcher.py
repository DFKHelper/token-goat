"""Tests for the hook dispatcher's fail-soft and dispatch behavior."""
import json

from tokenwise import hooks_cli


def test_unknown_event_returns_continue():
    result = hooks_cli.dispatch("not-a-real-event", {})
    assert result == {"continue": True}


def test_session_start_no_cwd_does_not_crash():
    result = hooks_cli.dispatch("session-start", {})
    assert result == {"continue": True}


def test_session_start_with_project_marker(tmp_path):
    (tmp_path / ".git").mkdir()
    payload = {"session_id": "test-123", "cwd": str(tmp_path)}
    result = hooks_cli.dispatch("session-start", payload)
    assert result == {"continue": True}


def test_session_start_with_unknown_cwd_no_crash(tmp_path):
    payload = {"session_id": "x", "cwd": str(tmp_path)}  # no marker
    result = hooks_cli.dispatch("session-start", payload)
    assert result == {"continue": True}


def test_fail_soft_swallows_exceptions(monkeypatch):
    """If a handler raises, dispatch must still return continue:true."""

    @hooks_cli.fail_soft
    def boom(_payload):
        raise RuntimeError("intentional")

    result = boom({"any": "payload"})
    assert result == {"continue": True}


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
    `tokenwise read`/`symbol` then return wrong line ranges and the pre-read
    hint shows stale data.
    """
    import json

    import tokenwise.paths as paths
    from tokenwise.project import canonicalize, project_hash

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
    assert result == {"continue": True}

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
    import tokenwise.paths as paths
    from tokenwise import project as project_mod

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
    assert result == {"continue": True}

    queue_path = paths.dirty_queue_path()
    queued = queue_path.exists() and queue_path.read_text(encoding="utf-8").strip()
    assert not queued, "no project detected — nothing should have been enqueued"


# ---------------------------------------------------------------------------
# post_edit — mid-session watchdog: respawn the worker if it has gone down
# ---------------------------------------------------------------------------

def test_post_edit_nudges_worker_when_heartbeat_missing(tmp_data_dir, tmp_path, monkeypatch):
    """post_edit feeds the dirty queue, so it must make sure something will
    drain it: with no fresh heartbeat, the watchdog calls ensure_running()."""
    from tokenwise import project as project_mod
    from tokenwise import worker as worker_mod

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
    assert result == {"continue": True}
    assert called == [True], "a down worker must be respawned from post_edit"


def test_post_edit_skips_nudge_when_heartbeat_fresh(tmp_data_dir, tmp_path, monkeypatch):
    """A fresh heartbeat means the worker is alive — the watchdog must not
    respawn it (the common path stays a single stat() with no worker import)."""
    import time as _time

    import tokenwise.paths as paths
    from tokenwise import project as project_mod
    from tokenwise import worker as worker_mod

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
    assert result == {"continue": True}
    assert called == [], "a live worker must not be respawned"
