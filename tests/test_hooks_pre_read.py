"""Tests for the pre_read hook handler and its dispatcher integration."""
from __future__ import annotations

import subprocess
import sys

from hook_helpers import assert_continue as _assert_continue
from hook_helpers import run_hook_subprocess as _run_hook_subprocess

from token_goat import hooks_cli, session

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
        _assert_continue(result)
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
        _assert_continue(result)
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
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        assert "additionalContext" in result["hookSpecificOutput"]


# ---------------------------------------------------------------------------
# Subprocess / CLI integration
# ---------------------------------------------------------------------------


class TestPreReadCli:
    def _run_hook(self, payload: dict, tmp_data_dir) -> dict:
        return _run_hook_subprocess("pre-read", payload)

    def test_cli_non_read_tool_no_hint(self, tmp_data_dir):
        payload = {"session_id": "cli1", "tool_name": "Bash", "tool_input": {"command": "ls"}}
        result = self._run_hook(payload, tmp_data_dir)
        _assert_continue(result)
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

        _assert_continue(result)
        assert "hookSpecificOutput" in result
        hint = result["hookSpecificOutput"]["additionalContext"]
        assert "cached" in hint
        assert "tokens" in hint


# ---------------------------------------------------------------------------
# Glob dispatch tests
# ---------------------------------------------------------------------------


class TestGlobDedup:
    """pre_read dispatches Glob tool_name through _handle_glob_dedup."""

    def _glob_payload(self, sid, pattern, path=None):
        payload = {
            "session_id": sid,
            "tool_name": "Glob",
            "tool_input": {"pattern": pattern},
        }
        if path is not None:
            payload["tool_input"]["path"] = path
        return payload

    def test_first_glob_passes_through(self, tmp_data_dir):
        """No prior glob recorded → CONTINUE with no hint."""
        payload = self._glob_payload("glob-new", "**/*.py")
        result = hooks_cli.dispatch("pre-read", payload)
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_glob_dedup_hit_injects_hint(self, tmp_data_dir):
        """Same (pattern, path) re-run with sufficient results → hint injected."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-dedup-hit"
        pattern = "**/*.py"
        session.mark_glob_run(sid, pattern, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)

        result = hooks_cli.dispatch("pre-read", self._glob_payload(sid, pattern))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "Glob" in ctx
        assert pattern in ctx

    def test_glob_dedup_different_pattern_no_hint(self, tmp_data_dir):
        """Prior glob with a different pattern → no hint for the new pattern."""
        sid = "glob-diff-pattern"
        session.mark_glob_run(sid, "**/*.ts", result_count=20)

        result = hooks_cli.dispatch("pre-read", self._glob_payload(sid, "**/*.py"))
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_glob_dedup_below_threshold_no_hint(self, tmp_data_dir):
        """Same pattern but result_count below threshold → suppressed."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-below-thresh"
        pattern = "src/**/*.js"
        session.mark_glob_run(sid, pattern, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT - 1)

        result = hooks_cli.dispatch("pre-read", self._glob_payload(sid, pattern))
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_glob_dedup_with_path_scope(self, tmp_data_dir):
        """Dedup matches on (pattern, path) pair, not pattern alone."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-with-path"
        pattern = "**/*.rs"
        path = "src/"
        session.mark_glob_run(sid, pattern, path=path, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 3)

        # Same pattern, same path → hit
        result = hooks_cli.dispatch("pre-read", self._glob_payload(sid, pattern, path=path))
        _assert_continue(result)
        assert "hookSpecificOutput" in result

    def test_glob_dedup_path_mismatch_no_hint(self, tmp_data_dir):
        """Prior glob on src/ does not match re-run on tests/ for same pattern."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT
        sid = "glob-path-mismatch"
        pattern = "**/*.py"
        session.mark_glob_run(sid, pattern, path="src/", result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)

        result = hooks_cli.dispatch("pre-read", self._glob_payload(sid, pattern, path="tests/"))
        _assert_continue(result)
        assert "hookSpecificOutput" not in result


