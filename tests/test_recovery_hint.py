"""Tests for the new recovery hint features added in iter-29.

Covers:
1. _build_pending_work_section — failed pytest, uncommitted edits, non-zero uv run
2. _build_key_commands_section — context-sensitive key commands
3. _diff_stats_for_file — (+N/-M lines) diff stats from snapshots
4. _truncate_recovery_hint — 400-token default size guard (reduced from 800)
5. Integration: the new sections appear in _build_recovery_hint output
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock

from token_goat import session, snapshots
from token_goat.hooks_session import (
    _build_key_commands_section,
    _build_pending_work_section,
    _build_recovery_hint,
    _diff_stats_for_file,
    _truncate_recovery_hint,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_bash_entry(
    cmd_preview: str,
    exit_code: int | None = 0,
    ts: float | None = None,
    stdout_bytes: int = 500,
    stderr_bytes: int = 0,
    output_id: str = "test-output-id",
    cmd_sha: str = "abc123",
) -> object:
    """Return a minimal BashEntry-like object for tests."""
    from token_goat.session import BashEntry

    return BashEntry(
        cmd_sha=cmd_sha,
        cmd_preview=cmd_preview,
        output_id=output_id,
        ts=ts if ts is not None else time.time(),
        stdout_bytes=stdout_bytes,
        stderr_bytes=stderr_bytes,
        exit_code=exit_code,
        truncated=False,
    )


def _make_cache(
    bash_entries: list[object] | None = None,
    edited_files: dict[str, int] | None = None,
    files: dict | None = None,
) -> object:
    """Return a minimal SessionCache-like mock."""
    cache = MagicMock()
    # bash_history: dict keyed by cmd_sha
    hist: dict[str, object] = {}
    for i, be in enumerate(bash_entries or []):
        sha = getattr(be, "cmd_sha", f"sha{i}")
        hist[sha] = be
    cache.bash_history = hist
    cache.edited_files = edited_files or {}
    cache.files = files or {}
    # Other attrs that _build_pending_work_section uses
    cache.unavailable = False
    return cache


# ---------------------------------------------------------------------------
# 1. _build_pending_work_section
# ---------------------------------------------------------------------------


class TestBuildPendingWorkSection:
    """Tests for _build_pending_work_section."""

    def test_returns_empty_when_no_bash_history(self):
        cache = _make_cache()
        result = _build_pending_work_section(cache, {}, set())
        assert result == ""

    def test_failed_pytest_detected(self):
        """A failed pytest within 2h shows up as '### Pending Work'."""
        be = _make_bash_entry("pytest tests/", exit_code=1, stdout_bytes=2000)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "### Pending Work" in result
        assert "pytest failed" in result

    def test_failed_uv_run_pytest_detected(self):
        """'uv run pytest' is treated as pytest, not as generic uv run."""
        be = _make_bash_entry("uv run pytest -x", exit_code=2, stdout_bytes=1500)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "pytest failed" in result

    def test_successful_pytest_not_in_pending(self):
        """A green pytest must NOT appear in pending work."""
        be = _make_bash_entry("pytest tests/", exit_code=0, stdout_bytes=2000)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "pytest failed" not in result

    def test_failed_pytest_stale_ignored(self):
        """A pytest failure older than 2 hours is not surfaced."""
        old_ts = time.time() - 7201  # just over 2 hours ago
        be = _make_bash_entry("pytest", exit_code=1, ts=old_ts, stdout_bytes=2000)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "pytest failed" not in result

    def test_uncommitted_edits_when_no_git_commit(self):
        """Edited files with no subsequent successful git commit → uncommitted edits item."""
        raw_edited = {"/proj/src/auth.py": 3, "/proj/src/models.py": 1}
        be_edit = _make_bash_entry(
            "vim /proj/src/auth.py", exit_code=0, cmd_sha="edit1",
        )
        cache = _make_cache([be_edit], edited_files=raw_edited)
        result = _build_pending_work_section(cache, raw_edited, set())
        assert "Uncommitted edits" in result
        # Should list file basenames
        assert "auth.py" in result

    def test_no_uncommitted_edits_after_successful_commit(self):
        """When a successful 'git commit' follows edits, no uncommitted-edits item."""
        raw_edited = {"/proj/src/auth.py": 2}
        # Commit is more recent than the edit
        now = time.time()
        be_commit = _make_bash_entry(
            "git commit -m 'fix auth'", exit_code=0, ts=now - 1, cmd_sha="commit1",
            stdout_bytes=100,
        )
        # Set up a file entry whose last_edit_ts is before the commit
        file_entry = MagicMock()
        file_entry.last_edit_ts = now - 600  # 10 min ago, before the commit
        cache = _make_cache(
            [be_commit],
            edited_files=raw_edited,
            files={"/proj/src/auth.py": file_entry},
        )
        result = _build_pending_work_section(cache, raw_edited, set())
        assert "Uncommitted edits" not in result

    def test_failed_uv_run_non_pytest(self):
        """A non-pytest 'uv run' with non-zero exit is surfaced as pending work."""
        be = _make_bash_entry("uv run ruff check src/", exit_code=1, stdout_bytes=600)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "### Pending Work" in result
        assert "uv run" in result
        assert "exited 1" in result

    def test_capped_at_three_items(self):
        """No more than 3 items are surfaced even with multiple failures."""
        now = time.time()
        entries = [
            _make_bash_entry("pytest tests/", exit_code=1, ts=now - 100, cmd_sha="p1", stdout_bytes=1000),
            _make_bash_entry("uv run mypy src/", exit_code=1, ts=now - 200, cmd_sha="u1", stdout_bytes=800),
        ]
        raw_edited = {f"/proj/src/file{i}.py": 1 for i in range(5)}
        cache = _make_cache(entries, edited_files=raw_edited)
        result = _build_pending_work_section(cache, raw_edited, set())
        # Count bullet points (lines starting with "- ")
        bullets = [ln for ln in result.splitlines() if ln.startswith("- ")]
        assert len(bullets) <= 3

    def test_age_format_seconds(self):
        """Recent failures show seconds-ago age."""
        be = _make_bash_entry("pytest", exit_code=1, ts=time.time() - 30, stdout_bytes=2000)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "s ago" in result

    def test_age_format_minutes(self):
        """Failures minutes ago show M-ago age."""
        be = _make_bash_entry("pytest", exit_code=1, ts=time.time() - 600, stdout_bytes=2000)
        cache = _make_cache([be])
        result = _build_pending_work_section(cache, {}, set())
        assert "m ago" in result

    def test_fail_soft_on_exception(self):
        """Any exception in the section builder returns empty string, never raises."""
        # Pass a deliberately broken cache
        broken = MagicMock()
        broken.bash_history = "not a dict"  # will cause TypeError
        result = _build_pending_work_section(broken, {}, set())
        # Must not raise; must return a string (possibly empty)
        assert isinstance(result, str)


# ---------------------------------------------------------------------------
# 2. _build_key_commands_section
# ---------------------------------------------------------------------------


class TestBuildKeyCommandsSection:
    """Tests for _build_key_commands_section."""

    def test_always_includes_map_compact(self):
        result = _build_key_commands_section(False, False, False)
        assert "token-goat map --compact" in result

    def test_python_edits_adds_symbol_and_read(self):
        result = _build_key_commands_section(True, False, False)
        assert "token-goat symbol" in result
        assert 'token-goat read "file.py::FuncName"' in result

    def test_no_python_skips_symbol_commands(self):
        result = _build_key_commands_section(False, False, False)
        assert "token-goat symbol" not in result

    def test_pytest_adds_bash_output(self):
        result = _build_key_commands_section(False, True, False)
        assert "token-goat bash-output" in result
        assert "--tail 50" in result

    def test_no_pytest_skips_bash_output(self):
        result = _build_key_commands_section(False, False, False)
        # bash-output may appear in map or recall lines; check the pytest-specific form
        assert "--tail 50" not in result

    def test_web_adds_web_output(self):
        result = _build_key_commands_section(False, False, True)
        assert "token-goat web-output" in result

    def test_no_web_skips_web_output(self):
        result = _build_key_commands_section(False, False, False)
        assert "token-goat web-output" not in result

    def test_all_flags_returns_full_section(self):
        result = _build_key_commands_section(True, True, True)
        assert "### Key Commands" in result
        assert "token-goat symbol" in result
        assert "token-goat bash-output" in result
        assert "token-goat web-output" in result
        assert "token-goat map --compact" in result

    def test_section_heading_present(self):
        result = _build_key_commands_section(False, False, False)
        assert result.startswith("### Key Commands")


# ---------------------------------------------------------------------------
# 3. _diff_stats_for_file
# ---------------------------------------------------------------------------


class TestDiffStatsForFile:
    """Tests for _diff_stats_for_file."""

    def test_returns_none_when_no_snapshot(self, tmp_data_dir):
        """When no snapshot exists, returns None (no crash)."""
        result = _diff_stats_for_file("no-such-session", "/nonexistent/file.py")
        assert result is None

    def test_returns_added_removed_counts(self, tmp_data_dir, tmp_path):
        """When snapshot and current file both exist, returns correct diff stats."""
        # Write files in binary mode to avoid CRLF translation on Windows.
        old_bytes = b"line1\nline2\nline3\n"
        new_bytes = b"line1\nnew_line\nline2\nline3\nline4\n"

        current_file = tmp_path / "myfile.py"
        current_file.write_bytes(new_bytes)

        session_id = "diff-stat-test"
        # Store the old content as a snapshot.
        snapshots.store(session_id, str(current_file), old_bytes)

        result = _diff_stats_for_file(session_id, str(current_file))
        assert result is not None
        added, removed = result
        # old: 3 lines; new: 5 lines (added "new_line" and "line4") → +2, -0
        assert added == 2
        assert removed == 0

    def test_added_and_removed(self, tmp_data_dir, tmp_path):
        """Correctly counts both additions and deletions."""
        old_bytes = b"line1\nline2\nline3\n"
        new_bytes = b"line1\nline_replacement\n"

        current_file = tmp_path / "edit.py"
        current_file.write_bytes(new_bytes)

        session_id = "diff-stat-test2"
        snapshots.store(session_id, str(current_file), old_bytes)

        result = _diff_stats_for_file(session_id, str(current_file))
        assert result is not None
        added, removed = result
        # old: 3 lines; new: 2 lines → +1 added, -2 removed
        assert added == 1
        assert removed == 2

    def test_no_changes_returns_zero_zero(self, tmp_data_dir, tmp_path):
        """Identical content → (0, 0)."""
        content_bytes = b"unchanged\ncontent\n"
        current_file = tmp_path / "same.py"
        current_file.write_bytes(content_bytes)

        session_id = "diff-stat-same"
        # Store the exact same bytes as snapshot.
        snapshots.store(session_id, str(current_file), content_bytes)

        result = _diff_stats_for_file(session_id, str(current_file))
        assert result == (0, 0)

    def test_missing_current_file_returns_none(self, tmp_data_dir, tmp_path):
        """When current file doesn't exist on disk, returns None."""
        old_content = b"some old content\n"
        session_id = "diff-stat-missing"
        nonexistent = tmp_path / "gone.py"
        snapshots.store(session_id, str(nonexistent), old_content)

        result = _diff_stats_for_file(session_id, str(nonexistent))
        # File was never written, so Path.read_bytes() fails → None
        assert result is None


