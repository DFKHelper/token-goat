"""In-process HTTP relay for Claude Code hook events.

The daemon starts a lightweight HTTP server on localhost that accepts hook
payloads and dispatches them without spawning a new Python process per event.
The tg-hook.cmd wrapper tries this relay first (via curl.exe); it only falls
back to spawning pythonw.exe when the relay is unavailable.

Wire-format
-----------
  POST http://127.0.0.1:{PORT}/hook/{event-name}
  Content-Type: application/json
  Body: the raw hook payload JSON that Claude Code pipes to stdin

The response body is the hook response JSON that would normally go to stdout.
"""
from __future__ import annotations

import contextlib
import http.server
import json
import logging
import threading
from http.server import ThreadingHTTPServer

from .hooks_common import HookPayload

_LOG = logging.getLogger(__name__)

_relay_server: http.server.HTTPServer | None = None
_relay_thread: threading.Thread | None = None
_relay_lock = threading.Lock()
_RELAY_LIVENESS_INTERVAL = 60.0


class _HookRelayHandler(http.server.BaseHTTPRequestHandler):
    """Minimal HTTP handler: POST /hook/<event> with payload JSON as body."""

    def do_POST(self) -> None:
        path = self.path.lstrip("/")
        parts = path.split("/", 1)
        if len(parts) != 2 or parts[0] != "hook":
            self.close_connection = True
            self._respond({"continue": True})
            return
        event = parts[1]

        try:
            length = min(int(self.headers.get("Content-Length", 0)), 1_048_576)
        except (ValueError, TypeError):
            length = 0
        body = self.rfile.read(length) if length else b"{}"
        try:
            raw: HookPayload = json.loads(body) if body else {}
        except (json.JSONDecodeError, ValueError):
            raw = {}

        result: dict = {"continue": True}
        try:
            from . import hooks_cli
            payload = hooks_cli.normalize_payload(raw, "claude")
            result = hooks_cli.dispatch(event, payload)
        except Exception:
            _LOG.exception("hook relay: unhandled error dispatching %r", event)

        self._respond(result)

    def _respond(self, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        with contextlib.suppress(OSError):
            self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def start_relay() -> int:
    """Start the hook relay on a random localhost port.

    Idempotent — returns the existing port if already started.  Writes the
    port number to paths.hook_relay_port_path() so tg-hook.cmd can discover
    it without any IPC.  Returns 0 on failure.
    """
    global _relay_server, _relay_thread
    with _relay_lock:
        if _relay_server is not None:
            return _relay_server.server_address[1]  # type: ignore[index]
        try:
            from . import paths
            server = ThreadingHTTPServer(("127.0.0.1", 0), _HookRelayHandler)
            port: int = server.server_address[1]  # type: ignore[index]
            port_path = paths.hook_relay_port_path()
            port_path.parent.mkdir(parents=True, exist_ok=True)
            paths.atomic_write_text(port_path, str(port))
            thread = threading.Thread(
                target=server.serve_forever,
                name="tg-hook-relay",
                daemon=True,
            )
            thread.start()
            _relay_server = server
            _relay_thread = thread
            _LOG.info("hook relay started on port %d", port)
            return port
        except Exception:
            _LOG.exception("hook relay: failed to start")
            return 0


def stop_relay() -> None:
    """Stop the relay and remove the port file (called on daemon shutdown)."""
    global _relay_server, _relay_thread
    with _relay_lock:
        if _relay_server is None:
            return
        server, _relay_server = _relay_server, None
        _relay_thread = None
        try:
            server.shutdown()
        except Exception:
            _LOG.exception("hook relay: error during shutdown")
        try:
            from . import paths
            paths.hook_relay_port_path().unlink(missing_ok=True)
        except Exception:
            _LOG.exception("hook relay: failed to remove port file")
def check_relay_liveness() -> None:
    """Restart the relay if its serve_forever thread has exited unexpectedly.

    Called periodically by the worker daemon main loop.  A dead relay leaves the
    port file pointing at a closed socket; restarting overwrites it atomically so
    tg-hook.cmd picks up the new port on its next invocation.
    """
    global _relay_server, _relay_thread
    needs_restart = False
    with _relay_lock:
        if _relay_server is not None and _relay_thread is not None and not _relay_thread.is_alive():
            _LOG.warning("hook relay thread died unexpectedly; will restart")
            _relay_server = None
            _relay_thread = None
            needs_restart = True
    if needs_restart:
        start_relay()

