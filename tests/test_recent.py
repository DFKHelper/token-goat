"""Tests for `token-goat recent` — read_commands.recent()."""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_file_entry(rel_or_abs: str, last_read_ts: float = 1000.0) -> MagicMock:
    """Return a minimal FileEntry-like mock."""
    entry = MagicMock()
    entry.rel_or_abs = rel_or_abs
    entry.last_read_ts = last_read_ts
    return entry


def _make_session_cache(
    edited_files: dict[str, int] | None = None,
    symbol_access_counts: dict[str, int] | None = None,
    files: dict | None = None,
) -> MagicMock:
    """Return a minimal SessionCache-like mock for testing.

    ``files`` mirrors session.SessionCache.files: a dict keyed by normalised
    path where each value is a FileEntry-like object with ``rel_or_abs`` and
    ``last_read_ts`` attributes.
    """
    cache = MagicMock()
    cache.unavailable = False
    cache.edited_files = edited_files or {}
    cache.symbol_access_counts = symbol_access_counts or {}
    cache.files = files or {}
    return cache


# ---------------------------------------------------------------------------
# Unit tests for _get_recent_git_files
# ---------------------------------------------------------------------------


class TestGetRecentGitFiles:
    """Unit tests for _get_recent_git_files — mock DB."""

    def test_returns_empty_when_no_project_db(self):
        from token_goat.read_commands import _get_recent_git_files

        with (
            patch("token_goat.read_commands.json.loads", side_effect=Exception("boom")),
            patch("token_goat.db.open_project_readonly", side_effect=FileNotFoundError),
        ):
            result = _get_recent_git_files("deadbeef", 10)
        assert result == []

    def test_returns_empty_when_table_missing(self):
        import sqlite3

        from token_goat.read_commands import _get_recent_git_files

        conn_mock = MagicMock()
        conn_mock.execute.side_effect = sqlite3.OperationalError("no such table")
        conn_mock.__enter__ = lambda s: s
        conn_mock.__exit__ = MagicMock(return_value=False)

        with patch("token_goat.db.open_project_readonly", return_value=conn_mock):
            result = _get_recent_git_files("deadbeef", 10)
        assert result == []

    def test_returns_files_from_commits(self):
        from token_goat.read_commands import _get_recent_git_files

        rows = [
            {"commit_short": "abc123", "summary": "fix bug", "author_ts": 1000,
             "changed_files": '["src/foo.py", "src/bar.py"]'},
            {"commit_short": "def456", "summary": "add feat", "author_ts": 900,
             "changed_files": '["src/baz.py"]'},
        ]
        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchall.return_value = rows
        conn_mock.__enter__ = lambda s: s
        conn_mock.__exit__ = MagicMock(return_value=False)

        with patch("token_goat.db.open_project_readonly", return_value=conn_mock):
            result = _get_recent_git_files("deadbeef", 10)

        paths = [r[0] for r in result]
        assert "src/foo.py" in paths
        assert "src/bar.py" in paths
        assert "src/baz.py" in paths

    def test_deduplicates_file_across_commits(self):
        from token_goat.read_commands import _get_recent_git_files

        # foo.py appears in both commits — should appear only once with label "1 commit ago"
        rows = [
            {"commit_short": "abc", "summary": "a", "author_ts": 1000,
             "changed_files": '["src/foo.py"]'},
            {"commit_short": "def", "summary": "b", "author_ts": 900,
             "changed_files": '["src/foo.py", "src/other.py"]'},
        ]
        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchall.return_value = rows
        conn_mock.__enter__ = lambda s: s
        conn_mock.__exit__ = MagicMock(return_value=False)

        with patch("token_goat.db.open_project_readonly", return_value=conn_mock):
            result = _get_recent_git_files("deadbeef", 10)

        paths = [r[0] for r in result]
        assert paths.count("src/foo.py") == 1
        # First commit -> "1 commit ago"
        foo_label = next(label for p, label in result if p == "src/foo.py")
        assert "1 commit" in foo_label

    def test_respects_limit(self):
        from token_goat.read_commands import _get_recent_git_files

        rows = [
            {"commit_short": "abc", "summary": "a", "author_ts": 1000,
             "changed_files": '["f1.py", "f2.py", "f3.py"]'},
        ]
        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchall.return_value = rows
        conn_mock.__enter__ = lambda s: s
        conn_mock.__exit__ = MagicMock(return_value=False)

        with patch("token_goat.db.open_project_readonly", return_value=conn_mock):
            result = _get_recent_git_files("deadbeef", 2)

        assert len(result) == 2


# ---------------------------------------------------------------------------
# Unit tests for _symbols_for_file
# ---------------------------------------------------------------------------


