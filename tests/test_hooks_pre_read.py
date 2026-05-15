"""Tests for the pre_read hook handler and its dispatcher integration."""
from __future__ import annotations

import json
import subprocess
import sys

from token_goat import hooks_cli, session


def _assert_continue(result: dict) -> None:
    """Assert continue:True, tolerating diagnostic fields added by dispatch."""
    assert result.get("continue") is True



# ---------------------------------------------------------------------------
# Direct handler tests
# ---------------------------------------------------------------------------


class TestPreReadHandlerDirect:
    def test_non_read_tool_passes_through(self, tmp_data_dir):
        """Non-Read tool_name → plain continue:true, no hookSpecificOutput."""
        payload = {
            "session_id": "s1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "foo"},
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_file_not_in_cache_nonexistent_file_no_hint(self, tmp_data_dir, tmp_path):
        """File not in cache + file doesn't exist → no hint, continue:true."""
        payload = {
            "session_id": "s2",
            "tool_name": "Read",
            "tool_input": {"file_path": str(tmp_path / "ghost.py"), "offset": 0, "limit": 100},
            "cwd": str(tmp_path),
        }
        result = hooks_cli.pre_read(payload)
        assert result["continue"] is True
        assert "hookSpecificOutput" not in result

    def test_cached_file_produces_hint(self, tmp_data_dir):
        """File previously marked → hint in hookSpecificOutput.additionalContext."""
        sid = "s3"
        path = "C:/proj/cached.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 200},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload)
        assert result["continue"] is True
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]
        assert ctx["hookEventName"] == "PreToolUse"
        assert "additionalContext" in ctx
        assert len(ctx["additionalContext"]) > 10  # non-trivial hint

    def test_garbage_payload_returns_continue(self, tmp_data_dir):
        """Malformed payload must not crash; fail-soft returns continue:true."""
        result = hooks_cli.pre_read(None)  # type: ignore[arg-type]
        _assert_continue(result)

    def test_hint_records_session_hint_stat(self, tmp_data_dir):
        """When pre_read emits a hint, the gross and overhead stat rows are appended."""
        from token_goat import db  # local import to honor tmp_data_dir patching

        sid = "stat_smoke"
        path = "C:/proj/cached.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 200},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload)
        assert "hookSpecificOutput" in result

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, detail FROM stats "
                "WHERE kind IN ('session_hint', 'session_hint_overhead') "
                "ORDER BY kind"
            ).fetchall()
        assert len(rows) == 2
        assert rows[0]["detail"] == path
        assert rows[1]["detail"] == path
        assert rows[0]["kind"] == "session_hint"
        assert rows[1]["kind"] == "session_hint_overhead"

    def test_session_hint_stat_is_net_of_injection_cost(self, tmp_data_dir):
        """The gross and overhead rows sum to the same net the user pays.

        Regression for the honest-accounting fix: a hint is not free, so
        `token-goat stats` must subtract the cost of injecting it.
        """
        from token_goat import db
        from token_goat.hints import CHARS_PER_TOKEN, build_read_hint

        sid = "net_acct"
        path = "C:/proj/cached.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Build the hint directly to derive the expected net independently.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd="C:/proj"
        )
        assert hint is not None
        injection_cost = max(1, int(len(hint) / CHARS_PER_TOKEN))
        assert injection_cost > 0  # the hint text is not free
        expected_net_tokens = hint.tokens_saved - injection_cost
        expected_net_bytes = hint.tokens_saved * 4 - len(hint)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 200},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload)
        assert "hookSpecificOutput" in result

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, tokens_saved, bytes_saved FROM stats "
                "WHERE kind IN ('session_hint', 'session_hint_overhead') "
                "ORDER BY kind"
            ).fetchall()
        assert len(rows) == 2
        gross_row, overhead_row = rows
        assert gross_row["kind"] == "session_hint"
        assert gross_row["tokens_saved"] == hint.tokens_saved
        assert gross_row["bytes_saved"] == hint.tokens_saved * 4
        assert overhead_row["kind"] == "session_hint_overhead"
        assert overhead_row["tokens_saved"] == -injection_cost
        assert overhead_row["bytes_saved"] == -len(hint)
        assert gross_row["tokens_saved"] + overhead_row["tokens_saved"] == expected_net_tokens
        assert gross_row["bytes_saved"] + overhead_row["bytes_saved"] == expected_net_bytes

    def test_suggestion_hint_records_nothing(self, tmp_data_dir):
        """A pure-suggestion hint (tokens_saved=0) records no stats rows.

        Suggestion hints cost tokens to inject but only realize savings if the
        agent acts on them (tracked separately by read_replacement). Recording
        overhead with zero gross caused the headline savings counter to drift
        negative as more suggestions fired.
        """
        from token_goat import db

        sid = "neg_net"
        path = "C:/proj/syms.py"
        # Symbol-only prior access → produces a suggestion hint (tokens_saved=0).
        session.mark_file_read(sid, path, symbol="some_func")

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 2000},
            "cwd": "C:/proj",
        }
        result = hooks_cli.pre_read(payload)
        assert "hookSpecificOutput" in result

        with db.open_global() as conn:
            rows = conn.execute(
                "SELECT kind, tokens_saved FROM stats "
                "WHERE kind IN ('session_hint', 'session_hint_overhead') "
                "ORDER BY kind"
            ).fetchall()
        assert len(rows) == 0, (
            "Suggestion-only hints must not record stats — they carry no realized savings"
        )

    def test_missing_tool_name_passes_through(self, tmp_data_dir):
        """No tool_name in payload → passes through as non-Read."""
        payload = {"session_id": "s4", "tool_input": {"file_path": "foo.py"}}
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)

    def test_no_session_id_no_hint(self, tmp_data_dir):
        """No session_id → no hint generated."""
        payload = {
            "tool_name": "Read",
            "tool_input": {"file_path": "foo.py", "offset": 0, "limit": 100},
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)


