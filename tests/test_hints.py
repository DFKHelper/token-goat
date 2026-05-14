"""Tests for hints.build_read_hint() — all hint-generation cases."""
from __future__ import annotations

from pathlib import Path

from tokenwise import db, session
from tokenwise.hints import (
    LARGE_FILE_LINE_THRESHOLD,
    _est_tokens_from_lines,
    build_read_hint,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mark(tmp_data_dir, sid: str, path: str, *, offset=0, limit=100, symbol=None):
    """Shortcut to mark a file read in the session cache."""
    session.mark_file_read(sid, path, offset=offset, limit=limit, symbol=symbol)


def _make_large_file(path: Path, n_lines: int = LARGE_FILE_LINE_THRESHOLD + 10) -> None:
    """Write a file with `n_lines` simple lines."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(f"line {i}" for i in range(1, n_lines + 1)), encoding="utf-8")


# ---------------------------------------------------------------------------
# Case 1: no session_id → None
# ---------------------------------------------------------------------------


class TestNoSessionId:
    def test_no_session_id_returns_none(self, tmp_data_dir):
        result = build_read_hint(
            session_id=None,
            file_path="/some/file.py",
            offset=0,
            limit=100,
            cwd="/some",
        )
        assert result is None

    def test_empty_session_id_returns_none(self, tmp_data_dir):
        result = build_read_hint(
            session_id="",
            file_path="/some/file.py",
            offset=0,
            limit=100,
            cwd="/some",
        )
        assert result is None

    def test_no_file_path_returns_none(self, tmp_data_dir):
        result = build_read_hint(
            session_id="s1",
            file_path="",
            offset=0,
            limit=100,
            cwd="/some",
        )
        assert result is None


# ---------------------------------------------------------------------------
# Case 2: file not in cache, file not large → None
# ---------------------------------------------------------------------------


class TestFileNotCachedNotLarge:
    def test_small_uncached_file_returns_none(self, tmp_data_dir, tmp_path):
        # No git/marker so no project; ensure no crash.
        result = build_read_hint(
            session_id="s1",
            file_path=str(tmp_path / "small.py"),
            offset=0,
            limit=50,
            cwd=str(tmp_path),
        )
        assert result is None

    def test_no_cwd_returns_none(self, tmp_data_dir):
        result = build_read_hint(
            session_id="s1",
            file_path="/tmp/foo.py",
            offset=0,
            limit=50,
            cwd=None,
        )
        assert result is None


# ---------------------------------------------------------------------------
# Case 3: file in cache, exact same range → "already read" + token waste
# ---------------------------------------------------------------------------


class TestCachedExactRange:
    def test_exact_range_hint(self, tmp_data_dir):
        sid = "s_exact"
        path = "C:/proj/foo.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=200,
            cwd=None,
        )
        assert hint is not None
        assert "already read" in hint
        assert "wastes" in hint.lower() or "waste" in hint.lower()
        expected_tokens = _est_tokens_from_lines(200)
        assert str(expected_tokens) in hint

    def test_exact_range_superset_also_triggers(self, tmp_data_dir):
        """Cached range that fully contains the requested range triggers exact_match."""
        sid = "s_super"
        path = "C:/proj/bar.py"
        # Cache lines 1-500
        _mark(tmp_data_dir, sid, path, offset=0, limit=500)

        # Request lines 51-150 (fully inside cached 1-500)
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=50,
            limit=100,
            cwd=None,
        )
        assert hint is not None
        assert "already read" in hint


# ---------------------------------------------------------------------------
# Case 4: file in cache, overlapping range → overlap warning + offset suggestion
# ---------------------------------------------------------------------------


class TestCachedOverlappingRange:
    def test_overlap_hint_mentions_overlap_and_offset(self, tmp_data_dir):
        sid = "s_overlap"
        path = "C:/proj/baz.py"
        # Cache lines 1-300
        _mark(tmp_data_dir, sid, path, offset=0, limit=300)

        # Request lines 201-450 — overlap = 201..300 = 100 lines (> MIN_OVERLAP_TO_WARN=50).
        # req_start=201, req_end=450; cached end=300; overlap = 300-201+1=100.
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=200,   # 0-indexed → start line 201
            limit=250,
            cwd=None,
        )
        assert hint is not None
        assert "overlap" in hint.lower()
        assert "offset" in hint.lower()

    def test_small_overlap_no_warn(self, tmp_data_dir):
        """Overlap below MIN_OVERLAP_TO_WARN should not produce an overlap warning."""
        sid = "s_small_ov"
        path = "C:/proj/small_ov.py"
        # Cache lines 1-100
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)

        # Request lines 91-200 — overlap = 10 lines (< 50)
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=90,
            limit=110,
            cwd=None,
        )
        # Should get the mild FYI, not the overlap warning
        assert hint is not None
        assert "overlap" not in hint.lower()
        assert "fyi" in hint.lower() or "earlier" in hint.lower()


# ---------------------------------------------------------------------------
# Case 5: file in cache, non-overlapping range → FYI
# ---------------------------------------------------------------------------


class TestCachedNonOverlappingRange:
    def test_non_overlapping_produces_fyi(self, tmp_data_dir):
        sid = "s_fyi"
        path = "C:/proj/noop.py"
        # Cache lines 1-100
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)

        # Request lines 500-600 — zero overlap
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=499,
            limit=100,
            cwd=None,
        )
        assert hint is not None
        assert "fyi" in hint.lower() or "earlier" in hint.lower()
        # Should NOT warn about wasted tokens
        assert "wastes" not in hint.lower()


# ---------------------------------------------------------------------------
# Case 6: symbol-only prior reads → mention tokenwise read
# ---------------------------------------------------------------------------


class TestSymbolOnlyCache:
    def test_symbol_read_hint(self, tmp_data_dir):
        sid = "s_sym"
        path = "C:/proj/mod.py"
        session.mark_file_read(sid, path, symbol="MyClass")
        session.mark_file_read(sid, path, symbol="helper_fn")

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=2000,
            cwd=None,
        )
        assert hint is not None
        assert "tokenwise read" in hint
        assert "MyClass" in hint
        assert "symbol" in hint.lower()

    def test_symbol_hint_lists_up_to_three(self, tmp_data_dir):
        sid = "s_sym3"
        path = "C:/proj/big.py"
        for sym in ["Alpha", "Beta", "Gamma", "Delta"]:
            session.mark_file_read(sid, path, symbol=sym)

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=100,
            cwd=None,
        )
        assert hint is not None
        # Should mention at most 3 symbols inline (4th is "more")
        assert "Alpha" in hint
        assert "and 1 more" in hint


# ---------------------------------------------------------------------------
# Case 7: large indexed file, not in session cache → tokenwise read suggestion
# ---------------------------------------------------------------------------


class TestLargeIndexedFile:
    def test_large_file_with_symbols_produces_hint(self, tmp_data_dir, tmp_path):
        """Set up: project root with .git, large file, index symbols → hint returned."""
        # Create .git so find_project detects tmp_path as root
        (tmp_path / ".git").mkdir()

        # Write a large file
        src_file = tmp_path / "bigfile.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 100)

        # Index a symbol into the project DB
        from tokenwise.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("bigfile.py", "python", 1000, 0.0, "abc123", 0),
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
                ("MyClass", "class", "bigfile.py", 10, 0, 50),
            )

        hint = build_read_hint(
            session_id="s_large",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        assert "tokenwise read" in hint
        assert "MyClass" in hint
        assert "symbol" in hint.lower()
        assert "85%" in hint

    def test_large_file_no_symbols_no_hint(self, tmp_data_dir, tmp_path):
        """Large file but no indexed symbols → no hint."""
        (tmp_path / ".git").mkdir()
        src_file = tmp_path / "unlabeled.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 50)

        hint = build_read_hint(
            session_id="s_nosym",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is None


# ---------------------------------------------------------------------------
# Case 8: non-existent cwd / non-project cwd → no hint
# ---------------------------------------------------------------------------


class TestNonProjectCwd:
    def test_nonexistent_cwd_returns_none(self, tmp_data_dir):
        hint = build_read_hint(
            session_id="s_nonexist",
            file_path="/tmp/some_file.py",
            offset=0,
            limit=100,
            cwd="/this/path/does/not/exist/at/all",
        )
        assert hint is None

    def test_cwd_with_no_project_marker_returns_none(self, tmp_data_dir, tmp_path):
        """tmp_path has no .git or other markers → find_project returns None."""
        src_file = tmp_path / "afile.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 10)

        hint = build_read_hint(
            session_id="s_noproj",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is None


# ---------------------------------------------------------------------------
# Honest savings accounting — ReadHint.tokens_saved
# ---------------------------------------------------------------------------


class TestReadHintTokensSaved:
    """tokens_saved must reflect *realized* avoided cost, not speculation.

    Regression: the pre-read hook used to record `session_hint` savings for
    every hint — including pure suggestions — at a flat "25% of file" estimate,
    inflating `tokenwise stats` with savings that never happened.
    """

    def test_exact_match_hint_carries_real_saving(self, tmp_data_dir):
        sid, path = "s_ts_exact", "C:/proj/foo.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None
        )
        assert hint is not None
        # An exact re-read of 200 cached lines — the whole request is avoidable.
        assert hint.tokens_saved == _est_tokens_from_lines(200)

    def test_overlap_hint_carries_overlap_saving(self, tmp_data_dir):
        sid, path = "s_ts_overlap", "C:/proj/baz.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=300)
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=200, limit=250, cwd=None
        )
        assert hint is not None
        # Overlap is lines 201-300 = 100 lines — only that is avoidable.
        assert hint.tokens_saved == _est_tokens_from_lines(100)

    def test_fyi_hint_records_no_saving(self, tmp_data_dir):
        """Non-overlapping prior read: the agent proceeds — nothing is saved."""
        sid, path = "s_ts_fyi", "C:/proj/noop.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=499, limit=100, cwd=None
        )
        assert hint is not None
        assert hint.tokens_saved == 0

    def test_symbol_only_hint_records_no_saving(self, tmp_data_dir):
        """Symbol-access nudge is a suggestion, not a realized saving."""
        sid, path = "s_ts_sym", "C:/proj/syms.py"
        _mark(tmp_data_dir, sid, path, symbol="some_func")
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=2000, cwd=None
        )
        assert hint is not None
        assert hint.tokens_saved == 0

    def test_index_suggestion_hint_records_no_saving(self, tmp_data_dir, tmp_path):
        """The 'large file, use tokenwise read' hint is a suggestion → 0 saving.

        If acted on, `tokenwise read` records the real `read_replacement` stat;
        counting a saving here too would double-count, and counting one when
        the hint is ignored is phantom inflation.
        """
        from tokenwise.parser import index_project
        from tokenwise.project import make_project_at

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()  # so build_read_hint's find_project detects it
        big = proj_root / "big.py"
        # Give it an indexed symbol so _hint_from_index has something to show.
        big.write_text(
            "def indexed_marker():\n    return 1\n"
            + "\n".join(f"# line {i}" for i in range(LARGE_FILE_LINE_THRESHOLD + 50)),
            encoding="utf-8",
        )
        proj = make_project_at(proj_root)
        index_project(proj, full=True)

        hint = build_read_hint(
            session_id="s_ts_index",
            file_path=str(big),
            offset=0,
            limit=2000,
            cwd=str(proj_root),
        )
        assert hint is not None
        assert "tokenwise read" in hint  # confirms it's the index suggestion hint
        assert hint.tokens_saved == 0