class TestSymbolsForFile:
    def test_returns_symbols_from_session_access_counts(self):
        from token_goat.read_commands import _symbols_for_file

        sess = _make_session_cache(
            symbol_access_counts={
                "src/foo.py::my_func": 3,
                "src/foo.py::AClass": 1,
                "src/bar.py::other": 2,
            }
        )
        result = _symbols_for_file("proj_hash", "src/foo.py", sess)
        assert set(result) == {"my_func", "AClass"}
        # "other" from a different file should not appear
        assert "other" not in result

    def test_returns_empty_when_no_session_and_no_db(self):
        from token_goat.read_commands import _symbols_for_file

        with patch("token_goat.db.open_project_readonly", side_effect=FileNotFoundError):
            result = _symbols_for_file("proj_hash", "src/foo.py", None)
        assert result == []

    def test_falls_back_to_db_when_session_has_no_symbols_for_file(self):
        from token_goat.read_commands import _symbols_for_file

        sess = _make_session_cache(
            symbol_access_counts={"src/other.py::unrelated": 1}
        )
        rows = [{"name": "build_hint"}, {"name": "dedupe"}]
        conn_mock = MagicMock()
        conn_mock.execute.return_value.fetchall.return_value = rows
        conn_mock.__enter__ = lambda s: s
        conn_mock.__exit__ = MagicMock(return_value=False)

        with patch("token_goat.db.open_project_readonly", return_value=conn_mock):
            result = _symbols_for_file("proj_hash", "src/foo.py", sess)

        assert "build_hint" in result
        assert "dedupe" in result


# ---------------------------------------------------------------------------
# Integration-style tests for recent()
# ---------------------------------------------------------------------------


