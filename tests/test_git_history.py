"""Tests for token_goat.git_history."""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

import pytest
from conftest import make_git_repo

from token_goat.git_history import (
    _MAX_COMMIT_AGE_DAYS,
    _REINDEX_STALENESS_SECS,
    _ensure_schema,
    _needs_reindex,
    _parse_log,
    build_hint,
    find_commits_for_file,
    index_project_history,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _mem_conn() -> sqlite3.Connection:
    """Return an in-memory SQLite connection with git history schema applied."""
    conn = sqlite3.connect(":memory:")
    _ensure_schema(conn)
    return conn


def _seed(conn: sqlite3.Connection, commits: list[dict]) -> None:
    """Insert rows into git_commits."""
    for c in commits:
        conn.execute(
            "INSERT INTO git_commits(commit_short, summary, author_ts, changed_files) "
            "VALUES (?, ?, ?, ?)",
            (c["commit_short"], c["summary"], c["author_ts"], json.dumps(c["changed_files"])),
        )
    conn.commit()


@contextmanager
def _fake_readonly(conn: sqlite3.Connection):
    """Patch db.open_project_readonly to yield the given in-memory connection."""
    @contextmanager
    def _cm(_hash):
        yield conn

    with patch("token_goat.db.open_project_readonly", _cm):
        yield


class _RecordingConn:
    """Wraps a sqlite3.Connection, recording every SQL string passed to execute()."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        self.executed: list[str] = []

    def execute(self, sql, *args, **kwargs):
        self.executed.append(sql)
        return self._conn.execute(sql, *args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._conn, name)


# ---------------------------------------------------------------------------
# _parse_log
# ---------------------------------------------------------------------------

class TestParseLog:
    def test_single_commit(self):
        raw = "\x00abc123def456789\x01add auth module\x0115000000\nmy/auth.py\nmy/utils.py\n"
        commits = _parse_log(raw)
        assert len(commits) == 1
        c = commits[0]
        assert c["commit_short"] == "abc123def456"
        assert c["summary"] == "add auth module"
        assert c["author_ts"] == 15000000
        assert c["changed_files"] == ["my/auth.py", "my/utils.py"]

    def test_multiple_commits(self):
        raw = (
            "\x00aaaa\x01first change\x011000\nfile_a.py\n"
            "\x00bbbb\x01second change\x012000\nfile_b.py\n"
        )
        commits = _parse_log(raw)
        assert len(commits) == 2
        assert commits[0]["commit_short"] == "aaaa"
        assert commits[1]["commit_short"] == "bbbb"

    def test_summary_too_short_skipped(self):
        raw = "\x00aaaa\x01wip\x011000\nfile.py\n"  # "wip" is 3 chars < _MIN_SUMMARY_LEN=6
        commits = _parse_log(raw)
        assert commits == []

    def test_empty_raw(self):
        assert _parse_log("") == []

    def test_only_null_bytes(self):
        assert _parse_log("\x00\x00\x00") == []

    def test_hash_truncated_to_12(self):
        raw = "\x00" + "a" * 40 + "\x01some long summary here\x011000\nf.py\n"
        commits = _parse_log(raw)
        assert commits[0]["commit_short"] == "a" * 12

    def test_changed_files_capped_at_40(self):
        files = [f"src/f{i}.py" for i in range(60)]
        raw = "\x00abc\x01big commit message\x011000\n" + "\n".join(files) + "\n"
        commits = _parse_log(raw)
        assert len(commits[0]["changed_files"]) == 40  # type: ignore[arg-type]

    def test_invalid_timestamp_defaults_zero(self):
        raw = "\x00abc\x01valid summary here\x01not-a-number\nfile.py\n"
        commits = _parse_log(raw)
        assert commits[0]["author_ts"] == 0


# ---------------------------------------------------------------------------
# _needs_reindex
# ---------------------------------------------------------------------------

class TestNeedsReindex:
    def test_fresh_index_not_stale(self):
        conn = _mem_conn()
        conn.execute(
            "INSERT INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
            (str(time.time()),),
        )
        conn.commit()
        assert _needs_reindex(conn) is False

    def test_stale_index_triggers_reindex(self):
        conn = _mem_conn()
        old_ts = time.time() - _REINDEX_STALENESS_SECS - 1
        conn.execute(
            "INSERT INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
            (str(old_ts),),
        )
        conn.commit()
        assert _needs_reindex(conn) is True

    def test_missing_meta_entry_triggers_reindex(self):
        conn = _mem_conn()
        assert _needs_reindex(conn) is True

    def test_git_history_meta_table_missing_triggers_reindex(self):
        conn = sqlite3.connect(":memory:")
        # No schema applied — table doesn't exist.
        assert _needs_reindex(conn) is True


# ---------------------------------------------------------------------------
# find_commits_for_file  (via patched db.open_project_readonly)
# ---------------------------------------------------------------------------

class TestFindCommitsForFile:
    def test_exact_match_only(self):
        """json_each must match exactly — no false positives from partial paths."""
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "aaa", "summary": "exact match", "author_ts": 3000,
             "changed_files": ["src/foo.py"]},
            {"commit_short": "bbb", "summary": "longer path", "author_ts": 2000,
             "changed_files": ["src/bar/src/foo.py"]},  # different file, shares suffix
            {"commit_short": "ccc", "summary": "backup file", "author_ts": 1000,
             "changed_files": ["src/foo.py.bak"]},  # extension variant
        ])
        with _fake_readonly(conn):
            results = find_commits_for_file("fakehash", "src/foo.py")
        assert len(results) == 1
        assert results[0]["commit_short"] == "aaa"

    def test_ordered_by_recency(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "old", "summary": "older commit", "author_ts": 1000,
             "changed_files": ["x.py"]},
            {"commit_short": "new", "summary": "newer commit", "author_ts": 9000,
             "changed_files": ["x.py"]},
        ])
        with _fake_readonly(conn):
            results = find_commits_for_file("fakehash", "x.py", limit=10)
        assert results[0]["commit_short"] == "new"
        assert results[1]["commit_short"] == "old"

    def test_limit_respected(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": f"c{i:03d}", "summary": f"commit {i}", "author_ts": i,
             "changed_files": ["f.py"]}
            for i in range(10)
        ])
        with _fake_readonly(conn):
            results = find_commits_for_file("fakehash", "f.py", limit=3)
        assert len(results) == 3

    def test_no_match_returns_empty(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "aaa", "summary": "some commit", "author_ts": 1000,
             "changed_files": ["other.py"]},
        ])
        with _fake_readonly(conn):
            results = find_commits_for_file("fakehash", "missing.py")
        assert results == []

    def test_missing_project_db_returns_empty(self):
        """FileNotFoundError from open_project_readonly must be swallowed."""
        def _raise(_hash):
            raise FileNotFoundError("project db not found")

        with patch("token_goat.db.open_project_readonly", _raise):
            results = find_commits_for_file("badhash", "any.py")
        assert results == []

    def test_result_fields_present(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "abc123", "summary": "fix bug", "author_ts": 5000,
             "changed_files": ["a.py"]},
        ])
        with _fake_readonly(conn):
            results = find_commits_for_file("fakehash", "a.py")
        assert len(results) == 1
        r = results[0]
        assert r["commit_short"] == "abc123"
        assert r["summary"] == "fix bug"
        assert r["author_ts"] == 5000


# ---------------------------------------------------------------------------
# build_hint
# ---------------------------------------------------------------------------

class TestBuildHint:
    def test_returns_none_when_no_commits(self):
        conn = _mem_conn()
        with _fake_readonly(conn):
            assert build_hint("fakehash", "missing.py") is None

    def test_hint_contains_file_path(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "deadbeef1234", "summary": "refactor auth", "author_ts": 1000,
             "changed_files": ["src/auth.py"]},
        ])
        with _fake_readonly(conn):
            hint = build_hint("fakehash", "src/auth.py")
        assert hint is not None
        assert "src/auth.py" in hint

    def test_hint_contains_short_hash(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "deadbeef1234", "summary": "refactor auth", "author_ts": 1000,
             "changed_files": ["src/auth.py"]},
        ])
        with _fake_readonly(conn):
            hint = build_hint("fakehash", "src/auth.py")
        assert "deadbeef" in hint  # type: ignore[operator]

    def test_today_label_for_recent_commit(self):
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "abc", "summary": "recent change", "author_ts": int(time.time()),
             "changed_files": ["f.py"]},
        ])
        with _fake_readonly(conn):
            hint = build_hint("fakehash", "f.py")
        assert "today" in hint  # type: ignore[operator]

    def test_age_days_shown_for_old_commit(self):
        conn = _mem_conn()
        ts_5d_ago = int(time.time()) - 5 * 86_400
        _seed(conn, [
            {"commit_short": "abc", "summary": "old change here", "author_ts": ts_5d_ago,
             "changed_files": ["f.py"]},
        ])
        with _fake_readonly(conn):
            hint = build_hint("fakehash", "f.py")
        assert "5d" in hint  # type: ignore[operator]

    def test_summary_truncated_to_80_chars(self):
        long_summary = "x" * 120
        conn = _mem_conn()
        _seed(conn, [
            {"commit_short": "abc", "summary": long_summary, "author_ts": 1000,
             "changed_files": ["f.py"]},
        ])
        with _fake_readonly(conn):
            hint = build_hint("fakehash", "f.py")
        assert hint is not None
        # The summary line is "  - abcdefgh: <summary> (Nd ago)"
        # It must not contain more than 80 x chars (truncated at 80)
        assert "x" * 81 not in hint


# ---------------------------------------------------------------------------
# index_project_history  (integration — requires a real temp git repo)
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestIndexProjectHistory:
    @pytest.fixture()
    def git_repo(self, tmp_path: Path):
        """Create a minimal git repo with two commits."""
        return make_git_repo(
            tmp_path,
            init_branch="main",
            user="Test",
            commits=[
                ({"a.py": "x = 1"}, "add a module"),
                ({"b.py": "y = 2"}, "add b module"),
            ],
        )

    def test_indexes_commits_and_writes_meta(self, git_repo: Path, tmp_path: Path):
        """index_project_history stores commits and updates last_indexed_at."""
        db_path = tmp_path / "project.db"
        proj_hash = "a" * 40

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
        ):
            # Use a real SQLite connection for the test.
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            count = index_project_history(git_repo, proj_hash)

        assert count == 2
        row = conn.execute(
            "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'"
        ).fetchone()
        assert row is not None
        # Timestamp should be recent (within last 10 seconds).
        assert abs(time.time() - float(row[0])) < 10

    def test_skips_reindex_when_fresh(self, git_repo: Path, tmp_path: Path):
        """Second call within staleness window returns 0 without running git."""
        db_path = tmp_path / "project.db"

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
        ):
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            _ensure_schema(conn)
            # Simulate a recent index.
            conn.execute(
                "INSERT OR REPLACE INTO git_history_meta(key, value) "
                "VALUES ('last_indexed_at', ?)",
                (str(time.time()),),
            )
            conn.commit()
            count = index_project_history(git_repo, "a" * 40)

        assert count == 0  # skipped — index is fresh

    def test_returns_zero_when_db_missing(self, tmp_path: Path):
        """No project DB → returns 0 without raising."""
        missing = tmp_path / "nonexistent.db"
        with patch("token_goat.paths.project_db_path", return_value=missing):
            count = index_project_history(tmp_path, "a" * 40)
        assert count == 0

    def test_no_merges_flag_present(self, git_repo: Path, tmp_path: Path):
        """git log must include --no-merges so merge commits are excluded."""
        db_path = tmp_path / "project.db"
        captured_args: list[list[str]] = []

        original_run_git = __import__(
            "token_goat.git_history", fromlist=["_run_git"]
        )._run_git

        def _capturing_run_git(args: list[str], cwd: Path, timeout: int = 10):
            captured_args.append(args)
            return original_run_git(args, cwd, timeout)

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
            patch("token_goat.git_history._run_git", _capturing_run_git),
        ):
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            index_project_history(git_repo, "a" * 40)

        all_args = [arg for args in captured_args for arg in args]
        assert "--no-merges" in all_args, (
            f"git log must include --no-merges to exclude merge commits; "
            f"got args: {captured_args}"
        )

    def test_git_log_after_uses_string_format(self, git_repo: Path, tmp_path: Path):
        """Verify the git log command uses '60 days ago' format, not raw Unix int."""
        db_path = tmp_path / "project.db"
        captured_args: list[list[str]] = []

        original_run_git = __import__(
            "token_goat.git_history", fromlist=["_run_git"]
        )._run_git

        def _capturing_run_git(args: list[str], cwd: Path, timeout: int = 10):
            captured_args.append(args)
            return original_run_git(args, cwd, timeout)

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
            patch("token_goat.git_history._run_git", _capturing_run_git),
        ):
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            index_project_history(git_repo, "a" * 40)

        # Find the --after flag in captured args.
        after_flags = [
            arg for args in captured_args for arg in args if arg.startswith("--after=")
        ]
        assert len(after_flags) == 1
        assert after_flags[0] == f"--after={_MAX_COMMIT_AGE_DAYS} days ago"
        # Must NOT be a raw integer.
        after_value = after_flags[0].split("=", 1)[1]
        assert not after_value.strip("-").isdigit(), (
            f"--after value must be a string date, got: {after_value!r}"
        )

    def test_failed_batch_does_not_stamp_last_indexed_at(
        self, git_repo: Path, tmp_path: Path
    ):
        """A batch where every commit insert fails must leave the index stale.

        Regression: the meta row was written unconditionally after the loop, so
        a wholly-failed batch stamped ``last_indexed_at`` and suppressed the
        retry for an hour.  An ``object()`` author_ts cannot be bound, so every
        INSERT raises and ``stored`` stays 0.
        """
        db_path = tmp_path / "project.db"
        bad_commit = {
            "commit_short": "abc123abc123",
            "summary": "valid summary here",
            "author_ts": object(),  # unbindable — every INSERT raises
            "changed_files": ["x.py"],
        }

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
            patch("token_goat.git_history._parse_log", return_value=[bad_commit]),
        ):
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            count = index_project_history(git_repo, "a" * 40)

        assert count == 0
        row = conn.execute(
            "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'"
        ).fetchone()
        assert row is None, "last_indexed_at must not be stamped when no commit stored"
        stored_rows = conn.execute("SELECT COUNT(*) FROM git_commits").fetchone()[0]
        assert stored_rows == 0

    def test_batch_inserts_run_in_a_single_transaction(
        self, git_repo: Path, tmp_path: Path
    ):
        """All commit inserts must be wrapped in exactly one BEGIN/COMMIT.

        Regression: connections open in autocommit mode (isolation_level=None),
        so without an explicit transaction each of the (up to 200) INSERTs
        committed on its own — 200 fsyncs and lock acquisitions per sweep.
        """
        db_path = tmp_path / "project.db"

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
        ):
            rec = _RecordingConn(sqlite3.connect(str(db_path)))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield rec

            mock_open_project.side_effect = _fake_open
            count = index_project_history(git_repo, "a" * 40)

        assert count == 2
        assert rec.executed.count("BEGIN") == 1, (
            f"batch must run in exactly one transaction, got "
            f"{rec.executed.count('BEGIN')} BEGIN statement(s)"
        )
        assert "COMMIT" in rec.executed

    def test_duplicate_commits_return_zero_stored_but_stamp_meta(
        self, git_repo: Path, tmp_path: Path
    ):
        """Re-indexing an already-indexed project: stored == 0, last_indexed_at still stamped.

        Regression: the original code used ``stored += 1`` unconditionally, so
        ``INSERT OR IGNORE`` duplicates incorrectly incremented the counter.
        The fixed code uses ``cur.rowcount`` (0 for ignored duplicates, 1 for new
        inserts). Separately, last_indexed_at must still be written when all
        commits are duplicates so the staleness guard prevents redundant re-indexes.
        """
        db_path = tmp_path / "project.db"
        proj_hash = "a" * 40

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
        ):
            conn = sqlite3.connect(str(db_path))
            from contextlib import contextmanager as cm

            @cm
            def _fake_open(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open
            # First run: indexes 2 commits and stamps last_indexed_at
            count1 = index_project_history(git_repo, proj_hash)

        assert count1 == 2

        # Reset the staleness guard so the second run actually re-indexes.
        conn.execute(
            "INSERT OR REPLACE INTO git_history_meta(key, value) VALUES ('last_indexed_at', ?)",
            (str(time.time() - _REINDEX_STALENESS_SECS - 1),),
        )
        conn.commit()

        with (
            patch("token_goat.paths.project_db_path", return_value=db_path),
            patch("token_goat.db.open_project") as mock_open_project,
        ):
            @cm
            def _fake_open2(_hash):
                yield conn

            mock_open_project.side_effect = _fake_open2
            # Second run: all commits already present — stored must be 0.
            count2 = index_project_history(git_repo, proj_hash)

        assert count2 == 0, (
            "Re-indexing a project with all-duplicate commits must return 0, "
            f"not {count2}. The stored counter must use cursor.rowcount."
        )
        # last_indexed_at must still be refreshed so the staleness guard works.
        row = conn.execute(
            "SELECT value FROM git_history_meta WHERE key = 'last_indexed_at'"
        ).fetchone()
        assert row is not None
        assert abs(time.time() - float(row[0])) < 10, (
            "last_indexed_at must be updated even when all commits are duplicates "
            "so the staleness guard suppresses redundant re-indexes."
        )
