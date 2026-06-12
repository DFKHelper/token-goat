"""Tests for new context-saving features: project_memory, git_history, compact stale/cold."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# project_memory
# ---------------------------------------------------------------------------


class TestProjectMemory:
    def test_set_and_load(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "owner", "alice")
            entries = project_memory.load_entries("abc123")
        assert entries["owner"] == "alice"

    def test_unset_removes_key(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "k", "v")
            project_memory.unset_entry("abc123", "k")
            entries = project_memory.load_entries("abc123")
        assert "k" not in entries

    def test_unset_nonexistent_is_noop(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.unset_entry("abc123", "ghost")

    def test_clear_all(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "a", "1")
            project_memory.set_entry("abc123", "b", "2")
            project_memory.clear_all("abc123")
            assert project_memory.load_entries("abc123") == {}

    def test_invalid_key_raises(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path), pytest.raises(ValueError):
            project_memory.set_entry("abc123", "bad key!", "v")

    def test_build_injection_returns_none_when_empty(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            result = project_memory.build_injection("abc123")
        assert result is None

    def test_build_injection_returns_markdown(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "stack", "Python/FastAPI")
            result = project_memory.build_injection("abc123")
        assert result is not None
        assert "stack" in result
        assert "Python/FastAPI" in result
        assert result.startswith("## Project Memory")

    def test_value_truncated_in_injection(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            long_val = "x" * 400
            project_memory.set_entry("abc123", "big", long_val)
            result = project_memory.build_injection("abc123")
        assert result is not None
        assert "…" in result

    def test_newline_in_value_survives_roundtrip(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "note", "line1\nline2")
            entries = project_memory.load_entries("abc123")
        assert entries["note"] == "line1\nline2"

    def test_carriage_return_in_value_survives_roundtrip(self, tmp_path: Path) -> None:
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "crlf", "line1\r\nline2")
            entries = project_memory.load_entries("abc123")
        assert entries["crlf"] == "line1\r\nline2"

    def test_total_size_budget_enforced(self, tmp_path: Path) -> None:
        """Oversized injection must be bounded and emit the omission marker."""
        from token_goat import paths, project_memory
        from token_goat.project_memory import _MAX_TOTAL_CHARS

        with patch.object(paths, "data_dir", return_value=tmp_path):
            # Each value is 350 chars; 20 entries × ~370 chars/line >> _MAX_TOTAL_CHARS
            for i in range(20):
                project_memory.set_entry("abc123", f"key{i:02d}", "v" * 350)
            result = project_memory.build_injection("abc123")

        assert result is not None
        assert len(result) <= _MAX_TOTAL_CHARS + 200  # omission line may push slightly past
        assert "omitted" in result

    def test_normal_memory_not_truncated_by_total_budget(self, tmp_path: Path) -> None:
        """A typical small memory block must not be cut off by the total budget."""
        from token_goat import paths, project_memory

        with patch.object(paths, "data_dir", return_value=tmp_path):
            project_memory.set_entry("abc123", "stack", "Python/FastAPI")
            project_memory.set_entry("abc123", "owner", "alice")
            result = project_memory.build_injection("abc123")

        assert result is not None
        assert "omitted" not in result
        assert "stack" in result
        assert "owner" in result


# ---------------------------------------------------------------------------
# git_history — unit tests (no real git required)
# ---------------------------------------------------------------------------


class TestGitHistoryParse:
    def test_parse_log_basic(self) -> None:
        from token_goat.git_history import _parse_log

        raw = "\x00abc123def456\x01fix(auth): validate token\x011700000000\nsrc/auth.py\nsrc/utils.py\n"
        commits = _parse_log(raw)
        assert len(commits) == 1
        assert commits[0]["commit_short"] == "abc123def456"
        assert commits[0]["summary"] == "fix(auth): validate token"
        assert commits[0]["author_ts"] == 1700000000
        assert "src/auth.py" in commits[0]["changed_files"]  # type: ignore[operator]

    def test_parse_log_skips_short_summaries(self) -> None:
        from token_goat.git_history import _parse_log

        raw = "\x00aabbccddeeff\x01wip\x011700000000\n"
        commits = _parse_log(raw)
        assert commits == []

    def test_parse_log_multiple_commits(self) -> None:
        from token_goat.git_history import _parse_log

        raw = (
            "\x00aaa111bbb222\x01feat(x): add feature\x011700000001\nsrc/x.py\n"
            "\x00bbb222ccc333\x01fix(y): fix bug\x011700000002\nsrc/y.py\n"
        )
        commits = _parse_log(raw)
        assert len(commits) == 2

    def test_build_hint_returns_none_on_empty(self) -> None:
        from token_goat import git_history

        with patch.object(git_history, "find_commits_for_file", return_value=[]):
            result = git_history.build_hint("proj123", "src/foo.py")
        assert result is None

    def test_build_hint_formats_correctly(self) -> None:
        from token_goat import git_history

        now = time.time()
        fake_commits = [
            {
                "commit_short": "abc123456789",
                "summary": "fix(bar): patch issue",
                "author_ts": int(now) - 86_400 * 3,
            }
        ]
        with patch.object(git_history, "find_commits_for_file", return_value=fake_commits):
            result = git_history.build_hint("proj123", "src/bar.py")
        assert result is not None
        assert "src/bar.py" in result
        assert "fix(bar): patch issue" in result
        assert "3d" in result
        # Terse header: starts with "git: " not a verbose sentence
        assert result.startswith("git: ")
        # No verbose "ago" suffix in age label
        assert "ago" not in result


# ---------------------------------------------------------------------------
# compact.py — stale reads and cold outputs
# ---------------------------------------------------------------------------


class TestCompactStaleAndCold:
    @pytest.fixture(autouse=True)
    def _isolate_data_dir(self, tmp_data_dir):
        """Point data_dir at a fresh temp dir so bash_outputs/ is empty.

        Without this, _render → _render_active_errors_section globs the real
        bash_outputs/ dir (thousands of .json files) on every test.
        """

    def _make_cache(
        self,
        *,
        edited: dict | None = None,
        files: list[tuple[str, float, float]] | None = None,
        bash_ts_offset: int | None = None,
        age_seconds: float = 7200.0,
    ):
        """Build a minimal SessionCache-like object.

        *age_seconds* controls the session age reported via ``created_ts``.
        Defaults to 7200 s (2 h, "mature" tier) so bash/web sections are not
        suppressed by the young-session guard in ``_render``.
        """
        from types import SimpleNamespace

        cache = SimpleNamespace()
        cache.edited_files = edited or {}
        cache.greps = []
        cache.bash_history = {}
        cache.web_history = {}
        # Backdate created_ts to match the requested age tier.
        cache.created_ts = time.time() - age_seconds

        file_entries: dict = {}
        for rel, last_read, last_edit in (files or []):
            entry = SimpleNamespace()
            entry.rel_or_abs = rel
            entry.symbols_read = []
            entry.read_count = 1
            entry.last_read_ts = last_read
            entry.last_edit_ts = last_edit
            entry.line_ranges = []
            file_entries[rel.lower()] = entry
        cache.files = file_entries

        if bash_ts_offset is not None:
            be = SimpleNamespace()
            be.ts = time.time() - bash_ts_offset
            be.stdout_bytes = 1000
            be.stderr_bytes = 0
            be.output_id = "test-output-id"
            be.cmd_preview = "pytest tests/"
            be.exit_code = 0
            be.truncated = False
            cache.bash_history = {"x": be}

        return cache

    def test_stale_read_files_detected(self) -> None:
        # stale_read file must be a different file from the edited one so it is
        # not suppressed by the "already listed in Files Edited" dedup filter.
        from token_goat import compact

        now = time.time()
        cache = self._make_cache(
            edited={"src/bar.py": 1},
            files=[("src/foo.py", now - 100, now - 50)],  # foo.py: stale, not in edited
        )
        with patch("token_goat.compact.estimate_tokens", return_value=1):
            result, _ = compact._render(cache, "sess1234", 400)  # type: ignore[attr-defined]
        assert "⚠" in result
        assert "Outdated File Snapshots" in result

    def test_no_stale_section_when_read_is_current(self) -> None:
        from token_goat import compact

        now = time.time()
        cache = self._make_cache(
            edited={"src/bar.py": 1},
            files=[("src/bar.py", now - 50, now - 100)],  # read AFTER edit
        )
        with patch("token_goat.compact.estimate_tokens", return_value=1):
            result, _ = compact._render(cache, "sess1234", 400)  # type: ignore[attr-defined]
        assert "Outdated File Snapshots" not in result

    def test_cold_outputs_section_appears(self) -> None:
        from token_goat import compact

        # bash output that is 40 minutes old (> _COLD_OUTPUT_AGE_SECS = 1800)
        # min_lines=2 applies: add second entry so Cold Outputs section renders
        cache = self._make_cache(
            edited={"src/x.py": 1},
            bash_ts_offset=2400,
        )
        # Add a second cold bash entry manually
        import time
        be2 = cache.bash_history.copy()
        from types import SimpleNamespace
        be = SimpleNamespace()
        be.ts = time.time() - 2400
        be.stdout_bytes = 500
        be.stderr_bytes = 0
        be.output_id = "test-output-id-2"
        be.cmd_preview = "ruff check src/"
        be.exit_code = 0
        be.truncated = False
        cache.bash_history = {"x": be2["x"], "y": be}
        # Use 800 tokens so the bash budget slice (10%) is wide enough to hold
        # both the "Commands Run" header+entry AND the "Cold Outputs" block.
        with patch("token_goat.compact.estimate_tokens", return_value=1):
            result, _ = compact._render(cache, "sess1234", 800)  # type: ignore[attr-defined]
        assert "❄" in result
        # Cold-bash header was shortened from "Cold Outputs (evict — recall …)"
        # to "**Cold:** evict, recall via `token-goat bash-output <id>`".
        # Verify the cold-bash header marker and the recall pointer both render.
        assert "**Cold:**" in result
        assert "token-goat bash-output" in result

    def test_recent_bash_not_flagged_cold(self) -> None:
        from token_goat import compact

        # bash output only 5 minutes old (< _COLD_OUTPUT_AGE_SECS = 1800)
        cache = self._make_cache(
            edited={"src/x.py": 1},
            bash_ts_offset=300,
        )
        with patch("token_goat.compact.estimate_tokens", return_value=1):
            result, _ = compact._render(cache, "sess1234", 400)  # type: ignore[attr-defined]
        assert "Cold Outputs" not in result

    def test_legend_contains_stale_and_cold_markers(self) -> None:
        from token_goat import compact

        now = time.time()
        # Stale read + cold bash output present, so the conditional legend
        # must list both stale=⚠ and cold=❄.
        cache = self._make_cache(
            edited={"src/bar.py": 1},
            files=[("src/foo.py", now - 100, now - 50)],
            bash_ts_offset=2400,
        )
        # Use 800 tokens so the bash budget slice (10%) is wide enough to hold
        # both the "Commands Run" header+entry AND the "Cold Outputs" block.
        with patch("token_goat.compact.estimate_tokens", return_value=1):
            result, _ = compact._render(cache, "sess1234", 800)  # type: ignore[attr-defined]
        assert "stale=⚠" in result
        assert "cold=❄" in result


# ---------------------------------------------------------------------------
# hooks_session — git history indexing wired in
# ---------------------------------------------------------------------------


class TestSessionStartGitHistory:
    def test_session_start_does_not_index_git_history_inline(self) -> None:
        """Git-history indexing is owned by the background worker, not the
        SessionStart hook. The hook used to spawn it on a daemon thread that
        died with the millisecond-lived hook process; the worker-side path is
        covered by test_reindex_triggers_git_history_indexing.
        """
        from token_goat import git_history, hooks_session

        fake_proj = MagicMock()
        fake_proj.root = Path("/fake/root")
        fake_proj.hash = "deadbeef" * 5

        with (
            patch("token_goat.hooks_session._detect", return_value=fake_proj),
            patch("token_goat.hooks_session._auto_index_if_needed"),
            patch("token_goat.hooks_session._ensure_worker_running"),
            patch("token_goat.hooks_session._reset_session_cache"),
            patch("token_goat.hooks_session._try_recovery_response", return_value=None),
            patch("token_goat.hooks_session._build_startup_context", return_value=None),
            patch("token_goat.db.touch_project_last_seen"),
            patch.object(git_history, "index_project_history") as mock_git,
        ):
            payload = {"session_id": "s" * 32, "cwd": "/fake/root", "source": "startup"}
            hooks_session.session_start(payload)

        assert not hasattr(hooks_session, "_index_git_history"), (
            "_index_git_history was reintroduced — git-history indexing belongs to the worker"
        )
        mock_git.assert_not_called()


# ---------------------------------------------------------------------------
# hooks_read — git hint appended to pre_read context
# ---------------------------------------------------------------------------


class TestPreReadGitHint:
    @pytest.fixture(autouse=True)
    def _isolate_db(self, tmp_data_dir):
        """Redirect DB writes to a temp dir so tests don't touch the production database.

        Both tests call hooks_read.pre_read() which calls db.record_stat() →
        open_global().  Without isolation this opens the real global.db and the
        wal_checkpoint(TRUNCATE) on close takes 5-9 s on Windows.
        """

    def test_git_hint_appended_to_session_hint(self) -> None:
        from token_goat import hooks_read

        fake_hint = MagicMock()
        fake_hint.__str__ = lambda self: "session hint text"
        fake_hint.tokens_saved = 10

        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            # build_read_hint is imported inside pre_read from hints; patch at source
            patch("token_goat.hints.build_read_hint", return_value=fake_hint),
            patch("token_goat.hooks_read._build_git_hint", return_value="git hint text"),
            patch("token_goat.hooks_read._record_session_hint_impact"),
            patch("token_goat.session.load", return_value=MagicMock(
                files={},
                hints_seen=set(),
                hints_content_dedup={},
                has_hint_fingerprint=lambda fp: False,
                has_session_hint_been_emitted=lambda key: False,
                get_hint_content_summary=lambda ch: None,
                record_hint_content_seen=MagicMock(),
            )),
        ):
            payload = {
                "tool_name": "Read",
                "session_id": "s" * 32,
                "cwd": "/fake",
                "tool_input": {"file_path": "/fake/src/foo.py"},
            }
            response = hooks_read.pre_read(payload)

        ctx = response.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "session hint text" in ctx
        assert "git hint text" in ctx

    def test_git_hint_standalone_when_no_session_hint(self) -> None:
        from token_goat import hooks_read

        with (
            patch("token_goat.hooks_read._try_shrink_image", return_value=None),
            patch("token_goat.hooks_read._try_diff_hint", return_value=None),
            patch("token_goat.hints.build_read_hint", return_value=None),
            patch("token_goat.hooks_read._build_git_hint", return_value="git only"),
            patch("token_goat.session.load", return_value=MagicMock(
                files={},
                edited_files={},
                hints_content_dedup={},
                has_hint_fingerprint=lambda fp: False,
                get_hint_content_summary=lambda ch: None,
                record_hint_content_seen=MagicMock(),
            )),
        ):
            payload = {
                "tool_name": "Read",
                "session_id": "s" * 32,
                "cwd": "/fake",
                "tool_input": {"file_path": "/fake/src/bar.py"},
            }
            response = hooks_read.pre_read(payload)

        ctx = response.get("hookSpecificOutput", {}).get("additionalContext", "")
        assert "git only" in ctx