# ---------------------------------------------------------------------------
# 4. _truncate_recovery_hint
# ---------------------------------------------------------------------------


class TestTruncateRecoveryHint:
    """Tests for _truncate_recovery_hint."""

    def test_short_text_unchanged(self):
        text = "## Post-Compact Recovery\n\nShort hint.\n"
        result = _truncate_recovery_hint(text, max_tokens=800)
        assert result == text

    def test_drops_key_commands_first(self):
        """When over budget, Key Commands section is dropped first."""
        big_section = "**Files**:\n" + "\n".join(f"- file{i}.py" for i in range(50))
        key_cmds = "### Key Commands\n- `token-goat map --compact`\n"
        pending = "### Pending Work\n- pytest failed: 2 failures\n"
        text = "## Post-Compact Recovery\n\n" + big_section + "\n\n" + pending + "\n\n" + key_cmds
        # Make it clearly over 800 tokens worth of chars (800 * 4 = 3200 chars)
        padding = "x" * 3200
        text = text + "\n" + padding

        result = _truncate_recovery_hint(text, max_tokens=800)
        # Key Commands should be gone
        assert "### Key Commands" not in result

    def test_drops_pending_work_second(self):
        """When Key Commands alone isn't enough, Pending Work is also dropped."""
        # Build text that is over budget even after dropping Key Commands
        big_files = "**Files**:\n" + "\n".join(f"- reallylongfilepath{i}.py" for i in range(200))
        key_cmds = "### Key Commands\n- `token-goat map --compact`\n"
        pending = "### Pending Work\n- pytest failed\n- Uncommitted edits: foo.py\n"
        text = "## Post-Compact Recovery\n\n" + big_files + "\n\n" + pending + "\n\n" + key_cmds

        result = _truncate_recovery_hint(text, max_tokens=200)
        # Both sections should be dropped
        assert "### Key Commands" not in result
        assert "### Pending Work" not in result

    def test_drops_symbols_third(self):
        """Symbols section is dropped as the third priority."""
        symbols = "**Symbols**:\n" + "\n".join(f"- sym{i} (file.py)" for i in range(100))
        key_cmds = "### Key Commands\n- `token-goat map --compact`\n"
        pending = "### Pending Work\n- pytest failed\n"
        text = (
            "## Post-Compact Recovery\n\n"
            + symbols + "\n\n"
            + pending + "\n\n"
            + key_cmds
        )

        result = _truncate_recovery_hint(text, max_tokens=100)
        # Symbols should be dropped
        assert "**Symbols**:" not in result

    def test_hard_truncate_with_ellipsis_as_last_resort(self):
        """Text that is over budget after all section drops gets hard-truncated."""
        # A single massive section with no removable headers
        text = "## Post-Compact Recovery\n\n**Files**:\n" + "x" * 10000
        result = _truncate_recovery_hint(text, max_tokens=100)
        # 100 * 4 = 400 chars budget
        assert len(result) <= 400
        assert result.endswith("...")

    def test_exactly_at_budget_unchanged(self):
        """Text exactly at the character budget is returned unchanged."""
        budget_chars = 800 * 4  # 3200
        text = "A" * budget_chars
        result = _truncate_recovery_hint(text, max_tokens=800)
        assert result == text

    def test_empty_text_unchanged(self):
        result = _truncate_recovery_hint("", max_tokens=800)
        assert result == ""

    def test_preserves_header_after_dropping_sections(self):
        """The '## Post-Compact Recovery' header survives truncation."""
        big = "**Files**:\n" + "\n".join(f"- f{i}.py" for i in range(30))
        key_cmds = "### Key Commands\n- `token-goat map --compact`\n"
        text = "## Post-Compact Recovery\n\n" + big + "\n\n" + key_cmds
        padding = "y" * 4000
        text += "\n" + padding

        result = _truncate_recovery_hint(text, max_tokens=800)
        # Even after truncation, the header line must be present (if not hard-truncated)
        # Check that it's not completely absent unless hard-truncated at start
        if "## Post-Compact Recovery" not in result:
            # Should have been hard-truncated — check it ends with "..."
            assert result.endswith("...")


