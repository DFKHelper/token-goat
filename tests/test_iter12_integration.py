"""Integration tests for iters 9-11: MCP stale invalidation, Bash streak hint,
and polling-loop detection.

Covers three gaps the unit tests don't reach:

1. **Stats accounting** — bash_streak_hint, bash_poll_hint, mcp_cache_invalidated
   record to DB, surface in summarize(), and appear in render_text().

2. **Renderer group assignment** — bash_range_read_hint, bash_streak_hint, and
   bash_poll_hint land in the "Bash" group; mcp_cache_invalidated falls through
   to "Other" (no MCP group exists yet).

3. **Pipeline wiring** — pre_read actually dispatches to the streak hint and
   poll hint handlers when session state meets their thresholds; the call path
   is exercised end-to-end via hooks_read.pre_read().
"""
from __future__ import annotations

import time

import pytest

from token_goat import db, hooks_read, session, stats
from token_goat.bash_cache import command_hash
from token_goat.mcp_cache import is_mcp_read_only
from token_goat.render.stats_renderer import _kind_group_label

# ---------------------------------------------------------------------------
# 1. Stats accounting
# ---------------------------------------------------------------------------


class TestNewStatKindAccounting:
    def test_bash_streak_hint_records(self, tmp_data_dir):
        db.record_stat(None, "bash_streak_hint", bytes_saved=0, tokens_saved=0)
        summary = stats.summarize(window_days=30)
        assert "bash_streak_hint" in summary.by_kind
        assert summary.by_kind["bash_streak_hint"]["events"] == 1

    def test_bash_poll_hint_records(self, tmp_data_dir):
        db.record_stat(None, "bash_poll_hint", bytes_saved=0, tokens_saved=0)
        summary = stats.summarize(window_days=30)
        assert "bash_poll_hint" in summary.by_kind
        assert summary.by_kind["bash_poll_hint"]["events"] == 1

    def test_mcp_cache_invalidated_records(self, tmp_data_dir):
        db.record_stat(None, "mcp_cache_invalidated", bytes_saved=0, tokens_saved=0)
        summary = stats.summarize(window_days=30)
        assert "mcp_cache_invalidated" in summary.by_kind
        assert summary.by_kind["mcp_cache_invalidated"]["events"] == 1

    def test_all_three_kinds_accumulate(self, tmp_data_dir):
        db.record_stat(None, "bash_streak_hint")
        db.record_stat(None, "bash_poll_hint")
        db.record_stat(None, "mcp_cache_invalidated")
        summary = stats.summarize(window_days=30)
        assert summary.total_events == 3

    def test_render_text_includes_streak_hint(self, tmp_data_dir):
        db.record_stat(None, "bash_streak_hint")
        summary = stats.summarize(window_days=30)
        assert "bash_streak_hint" in stats.render_text(summary)

    def test_render_text_includes_poll_hint(self, tmp_data_dir):
        db.record_stat(None, "bash_poll_hint")
        summary = stats.summarize(window_days=30)
        assert "bash_poll_hint" in stats.render_text(summary)


# ---------------------------------------------------------------------------
# 2. Renderer group assignment
# ---------------------------------------------------------------------------


class TestRendererGroupAssignment:
    @pytest.mark.parametrize("kind", [
        "bash_range_read_hint",
        "bash_streak_hint",
        "bash_poll_hint",
        "bash_dedup_hint",
    ])
    def test_bash_hint_kinds_land_in_bash_group(self, kind: str) -> None:
        assert _kind_group_label(kind) == "Bash", (
            f"{kind!r} should be in 'Bash' group, got {_kind_group_label(kind)!r}"
        )

    def test_mcp_cache_invalidated_falls_to_other(self) -> None:
        assert _kind_group_label("mcp_cache_invalidated") == "Other"


# ---------------------------------------------------------------------------
# 3a. Pipeline wiring — streak hint
# ---------------------------------------------------------------------------


class TestStreakHintPipelineWiring:
    """pre_read Bash branch fires streak hint after 2 prior reads of the same file."""

    def _seed_file_reads(self, sid: str, path: str, count: int) -> None:
        """Record *count* read events for *path* in the session."""
        for _ in range(count):
            session.mark_file_read(sid, path, offset=0, limit=200)

    def test_streak_hint_fires_from_pre_read(self, tmp_data_dir, tmp_path):
        (tmp_path / ".git").mkdir()
        src = tmp_path / "module.py"
        src.write_text("def foo(): pass\n" * 50, encoding="utf-8")

        sid = "streak-wiring-1"
        # Use posix-style path so bash_parser correctly identifies the read target.
        path = src.as_posix()

        # Seed two prior reads so read_count == 2; the next Bash cat is the 3rd.
        self._seed_file_reads(sid, path, 2)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": tmp_path.as_posix(),
        })

        assert result is not None, "Expected a hint response from pre_read"
        ctx = (result.get("additionalContext", "")
               or result.get("hookSpecificOutput", {}).get("additionalContext", ""))
        assert "module.py" in ctx, f"Expected filename in hint; got: {ctx!r}"

    def test_no_streak_hint_below_threshold(self, tmp_data_dir, tmp_path):
        (tmp_path / ".git").mkdir()
        src = tmp_path / "small.py"
        src.write_text("x = 1\n", encoding="utf-8")

        sid = "streak-wiring-2"
        path = src.as_posix()

        # Only one prior read — read_count == 1; hint must not fire.
        self._seed_file_reads(sid, path, 1)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": tmp_path.as_posix(),
        })

        ctx = ""
        if result is not None:
            hso = result.get("hookSpecificOutput", {})
            ctx = result.get("additionalContext", "") or hso.get("additionalContext", "")
        # Streak hint must not fire; the result may be None or a different hint.
        assert "has been read" not in ctx, (
            f"Streak hint fired at read_count==1; got: {ctx!r}"
        )

    def test_streak_hint_is_advisory(self, tmp_data_dir, tmp_path):
        (tmp_path / ".git").mkdir()
        src = tmp_path / "check.py"
        src.write_text("def bar(): ...\n" * 30, encoding="utf-8")

        sid = "streak-wiring-3"
        path = src.as_posix()
        self._seed_file_reads(sid, path, 2)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": f"cat {path}"},
            "cwd": tmp_path.as_posix(),
        })

        assert result is not None
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"


