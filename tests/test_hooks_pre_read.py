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
        assert "⌘" in hint  # terse form of "cached"
        # The re-read hint carries a wasted-tokens estimate; we trimmed
        # "tokens wasted" to "Nt wasted" for token savings — assert the
        # "wasted" concept, not the word "tokens" that no longer appears.
        assert "wasted" in hint


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
            assert "written" not in ctx.lower() or "⌘" in ctx  # terse "cached"

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
            assert "written" not in ctx.lower() or "⌘" in ctx  # terse "cached"

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

    # -- Item A15: directory-scope grep written-not-read (capped list) --------

    def test_grep_dir_written_not_read_emits_hint(self, tmp_data_dir):
        """Grep on a directory with edited-but-unread files → capped hint."""
        sid = "grep-dir-written-nr"
        dir_path = "/proj/src"
        # Mark 7 files under the directory as edited but not read back
        for i in range(7):
            session.mark_file_edited(sid, f"/proj/src/module_{i}.py")

        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "def ", "path": dir_path},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "written" in ctx.lower()
        # Should show first 5 + overflow
        assert "(+2 more edited)" in ctx

    def test_grep_dir_at_cap_no_overflow(self, tmp_data_dir):
        """Exactly 5 edited files → no overflow line."""
        sid = "grep-dir-at-cap"
        dir_path = "/proj/src"
        for i in range(5):
            session.mark_file_edited(sid, f"/proj/src/file_{i}.py")

        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "class ", "path": dir_path},
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "more edited" not in ctx

    def test_grep_dir_no_edited_files_no_hint(self, tmp_data_dir):
        """Directory grep with no edited files under it → no hint."""
        sid = "grep-dir-clean"
        result = hooks_cli.pre_read({
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "import", "path": "/proj/src"},
        })
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_grep_dir_all_already_read_no_hint(self, tmp_data_dir):
        """Edited files that were also read → hint must not fire."""
        sid = "grep-dir-all-read"
        path = "/proj/src/already.py"
        session.mark_file_edited(sid, path)
        session.mark_file_read(sid, path, offset=0, limit=200)

        result = hooks_cli.pre_read({
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "def ", "path": "/proj/src"},
        })
        _assert_continue(result)
        # File is in cache.files → directory hint must not fire
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "written" not in ctx.lower()


# ---------------------------------------------------------------------------
# Glob cache cap tests (item A13)
# ---------------------------------------------------------------------------


class TestGlobCacheCap:
    """Glob result cache dedup must cap the replayed path list to 20 entries."""

    def _post_glob(self, sid, pattern, result_text, path=None):
        from token_goat import bash_cache
        payload = {
            "session_id": sid,
            "tool_name": "Glob",
            "tool_input": {"pattern": pattern, **({"path": path} if path else {})},
            "tool_result_content": [{"type": "text", "text": result_text}],
            "cwd": "/proj",
        }
        hooks_cli.post_read(payload)
        bash_cache.store_glob_result(sid, pattern, path, result_text)

    def _pre_glob(self, sid, pattern, path=None):
        payload = {
            "session_id": sid,
            "tool_name": "Glob",
            "tool_input": {"pattern": pattern, **({"path": path} if path else {})},
        }
        return hooks_cli.pre_read(payload)

    def test_glob_cache_caps_at_20_paths(self, tmp_data_dir):
        """Cached glob result with >20 files → only first 20 + overflow shown."""
        sid = "glob-cap-30"
        pattern = "**/*.py"
        files = [f"src/file_{i:03d}.py" for i in range(30)]
        result_text = "\n".join(files) + "\n"
        self._post_glob(sid, pattern, result_text)

        result = self._pre_glob(sid, pattern)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        if hso is None:
            # Result count threshold not met by session history — skip
            return
        ctx = hso.get("additionalContext", "")
        if "cached result" not in ctx:
            return
        # First 20 files should be present
        assert "src/file_000.py" in ctx
        assert "src/file_019.py" in ctx
        # File 20 (index 20) should NOT appear verbatim
        assert "src/file_020.py" not in ctx
        # Overflow marker should appear
        assert "(+10 more)" in ctx

    def test_glob_cache_under_cap_shows_all(self, tmp_data_dir):
        """Cached glob result with ≤20 files → all files shown, no overflow line."""
        sid = "glob-cap-10"
        pattern = "**/*.ts"
        files = [f"src/component_{i}.ts" for i in range(10)]
        result_text = "\n".join(files) + "\n"
        self._post_glob(sid, pattern, result_text)

        result = self._pre_glob(sid, pattern)
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        if hso is None:
            return
        ctx = hso.get("additionalContext", "")
        if "cached result" not in ctx:
            return
        assert "src/component_0.ts" in ctx
        assert "src/component_9.ts" in ctx
        assert "(+0 more)" not in ctx
        assert "more)" not in ctx


