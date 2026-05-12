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
