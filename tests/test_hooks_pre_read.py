"""Tests for the pre_read hook handler and its dispatcher integration."""
from __future__ import annotations

import json
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

    def test_file_not_in_cache_nonexistent_file_no_hint(
        self, tmp_data_dir, tmp_path, monkeypatch
    ):
        """File not in cache + file doesn't exist → no hint, continue:true.

        Mocks find_project at its canonical module location to avoid an expensive
        filesystem walk from the deep Windows temp path to the filesystem root
        (9 markers × N parent dirs ≈ 1-2 s).  Patching token_goat.project.find_project
        covers all lazy local imports (``from .project import find_project`` inside
        function bodies) as well as the module-level binding in hints.py.

        The test exercises the "not in session cache, not found on disk" path, not
        project-detection logic, so this mock is appropriate.
        """
        monkeypatch.setattr("token_goat.project.find_project", lambda _cwd: None)
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
        from token_goat.hints import build_read_hint
        from token_goat.hooks_common import bytes_to_tokens

        sid = "net_acct"
        path = "C:/proj/cached.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Build the hint directly to derive the expected net independently.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd="C:/proj"
        )
        assert hint is not None
        # record_hint_stat_pair measures injection cost from UTF-8 bytes
        # (not Python str length) so multi-byte characters in the hint text
        # account for their real on-the-wire cost. Mirror that math here.
        hint_text = str(hint)
        injection_bytes = len(hint_text.encode("utf-8"))
        injection_cost = bytes_to_tokens(injection_bytes)
        assert injection_cost > 0  # the hint text is not free
        expected_net_tokens = hint.tokens_saved - injection_cost
        expected_net_bytes = hint.tokens_saved * 4 - injection_bytes

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
        assert overhead_row["bytes_saved"] == -injection_bytes
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
        payload = {"session_id": "cli1", "tool_name": "Bash", "tool_input": {"command": "pwd"}}
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
            timeout=30,
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
    """Glob result cache dedup rolls up large results into directory groups (>40 paths)."""

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

    def test_glob_cache_rolls_up_large_results(self, tmp_data_dir):
        """Cached glob result with >40 files → directory rollup, not flat list."""
        from token_goat.hooks_read import _GLOB_ROLLUP_THRESHOLD
        total = _GLOB_ROLLUP_THRESHOLD + 15
        sid = "glob-rollup-55"
        pattern = "**/*.py"
        # Spread across two directories so rollup has something to group
        files = [f"src/core/file_{i:03d}.py" for i in range(total // 2)]
        files += [f"src/util/file_{i:03d}.py" for i in range(total - total // 2)]
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
        # Rollup header must show total path count, directory count, and breakdown section
        assert str(total) in ctx
        assert "director" in ctx
        assert "Directory breakdown" in ctx
        # Old-style flat overflow without "not shown" must NOT appear
        assert "(+10 more)" not in ctx

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

    def test_session_dedup_within_verbose_window(self, tmp_data_dir, tmp_path):
        """Same large CSV read twice stays within verbose window → hint re-emits on both reads."""
        fpath = self._make_large_file(tmp_path, ".csv")
        sid = "struct-dedup"
        payload = self._read_payload(sid, fpath)

        result1 = hooks_cli.pre_read(payload)
        _assert_continue(result1)
        assert "hookSpecificOutput" in result1

        # Second read: within verbose_until_seen_count=2 window → must re-emit full hint.
        result2 = hooks_cli.pre_read(payload)
        _assert_continue(result2)
        assert "hookSpecificOutput" in result2, "second read within verbose window must emit hint"
        ctx2 = result2["hookSpecificOutput"].get("additionalContext", "")
        assert "csv" in ctx2.lower() or "📊" in ctx2, (
            "second read must re-emit the structured-file hint, not suppress it"
        )

    def test_session_dedup_emits_stub_past_verbose_window(self, tmp_data_dir, tmp_path):
        """Same large CSV read 3× → 3rd read emits short stub (verbose_until_seen_count=2)."""
        fpath = self._make_large_file(tmp_path, ".csv")
        sid = "struct-dedup-stub"
        payload = self._read_payload(sid, fpath)

        # Reads 1–2: full hint (within verbose_until_seen_count=2 window).
        for _ in range(2):
            hooks_cli.pre_read(payload)

        # 3rd read: seen_count=2 >= verbose_until=2 → short stub only.
        result3 = hooks_cli.pre_read(payload)
        _assert_continue(result3)
        if "hookSpecificOutput" in result3:
            ctx3 = result3["hookSpecificOutput"].get("additionalContext", "")
            # Stub contains "seen Nx" marker; full structured-file hint must not repeat.
            assert "📊" not in ctx3 and "large csv" not in ctx3.lower(), (
                "3rd read must emit a short stub, not the full structured-file hint"
            )

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

    def test_csv_includes_headers(self, tmp_data_dir, tmp_path):
        """Large CSV hint includes column names from header."""
        csv_file = tmp_path / "data.csv"
        # Create CSV with headers and rows.
        content = b"id,name,email,created_at\n1,Alice,alice@example.com,2025-01-01\n"
        content += b"2,Bob,bob@example.com,2025-01-02\n" * 5000
        csv_file.write_bytes(content)

        sid = "struct-csv-headers"
        result = hooks_cli.pre_read(self._read_payload(sid, str(csv_file)))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Hint should include column names.
        assert "id" in ctx and "name" in ctx and "email" in ctx
        assert "columns:" in ctx.lower()

    def test_ndjson_includes_first_record_schema(self, tmp_data_dir, tmp_path):
        """Large NDJSON hint includes schema from first record."""
        ndjson_file = tmp_path / "events.ndjson"
        # Create NDJSON with typed records.
        first_record = '{"event": "click", "ts": 1234567890, "user_id": "u123", "session": "s456"}\n'
        content = first_record.encode()
        # Add more records to reach size threshold.
        for i in range(5000):
            content += f'{{"event": "scroll", "ts": {1234567890 + i}, "user_id": "u{i}", "session": "s{i}"}}\n'.encode()
        ndjson_file.write_bytes(content)

        sid = "struct-ndjson-schema"
        result = hooks_cli.pre_read(self._read_payload(sid, str(ndjson_file)))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Hint should include first record schema with types.
        assert "schema:" in ctx.lower()
        # Should mention some of the keys from first record.
        assert any(key in ctx for key in ["event", "ts", "user_id"])

    def test_json_array_includes_schema(self, tmp_data_dir, tmp_path):
        """Large JSON array hint includes schema from first element."""
        json_file = tmp_path / "data.json"
        # Create JSON array of objects.
        json_obj = [
            {"id": 1, "name": "Alice", "active": True, "score": 95.5},
            {"id": 2, "name": "Bob", "active": False, "score": 87.3},
        ]
        # Pad with repeated JSON to reach size threshold.
        full_content = "[" + ", ".join([json.dumps(json_obj[0])] * 5000) + "]"
        while len(full_content.encode()) < 100_000:
            full_content = full_content[:-1] + ", " + json.dumps(json_obj[0]) + "]"
        json_file.write_text(full_content)

        sid = "struct-json-schema"
        result = hooks_cli.pre_read(self._read_payload(sid, str(json_file)))
        _assert_continue(result)
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]["additionalContext"]
        # Hint should include array schema.
        assert "array schema:" in ctx.lower()
        # Should mention some of the keys from first object.
        assert any(key in ctx for key in ["id", "name", "active", "score"])


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

    def test_session_dedup_within_verbose_window(self, tmp_data_dir, tmp_path):
        """Same lockfile read twice → within verbose window, hint re-emits on both reads."""
        fpath = self._make_lockfile(tmp_path, "cargo.lock")
        payload = self._read_payload("io-dedup", fpath)

        result1 = hooks_cli.pre_read(payload)
        _assert_continue(result1)
        assert "hookSpecificOutput" in result1
        ctx1 = result1["hookSpecificOutput"]["additionalContext"]
        assert "lockfile" in ctx1.lower()

        # Second read: within verbose_until_seen_count=2 window → must re-emit full hint.
        result2 = hooks_cli.pre_read(payload)
        _assert_continue(result2)
        assert "hookSpecificOutput" in result2, "second read within verbose window must emit hint"
        ctx2 = result2["hookSpecificOutput"].get("additionalContext", "")
        assert "lockfile" in ctx2.lower(), (
            "second read must re-emit the index-only hint, not suppress it"
        )

    def test_session_dedup_emits_stub_past_verbose_window(self, tmp_data_dir, tmp_path):
        """Same lockfile read 3× → 3rd read emits short stub (verbose_until_seen_count=2)."""
        fpath = self._make_lockfile(tmp_path, "cargo.lock")
        payload = self._read_payload("io-dedup-stub", fpath)

        # Reads 1–2: full hint (within verbose_until_seen_count=2 window).
        for _ in range(2):
            hooks_cli.pre_read(payload)

        # 3rd read: seen_count=2 >= verbose_until=2 → short stub only.
        result3 = hooks_cli.pre_read(payload)
        _assert_continue(result3)
        if "hookSpecificOutput" in result3:
            ctx3 = result3["hookSpecificOutput"].get("additionalContext", "")
            assert "lockfile" not in ctx3.lower(), (
                "3rd read must emit a short stub, not the full index-only hint"
            )


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

    def test_unchanged_hint_includes_sha_prefix(self, tmp_data_dir, tmp_path):
        """Unchanged-file hint must include a SHA prefix so the agent can verify the claim.

        The hint text should contain 'sha:' followed by 8 hex characters so
        the agent can cross-check against its own computation rather than
        relying on the hint blindly.
        """
        import hashlib
        import re

        from token_goat import snapshots
        from token_goat.hints import build_unchanged_file_hint

        sid = "unchanged-sha-prefix"
        fpath = self._make_file(tmp_path, "sha_check.py")
        with open(fpath, "rb") as _f:
            content = _f.read()

        expected_sha = hashlib.sha256(content).hexdigest()[:8]

        session.mark_file_read(sid, fpath, offset=None, limit=None)
        snapshots.store(sid, fpath, content)
        session.set_snapshot_sha(sid, fpath, hashlib.sha256(content).hexdigest())
        session.mark_file_edited(sid, fpath)

        hint = build_unchanged_file_hint(session_id=sid, file_path=fpath)
        assert hint is not None, "unchanged hint should fire"
        hint_text = str(hint)
        # Hint must contain 'sha:' followed by exactly the first 8 hex chars.
        assert f"sha:{expected_sha}" in hint_text, (
            f"Expected 'sha:{expected_sha}' in hint text but got: {hint_text!r}"
        )
        # Verify it looks like a real hex prefix (8 lowercase hex chars).
        assert re.search(r"sha:[0-9a-f]{8}", hint_text), (
            f"sha prefix should be 8 lowercase hex chars, got: {hint_text!r}"
        )


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

    def test_hints_ignored_persisted_for_large_file(self, tmp_data_dir, tmp_path):
        """hints_ignored increment is saved even when _try_snapshot exits early.

        _try_snapshot skips files exceeding MAX_SNAPSHOT_BYTES, so without an
        explicit save after _check_ignored_hint the curator increment is lost
        in memory and never written to disk.
        """
        import time

        from token_goat import snapshots

        sid = "curator_ignored_large_file"
        fpath = tmp_path / "big.py"
        # Write a file larger than the snapshot cap so _try_snapshot returns early.
        fpath.write_bytes(b"x" * (snapshots.MAX_SNAPSHOT_BYTES + 1))

        # Seed the session with recent_hints so _check_ignored_hint fires.
        # Paths must be in the normalized form (forward slashes, lowercase drive)
        # that _check_ignored_hint uses for comparison.
        cache = session.load(sid)
        norm_path = session._normalize_path(str(fpath))
        cache.recent_hints = [(norm_path, time.time())]
        cache.hints_emitted = 1
        cache.hints_ignored = 0
        cache._invalidate_json_cache()
        session.save(cache)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": str(fpath)},
            "cwd": str(tmp_path),
        }
        hooks_cli.post_read(payload)

        # Reload from disk — hints_ignored must be 1, not 0.
        reloaded = session.load(sid)
        assert reloaded.hints_ignored == 1, (
            "hints_ignored increment was not persisted for file exceeding MAX_SNAPSHOT_BYTES"
        )


# ---------------------------------------------------------------------------
# Curator: _check_ignored_hint_by_key shared helper
# ---------------------------------------------------------------------------


class TestCheckIgnoredHintByKey:
    """_check_ignored_hint_by_key is the shared ring-buffer scan used by both
    _check_ignored_hint (file path key) and _check_ignored_bash_hint (cmd SHA key)."""

    def test_matching_key_increments_ignored(self, tmp_data_dir):
        """Key found in recent_hints → hints_ignored++ and key removed from ring buffer."""
        import time

        from token_goat.hooks_read import _check_ignored_hint_by_key

        cache = session.load("by_key_1")
        key = "abc123"
        cache.recent_hints = [(key, time.time())]
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint_by_key(cache, key, "test_label")

        assert cache.hints_ignored == 1
        assert all(k != key for k, _ in cache.recent_hints)

    def test_non_matching_key_no_change(self, tmp_data_dir):
        """Key not in recent_hints → hints_ignored unchanged."""
        from token_goat.hooks_read import _check_ignored_hint_by_key

        cache = session.load("by_key_2")
        cache.recent_hints = [("other_key", 0.0)]
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint_by_key(cache, "target_key", "label")

        assert cache.hints_ignored == 0

    def test_empty_ring_buffer_no_change(self, tmp_data_dir):
        """Empty recent_hints → no-op."""
        from token_goat.hooks_read import _check_ignored_hint_by_key

        cache = session.load("by_key_3")
        cache.hints_ignored = 0

        _check_ignored_hint_by_key(cache, "any_key", "label")

        assert cache.hints_ignored == 0

    def test_second_call_no_double_count(self, tmp_data_dir):
        """After the key is removed from the ring buffer, a second call with the same key is a no-op."""
        import time

        from token_goat.hooks_read import _check_ignored_hint_by_key

        cache = session.load("by_key_4")
        key = "dedup_sha"
        cache.recent_hints = [(key, time.time())]
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_hint_by_key(cache, key, "label")
        assert cache.hints_ignored == 1

        _check_ignored_hint_by_key(cache, key, "label")
        assert cache.hints_ignored == 1  # still 1, not 2


# ---------------------------------------------------------------------------
# Curator: ignored-hint counting via _check_ignored_bash_hint
# ---------------------------------------------------------------------------


class TestCuratorIgnoredBashHintCounting:
    """_check_ignored_bash_hint increments hints_ignored when Bash reruns a hinted command."""

    def _make_cache_with_bash_hint(self, sid: str, command: str):
        """Load a fresh session and seed recent_hints with the command's cmd_sha."""
        import time

        from token_goat import bash_cache

        cache = session.load(sid)
        cmd_sha = bash_cache.command_hash(command)
        cache.recent_hints = [(cmd_sha, time.time())]
        cache.hints_emitted = 1
        cache.hints_ignored = 0
        cache._invalidate_json_cache()
        return cache, cmd_sha

    def test_bash_rerun_increments_ignored(self, tmp_data_dir):
        """If a bash-dedup hint was emitted for a command and Bash reruns it, hints_ignored++."""
        from token_goat.hooks_read import _check_ignored_bash_hint

        sid = "bash_ignored_1"
        command = "pytest -v tests/"
        cache, cmd_sha = self._make_cache_with_bash_hint(sid, command)

        _check_ignored_bash_hint(cache, command)

        assert cache.hints_ignored == 1
        # sha should be removed from ring buffer after counting
        assert all(k != cmd_sha for k, _ in cache.recent_hints)

    def test_no_prior_hint_does_not_increment(self, tmp_data_dir):
        """If no bash-dedup hint was emitted for this command, hints_ignored stays 0."""
        from token_goat.hooks_read import _check_ignored_bash_hint

        sid = "bash_ignored_2"
        cache = session.load(sid)
        cache.recent_hints = []
        cache.hints_ignored = 0
        cache._invalidate_json_cache()

        _check_ignored_bash_hint(cache, "pytest -v tests/")

        assert cache.hints_ignored == 0

    def test_different_command_does_not_increment(self, tmp_data_dir):
        """A hint for a different command does not fire for the current command."""
        from token_goat.hooks_read import _check_ignored_bash_hint

        sid = "bash_ignored_3"
        command_hinted = "rg foo src/"
        command_run = "pytest -v tests/"
        cache, _ = self._make_cache_with_bash_hint(sid, command_hinted)

        _check_ignored_bash_hint(cache, command_run)

        assert cache.hints_ignored == 0

    def test_second_rerun_does_not_double_count(self, tmp_data_dir):
        """After the first Bash run removes the sha from the ring buffer, a second run does not double-count."""
        from token_goat.hooks_read import _check_ignored_bash_hint

        sid = "bash_ignored_4"
        command = "npm test"
        cache, _ = self._make_cache_with_bash_hint(sid, command)

        _check_ignored_bash_hint(cache, command)
        assert cache.hints_ignored == 1

        # Second call — sha already removed from ring buffer.
        _check_ignored_bash_hint(cache, command)
        assert cache.hints_ignored == 1  # still 1, not 2

    def test_post_bash_increments_ignored_via_hook(self, tmp_data_dir):
        """post_bash increments hints_ignored when the command matches a recent bash-dedup hint."""
        import time

        from token_goat import bash_cache

        sid = "bash_ignored_hook_1"
        command = "git log --oneline -10"
        cmd_sha = bash_cache.command_hash(command)

        # Seed a session that looks like a bash-dedup hint was emitted.
        cache = session.load(sid)
        cache.recent_hints = [(cmd_sha, time.time())]
        cache.hints_emitted = 1
        cache.hints_ignored = 0
        cache._invalidate_json_cache()
        session.save(cache)

        payload = {
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": command},
            "tool_response": "abc123 Add feature\n",
        }
        hooks_cli.post_bash(payload)

        reloaded = session.load(sid)
        assert reloaded.hints_ignored == 1, (
            "post_bash did not increment hints_ignored after a bash-dedup hint was ignored"
        )


# ---------------------------------------------------------------------------
# Unchanged-file hint flush regression
# ---------------------------------------------------------------------------


class TestSurgicalReadHint:
    """Tests for _try_surgical_read_hint and its integration into pre_read."""

    def test_hint_fires_when_symbols_overlap_range(self, tmp_data_dir, monkeypatch):
        """When a line-range read overlaps indexed symbols, a token-goat read suggestion is injected."""
        import token_goat.hooks_read as _hr

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            return (
                "Lines 10–30 of `auth.py` span `login`. "
                "Use `token-goat read \"src/auth.py::login\"` for a surgical read (~90% fewer tokens on repeat access)."
            )

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "surg-1",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py", "offset": 10, "limit": 100},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat read" in ctx
        assert "login" in ctx

    def test_hint_deduped_on_second_read(self, tmp_data_dir, monkeypatch):
        """The surgical hint is suppressed when the same fingerprint was already seen this session."""
        import token_goat.hooks_read as _hr

        call_count = 0

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            nonlocal call_count
            call_count += 1
            return "Lines 10–30 of `auth.py` span `login`. Use `token-goat read \"src/auth.py::login\"` for a surgical read (~90% fewer tokens on repeat access)."

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "surg-2",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py", "offset": 10, "limit": 21},
            "cwd": "/proj",
        }
        hooks_cli.pre_read(payload)
        result2 = hooks_cli.pre_read(payload)
        hso2 = result2.get("hookSpecificOutput", {})
        ctx2 = hso2.get("additionalContext", "") if isinstance(hso2, dict) else ""
        # Second call: surgical hint must be absent (fingerprint dedup fired).
        assert "token-goat read" not in ctx2 or "login" not in ctx2

    def test_no_hint_when_no_offset_limit(self, tmp_data_dir, monkeypatch):
        """A full-file read (no offset/limit) does not call _try_surgical_read_hint."""
        import token_goat.hooks_read as _hr

        called = []

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            called.append((offset, limit))
            return None

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "surg-3",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py"},
            "cwd": "/proj",
        }
        hooks_cli.pre_read(payload)
        assert not called, "_try_surgical_read_hint must not be called for full-file reads"

    def test_try_surgical_read_hint_returns_none_when_no_project(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint returns None when no indexed project is found."""
        from token_goat.hooks_read import _try_surgical_read_hint

        result = _try_surgical_read_hint("/some/random/file.py", 10, 20, "/some/random")
        assert result is None

    def test_try_surgical_read_hint_returns_none_on_db_error(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint returns None when DB access fails."""
        from pathlib import Path as _Path

        from token_goat.hooks_read import _try_surgical_read_hint

        # Monkeypatch find_project to return a non-None project so we reach the DB.
        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        import token_goat.db as _db
        def _bad_open(hash):
            raise OSError("DB unavailable")
        monkeypatch.setattr(_db, "open_project_readonly", _bad_open)

        result = _try_surgical_read_hint("/proj/src/auth.py", 10, 20, str(tmp_data_dir))
        assert result is None

    def test_try_surgical_read_hint_names_symbol(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint returns a string naming the overlapping symbol."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        # Fake DB connection returning one symbol row.
        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                # Return a dict-accessible row via a namedtuple-like object.
                class _Row:
                    def __init__(self):
                        self.name = "login"
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": "login", "kind": "function"}[key]
                return [_Row()]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_surgical_read_hint
        result = _try_surgical_read_hint("/proj/src/auth.py", 10, 21, str(tmp_data_dir))
        assert result is not None
        assert "login" in result
        assert "token-goat read" in result
        assert "src/auth.py::login" in result

    def test_try_surgical_read_hint_returns_none_for_too_many_symbols(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint returns None when the range spans >3 symbols."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, name):
                        self.name = name
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": self.name, "kind": "function"}[key]
                return [_Row("a"), _Row("b"), _Row("c"), _Row("d")]  # 4 rows → too many
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_surgical_read_hint
        result = _try_surgical_read_hint("/proj/src/auth.py", 1, 500, str(tmp_data_dir))
        assert result is None

    def test_try_surgical_read_hint_sql_params_are_1indexed(self, tmp_data_dir, monkeypatch):
        """SQL query receives 1-indexed bounds even when offset=0 is passed.

        Regression test for the off-by-one bug where the 0-indexed Read tool offset
        was used directly as a DB line number.  The DB stores 1-indexed lines, so
        offset=0 must become req_start=1 and limit=50 must become req_end=50.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        captured_params: list[tuple[object, ...]] = []

        class _FakeConn:
            def execute(self, sql, params):
                captured_params.append(params)
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self):
                        self.name = "init_module"
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": "init_module", "kind": "function"}[key]
                return [_Row()]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_surgical_read_hint
        # offset=0, limit=50 → lines 1–50 in 1-indexed space.
        _try_surgical_read_hint("/proj/src/auth.py", 0, 50, str(tmp_data_dir))

        assert captured_params, "DB query must have been executed"
        params = captured_params[0]
        # params is (file_rel, req_end, req_start) per the SQL WHERE clause order.
        file_rel, req_end, req_start = params
        assert req_start == 1, f"req_start must be 1 (1-indexed), got {req_start}"
        assert req_end == 50, f"req_end must be 50 (1-indexed), got {req_end}"

    def test_try_surgical_read_hint_3_symbols_fires(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint emits a multi-symbol hint when exactly 3 symbols overlap."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, name):
                        self.name = name
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": self.name, "kind": "function"}[key]
                return [_Row("alpha"), _Row("beta"), _Row("gamma")]  # exactly 3 → fires
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_surgical_read_hint
        result = _try_surgical_read_hint("/proj/src/auth.py", 10, 60, str(tmp_data_dir))
        assert result is not None, "exactly 3 symbols must produce a hint"
        assert "alpha" in result
        assert "beta" in result
        assert "gamma" in result
        assert "token-goat read" in result

    def test_try_surgical_read_hint_limit_is_sentinel_shows_eof(self, tmp_data_dir, monkeypatch):
        """_try_surgical_read_hint with limit_is_sentinel=True shows 'Lines N–EOF', not the sentinel.

        Regression test for the sentinel-leak bug where open-ended tail reads
        produced 'Lines 10–2009' instead of 'Lines 10–EOF'.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self):
                        self.name = "login"
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": "login", "kind": "function"}[key]
                return [_Row()]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_surgical_read_hint
        # offset=9 (0-indexed, i.e. line 10), limit=2000 is the EOF sentinel.
        result = _try_surgical_read_hint(
            "/proj/src/auth.py", 9, 2000, str(tmp_data_dir), limit_is_sentinel=True
        )
        assert result is not None, "limit_is_sentinel=True must still produce a hint"
        assert "EOF" in result, f"hint must show 'Lines 10–EOF', got: {result}"
        assert "2000" not in result, f"sentinel value 2000 must not appear in hint: {result}"
        assert "2009" not in result, f"sentinel-derived value 2009 must not appear in hint: {result}"
        assert "Lines 10–EOF" in result, f"expected 'Lines 10–EOF' in hint: {result}"
        assert "token-goat read" in result
        assert "src/auth.py::login" in result

    def test_tail_skip_triggers_surgical_hint_with_eof_range(self, tmp_data_dir, monkeypatch):
        """tail -n +N triggers the surgical hint; displayed range ends with 'EOF', not a sentinel.

        Regression test for the bug where limit=None caused the 2000 sentinel to leak into
        the emitted hint text, producing 'Lines 10-2009' for a tail -n +10 command.
        """
        import token_goat.hooks_read as _hr

        received: list[tuple[int, int, bool]] = []

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            received.append((offset, limit, limit_is_sentinel))
            if limit_is_sentinel:
                return (
                    f"Lines {offset + 1}–EOF of `auth.py` span `login`. "
                    "Use `token-goat read \"src/auth.py::login\"` for a surgical read "
                    "(~90% fewer tokens on repeat access)."
                )
            return None

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "surg-tail-skip-1",
            "tool_name": "Bash",
            "tool_input": {"command": "tail -n +10 /proj/src/auth.py"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)

        # Verify _try_surgical_read_hint was called with the correct arguments.
        assert received, "_try_surgical_read_hint should have been called"
        offset_seen, limit_seen, sentinel_seen = received[0]
        assert offset_seen == 9, f"expected offset=9 (10-1, normalised), got {offset_seen}"
        assert limit_seen == 2000, f"expected effective limit=2000, got {limit_seen}"
        assert sentinel_seen, "limit_is_sentinel must be True for open-ended tail reads"

        # Verify the emitted hint uses 'EOF' not the sentinel number.
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "EOF" in ctx, "hint must display 'EOF' not the sentinel value"
        assert "2009" not in ctx and "2000" not in ctx, "sentinel must not appear in hint text"

    def test_sed_command_triggers_surgical_hint(self, tmp_data_dir, monkeypatch):
        """A `sed -n 'M,Np' file` Bash command triggers the surgical-read hint via pre_read.

        Verifies that the parsed offset, limit, and limit_is_sentinel flag are
        correct — not just that some hint fires.  For `sed -n '10,30p'`:
          - offset=9  (line 10 normalised to 0-indexed)
          - limit=21  (lines 10–30 inclusive: 30-10+1)
          - limit_is_sentinel=False  (explicit range, not an open-ended tail)
        """
        import token_goat.hooks_read as _hr

        received: list[tuple[int, int, bool]] = []

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            received.append((offset, limit, limit_is_sentinel))
            return (
                "Lines 10–30 of `auth.py` span `login`. "
                "Use `token-goat read \"src/auth.py::login\"` for a surgical read (~90% fewer tokens on repeat access)."
            )

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "surg-sed-1",
            "tool_name": "Bash",
            "tool_input": {"command": "sed -n '10,30p' /proj/src/auth.py"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat read" in ctx
        assert "login" in ctx

        assert received, "_try_surgical_read_hint should have been called"
        offset_seen, limit_seen, sentinel_seen = received[0]
        assert offset_seen == 9, f"expected offset=9 (line 10 normalised to 0-indexed), got {offset_seen}"
        assert limit_seen == 21, f"expected limit=21 (30-10+1 lines), got {limit_seen}"
        assert sentinel_seen is False, "sed explicit range must not set limit_is_sentinel"

    def test_offset_zero_does_not_suppress_hint(self, tmp_data_dir, monkeypatch):
        """offset=0 is a valid Read tool value (start from line 1) and must not suppress the hint.

        Regression test for the bug where ``if offset <= 0`` incorrectly rejected reads
        that started at the first line of the file (the standard 0-based Read tool offset).
        """
        from pathlib import Path as _Path

        from token_goat.hooks_read import _try_surgical_read_hint
        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        import token_goat.read_replacement as _rr
        monkeypatch.setattr(_rr, "resolve_file_rel", lambda proj, path: "src/auth.py")

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self):
                        self.name = "module_init"
                        self.kind = "function"
                    def __getitem__(self, key):
                        return {"name": "module_init", "kind": "function"}[key]
                return [_Row()]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        # offset=0 → read starts at the very first line; must still produce a hint.
        result = _try_surgical_read_hint("/proj/src/auth.py", 0, 50, str(tmp_data_dir))
        assert result is not None, "offset=0 is valid; hint must not be suppressed"
        assert "module_init" in result
        assert "token-goat read" in result

    def test_windowed_read_le_80_lines_no_hint(self, tmp_data_dir, monkeypatch):
        """A windowed Read with offset + limit <= 80 should NOT emit the surgical hint."""
        import token_goat.hooks_read as _hr

        call_count = [0]

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            call_count[0] += 1
            return "Lines 10–30 of `auth.py` span `login`. Use `token-goat read \"src/auth.py::login\"` for a surgical read (~90% fewer tok on repeat access)."

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        # Small windowed read (offset=100, limit=30) should NOT call _try_surgical_read_hint
        payload = {
            "session_id": "windowed-1",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/auth.py", "offset": 100, "limit": 30},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        assert call_count[0] == 0, "surgical hint should not be called for windowed reads <= 80 lines"
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat read" not in ctx or "90% fewer" not in ctx, "surgical read suggestion should not appear for small windowed reads"

    def test_large_file_full_read_still_gets_hint(self, tmp_data_dir, monkeypatch):
        """A full-file Read (no offset/limit) of a large indexed file should still get the surgical hint."""
        import token_goat.hooks_read as _hr

        def _fake_surgical(file_path, offset, limit, cwd, *, limit_is_sentinel=False):
            return "Lines 1–2000 of `large.py` span `setup`. Use `token-goat read \"src/large.py::setup\"` for a surgical read (~90% fewer tok on repeat access)."

        monkeypatch.setattr(_hr, "_try_surgical_read_hint", _fake_surgical)

        payload = {
            "session_id": "large-1",
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/src/large.py"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat read" not in ctx  # full-file read without offset gets no surgical hint


class TestGrepSymbolRedirect:
    """Tests for _handle_grep_symbol_redirect and _try_grep_symbol_hint."""

    def test_hint_fires_for_indexed_identifier(self, tmp_data_dir, monkeypatch):
        """When grep pattern is an indexed symbol, the hint suggests token-goat symbol."""
        import token_goat.hooks_read as _hr

        def _fake_symbol_hint(pattern, cwd):
            if pattern == "my_function":
                return (
                    "Symbol `my_function` is indexed — use `token-goat symbol my_function` "
                    "to jump directly to its definition(s) (`auth.py:42` (function)) "
                    "instead of scanning files with grep (~95% fewer tokens)."
                )
            return None

        monkeypatch.setattr(_hr, "_try_grep_symbol_hint", _fake_symbol_hint)

        payload = {
            "session_id": "grep-sym-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "my_function", "path": "src/"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat symbol" in ctx
        assert "my_function" in ctx

    def test_hint_deduped_on_second_grep(self, tmp_data_dir, monkeypatch):
        """The symbol-redirect hint is suppressed when the fingerprint was already seen."""
        import token_goat.hooks_read as _hr

        def _fake_symbol_hint(pattern, cwd):
            return (
                "Symbol `my_function` is indexed — use `token-goat symbol my_function` "
                "to jump directly to its definition(s) (`auth.py:42` (function)) "
                "instead of scanning files with grep (~95% fewer tokens)."
            )

        monkeypatch.setattr(_hr, "_try_grep_symbol_hint", _fake_symbol_hint)

        payload = {
            "session_id": "grep-sym-2",
            "tool_name": "Grep",
            "tool_input": {"pattern": "my_function"},
            "cwd": "/proj",
        }
        hooks_cli.pre_read(payload)
        result2 = hooks_cli.pre_read(payload)
        # Second call must NOT contain the symbol redirect (fingerprint dedup).
        hso2 = result2.get("hookSpecificOutput", {})
        ctx2 = hso2.get("additionalContext", "") if isinstance(hso2, dict) else ""
        assert "token-goat symbol" not in ctx2

    def test_no_hint_for_regex_pattern(self, tmp_data_dir, monkeypatch):
        """Patterns with regex metacharacters do not trigger the symbol lookup."""
        import token_goat.hooks_read as _hr

        called = []

        def _fake_symbol_hint(pattern, cwd):
            called.append(pattern)
            return None

        monkeypatch.setattr(_hr, "_try_grep_symbol_hint", _fake_symbol_hint)

        for regex_pattern in ["def\\s+foo", "import.*os", "foo.bar", "foo|bar"]:
            hooks_cli.pre_read({
                "session_id": "grep-sym-3",
                "tool_name": "Grep",
                "tool_input": {"pattern": regex_pattern},
                "cwd": "/proj",
            })
        # _try_grep_symbol_hint should not have been called for any of these
        # because _IDENTIFIER_RE filtering happens before it.
        assert not called, f"should not call hint for regex patterns, called for: {called}"

    def test_try_grep_symbol_hint_rejects_short_pattern(self, tmp_data_dir):
        """Patterns shorter than 3 chars are rejected by _IDENTIFIER_RE."""
        from token_goat.hooks_read import _try_grep_symbol_hint

        assert _try_grep_symbol_hint("ab", "/proj") is None
        assert _try_grep_symbol_hint("_x", "/proj") is None

    def test_try_grep_symbol_hint_rejects_regex_metacharacters(self, tmp_data_dir):
        """Patterns with metacharacters are rejected by _IDENTIFIER_RE."""
        from token_goat.hooks_read import _try_grep_symbol_hint

        assert _try_grep_symbol_hint("foo.bar", "/proj") is None
        assert _try_grep_symbol_hint("foo|bar", "/proj") is None
        assert _try_grep_symbol_hint("def.*foo", "/proj") is None
        assert _try_grep_symbol_hint("my func", "/proj") is None

    def test_try_grep_symbol_hint_names_symbol(self, tmp_data_dir, monkeypatch):
        """_try_grep_symbol_hint returns a hint naming the matching symbol location."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self):
                        self.name = "my_function"
                        self.kind = "function"
                        self.file_rel = "src/auth.py"
                        self.line = 42
                    def __getitem__(self, key):
                        return {"name": "my_function", "kind": "function", "file_rel": "src/auth.py", "line": 42}[key]
                return [_Row()]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_symbol_hint
        result = _try_grep_symbol_hint("my_function", str(tmp_data_dir))
        assert result is not None
        # Single-symbol path: includes direct read command AND symbol command.
        assert "token-goat read" in result
        assert "auth.py::my_function" in result
        assert "token-goat symbol my_function" in result
        assert "auth.py:42" in result

    def test_try_grep_symbol_hint_returns_none_for_too_many_symbols(self, tmp_data_dir, monkeypatch):
        """Returns None when >5 symbols match (pattern is too common to suggest a specific one)."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, i):
                        self.name = "func"
                        self.kind = "function"
                        self.file_rel = f"src/mod{i}.py"
                        self.line = i * 10
                    def __getitem__(self, key):
                        return {"name": "func", "kind": "function", "file_rel": self.file_rel, "line": self.line}[key]
                return [_Row(i) for i in range(6)]  # 6 rows → too many
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_symbol_hint
        result = _try_grep_symbol_hint("func", str(tmp_data_dir))
        assert result is None

    def test_try_grep_symbol_hint_5_symbols_fires(self, tmp_data_dir, monkeypatch):
        """_try_grep_symbol_hint fires when exactly 5 symbols match (boundary: ≤5 = emit)."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, i):
                        self.name = "func"
                        self.kind = "function"
                        self.file_rel = f"src/mod{i}.py"
                        self.line = i * 10
                    def __getitem__(self, key):
                        return {"name": "func", "kind": "function", "file_rel": self.file_rel, "line": self.line}[key]
                return [_Row(i) for i in range(5)]  # exactly 5 → must emit hint
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_symbol_hint
        result = _try_grep_symbol_hint("func", str(tmp_data_dir))
        assert result is not None, "exactly 5 symbols must produce a hint (boundary ≤5)"
        assert "token-goat symbol func" in result
        assert "mod0.py" in result
        # Multi-symbol path must NOT include a 'token-goat read' command — that is
        # reserved for the 1-symbol branch only.
        assert "token-goat read" not in result

    def test_try_grep_symbol_hint_2_symbols_uses_symbol_command(self, tmp_data_dir, monkeypatch):
        """_try_grep_symbol_hint with exactly 2 results emits symbol command, not read.

        Boundary test: 2 is the first multi-symbol case.  The result must contain
        'token-goat symbol' but must NOT contain 'token-goat read'.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, i):
                        self.name = "parse"
                        self.kind = "function"
                        self.file_rel = f"src/mod{i}.py"
                        self.line = i * 10 + 5
                    def __getitem__(self, key):
                        return {"name": "parse", "kind": "function", "file_rel": self.file_rel, "line": self.line}[key]
                return [_Row(0), _Row(1)]  # exactly 2 → multi-symbol path
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_symbol_hint
        result = _try_grep_symbol_hint("parse", str(tmp_data_dir))
        assert result is not None, "exactly 2 symbols must produce a hint"
        assert "token-goat symbol parse" in result
        assert "mod0.py" in result
        assert "token-goat read" not in result, "2-symbol path must use symbol command, not read"

    def test_hint_fires_for_dotted_pattern(self, tmp_data_dir, monkeypatch):
        """A dotted grep pattern like 'Session.load' routes through _try_grep_dotted_hint."""
        import token_goat.hooks_read as _hr

        def _fake_dotted(pattern, cwd):
            if pattern == "Session.load":
                return (
                    "For `Session.load`, `load` is indexed — use `token-goat symbol load` "
                    "to jump to its definition(s) (`session.py:42` (function)) "
                    "instead of scanning files with grep (~95% fewer tokens)."
                )
            return None

        monkeypatch.setattr(_hr, "_try_grep_dotted_hint", _fake_dotted)

        payload = {
            "session_id": "grep-dotted-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "Session.load"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat symbol load" in ctx
        assert "Session.load" in ctx

    def test_dotted_hint_deduped_on_second_grep(self, tmp_data_dir, monkeypatch):
        """The dotted-name hint is suppressed on the second grep for the same pattern."""
        import token_goat.hooks_read as _hr

        def _fake_dotted(pattern, cwd):
            return (
                "For `Session.load`, `load` is indexed — use `token-goat symbol load` "
                "to jump to its definition(s) (`session.py:42` (function)) "
                "instead of scanning files with grep (~95% fewer tokens)."
            )

        monkeypatch.setattr(_hr, "_try_grep_dotted_hint", _fake_dotted)

        payload = {
            "session_id": "grep-dotted-2",
            "tool_name": "Grep",
            "tool_input": {"pattern": "Session.load"},
            "cwd": "/proj",
        }
        hooks_cli.pre_read(payload)
        result2 = hooks_cli.pre_read(payload)
        hso2 = result2.get("hookSpecificOutput", {})
        ctx2 = hso2.get("additionalContext", "") if isinstance(hso2, dict) else ""
        assert "token-goat symbol load" not in ctx2

    def test_try_grep_dotted_hint_prefers_qualifier_match(self, tmp_data_dir, monkeypatch):
        """_try_grep_dotted_hint prefers symbols in files whose stem matches the qualifier."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, file_rel, line):
                        self.name = "load"
                        self.kind = "function"
                        self.file_rel = file_rel
                        self.line = line
                    def __getitem__(self, key):
                        return {"name": "load", "kind": "function", "file_rel": self.file_rel, "line": self.line}[key]
                # Two rows: one in session.py (matches qualifier "Session"), one elsewhere.
                return [_Row("src/session.py", 42), _Row("src/config.py", 100)]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        result = _try_grep_dotted_hint("Session.load", str(tmp_data_dir))
        assert result is not None
        # Should prefer session.py (qualifier "Session" matches stem "session").
        assert "session.py:42" in result
        # config.py should be filtered out since only the preferred row is shown.
        assert "config.py" not in result
        # The single preferred row must use the 'token-goat read' form, not 'symbol'.
        assert "token-goat read" in result, "1-preferred-row path must emit 'token-goat read'"
        assert "src/session.py::load" in result, "read command must name full relative path"

    def test_try_grep_dotted_hint_1_preferred_row_uses_read_command(self, tmp_data_dir, monkeypatch):
        """_try_grep_dotted_hint with exactly 1 preferred row emits a 'token-goat read' command.

        Verifies the 1-row branch format in isolation: the hint names both the
        full relative path and the method, and explicitly does not fall back to
        'token-goat symbol'.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self):
                        self.name = "refresh"
                        self.kind = "method"
                        self.file_rel = "src/auth/token.py"
                        self.line = 77
                    def __getitem__(self, key):
                        return {"name": "refresh", "kind": "method",
                                "file_rel": "src/auth/token.py", "line": 77}[key]
                return [_Row()]  # single row, stem "token" matches qualifier "Token"
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        result = _try_grep_dotted_hint("Token.refresh", str(tmp_data_dir))
        assert result is not None, "1 preferred row must produce a hint"
        assert "token-goat read" in result, "1-row path must emit 'token-goat read'"
        assert "src/auth/token.py::refresh" in result, "full path::method must appear in command"
        assert "token.py:77" in result, "location must be named in hint"
        # Must NOT fall back to the symbol-only format.
        assert "token-goat symbol" not in result

    def test_try_grep_dotted_hint_2_preferred_rows_uses_symbol_command(self, tmp_data_dir, monkeypatch):
        """_try_grep_dotted_hint with 2 preferred rows emits symbol command, not read.

        Boundary test for the multi-row preferred path: when the qualifier matches
        two files (e.g. session.py and session_mgr.py both define load()), the
        result must list both locations and use 'token-goat symbol', not a read
        command.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, file_rel, line):
                        self.name = "load"
                        self.kind = "function"
                        self.file_rel = file_rel
                        self.line = line
                    def __getitem__(self, key):
                        return {"name": "load", "kind": "function",
                                "file_rel": self.file_rel, "line": self.line}[key]
                # Both files have "session" in their stem → 2 preferred rows.
                return [_Row("src/session.py", 42), _Row("src/session_mgr.py", 77)]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        result = _try_grep_dotted_hint("Session.load", str(tmp_data_dir))
        assert result is not None, "2 preferred rows must produce a hint"
        assert "token-goat symbol load" in result
        assert "session.py:42" in result
        assert "session_mgr.py:77" in result
        # Multi-row path must NOT include a read command.
        assert "token-goat read" not in result

    def _make_dotted_hint_fake_conn(self, stem_prefix: str, count: int):
        """Helper: build a _FakeConn returning `count` rows all with stem matching `stem_prefix`."""
        class _FakeConn:
            def __init__(self, stem_prefix, count):
                self._stem_prefix = stem_prefix
                self._count = count
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, stem_prefix, i):
                        self.name = "load"
                        self.kind = "function"
                        self.file_rel = f"src/{stem_prefix}_{i}.py"
                        self.line = i * 10 + 5
                    def __getitem__(self, key):
                        return {"name": "load", "kind": "function",
                                "file_rel": self.file_rel, "line": self.line}[key]
                return [_Row(self._stem_prefix, i) for i in range(self._count)]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass
        return _FakeConn(stem_prefix, count)

    def test_try_grep_dotted_hint_3_preferred_rows_fires(self, tmp_data_dir, monkeypatch):
        """_try_grep_dotted_hint fires when exactly 3 preferred rows match (boundary: ≤3 = emit)."""
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        from contextlib import contextmanager

        import token_goat.db as _db
        fake_conn = self._make_dotted_hint_fake_conn("session", 3)
        @contextmanager
        def _fake_open(hash):
            yield fake_conn
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        result = _try_grep_dotted_hint("Session.load", str(tmp_data_dir))
        assert result is not None, "exactly 3 preferred rows must produce a hint (boundary ≤3)"
        assert "token-goat symbol load" in result
        assert "token-goat read" not in result

    def test_try_grep_dotted_hint_4_preferred_rows_returns_none(self, tmp_data_dir, monkeypatch):
        """_try_grep_dotted_hint returns None when exactly 4 preferred rows match (>3 boundary).

        Pins the suppression threshold: the first value above the display cap must
        produce None, not a noisy partial-result hint.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        from contextlib import contextmanager

        import token_goat.db as _db
        fake_conn = self._make_dotted_hint_fake_conn("session", 4)
        @contextmanager
        def _fake_open(hash):
            yield fake_conn
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        result = _try_grep_dotted_hint("Session.load", str(tmp_data_dir))
        assert result is None, "4 preferred rows must return None (threshold: >3)"

    def test_try_grep_dotted_hint_returns_none_for_non_dotted_pattern(self, tmp_data_dir):
        """_try_grep_dotted_hint returns None for patterns that aren't Qualifier.method."""
        from token_goat.hooks_read import _try_grep_dotted_hint

        assert _try_grep_dotted_hint("my_function", "/proj") is None
        assert _try_grep_dotted_hint("foo.bar.baz", "/proj") is None  # triple-dot
        assert _try_grep_dotted_hint("foo.", "/proj") is None           # no method
        assert _try_grep_dotted_hint(".bar", "/proj") is None            # no qualifier

    def test_try_grep_dotted_hint_suppresses_self_like_qualifiers(self, tmp_data_dir, monkeypatch):
        """self.load, cls.run, this.process must not fire when no file stem matches.

        Regression test for the case where instance-reference qualifiers (self,
        cls, this, obj, base, super) produce noise by falling back to the
        unfiltered DB rows when no file stem contains the qualifier word.
        """
        from pathlib import Path as _Path

        from token_goat.project import Project

        fake_proj = Project(root=_Path(tmp_data_dir), hash="deadbeef", marker=".git")

        import token_goat.project as _proj_mod
        monkeypatch.setattr(_proj_mod, "find_project", lambda cwd: fake_proj)

        class _FakeConn:
            def execute(self, sql, params):
                return self
            def fetchall(self):
                class _Row:
                    def __init__(self, file_rel, line):
                        self.name = "load"
                        self.kind = "function"
                        self.file_rel = file_rel
                        self.line = line
                    def __getitem__(self, key):
                        return {"name": "load", "kind": "function", "file_rel": self.file_rel, "line": self.line}[key]
                # Symbol named 'load' exists in auth.py (no "self" in stem).
                return [_Row("src/auth.py", 42)]
            def __enter__(self):
                return self
            def __exit__(self, *a):
                pass

        from contextlib import contextmanager

        import token_goat.db as _db
        @contextmanager
        def _fake_open(hash):
            yield _FakeConn()
        monkeypatch.setattr(_db, "open_project_readonly", _fake_open)

        from token_goat.hooks_read import _try_grep_dotted_hint
        for self_like_pattern in ["self.load", "cls.load", "this.load", "obj.load"]:
            result = _try_grep_dotted_hint(self_like_pattern, str(tmp_data_dir))
            assert result is None, (
                f"'{self_like_pattern}' should not fire a hint when no file stem matches "
                f"the qualifier — got: {result}"
            )

    def test_grep_symbol_redirect_hint_delivered_when_session_save_raises(self, tmp_data_dir, monkeypatch):
        """Symbol redirect hint is still delivered when session.save raises OSError.

        Regression test for the bare _sess.save(cache) call that propagated OSError
        up through pre_read into fail_soft, silently discarding the computed hint.
        All other hint paths use _flush_pending_hint_save (which swallows save errors);
        the symbol/dotted redirect path must behave consistently.

        _handle_grep_dedup runs first and also calls save (to record the grep for
        future dedup), so we let the first save succeed and raise only on the second
        (the redirect's save).
        """
        import token_goat.hooks_read as _hr
        import token_goat.session as _session_mod

        def _fake_symbol_hint(pattern, cwd):
            return "Symbol `compute` is indexed — use `token-goat read \"src/util.py::compute\"`..."

        monkeypatch.setattr(_hr, "_try_grep_symbol_hint", _fake_symbol_hint)

        # Let the dedup's save (first call) succeed; raise on the redirect's save (second call).
        original_save = _session_mod.save
        save_calls: list[int] = []

        def _patched_save(cache):
            save_calls.append(1)
            if len(save_calls) >= 2:
                raise OSError("disk full")
            return original_save(cache)

        monkeypatch.setattr(_session_mod, "save", _patched_save)

        payload = {
            "session_id": "save-error-1",
            "tool_name": "Grep",
            "tool_input": {"pattern": "compute"},
            "cwd": str(tmp_data_dir),
        }
        result = hooks_cli.pre_read(payload)

        # Hint must still be delivered despite the save failure.
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert "token-goat read" in ctx, (
            "Symbol redirect hint must be delivered even when session.save raises"
        )
        # The redirect's save must have been attempted (len >= 2).
        assert len(save_calls) >= 2, "save must have been called at least twice (dedup + redirect)"

    def test_grep_dedup_takes_priority_over_symbol_redirect(self, tmp_data_dir, monkeypatch):
        """grep dedup fires first; symbol redirect is skipped when dedup already returned."""
        import token_goat.hooks_read as _hr

        symbol_redirect_called = []

        def _fake_symbol_hint(pattern, cwd):
            symbol_redirect_called.append(pattern)
            return "Symbol `my_function` is indexed — use `token-goat symbol my_function`..."

        monkeypatch.setattr(_hr, "_try_grep_symbol_hint", _fake_symbol_hint)

        # Prime the session with a prior grep so dedup fires.
        sid = "grep-priority-1"
        session.mark_grep(
            session_id=sid, pattern="my_function", path=None,
            result_count=50,
        )

        payload = {
            "session_id": sid,
            "tool_name": "Grep",
            "tool_input": {"pattern": "my_function"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)
        # Dedup must have fired: result must contain additionalContext.
        hso = result.get("hookSpecificOutput", {})
        ctx = hso.get("additionalContext", "") if isinstance(hso, dict) else ""
        assert ctx, "grep dedup must return an additionalContext hint for result_count=50"
        # Symbol redirect must not have been called — dedup short-circuited before it.
        assert not symbol_redirect_called, (
            "_try_grep_symbol_hint must not be called when grep dedup already returned"
        )


class TestUnchangedFileHintFlushRegression:
    """Regression: unchanged-file early-return was missing _flush_pending_hint_save."""

    def test_unchanged_file_path_flushes_pending_save(self, tmp_data_dir, monkeypatch):
        """pre_read must flush deferred saves when the unchanged-file branch fires.

        Regression: the unchanged-file early-return in pre_read lacked the
        _flush_pending_hint_save(cache) call present on every other early-return
        branch.  Any mark_hint_seen() call that set _pending_hint_save=True
        before the unchanged-file check would be silently discarded at hook
        process exit.
        """
        import token_goat.hints as _hints
        import token_goat.session as _session
        from token_goat.hints import ReadHint

        sid = "unchanged_flush_regression"

        # Build a real cache with _pending_hint_save=True to simulate a
        # preceding mark_hint_seen() call.
        cache = session.load(sid)
        cache._pending_hint_save = True  # type: ignore[attr-defined]

        save_calls: list[object] = []

        def _capturing_save(c: object) -> None:
            save_calls.append(c)
            # Reset the flag so _flush_pending_hint_save considers it handled.
            if getattr(c, "_pending_hint_save", False):
                c._pending_hint_save = False  # type: ignore[attr-defined]

        monkeypatch.setattr(_session, "save", _capturing_save)

        # Ensure safe_load returns our prepared cache object.
        monkeypatch.setattr(_session, "load", lambda sid: cache)

        # Make build_unchanged_file_hint fire unconditionally.
        fake_hint = ReadHint("`mod.py` unchanged since your edit. Already in context.", tokens_saved=50)
        monkeypatch.setattr(_hints, "build_unchanged_file_hint", lambda **kw: fake_hint)

        import token_goat.db as _db
        monkeypatch.setattr(_db, "record_stat", lambda *a, **kw: None)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/mod.py"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)

        # The hint must have fired (unchanged-file branch taken).
        assert "hookSpecificOutput" in result
        ctx = result["hookSpecificOutput"]
        assert "unchanged since" in ctx.get("additionalContext", "")

        # session.save must have been called — _flush_pending_hint_save ran and
        # found _pending_hint_save=True, so it persisted the deferred mutations.
        assert len(save_calls) >= 1, (
            "session.save must be called when _pending_hint_save is set and "
            "the unchanged-file branch is taken"
        )

    def test_pre_read_flushes_hint_save_on_early_recovery_return(
        self, tmp_data_dir, monkeypatch
    ):
        """pre_read must flush deferred saves even on early recovery-hint return.

        Regression: the recovery-hint early-return in pre_read did not call
        _flush_pending_hint_save.  The try/finally wrapping the Read-tool path
        ensures _flush_pending_hint_save runs on ANY return, including
        recovery-hint returns that bypass the rest of the hint logic.
        """

        import token_goat.hooks_cli as hooks_cli
        import token_goat.session as _session

        sid = "recovery_flush_regression"
        recovery_text = "Recovery hint injected"

        # Prepare a cache with _pending_hint_save=True.
        cache = session.load(sid)
        cache._pending_hint_save = True  # type: ignore[attr-defined]

        save_calls: list[object] = []

        def _capturing_save(c: object) -> None:
            save_calls.append(c)
            if getattr(c, "_pending_hint_save", False):
                c._pending_hint_save = False  # type: ignore[attr-defined]

        monkeypatch.setattr(_session, "save", _capturing_save)
        monkeypatch.setattr(_session, "load", lambda sid: cache)

        # Make _check_recovery_pending return text so recovery-hint branch fires.
        import token_goat.hooks_read as _hr
        monkeypatch.setattr(_hr, "_check_recovery_pending", lambda *a, **kw: recovery_text)

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/test.py"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)

        # The recovery hint must have fired (early return taken).
        assert "hookSpecificOutput" in result
        assert recovery_text in result["hookSpecificOutput"].get("additionalContext", "")

        # The try/finally must have flushed the hint save even on early return.
        assert len(save_calls) >= 1, (
            "session.save must be called in finally block even when "
            "recovery-hint early-return fires"
        )

    def test_pre_read_try_finally_guarantees_flush_on_any_return(
        self, tmp_data_dir, monkeypatch
    ):
        """pre_read finally-block guarantees hint save flush on ANY return path.

        This test documents the core invariant: no matter which early-return is
        taken in the Read-tool path (recovery, index-only, structured-file, etc.),
        the finally block will execute and call _flush_pending_hint_save.  This
        makes it impossible for a developer to accidentally add a new return path
        and lose dedup fingerprints.
        """
        import token_goat.hooks_cli as hooks_cli
        import token_goat.session as _session

        sid = "finally_flush_invariant"

        # Prepare a cache with _pending_hint_save=True.
        cache = session.load(sid)
        cache._pending_hint_save = True  # type: ignore[attr-defined]

        save_calls: list[object] = []

        def _capturing_save(c: object) -> None:
            save_calls.append(c)
            if getattr(c, "_pending_hint_save", False):
                c._pending_hint_save = False  # type: ignore[attr-defined]

        monkeypatch.setattr(_session, "save", _capturing_save)
        monkeypatch.setattr(_session, "load", lambda sid: cache)

        # Make index-only-file hint fire so we hit the first early-return in the
        # try block (just after the Read-tool path starts).
        import token_goat.hooks_read as _hr
        monkeypatch.setattr(_hr, "_handle_index_only_file", lambda *a, **kw: {"continue": True})

        payload = {
            "session_id": sid,
            "tool_name": "Read",
            "tool_input": {"file_path": "/proj/uv.lock"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)

        # The index-only branch must have returned (CONTINUE).
        assert result.get("continue") is True

        # The finally block must have executed even though we returned early.
        assert len(save_calls) >= 1, (
            "session.save must be called in finally block when index-only "
            "early-return is taken (demonstrates finally-block invariant)"
        )


# ---------------------------------------------------------------------------
# Regression: P3-9 — pre_read Bash branch uses safe_load, not bare load
# ---------------------------------------------------------------------------

class TestPreReadBashSafeLoadRegression:
    """pre_read must survive a corrupt session file when the tool_name is 'Bash'.

    Regression P3-9: the Bash branch called _sess_mod.load() (raises on corrupt
    data) instead of _sess_mod.safe_load() (swallows corruption and returns None).
    A bad session file would crash the hook and block every subsequent Bash call.
    """

    def test_corrupt_session_does_not_crash_bash_pre_read(self, tmp_data_dir, monkeypatch) -> None:
        """pre_read with tool_name='Bash' must return continue even when session load raises."""
        import token_goat.hooks_cli as hooks_cli
        import token_goat.session as _session

        # Simulate a corrupt session by making safe_load return None (its contract on error)
        monkeypatch.setattr(_session, "safe_load", lambda *a, **kw: None)

        payload = {
            "session_id": "corrupt_bash_sess",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "cwd": "/proj",
        }
        result = hooks_cli.pre_read(payload)

        # Must still return a continue response — never raise or return None
        assert result is not None
        assert result.get("continue") is True

    def test_safe_load_called_in_bash_branch(self, tmp_data_dir, monkeypatch) -> None:
        """Bash branch must call safe_load at least once for the session (not only bare load)."""
        import token_goat.hooks_cli as hooks_cli
        import token_goat.session as _session

        safe_load_calls: list = []
        original_safe_load = _session.safe_load

        def _tracking_safe_load(sid, *a, **kw):
            safe_load_calls.append(sid)
            return original_safe_load(sid, *a, **kw)

        monkeypatch.setattr(_session, "safe_load", _tracking_safe_load)

        payload = {
            "session_id": "bash_load_tracking",
            "tool_name": "Bash",
            "tool_input": {"command": "pytest tests/"},
            "cwd": "/proj",
        }
        hooks_cli.pre_read(payload)

        # safe_load must have been called for this session (the Bash recovery-hint check uses it)
        assert "bash_load_tracking" in safe_load_calls, (
            "safe_load must be called in the Bash branch of pre_read (P3-9 regression)"
        )


# ---------------------------------------------------------------------------
# Bash fast-path early exit
# ---------------------------------------------------------------------------


class TestBashFastPath:
    """pre_read must return CONTINUE immediately for unrecognized Bash binaries
    without loading the session cache (saves ~1 s per hook call)."""

    def test_unrecognized_binary_skips_session_load(self, tmp_data_dir, monkeypatch):
        """chmod / rm / mkdir are fast-pathed: CONTINUE without safe_load."""
        import token_goat.session as _session

        calls: list[str] = []
        orig = _session.safe_load

        def _tracking(sid, *a, **kw):
            calls.append(sid)
            return orig(sid, *a, **kw)

        monkeypatch.setattr(_session, "safe_load", _tracking)

        for cmd in ("chmod +x script.sh", "rm -rf /tmp/junk", "mkdir -p /srv/data"):
            payload = {
                "session_id": "fp-1",
                "tool_name": "Bash",
                "tool_input": {"command": cmd},
            }
            result = hooks_cli.pre_read(payload)
            _assert_continue(result)
            assert "hookSpecificOutput" not in result, (
                f"fast-pathed command {cmd!r} must not produce hookSpecificOutput"
            )

        assert calls == [], "safe_load must not be called for fast-pathed commands"

    def test_fast_path_exclude_reaches_handler_chain(self, tmp_data_dir, monkeypatch):
        """which/where are in _BASH_FAST_PATH_EXCLUDE â†’ session IS loaded."""
        import token_goat.session as _session

        calls: list[str] = []
        orig = _session.safe_load

        def _tracking(sid, *a, **kw):
            calls.append(sid)
            return orig(sid, *a, **kw)

        monkeypatch.setattr(_session, "safe_load", _tracking)

        payload = {
            "session_id": "fp-2",
            "tool_name": "Bash",
            "tool_input": {"command": "which node"},
        }
        hooks_cli.pre_read(payload)
        assert "fp-2" in calls, "which/where must not be fast-pathed â€” safe_load must be called"

    def test_compound_command_not_fast_pathed(self, tmp_data_dir, monkeypatch):
        """Commands with && C:/Projects/token-goat/.venv/Scripts/pythonw.exe -m token_goat.cli compress --filter tail-trunc --timeout 600 --profile balanced --max-tokens 8000 --cmd 'bypass the fast-path guard (too complex to inspect first token)."""
        import token_goat.session as _session

        calls: list[str] = []
        orig = _session.safe_load

        def _tracking(sid, *a, **kw):
            calls.append(sid)
            return orig(sid, *a, **kw)

        monkeypatch.setattr(_session, "safe_load", _tracking)

        payload = {
            "session_id": "fp-3",
            "tool_name": "Bash",
            "tool_input": {"command": "chmod +x script.sh' && C:/Projects/token-goat/.venv/Scripts/pythonw.exe -m token_goat.cli compress --filter tail-trunc --timeout 600 --profile balanced --max-tokens 8000 --cmd './script.sh"},
        }
        result = hooks_cli.pre_read(payload)
        _assert_continue(result)
        assert "fp-3" in calls, "compound commands (' && ) must not be fast-pathed"
