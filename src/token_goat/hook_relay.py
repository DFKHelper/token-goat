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

import http.server
import json
import logging
import threading

_LOG = logging.getLogger(__name__)

_relay_server: http.server.HTTPServer | None = None
_relay_lock = threading.Lock()


class _HookRelayHandler(http.server.BaseHTTPRequestHandler):
    """Minimal HTTP handler: POST /hook/<event> with payload JSON as body."""

    def do_POST(self) -> None:
        path = self.path.lstrip("/")
        parts = path.split("/", 1)
        if len(parts) != 2 or parts[0] != "hook":
            self._respond({"continue": True})
            return
        event = parts[1]

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            raw: dict = json.loads(body) if body else {}
        except (json.JSONDecodeError, ValueError):
            raw = {}

        try:
            from . import hooks_cli
            payload = hooks_cli.normalize_payload(raw, "claude")
            result = hooks_cli.dispatch(event, payload)
        except Exception:
            _LOG.exception("hook relay: unhandled error dispatching %r", event)
            result = {"continue": True}

        self._respond(result)

    def _respond(self, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: object) -> None:
        pass


def start_relay() -> int:
    """Start the hook relay on a random localhost port.

    Idempotent — returns the existing port if already started.  Writes the
    port number to paths.hook_relay_port_path() so tg-hook.cmd can discover
    it without any IPC.  Returns 0 on failure.
    """
    global _relay_server
    with _relay_lock:
        if _relay_server is not None:
            return _relay_server.server_address[1]  # type: ignore[index]
        try:
            from . import paths
            server = http.server.HTTPServer(("127.0.0.1", 0), _HookRelayHandler)
            port: int = server.server_address[1]  # type: ignore[index]
            port_path = paths.hook_relay_port_path()
            port_path.parent.mkdir(parents=True, exist_ok=True)
            port_path.write_text(str(port), encoding="utf-8")
            thread = threading.Thread(
                target=server.serve_forever,
                name="tg-hook-relay",
                daemon=True,
            )
            thread.start()
            _relay_server = server
            _LOG.info("hook relay started on port %d", port)
            return port
        except Exception:
            _LOG.exception("hook relay: failed to start")
            return 0


def stop_relay() -> None:
    """Stop the relay and remove the port file (called on daemon shutdown)."""
    global _relay_server
    with _relay_lock:
        if _relay_server is None:
            return
        try:
            _relay_server.shutdown()
            _relay_server = None
        except Exception:
            _LOG.exception("hook relay: error during shutdown")
        try:
            from . import paths
            paths.hook_relay_port_path().unlink(missing_ok=True)
        except Exception:
            _LOG.exception("hook relay: failed to remove port file")