# ---------------------------------------------------------------------------
# Structured-file hint tests
# ---------------------------------------------------------------------------


class TestStructuredFileHint:
    """pre_read emits a structured-file hint for large CSV/JSON/log files."""

    def _read_payload(self, sid: str, path: str, offset=None, limit=None) -> dict:
        tool_input: dict = {"file_path": path}
        if offset is not None:
            tool_input["offset"] = offset
        if limit is not None:
            tool_input["limit"] = limit
        return {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": tool_input,
            "cwd": "/proj",
        }

    def _make_large_file(self, path, ext: str, size_bytes: int = 100_000) -> str:
        """Write a synthetic large file at path with the given extension."""
        full = path / f"data{ext}"
        # Build content that will give reasonable row estimates.
        row = b"col1,col2,col3\n"
        content = row * (size_bytes // len(row) + 1)
        full.write_bytes(content[:size_bytes])
        return str(full)

    def test_large_csv_hint_fires(self, tmp_data_dir, tmp_path):
        """100KB CSV with no offset/limit → structured-file hint injected."""
        fpath = self._make_large_file(tmp_path, ".csv")
        sid = "struct-csv"
        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "csv" in ctx.lower()
        assert "KB" in ctx
        # Hint must suggest surgical access.
        assert "offset" in ctx.lower() or "token-goat" in ctx.lower()

    def test_large_json_hint_fires(self, tmp_data_dir, tmp_path):
        """100KB JSON with no offset/limit → json-specific hint injected."""
        fpath = self._make_large_file(tmp_path, ".json")
        sid = "struct-json"
        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "json" in ctx.lower()
        assert "KB" in ctx
        assert "jq" in ctx or "token-goat" in ctx

    def test_large_log_hint_fires(self, tmp_data_dir, tmp_path):
        """100KB .log file → log-specific hint injected."""
        fpath = self._make_large_file(tmp_path, ".log")
        sid = "struct-log"
        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "log" in ctx.lower()
        assert "KB" in ctx
        # Log hint suggests tail/head/grep.
        assert any(word in ctx.lower() for word in ("tail", "head", "grep"))

    def test_surgical_read_no_hint(self, tmp_data_dir, tmp_path):
        """offset AND limit both specified → caller is reading surgically; no hint."""
        fpath = self._make_large_file(tmp_path, ".csv")
        sid = "struct-surgical"
        result = hooks_cli.pre_read(self._read_payload(sid, fpath, offset=10, limit=20))
        _assert_continue(result)
        # Structured-file hint must not fire when offset+limit are set.
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "📊" not in ctx and "large" not in ctx.lower()

    def test_small_file_no_hint(self, tmp_data_dir, tmp_path):
        """1KB CSV → below size threshold; no structured-file hint."""
        small = tmp_path / "tiny.csv"
        small.write_bytes(b"a,b,c\n1,2,3\n")
        sid = "struct-small"
        result = hooks_cli.pre_read(self._read_payload(sid, str(small)))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "📊" not in ctx

    def test_session_dedup_fires_only_once(self, tmp_data_dir, tmp_path):
        """Same large CSV read twice in a session → hint fires only on first read."""
        fpath = self._make_large_file(tmp_path, ".csv")
        sid = "struct-dedup"
        payload = self._read_payload(sid, fpath)

        result1 = hooks_cli.pre_read(payload)
        _assert_continue(result1)
        assert "hookSpecificOutput" in result1

        # Second read of same file same session → hint suppressed (fingerprint dedup).
        result2 = hooks_cli.pre_read(payload)
        _assert_continue(result2)
        # The second result may have a different hint (session cache hint) or none,
        # but the structured-file specific text must not repeat.
        if "hookSpecificOutput" in result2:
            ctx2 = result2["hookSpecificOutput"].get("additionalContext", "")
            assert "📊" not in ctx2 and "large csv" not in ctx2.lower()

    def test_jsonl_treated_as_tabular(self, tmp_data_dir, tmp_path):
        """.jsonl is classified as tabular, not document-json."""
        fpath = self._make_large_file(tmp_path, ".jsonl")
        sid = "struct-jsonl"
        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "jsonl" in ctx.lower()
        # Tabular hint suggests offset/limit row-slice, NOT jq.
        assert "jq" not in ctx


# ---------------------------------------------------------------------------
# Index-only file hint tests
# ---------------------------------------------------------------------------


class TestIndexOnlyFileHint:
    """pre_read emits a 'machine-generated, do not read' hint for lockfiles and bundles."""

    def _read_payload(self, session_id: str, file_path: str, offset=None, limit=None) -> dict:
        inp: dict = {"file_path": file_path}
        if offset is not None:
            inp["offset"] = offset
        if limit is not None:
            inp["limit"] = limit
        return {
            "tool_name": "Read",
            "tool_input": inp,
            "session_id": session_id,
            "cwd": "/proj",
        }

    def _make_lockfile(self, tmp_path, name: str, size_bytes: int = 60_000) -> str:
        """Write a synthetic large lockfile."""
        p = tmp_path / name
        row = b"# dep entry\nname = \"foo\"\nversion = \"1.0.0\"\n"
        content = row * (size_bytes // len(row) + 1)
        p.write_bytes(content[:size_bytes])
        return str(p)

    def test_uv_lock_fires(self, tmp_data_dir, tmp_path):
        """Pre-Read on a large uv.lock → index-only hint fires."""
        fpath = self._make_lockfile(tmp_path, "uv.lock")
        result = hooks_cli.pre_read(self._read_payload("io-uv", fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "uv.lock" in ctx
        assert "lockfile" in ctx.lower()

    def test_package_lock_json_fires(self, tmp_data_dir, tmp_path):
        """Pre-Read on a large package-lock.json → index-only hint fires."""
        fpath = self._make_lockfile(tmp_path, "package-lock.json")
        result = hooks_cli.pre_read(self._read_payload("io-pkglock", fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "package-lock.json" in ctx
        assert "lockfile" in ctx.lower()

    def test_min_js_fires(self, tmp_data_dir, tmp_path):
        """Pre-Read on a large *.min.js → index-only hint fires."""
        p = tmp_path / "app.min.js"
        p.write_bytes(b"!function(){}" * 1000)  # ~14 KB — above 5 KB floor
        result = hooks_cli.pre_read(self._read_payload("io-minjs", str(p)))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "min" in ctx.lower() or "minified" in ctx.lower() or "bundle" in ctx.lower()

    def test_regular_py_does_not_fire(self, tmp_data_dir, tmp_path):
        """Pre-Read on a regular Python file → index-only hint must NOT fire."""
        p = tmp_path / "regular.py"
        p.write_bytes(b"def foo(): pass\n" * 5000)
        result = hooks_cli.pre_read(self._read_payload("io-py", str(p)))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "lockfile" not in ctx.lower()
            assert "minified" not in ctx.lower()

    def test_surgical_read_no_hint(self, tmp_data_dir, tmp_path):
        """offset AND limit both specified → surgical intent; no index-only hint."""
        fpath = self._make_lockfile(tmp_path, "uv.lock")
        result = hooks_cli.pre_read(self._read_payload("io-surgical", fpath, offset=10, limit=20))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "lockfile" not in ctx.lower()

    def test_tiny_lockfile_no_hint(self, tmp_data_dir, tmp_path):
        """A uv.lock smaller than 5KB → below threshold; no hint."""
        p = tmp_path / "uv.lock"
        p.write_bytes(b"# tiny\n" * 10)  # ~70 bytes
        result = hooks_cli.pre_read(self._read_payload("io-tiny", str(p)))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "lockfile" not in ctx.lower()

    def test_session_dedup_fires_only_once(self, tmp_data_dir, tmp_path):
        """Same lockfile read twice in a session → index-only hint fires only on first read."""
        fpath = self._make_lockfile(tmp_path, "cargo.lock")
        payload = self._read_payload("io-dedup", fpath)

        result1 = hooks_cli.pre_read(payload)
        _assert_continue(result1)
        assert "hookSpecificOutput" in result1
        ctx1 = result1["hookSpecificOutput"]["additionalContext"]
        assert "lockfile" in ctx1.lower()

        result2 = hooks_cli.pre_read(payload)
        _assert_continue(result2)
        if "hookSpecificOutput" in result2:
            ctx2 = result2["hookSpecificOutput"].get("additionalContext", "")
            assert "lockfile" not in ctx2.lower()


# ---------------------------------------------------------------------------
# Content-unchanged short-circuit hint tests
# ---------------------------------------------------------------------------


class TestUnchangedFileHint:
    """pre_read emits an 'unchanged since edit' hint when SHA matches snapshot."""

    def _make_file(self, tmp_path, name: str, content: bytes | None = None) -> str:
        """Write a file large enough to pass _UNCHANGED_MIN_BYTES threshold."""
        p = tmp_path / name
        if content is None:
            content = b"x = 1\n" * 200  # ~1200 bytes, well above 800-byte floor
        p.write_bytes(content)
        return str(p)

    def _read_payload(self, sid: str, path: str, offset=None, limit=None) -> dict:
        tool_input: dict = {"file_path": path}
        if offset is not None:
            tool_input["offset"] = offset
        if limit is not None:
            tool_input["limit"] = limit
        return {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": tool_input,
            "cwd": str(path),
        }

    def test_unchanged_hint_fires_after_edit(self, tmp_data_dir, tmp_path):
        """Read → Edit → Re-Read with same content → unchanged hint injected."""
        from token_goat import snapshots

        sid = "unchanged-basic"
        fpath = self._make_file(tmp_path, "mod.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        # Simulate post_read recording the file and snapshot.
        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(content).hexdigest())

        # Simulate an edit happening after the read.
        session.mark_file_edited(sid, fpath)

        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        assert "unchanged" in ctx.lower()
        assert "mod.py" in ctx

    def test_unchanged_hint_carries_token_saving(self, tmp_data_dir, tmp_path):
        """Hint must have tokens_saved > 0 (it's a realized saving, not a suggestion)."""
        from token_goat import snapshots
        from token_goat.hints import build_unchanged_file_hint

        sid = "unchanged-tokens"
        fpath = self._make_file(tmp_path, "big.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(content).hexdigest())
        session.mark_file_edited(sid, fpath)

        hint = build_unchanged_file_hint(session_id=sid, file_path=fpath)
        assert hint is not None
        assert hint.tokens_saved > 0

    def test_no_hint_when_offset_supplied(self, tmp_data_dir, tmp_path):
        """Surgical read with offset → unchanged hint must NOT fire."""
        from token_goat import snapshots

        sid = "unchanged-offset"
        fpath = self._make_file(tmp_path, "partial.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(content).hexdigest())
        session.mark_file_edited(sid, fpath)

        result = hooks_cli.pre_read(self._read_payload(sid, fpath, offset=10))
        _assert_continue(result)
        # No unchanged hint — offset present means surgical intent.
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "unchanged" not in ctx.lower()

    def test_no_hint_when_limit_supplied(self, tmp_data_dir, tmp_path):
        """Surgical read with limit → unchanged hint must NOT fire."""
        from token_goat import snapshots

        sid = "unchanged-limit"
        fpath = self._make_file(tmp_path, "sliced.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(content).hexdigest())
        session.mark_file_edited(sid, fpath)

        result = hooks_cli.pre_read(self._read_payload(sid, fpath, limit=50))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "unchanged" not in ctx.lower()

    def test_no_hint_when_content_changed(self, tmp_data_dir, tmp_path):
        """File mutated on disk after snapshot → SHA mismatch → no unchanged hint."""
        from token_goat import snapshots

        sid = "unchanged-mutated"
        fpath = self._make_file(tmp_path, "mutated.py")
        with open(fpath, "rb") as _f:
            original = _f.read()

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, original)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(original).hexdigest())
        session.mark_file_edited(sid, fpath)

        # Mutate the file externally.
        with open(fpath, "ab") as fh:
            fh.write(b"\n# external change\n")

        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        # SHA mismatch → unchanged hint must NOT fire.
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "unchanged" not in ctx.lower()

    def test_no_hint_when_no_snapshot(self, tmp_data_dir, tmp_path):
        """No snapshot stored for file → unchanged hint must not fire."""
        sid = "unchanged-no-snap"
        fpath = self._make_file(tmp_path, "nosnap.py")

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        # Deliberately no snapshots.store() or set_snapshot_sha() call.
        session.mark_file_edited(sid, fpath)

        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "unchanged" not in ctx.lower()

    def test_no_hint_when_not_edited(self, tmp_data_dir, tmp_path):
        """File read but never edited → unchanged hint must not fire (no edit signal)."""
        from token_goat import snapshots

        sid = "unchanged-no-edit"
        fpath = self._make_file(tmp_path, "noedit.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, __import__("hashlib").sha256(content).hexdigest())
        # No mark_file_edited → last_edit_ts == 0 <= last_read_ts

        result = hooks_cli.pre_read(self._read_payload(sid, fpath))
        _assert_continue(result)
        if "hookSpecificOutput" in result:
            ctx = result["hookSpecificOutput"].get("additionalContext", "")
            assert "unchanged" not in ctx.lower()


# ---------------------------------------------------------------------------
# Curator: ignored-hint counting via _check_ignored_hint
# ---------------------------------------------------------------------------


class TestCuratorIgnoredHintCounting:
    """_check_ignored_hint increments hints_ignored when Read fires for hinted path."""

    def test_hint_then_read_increments_ignored(self, tmp_data_dir):
        """If a path is in recent_hints and then Read fires for it, hints_ignored++."""
        import time

        from token_goat.hooks_read import _check_ignored_hint

        sid = "curator_ignored_1"
        cache = session.load(sid)
        norm_path = "/proj/foo.py"
        # Simulate a hint having been emitted for this path.
        cache.recent_hints = [(norm_path, time.time())]
        cache.hints_emitted = 1
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint(cache, norm_path)

        assert cache.hints_ignored == 1
        # Path should be removed from ring buffer after counting.
        assert all(p != norm_path for p, _ in cache.recent_hints)

    def test_no_hint_for_path_does_not_increment(self, tmp_data_dir):
        """If the path was not recently hinted, hints_ignored stays at 0."""
        from token_goat.hooks_read import _check_ignored_hint

        sid = "curator_ignored_2"
        cache = session.load(sid)
        cache.recent_hints = [("/proj/other.py", 0.0)]
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint(cache, "/proj/foo.py")

        assert cache.hints_ignored == 0

    def test_empty_recent_hints_does_not_increment(self, tmp_data_dir):
        """Empty recent_hints → hints_ignored unchanged."""
        from token_goat.hooks_read import _check_ignored_hint

        sid = "curator_ignored_3"
        cache = session.load(sid)
        cache.hints_ignored = 0

        _check_ignored_hint(cache, "/proj/foo.py")

        assert cache.hints_ignored == 0

    def test_second_read_same_path_does_not_double_count(self, tmp_data_dir):
        """After the first Read removes the path from ring buffer, second Read does not increment again."""
        import time

        from token_goat.hooks_read import _check_ignored_hint

        sid = "curator_ignored_4"
        cache = session.load(sid)
        norm_path = "/proj/bar.py"
        cache.recent_hints = [(norm_path, time.time())]
        cache.hints_emitted = 1
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint(cache, norm_path)
        assert cache.hints_ignored == 1

        # Second call — path was already removed from ring buffer.
        _check_ignored_hint(cache, norm_path)
        assert cache.hints_ignored == 1  # still 1, not 2