# ---------------------------------------------------------------------------
# 3b. Pipeline wiring — poll hint
# ---------------------------------------------------------------------------


class TestPollHintPipelineWiring:
    """pre_read Bash branch fires poll hint when a known polling command has run 2+x."""

    def _seed_bash_runs(self, sid: str, cmd: str, cwd: str, count: int) -> None:
        cmd_sha = command_hash(cmd, cwd)
        cache = session.load(sid)
        for i in range(count):
            cache = session.mark_bash_run(
                session_id=sid,
                cmd_sha=cmd_sha,
                cmd_preview=cmd,
                output_id=f"out-poll-{i}",
                stdout_bytes=100,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
                cache=cache,
            )
        session.save(cache)

    def test_poll_hint_fires_from_pre_read(self, tmp_data_dir, tmp_path):
        sid = "poll-wiring-1"
        cmd = "gh run view 12345"
        cwd = str(tmp_path)

        # Two prior runs → run_count == 2; 3rd call should trigger the hint.
        self._seed_bash_runs(sid, cmd, cwd, 2)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": cwd,
        })

        assert result is not None, "Expected a poll-hint response from pre_read"
        ctx = (result.get("additionalContext", "")
               or result.get("hookSpecificOutput", {}).get("additionalContext", ""))
        assert "until" in ctx or "loop" in ctx.lower() or "sleep" in ctx, (
            f"Expected loop suggestion in hint; got: {ctx!r}"
        )

    def test_curl_poll_hint_fires_from_pre_read(self, tmp_data_dir, tmp_path):
        sid = "poll-wiring-2"
        cmd = "curl https://api.example.com/status"
        cwd = str(tmp_path)

        self._seed_bash_runs(sid, cmd, cwd, 2)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": cwd,
        })

        assert result is not None, "Expected poll-hint for curl polling"

    def test_poll_hint_absent_for_first_two_runs(self, tmp_data_dir, tmp_path):
        sid = "poll-wiring-3"
        cmd = "gh run view 99999"
        cwd = str(tmp_path)

        # Only one prior run — run_count == 1; hint must not fire.
        self._seed_bash_runs(sid, cmd, cwd, 1)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": cwd,
        })

        ctx = ""
        if result is not None:
            hso = result.get("hookSpecificOutput", {})
            ctx = result.get("additionalContext", "") or hso.get("additionalContext", "")
        assert "manual polling" not in ctx, (
            f"Poll hint fired at run_count==1; got: {ctx!r}"
        )

    def test_stale_poll_entry_suppresses_hint(self, tmp_data_dir, tmp_path):
        """Hint is suppressed when last run was > 600 seconds ago."""
        sid = "poll-wiring-4"
        cmd = "gh run view 77777"
        cwd = str(tmp_path)

        cmd_sha = command_hash(cmd, cwd)
        cache = session.load(sid)
        # Run twice to build up run_count, then manually age the timestamp.
        for i in range(2):
            cache = session.mark_bash_run(
                session_id=sid,
                cmd_sha=cmd_sha,
                cmd_preview=cmd,
                output_id=f"out-stale-{i}",
                stdout_bytes=100,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
                cache=cache,
            )
        # Push ts back beyond the 600 s stale threshold.
        entry = cache.bash_history.get(cmd_sha)
        assert entry is not None
        entry.ts = time.time() - 700.0
        session.save(cache)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": cwd,
        })

        ctx = ""
        if result is not None:
            hso = result.get("hookSpecificOutput", {})
            ctx = result.get("additionalContext", "") or hso.get("additionalContext", "")
        assert "manual polling" not in ctx, (
            f"Stale entry should suppress hint; got: {ctx!r}"
        )

    def test_poll_hint_is_advisory(self, tmp_data_dir, tmp_path):
        sid = "poll-wiring-5"
        cmd = "gh run view 55555"
        cwd = str(tmp_path)
        self._seed_bash_runs(sid, cmd, cwd, 2)

        result = hooks_read.pre_read({
            "session_id": sid,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": cwd,
        })

        assert result is not None
        hso = result.get("hookSpecificOutput", {})
        assert hso.get("permissionDecision") != "deny"


# ---------------------------------------------------------------------------
# 4. MCP copy-verb classification (iter 9)
# ---------------------------------------------------------------------------


class TestMcpCopyClassification:
    @pytest.mark.parametrize("tool_name", [
        "mcp__claude_ai_Google_Drive__copy_file",
        "mcp__plugin_github_github__copy_file",
        "mcp__some_service__copy_document",
    ])
    def test_copy_verb_is_not_read_only(self, tool_name: str) -> None:
        assert not is_mcp_read_only(tool_name), (
            f"{tool_name!r} contains 'copy' and should not be read-only"
        )

    @pytest.mark.parametrize("tool_name", [
        "mcp__plugin_github_github__get_file_contents",
        "mcp__claude_ai_Google_Drive__read_file_content",
        "mcp__plugin_github_github__list_issues",
        "mcp__plugin_github_github__search_repositories",
    ])
    def test_read_verbs_are_read_only(self, tool_name: str) -> None:
        assert is_mcp_read_only(tool_name), (
            f"{tool_name!r} should be classified read-only"
        )