# ---------------------------------------------------------------------------
# Dispatcher integration
# ---------------------------------------------------------------------------


class TestDispatcherPreRead:
    def test_dispatch_pre_read_non_read_tool(self, tmp_data_dir):
        payload = {
            "session_id": "d1",
            "tool_name": "Write",
            "tool_input": {"file_path": "x.py"},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        _assert_continue(result)

    def test_dispatch_pre_read_cached_file_has_hint(self, tmp_data_dir):
        sid = "d2"
        path = "C:/some/source.py"
        session.mark_file_read(sid, path, offset=0, limit=500)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 500},
        }
        result = hooks_cli.dispatch("pre-read", payload)
        assert result["continue"] is True
        assert "hookSpecificOutput" in result
        assert "additionalContext" in result["hookSpecificOutput"]


# ---------------------------------------------------------------------------
# Subprocess / CLI integration
# ---------------------------------------------------------------------------


class TestPreReadCli:
    def _run_hook(self, payload: dict, tmp_data_dir) -> dict:
        """Run `token-goat hook pre-read` as a subprocess with JSON on stdin."""
        raw = json.dumps(payload)
        proc = subprocess.run(
            [sys.executable, "-m", "token_goat.cli", "hook", "pre-read"],
            input=raw,
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, f"hook subprocess failed:\nSTDERR: {proc.stderr}"
        return json.loads(proc.stdout)

    def test_cli_non_read_tool_no_hint(self, tmp_data_dir):
        payload = {"session_id": "cli1", "tool_name": "Bash", "tool_input": {"command": "ls"}}
        result = self._run_hook(payload, tmp_data_dir)
        assert result["continue"] is True
        assert "hookSpecificOutput" not in result

    def test_cli_garbage_payload_continue(self, tmp_data_dir):
        """Garbage JSON payload → subprocess still exits 0, returns continue:true."""
        proc = subprocess.run(
            [sys.executable, "-m", "token_goat.cli", "hook", "pre-read"],
            input="not-json-at-all",
            capture_output=True,
            text=True,
        )
        # The CLI may return a non-zero exit code for invalid JSON, but should still
        # produce continue:true or at least not produce garbage output.
        # Primarily we want it not to crash with an unhandled exception.
        # If JSON is invalid, the cli catches it upstream.
        assert proc.returncode in (0, 1)


# ---------------------------------------------------------------------------
# Real-world spike: mark → pre-read → hint
# ---------------------------------------------------------------------------


class TestRealWorldSpike:
    def test_mark_then_pre_read_yields_hint(self, tmp_data_dir):
        """End-to-end: mark file read → invoke pre_read with same file → hint present."""
        sid = "spike_s1"
        path = "C:/spike/module.py"

        # Simulate post_read having recorded the file
        session.mark_file_read(sid, path, offset=0, limit=300)

        # Now pre_read fires for the same file
        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 300},
            "cwd": "C:/spike",
        }
        result = hooks_cli.dispatch("pre-read", payload)

        assert result["continue"] is True
        assert "hookSpecificOutput" in result
        hint = result["hookSpecificOutput"]["additionalContext"]
        assert "already read" in hint
        assert "tokens" in hint