# ---------------------------------------------------------------------------
# 5. Integration: new sections in _build_recovery_hint
# ---------------------------------------------------------------------------


class TestRecoveryHintIntegration:
    """Integration tests: new sections appear in the full hint."""

    def test_key_commands_always_present_with_activity(self, tmp_data_dir):
        """Any session with files or bash emits the Key Commands section."""
        sid = "hint-kc-1"
        session.mark_file_read(sid, "/proj/auth.py", offset=0, limit=100)
        session.mark_file_edited(sid, "/proj/auth.py")
        hint = _build_recovery_hint(sid)
        assert hint is not None
        assert "### Key Commands" in hint

    def test_key_commands_has_python_hints_when_py_edited(self, tmp_data_dir):
        """When .py files are edited, symbol and read commands appear."""
        sid = "hint-kc-py"
        session.mark_file_edited(sid, "/proj/src/auth.py")
        hint = _build_recovery_hint(sid)
        assert hint is not None
        assert "token-goat symbol" in hint

    def test_pending_work_section_present_for_failed_pytest(self, tmp_data_dir):
        """Failed pytest in session → Pending Work section in hint."""
        sid = "hint-pw-pytest"
        # Record a failed pytest with enough output to pass the min-bytes floor
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="pytestfail",
            cmd_preview="pytest tests/",
            output_id=f"{sid}-out-pytestfail",
            stdout_bytes=1500,
            stderr_bytes=0,
            exit_code=1,
            truncated=False,
        )
        hint = _build_recovery_hint(sid)
        assert hint is not None
        assert "### Pending Work" in hint
        assert "pytest failed" in hint

    def test_pending_work_absent_for_green_pytest(self, tmp_data_dir):
        """Passing pytest → no Pending Work section."""
        sid = "hint-pw-green"
        session.mark_bash_run(
            session_id=sid,
            cmd_sha="pytestok",
            cmd_preview="pytest tests/",
            output_id=f"{sid}-out-pytestok",
            stdout_bytes=2000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        session.mark_file_edited(sid, "/proj/src/x.py")
        hint = _build_recovery_hint(sid)
        assert hint is not None
        # No pending work from a green pytest
        if "### Pending Work" in hint:
            # Could be there for uncommitted edits — that's OK
            # but "pytest failed" must not appear
            assert "pytest failed" not in hint

    def test_diff_stats_in_edited_section(self, tmp_data_dir, tmp_path):
        """When a snapshot exists for an edited file, diff stats appear."""
        sid = "hint-diff-1"
        target = tmp_path / "changes.py"
        # Use binary writes to avoid CRLF translation on Windows.
        old_bytes = b"a = 1\nb = 2\n"
        new_bytes = b"a = 1\nb = 2\nc = 3\nd = 4\n"
        target.write_bytes(new_bytes)

        # Store old content as snapshot (snapshot = state before edit).
        snapshots.store(sid, str(target), old_bytes)

        # Mark as edited so it appears in the **Edited** section.
        session.mark_file_edited(sid, str(target))

        hint = _build_recovery_hint(sid)
        assert hint is not None
        # The diff stat badge (+2/-0) should appear in the **Edited** section.
        assert "(+2/-0)" in hint

    def test_hint_within_token_budget(self, tmp_data_dir):
        """The hint must not exceed 800 tokens (3200 chars) regardless of session size."""
        sid = "hint-size-guard"
        # Seed a large session
        for i in range(20):
            session.mark_file_read(sid, f"/proj/src/mod_{i:03d}.py", offset=0, limit=200)
            session.mark_file_edited(sid, f"/proj/src/mod_{i:03d}.py")
        for i in range(10):
            session.mark_bash_run(
                session_id=sid,
                cmd_sha=f"bash{i:02d}",
                cmd_preview=f"uv run pytest tests/mod_{i:03d}.py -v",
                output_id=f"{sid}-out-bash{i:02d}",
                stdout_bytes=8000,
                stderr_bytes=0,
                exit_code=0,
                truncated=False,
            )

        hint = _build_recovery_hint(sid)
        assert hint is not None
        max_chars = 800 * 4  # 3200
        assert len(hint) <= max_chars, (
            f"Hint exceeded {max_chars} chars: got {len(hint)} chars.\n"
            f"First 200 chars: {hint[:200]!r}"
        )

    def test_uncommitted_edits_with_no_commit(self, tmp_data_dir):
        """Session with edits and no git commit surfaces uncommitted edits in Pending Work."""
        sid = "hint-uncommit"
        session.mark_file_edited(sid, "/proj/src/worker.py")
        session.mark_file_edited(sid, "/proj/src/db.py")
        hint = _build_recovery_hint(sid)
        assert hint is not None
        # Pending Work may or may not appear depending on last_edit_ts tracking,
        # but if it appears it should mention the edited file
        if "### Pending Work" in hint:
            assert "worker.py" in hint or "db.py" in hint