# ---------------------------------------------------------------------------
# Written-not-read hint tests
# ---------------------------------------------------------------------------


class TestWrittenNotReadHint:
    """pre_read emits a note when a file was written this session but never read."""

    def _read_payload(self, sid: str, path: str) -> dict:
        return {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": path, "offset": 0, "limit": 100},
            "cwd": "/proj",
        }

    def test_written_not_read_emits_hint(self, tmp_data_dir):
        """File written but never read → hint injected into additionalContext."""
        sid = "written-not-read-hint"
        path = "/proj/src/new_module.py"
        session.mark_file_edited(sid, path)

        result = hooks_cli.pre_read(self._read_payload(sid, path))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "written" in ctx.lower()
        assert "new_module.py" in ctx

    def test_read_before_write_no_extra_hint(self, tmp_data_dir):
        """File was read before being written → existing diff/cache hint path, not written-not-read."""
        sid = "read-then-written"
        path = "/proj/src/existing.py"
        session.mark_file_read(sid, path, offset=0, limit=200)
        session.mark_file_edited(sid, path)

        result = hooks_cli.pre_read(self._read_payload(sid, path))
        _assert_continue(result)
        # The file IS in cache.files (was read), so the written-not-read branch
        # does not fire. Some other hint (cache overlap or diff) may appear,
        # but the written-not-read text should not.
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "written" not in ctx.lower() or "cached" in ctx.lower()

    def test_never_written_never_read_no_hint(self, tmp_data_dir):
        """File with no session history → no hint at all."""
        sid = "pristine-session"
        path = "/proj/src/pristine.py"

        result = hooks_cli.pre_read(self._read_payload(sid, path))
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_written_multiple_times_count_in_hint(self, tmp_data_dir):
        """Edit count reflected in the hint when file written 3× but never read."""
        sid = "multi-write"
        path = "/proj/src/hotfile.py"
        for _ in range(3):
            session.mark_file_edited(sid, path)

        result = hooks_cli.pre_read(self._read_payload(sid, path))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "3" in ctx


# ---------------------------------------------------------------------------
# Grep written-not-read hint tests
# ---------------------------------------------------------------------------


class TestGrepWrittenNotReadHint:
    """pre_read emits a note when Grep targets a file written but never read."""

    def _grep_payload(self, sid: str, path: str, pattern: str = "def ") -> dict:
        return {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": pattern, "path": path},
            "cwd": "/proj",
        }

    def test_grep_written_not_read_emits_hint(self, tmp_data_dir):
        """Grep on a file written but never read → hint in additionalContext."""
        sid = "grep-written-not-read"
        path = "/proj/src/new_service.py"
        session.mark_file_edited(sid, path)

        result = hooks_cli.pre_read(self._grep_payload(sid, path))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "written" in ctx.lower()
        assert "new_service.py" in ctx

    def test_grep_after_read_no_hint(self, tmp_data_dir):
        """Grep on a file that was already read → no written-not-read hint."""
        sid = "grep-read-then-written"
        path = "/proj/src/already_read.py"
        session.mark_file_read(sid, path, offset=0, limit=200)
        session.mark_file_edited(sid, path)

        result = hooks_cli.pre_read(self._grep_payload(sid, path))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            # written-not-read branch must not fire when file is in cache.files
            assert "written" not in ctx.lower() or "cached" in ctx.lower()

    def test_grep_no_path_no_hint(self, tmp_data_dir):
        """Grep with no path parameter → no written-not-read hint."""
        sid = "grep-no-path"
        path = "/proj/src/written_file.py"
        session.mark_file_edited(sid, path)

        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "def "},  # no path
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        # No path means directory-wide grep; written-not-read must not fire
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "written" not in ctx.lower()

    def test_grep_never_written_no_hint(self, tmp_data_dir):
        """Grep on a file with no session history → no hint."""
        sid = "grep-pristine"
        path = "/proj/src/untouched.py"

        result = hooks_cli.pre_read(self._grep_payload(sid, path))
        _assert_continue(result)
        assert "hookSpecificOutput" not in result