class TestRecent:
    """Tests for read_commands.recent() — mock session, project, and git DB."""

    def _patch_project(self, project_hash: str = "abc123"):
        proj = MagicMock()
        proj.hash = project_hash
        proj.root = MagicMock()
        return patch("token_goat.project.find_project", return_value=proj)

    def test_session_edits_appear_first(self, capsys):
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/token_goat/hints.py": 2},
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[("src/token_goat/compact.py", "1 commit ago")]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=5, session_id="test-session")

        captured = capsys.readouterr().out
        lines = captured.strip().splitlines()
        # Session edit comes before git commit
        assert "hints.py" in lines[0]
        assert "edited this session" in lines[0]
        assert "compact.py" in lines[1]

    def test_git_fills_remainder(self, capsys):
        from token_goat.read_commands import recent

        # No session edits
        sess = _make_session_cache(edited_files={})

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[
                      ("src/a.py", "1 commit ago"),
                      ("src/b.py", "2 commits ago"),
                  ]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=5, session_id="test-session")

        out = capsys.readouterr().out
        assert "src/a.py" in out
        assert "src/b.py" in out

    def test_dedup_session_over_git(self, capsys):
        """Files edited this session should not appear again from git source."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/hints.py": 1},
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[
                      ("src/hints.py", "1 commit ago"),  # duplicate
                      ("src/other.py", "1 commit ago"),
                  ]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=5, session_id="test-session")

        out = capsys.readouterr().out
        # hints.py should appear exactly once
        assert out.count("hints.py") == 1
        assert "edited this session" in out
        assert "src/other.py" in out

    def test_n_limits_output(self, capsys):
        """--n limits total files shown."""
        from token_goat.read_commands import recent

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=None),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[(f"src/f{i}.py", "1 commit ago") for i in range(20)]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=3)

        out = capsys.readouterr().out
        # Only 3 files shown
        lines = [line for line in out.strip().splitlines() if "(1 commit ago)" in line]
        assert len(lines) == 3

    def test_symbols_shown_in_output(self, capsys):
        """Symbols should appear indented below the file line."""
        from token_goat.read_commands import recent

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=None),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[("src/foo.py", "1 commit ago")]),
            patch("token_goat.read_commands._symbols_for_file",
                  return_value=["build_hint", "dedup_hints"]),
        ):
            recent(n=5)

        out = capsys.readouterr().out
        assert "build_hint" in out
        assert "dedup_hints" in out
        # Symbols should be on an indented line below the file
        lines = out.strip().splitlines()
        assert lines[0].startswith("src/foo.py")
        assert lines[1].startswith("  ")

    def test_json_output(self, capsys):
        """--json emits a valid JSON object with expected structure."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/hints.py": 1},
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files", return_value=[]),
            patch("token_goat.read_commands._symbols_for_file",
                  return_value=["my_func"]),
        ):
            recent(n=5, session_id="test-session", json_output=True)

        raw = capsys.readouterr().out.strip()
        data = json.loads(raw)
        assert "files" in data
        files = data["files"]
        assert len(files) == 1
        entry = files[0]
        assert entry["path"] == "src/hints.py"
        assert entry["source"] == "edited this session"
        assert "my_func" in entry["symbols"]

    def test_no_project_no_crash(self, capsys):
        """When no project is detected, should still show session edits without crashing."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/foo.py": 1},
        )

        with (
            patch("token_goat.project.find_project", return_value=None),
            patch("token_goat.session.load", return_value=sess),
        ):
            recent(n=5, session_id="test-session")

        out = capsys.readouterr().out
        assert "src/foo.py" in out

    def test_empty_output_message(self, capsys):
        """When nothing is found, emit a friendly message."""
        from token_goat.read_commands import recent

        with (
            patch("token_goat.project.find_project", return_value=None),
            patch("token_goat.session.load", return_value=None),
        ):
            recent(n=5)

        out = capsys.readouterr().out
        assert "No recently" in out

    # ------------------------------------------------------------------
    # Tests for the "read this session" tier (session.files integration)
    # ------------------------------------------------------------------

    def test_read_files_appear_with_read_label(self, capsys):
        """Files in sess.files (read but not edited) show 'read this session'."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={},
            files={
                "src/token_goat/session.py": _make_file_entry("src/token_goat/session.py", 1000.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files", return_value=[]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=5, session_id="test-session")

        out = capsys.readouterr().out
        assert "session.py" in out
        assert "read this session" in out

    def test_read_files_between_edited_and_git(self, capsys):
        """Priority order: edited > read > git."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/edited.py": 1},
            files={
                "src/read_only.py": _make_file_entry("src/read_only.py", 999.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[("src/git_file.py", "1 commit ago")]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=10, session_id="test-session")

        out = capsys.readouterr().out
        lines = [line for line in out.strip().splitlines() if line and not line.startswith("  ")]
        # edited.py must come before read_only.py must come before git_file.py
        idx_edited = next(i for i, line in enumerate(lines) if "edited.py" in line)
        idx_read = next(i for i, line in enumerate(lines) if "read_only.py" in line)
        idx_git = next(i for i, line in enumerate(lines) if "git_file.py" in line)
        assert idx_edited < idx_read < idx_git

    def test_edited_files_not_duplicated_in_read_tier(self, capsys):
        """A file that was both edited and is in sess.files appears only once (as 'edited')."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={"src/hints.py": 2},
            files={
                "src/hints.py": _make_file_entry("src/hints.py", 1500.0),
                "src/other.py": _make_file_entry("src/other.py", 1000.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files", return_value=[]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=10, session_id="test-session")

        out = capsys.readouterr().out
        # hints.py appears exactly once and as 'edited', not 'read'
        assert out.count("hints.py") == 1
        assert "edited this session" in out
        # read this session appears for other.py only
        assert "other.py" in out
        assert "read this session" in out

    def test_read_files_sorted_by_recency(self, capsys):
        """Most recently read file appears first among read-tier entries."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={},
            files={
                "src/older.py": _make_file_entry("src/older.py", 500.0),
                "src/newer.py": _make_file_entry("src/newer.py", 2000.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files", return_value=[]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=10, session_id="test-session")

        out = capsys.readouterr().out
        lines = [line for line in out.strip().splitlines() if "read this session" in line]
        assert len(lines) == 2
        # newer.py (ts=2000) should appear before older.py (ts=500)
        assert lines.index(next(line for line in lines if "newer.py" in line)) < \
               lines.index(next(line for line in lines if "older.py" in line))

    def test_read_files_in_json_output(self, capsys):
        """JSON output includes 'read this session' entries with correct source field."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={},
            files={
                "src/compact.py": _make_file_entry("src/compact.py", 1000.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files", return_value=[]),
            patch("token_goat.read_commands._symbols_for_file", return_value=["_render"]),
        ):
            recent(n=5, session_id="test-session", json_output=True)

        raw = capsys.readouterr().out.strip()
        data = json.loads(raw)
        files = data["files"]
        assert len(files) == 1
        assert files[0]["source"] == "read this session"
        assert "_render" in files[0]["symbols"]

    def test_read_files_dedup_vs_git(self, capsys):
        """A file in sess.files that also appears in git history appears only once (as 'read')."""
        from token_goat.read_commands import recent

        sess = _make_session_cache(
            edited_files={},
            files={
                "src/parser.py": _make_file_entry("src/parser.py", 1000.0),
            },
        )

        with (
            self._patch_project(),
            patch("token_goat.session.load", return_value=sess),
            patch("token_goat.read_commands._get_recent_git_files",
                  return_value=[
                      ("src/parser.py", "1 commit ago"),  # duplicate
                      ("src/other.py", "1 commit ago"),
                  ]),
            patch("token_goat.read_commands._symbols_for_file", return_value=[]),
        ):
            recent(n=10, session_id="test-session")

        out = capsys.readouterr().out
        # parser.py should appear exactly once and as 'read this session', not git
        assert out.count("parser.py") == 1
        assert "read this session" in out
        assert "src/other.py" in out
