"""Tests for the in-process HTTP hook relay (hook_relay.py)."""
from __future__ import annotations

import json
import sys
import threading
import urllib.request
from pathlib import Path
from unittest.mock import patch

import pytest

import token_goat.hook_relay as relay

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _post(port: int, path: str, body: bytes | dict = b"{}") -> tuple[int, dict]:
    """POST to the relay and return (status_code, json_body)."""
    if isinstance(body, dict):
        body = json.dumps(body).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Content-Length": str(len(body))},
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return resp.status, json.loads(resp.read())


# ---------------------------------------------------------------------------
# Isolation fixture — resets module globals and port file before/after each test
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _reset_relay(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[return]
    """Ensure each test starts with the relay stopped and port file isolated."""
    # Redirect port file to tmp_path so tests never touch real data dir.
    port_file = tmp_path / "hook-relay.port"
    monkeypatch.setattr("token_goat.hook_relay.relay", relay, raising=False)

    import token_goat.paths as paths_mod
    monkeypatch.setattr(paths_mod, "hook_relay_port_path", lambda: port_file)

    yield

    relay.stop_relay()
    # Hard-reset globals in case stop_relay left them dirty (e.g. shutdown raised).
    relay._relay_server = None
    relay._relay_thread = None


# ---------------------------------------------------------------------------
# start_relay / stop_relay lifecycle
# ---------------------------------------------------------------------------

def test_start_relay_returns_nonzero_port(tmp_path: Path) -> None:
    port = relay.start_relay()
    assert isinstance(port, int)
    assert port > 0


def test_start_relay_idempotent(tmp_path: Path) -> None:
    p1 = relay.start_relay()
    p2 = relay.start_relay()
    assert p1 == p2
    assert p1 > 0


def test_start_relay_writes_port_file(tmp_path: Path) -> None:
    import token_goat.paths as paths_mod
    port = relay.start_relay()
    port_file = paths_mod.hook_relay_port_path()
    assert port_file.exists()
    assert int(port_file.read_text().strip()) == port


def test_stop_relay_removes_port_file(tmp_path: Path) -> None:
    import token_goat.paths as paths_mod
    relay.start_relay()
    relay.stop_relay()
    assert not paths_mod.hook_relay_port_path().exists()


def test_stop_relay_clears_globals() -> None:
    relay.start_relay()
    relay.stop_relay()
    assert relay._relay_server is None
    assert relay._relay_thread is None


def test_stop_relay_idempotent() -> None:
    relay.start_relay()
    relay.stop_relay()
    relay.stop_relay()  # second call must not raise


def test_stop_relay_clears_server_even_if_shutdown_raises() -> None:
    relay.start_relay()
    original_shutdown = relay._relay_server.shutdown  # type: ignore[union-attr]
    with patch.object(relay._relay_server, "shutdown", side_effect=RuntimeError("boom")):
        relay.stop_relay()
    assert relay._relay_server is None
    assert relay._relay_thread is None
    # cleanup: real shutdown so the serve_forever thread exits
    original_shutdown()


def test_restart_after_stop_gets_fresh_port() -> None:
    relay.start_relay()
    relay.stop_relay()
    p2 = relay.start_relay()
    assert p2 > 0
    # Ports MAY differ (OS chooses); both are valid.  The important thing is
    # that start_relay() works after a full stop, not a specific port value.


# ---------------------------------------------------------------------------
# HTTP round-trips
# ---------------------------------------------------------------------------

def test_unknown_event_returns_continue() -> None:
    port = relay.start_relay()
    status, body = _post(port, "/hook/not-a-real-event", {})
    assert status == 200
    assert body.get("continue") is True


def test_empty_body_returns_continue() -> None:
    port = relay.start_relay()
    status, body = _post(port, "/hook/not-a-real-event", b"")
    assert status == 200
    assert body.get("continue") is True


def test_malformed_json_body_returns_continue() -> None:
    port = relay.start_relay()
    status, body = _post(port, "/hook/not-a-real-event", b"{not valid json}")
    assert status == 200
    assert body.get("continue") is True


def test_bad_path_returns_continue() -> None:
    port = relay.start_relay()
    status, body = _post(port, "/wrong-path", {})
    assert status == 200
    assert body.get("continue") is True


def test_no_event_segment_returns_continue() -> None:
    port = relay.start_relay()
    status, body = _post(port, "/hook", {})
    assert status == 200
    assert body.get("continue") is True


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------

def test_concurrent_requests_all_return_continue() -> None:
    port = relay.start_relay()
    n = 20
    results: list[dict | Exception] = [None] * n  # type: ignore[list-item]

    def worker(i: int) -> None:
        try:
            _, body = _post(port, "/hook/not-a-real-event", {"idx": i})
            results[i] = body
        except Exception as exc:
            results[i] = exc

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    errors = [r for r in results if isinstance(r, Exception)]
    assert not errors, f"concurrent requests raised: {errors}"
    assert all(r.get("continue") is True for r in results if isinstance(r, dict))


# ---------------------------------------------------------------------------
# OSError suppression in _respond
# ---------------------------------------------------------------------------

def test_wfile_write_oserror_does_not_propagate() -> None:
    """A BrokenPipeError from a timed-out client must not surface from the handler."""
    import io

    handler = relay._HookRelayHandler.__new__(relay._HookRelayHandler)

    class BrokenFile:
        def write(self, data: bytes) -> None:
            raise BrokenPipeError("client gone")

    # Minimal attribute stubs needed to call _respond() without a real socket.
    class FakeRequest:
        def makefile(self, *a: object, **kw: object) -> io.BytesIO:
            return io.BytesIO()

    handler.rfile = io.BytesIO()
    handler.wfile = BrokenFile()  # type: ignore[assignment]
    handler.request = FakeRequest()  # type: ignore[assignment]
    handler.server = object()  # type: ignore[assignment]
    handler.close_connection = False

    # Stub send_response / send_header / end_headers to write to broken_buf instead
    # (they normally write to wfile too, but we only want to test _respond's guard).
    handler.send_response = lambda *a: None  # type: ignore[method-assign]
    handler.send_header = lambda *a: None  # type: ignore[method-assign]
    handler.end_headers = lambda: None  # type: ignore[method-assign]

    # Must not raise.
    handler._respond({"continue": True})


# ---------------------------------------------------------------------------
# check_relay_liveness
# ---------------------------------------------------------------------------

def test_liveness_noop_when_no_relay() -> None:
    """check_relay_liveness must not raise when relay is not started."""
    relay.check_relay_liveness()  # relay is stopped


def test_liveness_noop_when_thread_alive() -> None:
    """check_relay_liveness does nothing when thread is healthy."""
    relay.start_relay()
    relay.check_relay_liveness()
    # Relay still running after liveness check
    assert relay._relay_server is not None
    assert relay._relay_thread is not None
    assert relay._relay_thread.is_alive()


def test_liveness_restarts_dead_relay(tmp_path: Path) -> None:
    """If thread.is_alive() returns False, liveness check clears state and restarts."""
    relay.start_relay()
    assert relay._relay_thread is not None

    with patch.object(relay._relay_thread, "is_alive", return_value=False):
        relay.check_relay_liveness()

    # After liveness check, relay should be restarted (globals reset + new server).
    assert relay._relay_server is not None
    assert relay._relay_thread is not None
    assert relay._relay_thread.is_alive()


def test_liveness_port_file_rewritten_after_restart(tmp_path: Path) -> None:
    """Port file must reflect the new port after a liveness-triggered restart."""
    import token_goat.paths as paths_mod

    relay.start_relay()
    original_thread = relay._relay_thread
    assert original_thread is not None

    with patch.object(original_thread, "is_alive", return_value=False):
        relay.check_relay_liveness()

    port_file = paths_mod.hook_relay_port_path()
    assert port_file.exists()
    new_port = int(port_file.read_text().strip())
    assert new_port > 0


# ---------------------------------------------------------------------------
# hook_wrapper_content CMD structure assertions (paths.py generator)
# ---------------------------------------------------------------------------

@pytest.mark.skipif(sys.platform != "win32", reason="relay block is Windows CMD only")
def test_hook_wrapper_content_contains_relay_block() -> None:
    """The generated tg-hook.cmd must include the curl relay fast path."""
    from token_goat import paths as paths_mod

    content = paths_mod.hook_wrapper_content()

    assert 'FOR /F "usebackq tokens=*" %%P IN' in content, "FOR /F usebackq missing"
    assert "%%P/hook/" in content, "%%P port interpolation missing"
    assert "curl.exe" in content, "curl.exe call missing"
    assert "IF NOT ERRORLEVEL 1" in content, "ERRORLEVEL success-exit guard missing"
    assert "EXIT /B 0" in content, "EXIT /B 0 missing"
    # Fallback pythonw must still be present.
    assert "token_goat.cli" in content, "pythonw fallback missing"
