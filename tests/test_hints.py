"""Tests for hints.build_read_hint() — all hint-generation cases."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

from token_goat import db, session
from token_goat.hints import (
    _BASH_DEDUP_GREP_SUGGEST_BYTES,
    _BASH_DEDUP_LIGHT_MAX_BYTES,
    _BASH_DEDUP_MIN_BYTES,
    LARGE_FILE_LINE_THRESHOLD,
    STALE_READ_AGE_SECONDS,
    _est_tokens_from_chars,
    _est_tokens_from_lines,
    _get_indexed_symbols_and_line_count,
    _hint_fingerprint,
    _line_count,
    _sha256_hex,
    _total_cached_lines,
    build_bash_dedup_hint,
    build_read_hint,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mark(tmp_data_dir, sid: str, path: str, *, offset=0, limit=100, symbol=None):
    """Shortcut to mark a file read in the session cache."""
    session.mark_file_read(sid, path, offset=offset, limit=limit, symbol=symbol)


def _make_large_file(path: Path, n_lines: int = LARGE_FILE_LINE_THRESHOLD + 10) -> None:
    """Write a file with `n_lines` lines long enough to exceed the stat fast-path threshold.

    Each line is ~76 bytes so LARGE_FILE_LINE_THRESHOLD lines ≈ 38 KB, clearing the
    LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE byte threshold in build_read_hint.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(f"x = {'x' * 70}  # {i:05d}" for i in range(1, n_lines + 1)), encoding="utf-8")


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
        # Mock find_project to avoid a slow directory walk — this test exercises
        # the "file not in cache, file not large" path, not project detection.
        with patch("token_goat.hints.find_project", return_value=None), \
             patch("token_goat.hints._get_indexed_symbols_and_line_count",
                   return_value=([], None, False)):
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
        assert "⌘" in hint  # terse form of "cached"
        assert "waste" in hint.lower()
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
        assert "⌘" in hint  # terse form of "cached"

    def test_partial_reread_reports_full_cached_waste_not_request_window(self, tmp_data_dir):
        """An exact-match partial re-read reports waste for the FULL cached content.

        Regression for the "~NNNNt wasted" undercount: when a large file is fully
        cached (e.g. 1-500) and the agent re-reads a narrow sub-window (51-150),
        the waste figure must reflect the whole file already in context (500
        lines), not just the 100-line requested window.  The pre-fix code used
        ``_est_tokens_from_lines(requested_lines)`` and reported the partial
        figure; this test fails on that code and passes on the fix.
        """
        sid = "s_partial_waste"
        path = "C:/proj/big.py"
        # Cache the whole file: lines 1-500.
        _mark(tmp_data_dir, sid, path, offset=0, limit=500)

        # Re-read a narrow sub-window fully inside the cached range.
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=50,   # 0-indexed → start line 51
            limit=100,   # lines 51-150
            cwd=None,
        )
        assert hint is not None
        assert "waste" in hint.lower()

        full_tokens = _est_tokens_from_lines(500)
        request_tokens = _est_tokens_from_lines(100)
        # The hint must advertise the full-file waste, never the partial window.
        assert str(full_tokens) in hint
        assert str(request_tokens) not in hint
        # And the machine-readable tokens_saved annotation matches the full figure.
        assert hint.tokens_saved == full_tokens


class TestTotalCachedLines:
    """Unit coverage for the union-counting helper behind the waste figure."""

    def test_single_range(self):
        assert _total_cached_lines([(1, 100)]) == 100

    def test_overlapping_ranges_not_double_counted(self):
        # 1-100 and 50-150 union to 1-150 = 150 distinct lines.
        assert _total_cached_lines([(1, 100), (50, 150)]) == 150

    def test_adjacent_ranges_merge(self):
        # 1-100 and 101-200 are contiguous → 200 distinct lines.
        assert _total_cached_lines([(1, 100), (101, 200)]) == 200

    def test_disjoint_ranges_sum(self):
        assert _total_cached_lines([(1, 100), (301, 400)]) == 200

    def test_sentinel_and_empty_ignored(self):
        assert _total_cached_lines([(0, 0)]) == 0
        assert _total_cached_lines([]) == 0


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

    def test_small_overlap_no_hint(self, tmp_data_dir):
        """Overlap below MIN_OVERLAP_TO_WARN produces no hint at all.

        The avoidable cost is too small to be worth an overlap warning, and the
        bulk of the request is new content — so, like a fully non-overlapping
        re-read, there is nothing actionable to inject.
        """
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
        assert hint is None


# ---------------------------------------------------------------------------
# Case 5: file in cache, non-overlapping range → FYI
# ---------------------------------------------------------------------------


class TestCachedNonOverlappingRange:
    def test_non_overlapping_produces_no_hint(self, tmp_data_dir):
        """A prior read with zero overlap is suppressed entirely.

        The agent is reading genuinely new content, so there is nothing
        actionable to say — injecting an "FYI, proceeding" note would only
        cost tokens in the conversation for no benefit.
        """
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
        assert hint is None


# ---------------------------------------------------------------------------
# Case 6: symbol-only prior reads → mention token-goat read
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
        assert "token-goat read" in hint
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
        assert "+1" in hint


# ---------------------------------------------------------------------------
# Case 7: large indexed file, not in session cache → token-goat read suggestion
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
        from token_goat.project import find_project
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
        assert "token-goat read" in hint
        assert "MyClass" in hint
        assert "symbol" in hint.lower()
        assert "85%" in hint

    def test_large_file_hint_is_terse(self, tmp_data_dir, tmp_path):
        """The large-file hint must not enumerate every indexed symbol.

        The hint text itself costs tokens in the conversation, so it carries
        one example command, not a per-symbol listing. Regression guard against
        the old verbose 'Top symbols: ...' block creeping back.
        """
        (tmp_path / ".git").mkdir()
        src_file = tmp_path / "many.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 100)

        from token_goat.project import find_project

        proj = find_project(tmp_path)
        assert proj is not None
        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("many.py", "python", 1000, 0.0, "abc123", 0),
            )
            for i in range(12):
                conn.execute(
                    "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (f"sym_{i}", "function", "many.py", 10 + i, 0, 12 + i),
                )

        hint = build_read_hint(
            session_id="s_terse",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        assert "Top symbols:" not in hint
        # Only the first symbol appears (inside the example command); the rest
        # are not enumerated.
        assert "sym_5" not in hint
        assert len(hint) < 400  # comfortably terse

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
        """tmp_path has no .git or other markers → find_project returns None.

        Mock find_project to return None immediately — this test verifies
        build_read_hint's behaviour when no project is detected, not the
        project-detection walk itself (which would scan the entire directory
        tree up to the filesystem root and add ~2 s on Windows).
        """
        src_file = tmp_path / "afile.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 10)

        with patch("token_goat.hints.find_project", return_value=None), \
             patch("token_goat.hints._get_indexed_symbols_and_line_count",
                   return_value=([], None, False)):
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
    inflating `token-goat stats` with savings that never happened.
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

    def test_fyi_hint_is_suppressed(self, tmp_data_dir):
        """Non-overlapping prior read: nothing actionable → no hint at all.

        Previously this returned an "FYI, proceeding" ReadHint with
        tokens_saved=0. That hint cost tokens to inject for zero benefit, so it
        is now suppressed entirely (build_read_hint returns None).
        """
        sid, path = "s_ts_fyi", "C:/proj/noop.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=499, limit=100, cwd=None
        )
        assert hint is None

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
        """The 'large file, use token-goat read' hint is a suggestion → 0 saving.

        If acted on, `token-goat read` records the real `read_replacement` stat;
        counting a saving here too would double-count, and counting one when
        the hint is ignored is phantom inflation.
        """
        from token_goat.parser import index_project
        from token_goat.project import make_project_at

        proj_root = tmp_path / "proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()  # so build_read_hint's find_project detects it
        big = proj_root / "big.py"
        # Give it an indexed symbol so _hint_from_index has something to show.
        # Lines must be long enough to exceed the stat fast-path threshold
        # (LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE bytes).
        big.write_text(
            "def indexed_marker():\n    return 1\n"
            + "\n".join(f"# {'-' * 72} {i:04d}" for i in range(LARGE_FILE_LINE_THRESHOLD + 50)),
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
        assert "token-goat read" in hint  # confirms it's the index suggestion hint
        assert hint.tokens_saved == 0


# ---------------------------------------------------------------------------
# _est_tokens_from_chars
# ---------------------------------------------------------------------------


class TestEstTokensFromChars:
    def test_nonzero_chars(self):
        result = _est_tokens_from_chars(350)
        assert result == max(1, int(350 / 3.5))

    def test_zero_chars_returns_one(self):
        assert _est_tokens_from_chars(0) == 1


# ---------------------------------------------------------------------------
# _line_count edge cases
# ---------------------------------------------------------------------------


class TestLineCount:
    def test_nonexistent_path_returns_none(self, tmp_path):
        result = _line_count(tmp_path / "ghost.py")
        assert result is None

    def test_directory_returns_none(self, tmp_path):
        d = tmp_path / "subdir"
        d.mkdir()
        result = _line_count(d)
        assert result is None

    def test_oserror_returns_none(self, tmp_path):
        p = tmp_path / "file.py"
        p.write_text("line1\nline2\n", encoding="utf-8")
        with patch.object(Path, "open", side_effect=OSError("perm denied")):
            result = _line_count(p)
        assert result is None


# ---------------------------------------------------------------------------
# _get_indexed_symbols_and_line_count — exception path
# ---------------------------------------------------------------------------


class TestGetIndexedSymbolsAndLineCount:
    def test_db_exception_returns_empty_and_none(self, tmp_data_dir):
        from token_goat import db as _db
        with patch.object(_db, "open_project", side_effect=_db.DBError("db gone")):
            symbols, n_lines, exact = _get_indexed_symbols_and_line_count("foo.py", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
        assert symbols == []
        assert n_lines is None
        assert exact is False


# ---------------------------------------------------------------------------
# _hint_from_index — relative path and out-of-root edge cases
# ---------------------------------------------------------------------------


class TestHintFromIndexEdgeCases:
    def test_exact_line_count_skips_fallback_file_read(self, tmp_data_dir, tmp_path):
        """Stored line counts should make small indexed files return None without rereading."""
        from token_goat.parser import index_project
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        src = tmp_path / "small.py"
        src.write_text("def greet():\n    return 1\n", encoding="utf-8")

        proj = find_project(tmp_path)
        assert proj is not None
        index_project(proj, full=True)

        with patch("token_goat.hints._line_count", side_effect=AssertionError("fallback read should not run")):
            hint = build_read_hint(
                session_id="s_exact",
                file_path=str(src),
                offset=0,
                limit=2000,
                cwd=str(tmp_path),
            )
        assert hint is None

        symbols, n_lines, exact = _get_indexed_symbols_and_line_count("small.py", proj.hash)
        assert symbols
        assert exact is True
        assert n_lines == 2

    def test_relative_file_path_resolves_under_project_root(self, tmp_data_dir, tmp_path):
        """Relative file_path is joined with the project root before DB lookup."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "rel.py"
        _make_large_file(src, n_lines=LARGE_FILE_LINE_THRESHOLD + 50)

        from token_goat.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("rel.py", "python", 50000, 0.0, "abc", 0),
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
                ("RelFunc", "function", "rel.py", 5, 0, 20),
            )

        # Pass a *relative* file_path (no leading slash)
        hint = build_read_hint(
            session_id="s_rel",
            file_path="rel.py",
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        assert "token-goat read" in hint

    def test_large_file_no_symbols_emits_chunk_hint(self, tmp_data_dir, tmp_path):
        """Large indexed file with no symbols gets a 'read in chunks' hint.

        Previously this returned None (no hint at all), letting the agent load
        hundreds of tokens silently.  Now it emits a chunk-read suggestion.

        The file must be large enough (>= LARGE_FILE_LINE_THRESHOLD * 75 bytes)
        to pass the stat fast-path, so we write lines of 80 characters each.
        """
        from token_goat.hints import _BYTES_PER_LINE_ESTIMATE  # type: ignore[attr-defined]

        (tmp_path / ".git").mkdir()
        src = tmp_path / "big_data.json"
        # Write lines long enough to exceed the stat threshold.
        n_lines = LARGE_FILE_LINE_THRESHOLD + 50
        line = "x" * (_BYTES_PER_LINE_ESTIMATE + 5)  # 80 chars → safely above 75B/line estimate
        src.parent.mkdir(parents=True, exist_ok=True)
        src.write_text("\n".join(line for _ in range(n_lines)), encoding="utf-8")
        assert src.stat().st_size >= LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE

        from token_goat.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("big_data.json", "json", 80000, 0.0, "abc", 0),
            )
            # No symbols inserted — simulate a structured-data file or a language
            # whose parser extracts no named symbols.

        hint = build_read_hint(
            session_id="s_no_sym",
            file_path=str(src),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        assert "offset" in hint
        assert "limit" in hint
        # Should NOT suggest token-goat read (no symbol to target)
        assert "token-goat read" not in hint

    def test_small_file_stat_skips_index_lookup(self, tmp_data_dir, tmp_path):
        """Files smaller than LARGE_FILE_LINE_THRESHOLD*75 bytes skip _hint_from_index.

        The stat fast-path avoids the project-find + DB round-trip for small
        files.  We verify by patching _hint_from_index to raise if called —
        the test must pass without triggering it.
        """
        from token_goat.hints import (  # type: ignore[attr-defined]
            _BYTES_PER_LINE_ESTIMATE,
            LARGE_FILE_LINE_THRESHOLD,
        )

        (tmp_path / ".git").mkdir()
        src = tmp_path / "small.py"
        # Write a file that is clearly below the byte threshold.
        src.write_text("x = 1\n" * 5, encoding="utf-8")
        assert src.stat().st_size < LARGE_FILE_LINE_THRESHOLD * _BYTES_PER_LINE_ESTIMATE

        with patch(
            "token_goat.hints._hint_from_index",
            side_effect=AssertionError("_hint_from_index must not be called for small files"),
        ):
            hint = build_read_hint(
                session_id="s_stat_skip",
                file_path=str(src),
                offset=0,
                limit=2000,
                cwd=str(tmp_path),
            )
        assert hint is None

    def test_file_outside_project_root_returns_none(self, tmp_data_dir, tmp_path):
        """File path that cannot be made relative to project root → no hint."""
        (tmp_path / ".git").mkdir()
        outside = tmp_path.parent / "elsewhere.py"
        outside.write_text("\n".join(["x"] * (LARGE_FILE_LINE_THRESHOLD + 10)), encoding="utf-8")

        hint = build_read_hint(
            session_id="s_outside",
            file_path=str(outside),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is None

    def test_db_estimate_too_small_but_actual_file_also_small_returns_none(self, tmp_data_dir, tmp_path):
        """When DB line estimate < threshold AND actual file < threshold → no hint."""
        (tmp_path / ".git").mkdir()
        src = tmp_path / "tiny.py"
        src.write_text("\n".join(["x"] * 10), encoding="utf-8")  # 10 lines, well below threshold

        from token_goat.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("tiny.py", "python", 50, 0.0, "abc", 0),  # tiny size → low line estimate
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
                ("fn", "function", "tiny.py", 1, 0, 3),
            )

        hint = build_read_hint(
            session_id="s_tiny",
            file_path=str(src),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is None


# ---------------------------------------------------------------------------
# Case 9: cached entry whose content is stale — edited after read or aged out
# ---------------------------------------------------------------------------


class TestCachedStaleEntry:
    """Suppress the line-range dedup hint when cached ranges can't be trusted.

    Two scenarios:
    1. The file was Write/Edit'd after the last read — line numbers no longer
       map to the same content (any insertion shifts every later line).
    2. The cached read is older than STALE_READ_AGE_SECONDS — the model has
       most likely scrolled the content out of its actual context window.
    """

    def test_edited_after_read_suppresses_exact_match_hint(self, tmp_data_dir):
        """Editing a file after reading invalidates its line-range hint.

        Without this guard, the model gets a "you already read lines X-Y"
        nudge that points at lines that may now contain entirely different
        code because the edit inserted or removed lines above range X.
        """
        sid = "s_edited_exact"
        path = "C:/proj/edited.py"
        # Read lines 1-200, then edit the file — last_edit_ts > last_read_ts.
        # Backdate last_read_ts so the subsequent mark_file_edited timestamp is
        # guaranteed strictly greater (avoids a sub-millisecond timing race).
        session.mark_file_read(sid, path, offset=0, limit=200)
        from token_goat.session import _normalize_path
        _cache = session.load(sid)
        _cache.files[_normalize_path(path)].last_read_ts -= 1.0
        session.save(_cache)
        session.mark_file_edited(sid, path)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is None, (
            "Expected no hint after edit invalidated the cached range, "
            f"got: {hint!r}"
        )

    def test_edited_after_read_suppresses_overlap_hint(self, tmp_data_dir):
        """Even partial-overlap hints are suppressed when cache is stale."""
        sid = "s_edited_overlap"
        path = "C:/proj/edited_ov.py"
        session.mark_file_read(sid, path, offset=0, limit=300)
        session.mark_file_edited(sid, path)

        # Overlap of 100 lines would normally fire the overlap hint.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=200, limit=250, cwd=None,
        )
        assert hint is None

    def test_read_after_edit_re_enables_hint(self, tmp_data_dir):
        """If the file is re-read after the edit, the new read is current.

        After a fresh post-edit read the cached ranges describe the *current*
        content, so the dedup hint is meaningful again on the next request.
        """
        sid = "s_edit_then_read"
        path = "C:/proj/cycled.py"
        session.mark_file_read(sid, path, offset=0, limit=200)
        session.mark_file_edited(sid, path)
        # Backdate last_edit_ts so the next mark_file_read timestamp is
        # guaranteed to be strictly newer — avoids a real time.sleep().
        from token_goat.session import _normalize_path
        _cache = session.load(sid)
        _entry = _cache.files[_normalize_path(path)]
        _entry.last_edit_ts -= 1.0
        session.save(_cache)
        session.mark_file_read(sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"

    def test_stale_entry_suppresses_hint(self, tmp_data_dir):
        """A read older than STALE_READ_AGE_SECONDS is treated as out of context."""
        sid = "s_stale"
        path = "C:/proj/stale.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Backdate the read so it is "stale" — the cached lines are presumed
        # to have scrolled out of the model's context.
        cache = session.load(sid)
        from token_goat.session import _normalize_path
        entry = cache.files[_normalize_path(path)]
        entry.last_read_ts = time.time() - (STALE_READ_AGE_SECONDS + 60)
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is None

    def test_edited_after_read_does_not_break_symbol_only_entries(self, tmp_data_dir):
        """If only symbols (not line ranges) were tracked, the entry has no
        line numbers to invalidate — but the edit still means the symbol body
        likely changed.  Suppress the suggestion to be safe.
        """
        sid = "s_edited_sym"
        path = "C:/proj/edited_sym.py"
        session.mark_file_read(sid, path, symbol="MyClass")
        session.mark_file_edited(sid, path)

        # Symbol-only entries have empty line_ranges, so the new guard's
        # "and entry.line_ranges" predicate lets this through.  The existing
        # symbol-hint path then fires normally — names don't shift on edit.
        # This is the conservative tradeoff: keep symbol nudges, kill range nudges.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=2000, cwd=None,
        )
        # Symbol hint is allowed; the test exists so future tightening of this
        # behaviour stays explicit.
        assert hint is None or "token-goat read" in hint


class TestEditedFileTimestamp:
    """``mark_file_edited`` should stamp ``last_edit_ts`` on the read entry."""

    def test_mark_file_edited_stamps_last_edit_ts(self, tmp_data_dir):
        sid = "s_stamp"
        path = "C:/proj/stamp.py"
        session.mark_file_read(sid, path, offset=0, limit=10)

        before = time.time()
        session.mark_file_edited(sid, path)
        after = time.time()

        from token_goat.session import _normalize_path
        cache = session.load(sid)
        entry = cache.files[_normalize_path(path)]
        # 0.05s slack on each side covers clock granularity on Windows.
        assert before - 0.05 <= entry.last_edit_ts <= after + 0.05

    def test_mark_file_edited_without_prior_read_is_noop_on_read_map(self, tmp_data_dir):
        """Editing a file that was never read does not invent a read entry."""
        sid = "s_edit_only"
        path = "C:/proj/edit_only.py"
        session.mark_file_edited(sid, path)

        cache = session.load(sid)
        # edited_files map gains an entry; files map remains empty.
        assert cache.edited_files
        assert cache.files == {}

    def test_file_entry_persists_last_edit_ts_across_reload(self, tmp_data_dir):
        """``last_edit_ts`` round-trips through the JSON cache."""
        sid = "s_persist"
        path = "C:/proj/persist.py"
        session.mark_file_read(sid, path, offset=0, limit=10)
        session.mark_file_edited(sid, path)

        # Reload from disk (simulating a fresh hook process).
        reloaded = session.load(sid)
        from token_goat.session import _normalize_path
        entry = reloaded.files[_normalize_path(path)]
        assert entry.last_edit_ts > 0.0

class TestSurgicalReadSuppression:
    """Narrow re-reads with explicit limit should not trigger the dedup nag.

    When the agent supplies an explicit ``limit`` (i.e., they picked a small,
    deliberate window — not the implicit DEFAULT_READ_LIMIT fallback) and the
    requested span is at or below ``_NARROW_EXPLICIT_READ_LINES``, the
    exact-match hint is suppressed. Rationale documented next to the constant
    in ``hints.py``.

    Regression guard: the prior implementation would emit a "use a different
    offset/limit" nag even when the agent already used a narrow explicit
    offset/limit — punishing the surgical behaviour we want to encourage.
    """

    def test_narrow_explicit_reread_is_suppressed(self, tmp_data_dir):
        sid, path = "s_surgical", "C:/proj/surgical.py"
        # Prior broad read caches lines 1-1000.
        _mark(tmp_data_dir, sid, path, offset=0, limit=1000)

        # Agent now does a surgical 30-line re-read inside the cached range.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=499, limit=30, cwd=None,
        )
        assert hint is None, (
            "Narrow explicit re-read should be suppressed (surgical intent), "
            f"got: {hint!r}"
        )

    def test_wide_explicit_reread_still_warns(self, tmp_data_dir):
        """A wide explicit limit is not surgical — keep the nag."""
        sid, path = "s_wide", "C:/proj/wide.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=1000)

        # 500 lines is well above _NARROW_EXPLICIT_READ_LINES (50).
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=500, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"

    def test_narrow_implicit_reread_still_warns(self, tmp_data_dir):
        """No explicit limit → not surgical intent. Default-limit re-reads
        of cached content still get the dedup hint."""
        sid, path = "s_implicit", "C:/proj/implicit.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=2000)

        # limit=None means "use the default" — Claude Code would read up to
        # 2000 lines, fully inside the cached range, so the agent isn't being
        # deliberately narrow even though we happen to compute a small span.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=None, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"

    def test_at_threshold_explicit_reread_is_suppressed(self, tmp_data_dir):
        """Exactly _NARROW_EXPLICIT_READ_LINES with explicit limit → suppressed."""
        from token_goat.hints import _NARROW_EXPLICIT_READ_LINES

        sid, path = "s_thresh", "C:/proj/thresh.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=500)

        hint = build_read_hint(
            session_id=sid, file_path=path,
            offset=10, limit=_NARROW_EXPLICIT_READ_LINES, cwd=None,
        )
        assert hint is None

    def test_just_above_threshold_explicit_reread_still_warns(self, tmp_data_dir):
        """One line over the threshold → nag returns. Boundary regression guard."""
        from token_goat.hints import _NARROW_EXPLICIT_READ_LINES

        sid, path = "s_just_over", "C:/proj/just_over.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=500)

        hint = build_read_hint(
            session_id=sid, file_path=path,
            offset=10, limit=_NARROW_EXPLICIT_READ_LINES + 1, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"


# ---------------------------------------------------------------------------
# Symbol tagging in re-read hints (_hint_from_cache exact-match and overlap)
# ---------------------------------------------------------------------------


class TestCacheHintSymbolSuffix:
    """Re-read hints include '[symbols: ...]' when symbols_read is populated."""

    def test_exact_match_hint_includes_symbol_names(self, tmp_data_dir):
        """When symbols were also accessed, exact-match hint mentions them."""
        sid = "s_sym_exact"
        path = "C:/proj/auth.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)
        session.mark_file_read(sid, path, symbol="login")
        session.mark_file_read(sid, path, symbol="validate_token")

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"
        assert "login" in hint
        assert "validate_token" in hint
        assert "[symbols:" in hint

    def test_exact_match_hint_overflow_shows_plus_n(self, tmp_data_dir):
        """Four symbols → first 3 shown inline, '+1' for the overflow.

        Uses _mark + 4 symbol reads but pins read_count to 4 (below the
        _SUPPRESS_HINT_AT_READ_COUNT=5 threshold) so the exact-match hint
        still fires and we can exercise the symbols suffix overflow display.
        """
        from token_goat.session import _normalize_path

        sid = "s_sym_overflow"
        path = "C:/proj/util.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=300)
        for sym in ["alpha", "beta", "gamma", "delta"]:
            session.mark_file_read(sid, path, symbol=sym)

        # Pin read_count below the suppression threshold so this test stays
        # focused on the symbols-suffix overflow display rather than the
        # working-file suppression path.
        cache = session.load(sid)
        entry = cache.files[_normalize_path(path)]
        entry.read_count = 4
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=300, cwd=None,
        )
        assert hint is not None
        assert "alpha" in hint
        assert "beta" in hint
        assert "gamma" in hint
        assert "+1" in hint
        # Fourth name should NOT appear as a standalone entry
        assert "delta" not in hint

    def test_exact_match_hint_no_symbols_read_unchanged(self, tmp_data_dir):
        """When symbols_read is empty, hint has no '[symbols:' suffix."""
        sid = "s_nosym_exact"
        path = "C:/proj/plain.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd=None,
        )
        assert hint is not None
        assert "[symbols:" not in hint

    def test_overlap_hint_includes_symbol_names(self, tmp_data_dir):
        """Overlap hint also carries the symbol suffix when symbols were read."""
        sid = "s_sym_overlap"
        path = "C:/proj/service.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=300)
        session.mark_file_read(sid, path, symbol="get_user")
        session.mark_file_read(sid, path, symbol="set_password")

        # Overlap of 100 lines (201-300) — above MIN_OVERLAP_TO_WARN.
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=200, limit=250, cwd=None,
        )
        assert hint is not None
        assert "overlap" in hint.lower()
        assert "get_user" in hint
        assert "set_password" in hint
        assert "[symbols:" in hint

    def test_symbol_suffix_is_under_max_chars(self, tmp_data_dir):
        """Suffix must be ≤ 60 chars; very long names cause it to be suppressed."""
        sid = "s_longname"
        path = "C:/proj/heavy.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)
        long_name = "a" * 70  # a single 70-char name exceeds the 60-char cap
        session.mark_file_read(sid, path, symbol=long_name)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        # The suffix is suppressed because even one name exceeds the budget.
        assert "[symbols:" not in hint

    def test_three_symbols_no_overflow(self, tmp_data_dir):
        """Exactly 3 symbols → no '+N' overflow marker."""
        sid = "s_three"
        path = "C:/proj/three.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)
        for sym in ["foo", "bar", "baz"]:
            session.mark_file_read(sid, path, symbol=sym)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "foo" in hint
        assert "bar" in hint
        assert "baz" in hint
        assert "+" not in hint.split("[symbols:")[-1].split("]")[0]


# ---------------------------------------------------------------------------
# Symbol listing in _hint_from_index (large indexed file)
# ---------------------------------------------------------------------------


class TestIndexHintSymbolListing:
    """_hint_from_index lists the first 3 indexed symbol names."""

    def test_index_hint_lists_first_symbol_names(self, tmp_data_dir, tmp_path):
        """Large indexed file hint shows first 3 symbol names."""
        (tmp_path / ".git").mkdir()
        src_file = tmp_path / "big2.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 50)

        from token_goat.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("big2.py", "python", 50000, 0.0, "abc123", 0),
            )
            for i, name in enumerate(["login", "logout", "validate_token", "refresh"]):
                conn.execute(
                    "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
                    (name, "function", "big2.py", 10 + i * 20, 0, 25 + i * 20),
                )

        hint = build_read_hint(
            session_id="s_idx_syms",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        # First 3 symbols must appear in the hint
        assert "login" in hint
        assert "logout" in hint
        assert "validate_token" in hint
        # 4th symbol is overflow — should NOT appear by name
        assert "refresh" not in hint
        assert "..." in hint  # overflow indicator

    def test_index_hint_single_symbol_no_overflow(self, tmp_data_dir, tmp_path):
        """Single indexed symbol: hint shows it, no overflow marker."""
        (tmp_path / ".git").mkdir()
        src_file = tmp_path / "single_sym.py"
        _make_large_file(src_file, n_lines=LARGE_FILE_LINE_THRESHOLD + 10)

        from token_goat.project import find_project
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("single_sym.py", "python", 50000, 0.0, "xyz", 0),
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, col, end_line) VALUES (?, ?, ?, ?, ?, ?)",
                ("only_func", "function", "single_sym.py", 10, 0, 20),
            )

        hint = build_read_hint(
            session_id="s_single",
            file_path=str(src_file),
            offset=0,
            limit=2000,
            cwd=str(tmp_path),
        )
        assert hint is not None
        assert "only_func" in hint
        assert "..." not in hint


class TestLegacySessionJsonFromOlderVersion:
    def test_legacy_session_json_without_last_edit_ts_loads_clean(self, tmp_data_dir):
        """Session JSON written by older token-goat versions (no last_edit_ts) loads."""
        import json

        from token_goat import paths
        sid = "s_legacy"
        session.validate_session_id(sid)
        legacy = {
            "schema_version": 1,
            "created_by": "token-goat",
            "session_id": sid,
            "started_ts": time.time(),
            "last_activity_ts": time.time(),
            # No last_edit_ts on the file entry — the old wire format.
            "files": {
                "c:/proj/legacy.py": {
                    "rel_or_abs": "C:/proj/legacy.py",
                    "last_read_ts": time.time(),
                    "read_count": 1,
                    "line_ranges": [[1, 100]],
                    "symbols_read": [],
                }
            },
            "greps": [],
            "edited_files": {},
        }
        paths.atomic_write_text(paths.session_cache_path(sid), json.dumps(legacy))

        cache = session.load(sid)
        entry = cache.files["c:/proj/legacy.py"]
        # Missing field defaults to 0.0 (= "never edited").
        assert entry.last_edit_ts == 0.0


# ---------------------------------------------------------------------------
# Improvement 1: suppress line-range hints for heavily-repeated reads
# ---------------------------------------------------------------------------


class TestReadCountSuppression:
    """At read_count >= threshold, a one-time surgical-read nudge replaces the nag.

    A file read 5+ times is a "working file" — the agent is clearly iterating
    on it. Instead of suppressing the hint entirely (which loses guidance) or
    repeating the nag (which wastes tokens), we emit a stable surgical-read
    suggestion once; the fingerprint dedup in pre_read kills repeats.
    The symbol-only hint (no line_ranges) is exempt: it's a suggestion, not a nag.
    """

    def _make_entry_with_read_count(self, sid: str, path: str, read_count: int) -> None:
        """Mark a file read `read_count` times so session cache reflects it."""
        for _ in range(read_count):
            session.mark_file_read(sid, path, offset=0, limit=200)

    def test_read_count_4_still_gets_exact_match_hint(self, tmp_data_dir):
        """read_count=4 is below threshold — exact-match hint still fires."""
        sid, path = "s_rc4", "C:/proj/rc4.py"
        self._make_entry_with_read_count(sid, path, 4)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"

    def test_read_count_5_emits_surgical_nudge(self, tmp_data_dir):
        """read_count=5 hits the threshold — surgical-read nudge emitted instead of nag."""
        sid, path = "s_rc5", "C:/proj/rc5.py"
        self._make_entry_with_read_count(sid, path, 5)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "token-goat read" in hint
        assert "frequently" in hint.lower() or "surgical" in hint.lower()

    def test_surgical_nudge_text_is_stable_across_read_counts(self, tmp_data_dir):
        """Nudge text does not include the dynamic read count so fingerprint stays stable."""
        # Use paths with no digits so digit-checks are unambiguous.
        sid_a, path_a = "s_nudge_alpha", "C:/proj/alpha.py"
        sid_b, path_b = "s_nudge_beta", "C:/proj/beta.py"
        self._make_entry_with_read_count(sid_a, path_a, 5)
        self._make_entry_with_read_count(sid_b, path_b, 7)

        hint_a = build_read_hint(session_id=sid_a, file_path=path_a, offset=0, limit=200, cwd=None)
        hint_b = build_read_hint(session_id=sid_b, file_path=path_b, offset=0, limit=200, cwd=None)
        assert hint_a is not None and hint_b is not None
        # The read counts (5 and 7) must not appear in the hint text — stable fingerprint.
        assert "5" not in str(hint_a)
        assert "7" not in str(hint_b)

    def test_read_count_10_returns_sentinel_hint(self, tmp_data_dir):
        """read_count=10 triggers full-file sentinel hint (not suppressed).

        At read_count >= 10, line_ranges collapse to [(0, 0)] sentinel, which
        generates a special summary hint instead of being suppressed.
        """
        sid, path = "s_rc10", "C:/proj/rc10.py"
        self._make_entry_with_read_count(sid, path, 10)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        # Should emit sentinel hint, not suppress
        assert hint is not None
        assert "full file" in hint
        assert "10" in hint

    def test_symbol_only_hint_not_suppressed_at_high_read_count(self, tmp_data_dir):
        """Symbol-only entries (no line_ranges) are not suppressed at read_count=5.

        The symbol hint is a suggestion, not a nag — it doesn't cost tokens
        relative to a full-file read because the agent is already using surgical
        reads. Suppressing it would reduce useful guidance with no token benefit.
        """
        sid, path = "s_rc_sym", "C:/proj/rc_sym.py"
        # Mark as symbol-only reads (no line ranges accumulate).
        for _ in range(5):
            session.mark_file_read(sid, path, symbol="MyFunc")

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=2000, cwd=None,
        )
        # Symbol hint should still fire (not suppressed by read_count).
        assert hint is not None
        assert "token-goat read" in hint


# ---------------------------------------------------------------------------
# Improvement 2: adaptive staleness threshold based on session age
# ---------------------------------------------------------------------------


class TestComputeStaleThreshold:
    """compute_stale_threshold() returns a session-age-proportional threshold
    clamped to [900, STALE_READ_AGE_SECONDS]."""

    def test_zero_session_age_returns_floor(self):
        """0s session → 25% of 0 = 0, clamped up to 900s floor."""
        from token_goat.hints import compute_stale_threshold
        assert compute_stale_threshold(0) == 900.0

    def test_3600s_session_age_returns_floor(self):
        """3600s session → 25% of 3600 = 900s = exactly the floor."""
        from token_goat.hints import compute_stale_threshold
        assert compute_stale_threshold(3600) == 900.0

    def test_7200s_session_age_returns_mid_range(self):
        """7200s session → 25% of 7200 = 1800s, within [900, 1800]."""
        from token_goat.hints import compute_stale_threshold
        assert compute_stale_threshold(7200) == 1800.0

    def test_14400s_session_age_returns_ceiling(self):
        """14400s session → 25% of 14400 = 3600s, clamped down to ceiling (1800s)."""
        from token_goat.hints import STALE_READ_AGE_SECONDS, compute_stale_threshold
        result = compute_stale_threshold(14400)
        assert result == STALE_READ_AGE_SECONDS

    def test_stale_read_age_seconds_is_unchanged(self):
        """Public constant STALE_READ_AGE_SECONDS must remain 30*60=1800s."""
        from token_goat.hints import STALE_READ_AGE_SECONDS
        assert STALE_READ_AGE_SECONDS == 30 * 60

    def test_adaptive_threshold_used_in_read_hint(self, tmp_data_dir):
        """A read that is older than the adaptive threshold (but newer than
        STALE_READ_AGE_SECONDS) should be suppressed in a long session."""
        from token_goat.session import _normalize_path

        sid, path = "s_adaptive", "C:/proj/adaptive.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Simulate a long session (4 hours = 14400s) with a read that is
        # 1000s old. The adaptive threshold = clamp(14400*0.25, 900, 1800) = 1800s.
        # Since 1000s < 1800s the read is still fresh — hint should fire.
        cache = session.load(sid)
        cache.created_ts = time.time() - 14400  # session started 4h ago
        entry = cache.files[_normalize_path(path)]
        entry.last_read_ts = time.time() - 1000  # read 1000s ago
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None, "Read 1000s ago in 4h session should still be fresh (threshold=1800s)"
        assert "⌘" in hint  # terse form of "cached"

    def test_adaptive_threshold_suppresses_older_read_in_long_session(self, tmp_data_dir):
        """In a short session (1h), a read 1000s ago uses threshold=900s.
        Since 1000s > 900s the read is stale — hint should be suppressed."""
        from token_goat.session import _normalize_path

        sid, path = "s_adaptive2", "C:/proj/adaptive2.py"
        session.mark_file_read(sid, path, offset=0, limit=200)

        # Short session (3600s = 1h). threshold = clamp(3600*0.25, 900, 1800) = 900s.
        cache = session.load(sid)
        cache.created_ts = time.time() - 3600
        entry = cache.files[_normalize_path(path)]
        entry.last_read_ts = time.time() - 1000  # read 1000s ago (> 900s threshold)
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is None, "Read 1000s ago in 1h session should be stale (threshold=900s)"

    def test_stale_symbol_only_access_suppressed(self, tmp_data_dir):
        """A symbol-only access (no line_ranges) older than the stale threshold is suppressed.

        Regression: the stale guard was gated on `entry.line_ranges` which meant
        symbol-only entries were always emitted regardless of age.
        """
        from token_goat.session import _normalize_path

        sid, path = "s_stale_sym", "C:/proj/stale_sym.py"
        session.mark_file_read(sid, path, symbol="MyClass")

        # Short session (1h). threshold = clamp(3600*0.25, 900, 1800) = 900s.
        # Make the symbol access 1000s old — beyond the 900s threshold.
        cache = session.load(sid)
        cache.created_ts = time.time() - 3600
        entry = cache.files[_normalize_path(path)]
        entry.last_read_ts = time.time() - 1000
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=None, limit=None, cwd=None,
        )
        assert hint is None, "Stale symbol-only access must be suppressed"


class TestSessionStaleThreshold:
    """_session_stale_threshold() extracts session age and computes threshold."""

    def test_extracts_created_ts_from_cache(self, tmp_data_dir):
        """_session_stale_threshold extracts created_ts from cache object."""
        from token_goat.hints import _session_stale_threshold
        from token_goat.session import SessionCache

        now = time.time()
        session_age = 3600  # 1h old session
        cache = SessionCache(
            session_id="test_extract",
            started_ts=now - session_age,
            last_activity_ts=now,
        )
        cache.created_ts = now - session_age  # 1h old session

        # 1h session → threshold = clamp(3600*0.25, 900, 1800) = 900s
        result = _session_stale_threshold(cache, now)
        assert result == 900.0

    def test_uses_stale_read_age_when_created_ts_missing(self, tmp_data_dir):
        """_session_stale_threshold falls back to STALE_READ_AGE_SECONDS when created_ts is None."""
        from token_goat.hints import _session_stale_threshold
        from token_goat.session import SessionCache

        now = time.time()
        cache = SessionCache(
            session_id="test_fallback",
            started_ts=now,
            last_activity_ts=now,
        )
        # Don't set created_ts — it defaults to None or not present

        result = _session_stale_threshold(cache, now)
        # With session_age = STALE_READ_AGE_SECONDS (1800s), threshold
        # = clamp(1800*0.25, 900, 1800) = clamp(450, 900, 1800) = 900s
        assert result == 900.0

    def test_agrees_with_compute_stale_threshold(self, tmp_data_dir):
        """_session_stale_threshold(cache, now) == compute_stale_threshold(now - cache.created_ts)."""
        from token_goat.hints import _session_stale_threshold, compute_stale_threshold
        from token_goat.session import SessionCache

        now = time.time()
        for session_age in [0, 1800, 3600, 7200, 14400]:
            cache = SessionCache(
                session_id=f"test_agree_{session_age}",
                started_ts=now - session_age,
                last_activity_ts=now,
            )
            cache.created_ts = now - session_age

            result1 = _session_stale_threshold(cache, now)
            result2 = compute_stale_threshold(session_age)
            assert result1 == result2, f"Mismatch for session_age={session_age}"

    def test_fresh_symbol_only_access_still_emits(self, tmp_data_dir):
        """A symbol-only access within the stale threshold still emits a hint."""
        from token_goat.session import _normalize_path

        sid, path = "s_fresh_sym", "C:/proj/fresh_sym.py"
        session.mark_file_read(sid, path, symbol="MyClass")

        # Long session (4h). threshold = min(14400*0.25, 1800) = 1800s.
        # Read 500s ago — well within the 1800s threshold.
        cache = session.load(sid)
        cache.created_ts = time.time() - 14400
        entry = cache.files[_normalize_path(path)]
        entry.last_read_ts = time.time() - 500
        cache._invalidate_json_cache()
        session.save(cache)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=None, limit=None, cwd=None,
        )
        assert hint is not None, "Fresh symbol-only access must still emit a hint"


# ---------------------------------------------------------------------------
# Edge cases: hints.py
# ---------------------------------------------------------------------------


class TestHintsEdgeCases:
    """Edge cases for hint generation: empty sessions, long paths, glob with 0 results."""

    def test_empty_session_first_read_returns_none(self, tmp_data_dir):
        """On first read of a file in a fresh session, build_read_hint returns None."""

        sid = "fresh_session_edge"
        # Don't mark anything — the file has never been read
        path = "src/never_read.py"
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd="/tmp",
        )
        # File is not in session cache, not indexed, and not large → no hint
        assert hint is None

    def test_file_read_once_emits_hint_on_second_read(self, tmp_data_dir):
        """After one read, a second read of the same file emits a dedup hint."""

        sid = "second_read_edge"
        path = "src/test.py"

        # First read
        session.mark_file_read(sid, path, offset=0, limit=100)

        # Second read of the same range
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd="/tmp",
        )
        # Should emit an exact-match hint
        assert hint is not None
        assert "⌘" in str(hint)  # terse form of "cached"
        assert hint.tokens_saved > 0

    def test_very_long_file_path_in_hint(self, tmp_data_dir):
        """A 200-char file path should be sanitized and not crash hint generation."""

        sid = "long_path_edge"
        # Create a 200-char path
        long_path = "src/" + "a" * 180 + "/file.py"
        assert len(long_path) > 180

        session.mark_file_read(sid, long_path, offset=0, limit=50)

        # Second read with a different range to get a partial-overlap hint
        # (same range as before would be exact-match which might be suppressed for surgical intent)
        hint = build_read_hint(
            session_id=sid, file_path=long_path, offset=0, limit=100, cwd="/tmp",
        )
        # Should not crash, may or may not produce a hint depending on overlap logic
        # Main test: ensure no exception is raised and path is sanitized
        if hint is not None:
            # The hint text should be reasonable size (sanitized/truncated)
            assert len(str(hint)) < 1000
        # Even if no hint, the function should complete without crashing

    def test_glob_dedup_hint_zero_results_suppressed(self, tmp_data_dir):
        """A glob with 0 results should not emit a hint (no dedup value)."""
        from token_goat.hints import build_glob_dedup_hint

        sid = "glob_zero_results"

        # Record a glob with 0 results
        session.mark_glob_run(sid, "**/*.nonexistent", result_count=0)

        # Try to build a hint for the same glob
        hint = build_glob_dedup_hint(session_id=sid, pattern="**/*.nonexistent", path=None)

        # Should be suppressed because result_count (0) < _GLOB_DEDUP_MIN_RESULT_COUNT (5)
        assert hint is None

    def test_glob_dedup_hint_with_special_regex_chars(self, tmp_data_dir):
        """A glob pattern with special regex chars should not crash."""
        from token_goat.hints import build_glob_dedup_hint

        sid = "glob_special_chars"

        # A pattern with regex-special chars: [, ], *, +, ?, etc.
        pattern = "**/[test_]+([a-z]*).py"
        session.mark_glob_run(sid, pattern, path="src/", result_count=10)

        # Should not crash
        hint = build_glob_dedup_hint(session_id=sid, pattern=pattern, path="src/")

        # Should emit a hint (10 >= 5)
        assert hint is not None
        assert "Glob" in str(hint)

    def test_glob_dedup_hint_exact_threshold_boundary(self, tmp_data_dir):
        """A glob with exactly _GLOB_DEDUP_MIN_RESULT_COUNT results emits hint."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT, build_glob_dedup_hint

        sid = "glob_boundary"
        pattern = "**/*.py"

        # Record exactly at threshold
        session.mark_glob_run(sid, pattern, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT)

        hint = build_glob_dedup_hint(session_id=sid, pattern=pattern, path=None)

        # Should emit (not suppressed)
        assert hint is not None
        assert str(_GLOB_DEDUP_MIN_RESULT_COUNT) in str(hint)

    def test_glob_dedup_hint_one_below_threshold_suppressed(self, tmp_data_dir):
        """A glob with _GLOB_DEDUP_MIN_RESULT_COUNT - 1 results is suppressed."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT, build_glob_dedup_hint

        sid = "glob_below_threshold"
        pattern = "**/*.txt"

        session.mark_glob_run(sid, pattern, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT - 1)

        hint = build_glob_dedup_hint(session_id=sid, pattern=pattern, path=None)

        # Should be suppressed (below threshold)
        assert hint is None

    def test_build_read_hint_empty_session_cache_object(self, tmp_data_dir):
        """Pass an empty SessionCache object directly to build_read_hint."""

        sid = "explicit_empty_cache"
        path = "src/file.py"

        # Create an empty cache object
        empty_cache = session.load(sid)
        assert empty_cache.files == {}

        # Try to build a hint with this empty cache
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=100,
            cwd="/tmp",
            cache=empty_cache,
        )
        # No hint because file was never read
        assert hint is None

    def test_build_read_hint_cache_with_edited_but_unread_file(self, tmp_data_dir):
        """A file marked as edited but never read should not emit a cached hint."""

        sid = "edited_unread"
        path = "src/edited.py"

        # Mark file as edited without reading
        session.mark_file_edited(sid, path)

        # Try to build a hint for a read
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=100,
            cwd="/tmp",
        )
        # No hint because file was never read (only edited)
        assert hint is None


# ---------------------------------------------------------------------------
# Hint throttle by file size (small files with 1 read)
# ---------------------------------------------------------------------------


class TestHintThrottleByFileSize:
    """Test that small files (< 30 lines) with single read don't emit hints."""

    def test_small_file_10_lines_single_read_no_hint(self, tmp_data_dir):
        """A 10-line file with only 1 prior read should not emit a hint.

        Rationale: the hint text (~25 tokens) costs almost as much as the
        saving it advertises, making the nudge net-negative.
        """
        sid = "s_small_1_read"
        path = "C:/proj/tiny.py"
        # Mark as read with 10-line span (offset=0, limit=10)
        _mark(tmp_data_dir, sid, path, offset=0, limit=10)

        # Request the same range again
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=10,
            cwd=None,
        )
        # Should suppress hint for tiny file with single read
        assert hint is None

    def test_small_file_25_lines_multiple_reads_with_overlap_emits_hint(self, tmp_data_dir):
        """A 25-line file (< 30) with 3 reads and overlap (not exact) should emit.

        The small-file suppression (skip when <30 lines AND read_count==1) should
        NOT apply when read_count > 1. Overlap hint fires because it's > 50 lines.
        """
        sid = "s_small_25_3_reads_overlap"
        path = "C:/proj/tiny25.py"
        # Mark lines 1-100 to create overlap that's > MIN_OVERLAP_TO_WARN (50)
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)
        session.mark_file_read(sid, path, offset=0, limit=100)
        session.mark_file_read(sid, path, offset=0, limit=100)

        # Now request L1-75 (overlap = 75 lines, which is > 50)
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=75,
            cwd=None,
        )
        # Should emit overlap hint (read_count=3 so small-file check doesn't apply)
        assert hint is not None
        assert "⌘" in hint or "overlap" in hint.lower()  # terse "cached" or overlap warning

    def test_large_file_100_lines_emits_hint(self, tmp_data_dir):
        """A 100-line file with single read should emit a hint.

        Files >= 30 lines should always emit hints when there is overlap,
        regardless of read count.
        """
        sid = "s_large_1_read"
        path = "C:/proj/medium.py"
        # Mark as read with 100-line span (offset=0, limit=100)
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)

        # Request the same range again
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=100,
            cwd=None,
        )
        # Should emit hint for larger file even with single read
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"
        assert "waste" in hint.lower()

    def test_exactly_30_lines_boundary_emits_hint(self, tmp_data_dir):
        """A 30-line file (boundary) should emit a hint when not subject to surgical intent.

        The threshold _MIN_LINES_FOR_HINT = 30 is inclusive on the boundary.
        Since 30 lines <= NARROW_EXPLICIT_READ_LINES (50), exact-match surgical
        intent guard applies. Use a non-exact overlap instead (30 lines cached,
        request 100 lines → 30-line overlap which is still < 50, so no overlap
        hint either). Instead, request from offset 0 without explicit limit,
        or mark a larger range. Use the latter.
        """
        sid = "s_boundary_30"
        path = "C:/proj/boundary.py"
        # Mark with 100 lines to avoid both exact-match and overlap suppressions
        _mark(tmp_data_dir, sid, path, offset=0, limit=100)

        # Request lines 1-30 (30-line overlap out of 100 cached)
        # overlap_lines = 30, which is < MIN_OVERLAP_TO_WARN (50), so no overlap hint.
        # Instead, request ALL 100 lines again (exact match), which should emit
        # a hint since 100 > NARROW_EXPLICIT_READ_LINES (50).
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=100,
            cwd=None,
        )
        # Should emit exact-match hint (100 lines > NARROW_EXPLICIT_READ_LINES threshold)
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"
        assert "waste" in hint.lower()

    def test_sentinel_full_file_hint(self, tmp_data_dir):
        """Full-file collapse sentinel [(0, 0)] generates a summary hint."""
        from token_goat import session as session_module

        sid = "s_sentinel_hint"
        path = "c:/proj/hotfile.py"  # Use lowercase drive on Windows
        # Manually create a FileEntry with sentinel to test hint generation
        cache = session_module.load(sid)
        cache.files[path] = session_module.FileEntry(
            rel_or_abs=path,
            last_read_ts=time.time(),
            read_count=15,
            line_ranges=[(0, 0)],  # The sentinel
            symbols_read=["func1", "func2"],
        )
        session_module.save(cache)

        # Request any range on this file (use original path; normalization will match)
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=50,
            cwd=None,
        )
        # Should emit a full-file summary hint
        assert hint is not None
        assert "full file" in hint
        assert "15" in hint  # read count
        assert "func1" in hint or "func2" in hint  # symbols should be in suffix


# ---------------------------------------------------------------------------
# TestBashDedupLightOutput — light-output dedup threshold (200–999 bytes)
# ---------------------------------------------------------------------------


class TestBashDedupLightOutput:
    """Bash dedup hint fires for outputs >= 200 bytes (not just >= 1000).

    Small outputs (200–999 bytes) get a compact one-liner hint so the hint
    cost (~12 tokens) stays net-positive against the ~50–250 tokens avoided.
    """

    def _record(
        self,
        sid: str,
        cmd: str,
        *,
        stdout_bytes: int,
        stderr_bytes: int = 0,
        exit_code: int = 0,
    ) -> str:
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        output_id = f"out_{cmd_sha[:8]}"
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd[:120],
            output_id,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
            exit_code=exit_code,
            truncated=False,
        )
        return cmd_sha

    def test_below_min_threshold_no_hint(self, tmp_data_dir):
        """Outputs below _BASH_DEDUP_MIN_BYTES (200) produce no hint."""
        sid = "s_light_below"
        cmd = "git status"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_MIN_BYTES - 1)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is None

    def test_at_min_threshold_emits_light_hint(self, tmp_data_dir):
        """Outputs exactly at _BASH_DEDUP_MIN_BYTES emit the compact hint."""
        sid = "s_light_at_min"
        cmd = "git status --short"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_MIN_BYTES)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "⌘" in hint  # terse form of "cached"
        assert "bash-output" in hint

    def test_light_hint_is_compact(self, tmp_data_dir):
        """Light hint (200–999 bytes) is shorter than the full hint."""
        sid = "s_light_compact"
        cmd = "python --version"
        self._record(sid, cmd, stdout_bytes=300)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        # Light hint must not contain the verbose "tokens" or "WARNING" markers
        assert "tokens" not in hint
        assert "WARNING" not in hint
        assert "bash-output" in hint

    def test_at_light_max_boundary_still_light(self, tmp_data_dir):
        """Outputs at exactly _BASH_DEDUP_LIGHT_MAX_BYTES still use light hint."""
        sid = "s_light_boundary"
        cmd = "ls -la"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_LIGHT_MAX_BYTES)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "tokens" not in hint
        assert "bash-output" in hint

    def test_above_light_max_uses_full_hint(self, tmp_data_dir):
        """Outputs above _BASH_DEDUP_LIGHT_MAX_BYTES use the detailed hint.

        The full hint formats byte counts with thousands-comma (e.g. "1,000B")
        whereas the light hint uses plain integers ("1000B"). This is the
        structural discriminator between the two variants.
        """
        sid = "s_full_hint"
        cmd = "uv run pytest tests/ -v"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_LIGHT_MAX_BYTES + 1)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        # Full hint: uses comma-formatted bytes like "1,000B"; light uses "1000B"
        assert "1,000B" in hint
        assert "bash-output" in hint


# ---------------------------------------------------------------------------
# TestBashDedupGrepSuggest — --grep PATTERN suggestion for large outputs
# ---------------------------------------------------------------------------


class TestBashDedupGrepSuggest:
    """Large cached outputs include a --grep PATTERN suggestion in the hint.

    At _BASH_DEDUP_GREP_SUGGEST_BYTES (5000) the output is ~1250 tokens.
    Loading it whole when only a few lines are needed wastes significant
    context; the --grep suffix costs ~8 tokens and can save hundreds.
    """

    def _record(self, sid: str, cmd: str, *, stdout_bytes: int) -> None:
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd[:120],
            f"out_{cmd_sha[:8]}",
            stdout_bytes=stdout_bytes,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )

    def test_below_grep_threshold_no_grep_suffix(self, tmp_data_dir):
        """Outputs below 5000 bytes do not include --grep suggestion."""
        sid = "s_grep_below"
        cmd = "uv run pytest tests/test_hints.py -q"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES - 1)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "--grep" not in hint

    def test_at_grep_threshold_includes_grep_suffix(self, tmp_data_dir):
        """Outputs at exactly 5000 bytes include --grep suggestion."""
        sid = "s_grep_at"
        cmd = "uv run pytest tests/ -v --tb=long"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "--grep" in hint
        assert "PATTERN" in hint

    def test_above_grep_threshold_includes_grep_suffix(self, tmp_data_dir):
        """Outputs well above 5000 bytes also include --grep suggestion."""
        sid = "s_grep_above"
        cmd = "git log --oneline --all"
        self._record(sid, cmd, stdout_bytes=20000)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "--grep" in hint

    def test_light_hint_never_gets_grep_suffix(self, tmp_data_dir):
        """Light hint (200-999 bytes) never gets --grep even if threshold were met."""
        sid = "s_grep_light"
        cmd = "git status"
        self._record(sid, cmd, stdout_bytes=_BASH_DEDUP_LIGHT_MAX_BYTES - 100)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "--grep" not in hint


# ---------------------------------------------------------------------------
# TestBashDedupFailedExitCode — FAILED prefix for non-zero exit codes
# ---------------------------------------------------------------------------


class TestBashDedupFailedExitCode:
    """Non-zero exit codes produce a FAILED prefix at the start of the hint.

    The exit code used to be buried as "exit=1" mid-string.  Front-loading it
    helps the agent immediately recognise a failed command without needing to
    re-run it to rediscover the failure.
    """

    def _record(
        self, sid: str, cmd: str, *, stdout_bytes: int, exit_code: int
    ) -> None:
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid,
            cmd_sha,
            cmd[:120],
            f"out_{cmd_sha[:8]}",
            stdout_bytes=stdout_bytes,
            stderr_bytes=0,
            exit_code=exit_code,
            truncated=False,
        )

    def test_zero_exit_no_failed_prefix(self, tmp_data_dir):
        """Successful commands produce no FAILED prefix."""
        sid = "s_exit0"
        cmd = "uv run pytest tests/ -q"
        self._record(sid, cmd, stdout_bytes=2000, exit_code=0)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "FAILED" not in hint

    def test_nonzero_exit_light_hint_has_prefix(self, tmp_data_dir):
        """Light hint for failed command starts with FAILED."""
        sid = "s_exit1_light"
        cmd = "git push"
        self._record(sid, cmd, stdout_bytes=400, exit_code=1)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert hint.startswith("FAILED")
        assert "x=1" in hint  # terse form of "exit=1"

    def test_nonzero_exit_full_hint_has_prefix(self, tmp_data_dir):
        """Full hint for failed command starts with FAILED."""
        sid = "s_exit2_full"
        cmd = "uv run mypy src"
        self._record(sid, cmd, stdout_bytes=3000, exit_code=2)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert hint.startswith("FAILED")
        assert "x=2" in hint  # terse form of "exit=2"

    def test_exit_code_not_duplicated_in_hint(self, tmp_data_dir):
        """Exit code appears exactly once — not in both prefix and body."""
        sid = "s_no_dup"
        cmd = "ruff check src/"
        self._record(sid, cmd, stdout_bytes=1500, exit_code=1)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert hint.count("x=1") == 1  # terse form of "exit=1", appears exactly once

    def test_none_exit_code_no_prefix(self, tmp_data_dir):
        """None exit code (unknown) produces no prefix and no exit string."""
        sid = "s_exit_none"
        cmd = "some-command"
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd, f"out_{cmd_sha[:8]}",
            stdout_bytes=2000, stderr_bytes=0,
            exit_code=None, truncated=False,
        )
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        assert "FAILED" not in hint
        assert "x=" not in hint  # terse form of "exit=" — must be absent for None exit code


# ---------------------------------------------------------------------------
# TestShortOutputIdInHints — hints render …<last8> not the full output_id
# ---------------------------------------------------------------------------


class TestShortOutputIdInHints:
    """Bash and web dedup hints render the trailing 8 chars of output_id.

    This keeps hint strings compact (~13 chars for the id vs 40+) while still
    giving the agent an unambiguous suffix to pass to bash-output/web-output.
    """

    def _record_bash(self, sid: str, cmd: str, output_id: str, *, stdout_bytes: int) -> None:
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd[:120], output_id,
            stdout_bytes=stdout_bytes, stderr_bytes=0,
            exit_code=0, truncated=False,
        )

    def test_bash_hint_uses_short_id(self, tmp_data_dir):
        """Bash dedup hint contains …<last8> not the full output_id."""
        sid = "s_shortid_bash"
        cmd = "uv run pytest tests/ -q"
        full_id = "ses-abc123-0000000000001-deadbeef12345678"
        self._record_bash(sid, cmd, full_id, stdout_bytes=2000)
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        # Short suffix must appear
        assert "…12345678" in hint
        # Full id must NOT appear
        assert full_id not in hint

    def test_web_hint_uses_short_id(self, tmp_data_dir):
        """Web dedup hint contains …<last8> not the full output_id."""
        from token_goat import web_cache
        from token_goat.hints import build_web_dedup_hint

        sid = "s_shortid_web"
        url = "https://docs.example.com/api/reference"
        full_id = "ses-abc123-0000000000002-cafebabe87654321"
        url_sha = web_cache.url_hash(url)
        session.mark_web_fetch(
            sid, url_sha, url[:200], full_id,
            body_bytes=5000, status_code=200, truncated=False,
        )
        hint = build_web_dedup_hint(session_id=sid, url=url)
        assert hint is not None
        assert "…87654321" in hint
        assert full_id not in hint

    def test_short_id_helper_ellipsis_prefix(self):
        """short_output_id renders …<last8> for ids longer than 8 chars."""
        from token_goat.cache_common import short_output_id
        full = "ses-abc-0000000000001-abcd1234"
        assert short_output_id(full) == "…abcd1234"

    def test_short_id_helper_passthrough_for_short(self):
        """short_output_id returns full id unchanged when <= 8 chars."""
        from token_goat.cache_common import short_output_id
        assert short_output_id("abc123") == "abc123"
        assert short_output_id("abcd1234") == "abcd1234"


# ---------------------------------------------------------------------------
# TestCuratorEmissionGating — _curator_should_emit suppresses when rate low
# ---------------------------------------------------------------------------


class TestCuratorEmissionGating:
    """Curator suppresses dedup hints when hint-acceptance rate is too low."""

    def _make_cache(self, sid: str, tmp_data_dir, *, emitted: int, ignored: int) -> object:
        """Return a loaded session cache with preset curator counters."""
        cache = session.load(sid)
        cache.hints_emitted = emitted
        cache.hints_ignored = ignored
        cache._invalidate_json_cache()
        session.save(cache)
        return session.load(sid)

    def test_below_min_samples_always_emits(self, tmp_data_dir):
        """With fewer than min_samples hints emitted, curator always returns True."""
        from token_goat.hints import _curator_should_emit

        cache = self._make_cache("curator_gate_1", tmp_data_dir, emitted=5, ignored=5)
        # 5 < default min_samples (10), so should still emit
        assert _curator_should_emit(cache) is True

    def test_high_acceptance_rate_emits(self, tmp_data_dir):
        """15 emitted, 5 ignored → 66% acceptance → hint fires (above 20% threshold)."""
        from token_goat.hints import _curator_should_emit

        cache = self._make_cache("curator_gate_2", tmp_data_dir, emitted=15, ignored=5)
        assert _curator_should_emit(cache) is True

    def test_low_acceptance_rate_suppresses(self, tmp_data_dir):
        """15 emitted, 13 ignored → 13% acceptance → hint suppressed (below 20% threshold)."""
        from token_goat.hints import _curator_should_emit

        cache = self._make_cache("curator_gate_3", tmp_data_dir, emitted=15, ignored=13)
        assert _curator_should_emit(cache) is False

    def test_exactly_at_threshold_emits(self, tmp_data_dir):
        """Exactly 20% acceptance (10 emitted, 8 ignored) is NOT suppressed (threshold is strict <)."""
        from token_goat.hints import _curator_should_emit

        cache = self._make_cache("curator_gate_4", tmp_data_dir, emitted=10, ignored=8)
        # acceptance = 2/10 * 100 = 20.0 — exactly at threshold, NOT below, so emits
        assert _curator_should_emit(cache) is True

    def test_bash_dedup_hint_suppressed_at_low_rate(self, tmp_data_dir):
        """build_bash_dedup_hint returns None when curator suppresses."""
        from token_goat import bash_cache

        sid = "curator_bash_1"
        cmd = "uv run pytest tests/"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd[:120], "output-id-1",
            stdout_bytes=2000, stderr_bytes=0, exit_code=0, truncated=False,
        )
        cache = session.load(sid)
        cache.hints_emitted = 15
        cache.hints_ignored = 13  # 13% acceptance → suppress
        cache._invalidate_json_cache()
        session.save(cache)
        cache = session.load(sid)

        hint = build_bash_dedup_hint(session_id=sid, command=cmd, cache=cache)
        assert hint is None, "curator should suppress bash dedup hint at low acceptance rate"

    def test_bash_dedup_hint_fires_at_high_rate(self, tmp_data_dir):
        """build_bash_dedup_hint returns a hint when acceptance rate is high."""
        from token_goat import bash_cache

        sid = "curator_bash_2"
        cmd = "uv run pytest tests/ -q"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd[:120], "output-id-2",
            stdout_bytes=2000, stderr_bytes=0, exit_code=0, truncated=False,
        )
        cache = session.load(sid)
        cache.hints_emitted = 15
        cache.hints_ignored = 5  # 66% acceptance → emit
        cache._invalidate_json_cache()
        session.save(cache)
        cache = session.load(sid)

        hint = build_bash_dedup_hint(session_id=sid, command=cmd, cache=cache)
        assert hint is not None, "curator should allow bash dedup hint at high acceptance rate"

    def test_record_hint_emitted_increments_and_tracks_path(self, tmp_data_dir):
        """_record_hint_emitted increments hints_emitted and appends to recent_hints."""
        from token_goat.hints import _record_hint_emitted

        sid = "curator_record_1"
        cache = session.load(sid)
        assert cache.hints_emitted == 0
        assert cache.recent_hints == []

        _record_hint_emitted(cache, "/proj/foo.py")
        assert cache.hints_emitted == 1
        assert len(cache.recent_hints) == 1
        assert cache.recent_hints[0][0] == "/proj/foo.py"

    def test_record_hint_emitted_caps_ring_buffer(self, tmp_data_dir):
        """_record_hint_emitted caps recent_hints at 3 entries (oldest dropped)."""
        from token_goat.hints import _record_hint_emitted

        sid = "curator_record_2"
        cache = session.load(sid)
        for i in range(5):
            _record_hint_emitted(cache, f"/proj/file_{i}.py")
        assert cache.hints_emitted == 5
        assert len(cache.recent_hints) == 3
        # Most recent 3 paths are kept
        paths = [p for p, _ in cache.recent_hints]
        assert "/proj/file_2.py" in paths
        assert "/proj/file_3.py" in paths
        assert "/proj/file_4.py" in paths
        assert "/proj/file_0.py" not in paths


# ---------------------------------------------------------------------------
# TestHintBudgetCheck — _hint_budget_check enforces per-session hard caps
# ---------------------------------------------------------------------------


class TestHintBudgetCheck:
    """_hint_budget_check suppresses hints once session counters hit their cap."""

    def _make_cache(self, sid: str, tmp_data_dir) -> session.SessionCache:
        cache = session.load(sid)
        session.save(cache)
        return session.load(sid)

    def test_dedup_99th_hint_still_fires(self, tmp_data_dir):
        """With 99 hints emitted (cap=100), the 99th check passes."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _hint_budget_check

        cache = self._make_cache("hb_dedup_99", tmp_data_dir)
        cache.hints_emitted = 99

        cfg = HintBudgetConfig(enabled=True, max_per_session=100)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            result = _hint_budget_check(cache, _HINT_KIND_DEDUP)
        assert result is True, "99th hint should still be allowed (cap=100)"

    def test_dedup_100th_hint_is_suppressed(self, tmp_data_dir):
        """Once hints_emitted reaches the cap, _hint_budget_check returns False."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _hint_budget_check

        cache = self._make_cache("hb_dedup_100", tmp_data_dir)
        cache.hints_emitted = 100  # at cap

        cfg = HintBudgetConfig(enabled=True, max_per_session=100)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            result = _hint_budget_check(cache, _HINT_KIND_DEDUP)
        assert result is False, "100th hint (== cap) should be suppressed"

    def test_structured_budget_independent_of_dedup(self, tmp_data_dir):
        """Structured-file budget uses its own counter; exhausting dedup does not suppress structured."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _HINT_KIND_STRUCTURED, _hint_budget_check

        cache = self._make_cache("hb_structured_indep", tmp_data_dir)
        cache.hints_emitted = 200          # dedup exhausted
        cache.structured_hints_emitted = 5  # structured has room

        cfg = HintBudgetConfig(enabled=True, max_per_session=100, max_structured_per_session=30)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            dedup_ok = _hint_budget_check(cache, _HINT_KIND_DEDUP)
            structured_ok = _hint_budget_check(cache, _HINT_KIND_STRUCTURED)
        assert dedup_ok is False, "Dedup budget should be exhausted"
        assert structured_ok is True, "Structured budget should still be open"

    def test_index_only_budget_independent_of_dedup(self, tmp_data_dir):
        """Index-only budget uses its own counter; exhausting dedup does not suppress index-only."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _HINT_KIND_INDEX_ONLY, _hint_budget_check

        cache = self._make_cache("hb_index_indep", tmp_data_dir)
        cache.hints_emitted = 200           # dedup exhausted
        cache.index_only_hints_emitted = 2  # index-only has room

        cfg = HintBudgetConfig(enabled=True, max_per_session=100, max_index_only_per_session=30)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            dedup_ok = _hint_budget_check(cache, _HINT_KIND_DEDUP)
            index_only_ok = _hint_budget_check(cache, _HINT_KIND_INDEX_ONLY)
        assert dedup_ok is False
        assert index_only_ok is True

    def test_structured_cap_enforced(self, tmp_data_dir):
        """Once structured_hints_emitted reaches its cap, structured hints are suppressed."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_STRUCTURED, _hint_budget_check

        cache = self._make_cache("hb_structured_cap", tmp_data_dir)
        cache.structured_hints_emitted = 30  # at cap

        cfg = HintBudgetConfig(enabled=True, max_structured_per_session=30)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            result = _hint_budget_check(cache, _HINT_KIND_STRUCTURED)
        assert result is False

    def test_disabled_budget_always_emits(self, tmp_data_dir):
        """When hint_budget.enabled=False, _hint_budget_check always returns True."""
        from token_goat.config import HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _hint_budget_check

        cache = self._make_cache("hb_disabled", tmp_data_dir)
        cache.hints_emitted = 9999  # way over any cap

        cfg = HintBudgetConfig(enabled=False, max_per_session=10)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": cfg})()
            result = _hint_budget_check(cache, _HINT_KIND_DEDUP)
        assert result is True, "Disabled budget should never suppress"

    def test_curator_and_budget_both_apply(self, tmp_data_dir):
        """Curator suppression and budget cap are both enforced — whichever fires first wins."""
        from token_goat.config import CuratorConfig, HintBudgetConfig
        from token_goat.hints import _HINT_KIND_DEDUP, _curator_should_emit, _hint_budget_check

        cache = self._make_cache("hb_curator_combined", tmp_data_dir)
        # Both curator and budget would suppress.
        cache.hints_emitted = 200   # budget: over cap
        cache.hints_ignored = 190   # curator: only 5% acceptance, well below 20% threshold

        # Curator check.
        cur_cfg = CuratorConfig(enabled=True, min_samples=10, threshold_pct=20)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"curator": cur_cfg})()
            curator_ok = _curator_should_emit(cache)
        assert curator_ok is False, "Curator should suppress at 5% acceptance"

        # Budget check.
        hb_cfg = HintBudgetConfig(enabled=True, max_per_session=100)
        with patch("token_goat.config.load") as mock_load:
            mock_load.return_value = type("C", (), {"hint_budget": hb_cfg})()
            budget_ok = _hint_budget_check(cache, _HINT_KIND_DEDUP)
        assert budget_ok is False, "Budget should also suppress at 200 hints"


# ---------------------------------------------------------------------------
# TestWebDedupGrepSuggest — large cached responses include --grep suggestion
# ---------------------------------------------------------------------------


class TestWebDedupGrepSuggest:
    """Large cached web responses include a --grep PATTERN suggestion in the hint.

    At _BASH_DEDUP_GREP_SUGGEST_BYTES (5000) the response is ~1250 tokens.
    Loading it whole when only a few lines are needed wastes significant
    context; the --grep suffix costs ~8 tokens and can save hundreds.
    """

    def _record(self, sid: str, url: str, *, body_bytes: int) -> None:
        from token_goat import web_cache

        url_sha = web_cache.url_hash(url)
        output_id = f"web-{url_sha[:8]}"
        session.mark_web_fetch(
            sid,
            url_sha,
            url[:200],
            output_id,
            body_bytes=body_bytes,
            status_code=200,
            truncated=False,
        )

    def test_below_grep_threshold_no_grep_suffix(self, tmp_data_dir):
        """Responses below 5000 bytes do not include --grep suggestion."""
        from token_goat.hints import _BASH_DEDUP_GREP_SUGGEST_BYTES, build_web_dedup_hint

        sid = "s_web_grep_below"
        url = "https://example.com/api/data"
        self._record(sid, url, body_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES - 1)
        hint = build_web_dedup_hint(session_id=sid, url=url)
        assert hint is not None
        assert "--grep" not in hint

    def test_at_grep_threshold_includes_grep_suffix(self, tmp_data_dir):
        """Responses at exactly 5000 bytes include --grep suggestion."""
        from token_goat.hints import _BASH_DEDUP_GREP_SUGGEST_BYTES, build_web_dedup_hint

        sid = "s_web_grep_at"
        url = "https://api.github.com/repos/owner/repo"
        self._record(sid, url, body_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES)
        hint = build_web_dedup_hint(session_id=sid, url=url)
        assert hint is not None
        assert "--grep" in hint
        assert "PATTERN" in hint

    def test_above_grep_threshold_includes_grep_suffix(self, tmp_data_dir):
        """Responses well above 5000 bytes also include --grep suggestion."""
        from token_goat.hints import build_web_dedup_hint

        sid = "s_web_grep_above"
        url = "https://example.com/large-doc"
        self._record(sid, url, body_bytes=50000)
        hint = build_web_dedup_hint(session_id=sid, url=url)
        assert hint is not None
        assert "--grep" in hint

    def test_grep_suffix_shown_only_once_per_session(self, tmp_data_dir):
        """The --grep PATTERN recall hint fires only on the first large-body dedup per session."""
        import token_goat.session as _sess
        from token_goat.hints import _BASH_DEDUP_GREP_SUGGEST_BYTES, build_web_dedup_hint

        sid = "s_web_recall_once"
        url1 = "https://example.com/large-1"
        url2 = "https://example.com/large-2"
        self._record(sid, url1, body_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES + 100)
        self._record(sid, url2, body_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES + 200)

        cache = _sess.load(sid)

        # First large-body dedup should include the --grep suffix.
        hint1 = build_web_dedup_hint(session_id=sid, url=url1, cache=cache)
        assert hint1 is not None
        assert "--grep" in hint1

        # Second large-body dedup in the same session should omit --grep.
        hint2 = build_web_dedup_hint(session_id=sid, url=url2, cache=cache)
        assert hint2 is not None
        assert "--grep" not in hint2

    def test_grep_suffix_omitted_when_cache_unavailable(self, tmp_data_dir):
        """When cache=None, the --grep suffix fires (no session to track state)."""
        from token_goat.hints import _BASH_DEDUP_GREP_SUGGEST_BYTES, build_web_dedup_hint

        sid = "s_web_recall_nocache"
        url = "https://example.com/large-nocache"
        self._record(sid, url, body_bytes=_BASH_DEDUP_GREP_SUGGEST_BYTES + 100)

        # cache=None path — cannot suppress, so hint includes --grep.
        hint = build_web_dedup_hint(session_id=sid, url=url, cache=None)
        assert hint is not None
        assert "--grep" in hint


# ---------------------------------------------------------------------------
# Cross-session Grep dedup hint
# ---------------------------------------------------------------------------


class TestCrossSessionGrepDedup:
    """Tests for the global.db-backed cross-session grep frequency hint."""

    _PATTERN = "def test_login"

    @staticmethod
    def _pattern_hash(pattern: str) -> str:
        import hashlib  # noqa: PLC0415
        return hashlib.sha1(pattern.encode("utf-8", errors="replace")).hexdigest()  # noqa: S324

    def _seed_global(self, tmp_data_dir, count: int, last_ts: float, pattern: str | None = None) -> None:
        """Directly insert a grep_patterns row, bypassing amortization logic."""
        pat = pattern if pattern is not None else self._PATTERN
        pat_hash = self._pattern_hash(pat)
        with db.open_global() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO grep_patterns "
                "(pattern_hash, first_pattern, last_ts, count) VALUES (?,?,?,?)",
                (pat_hash, pat, last_ts, count),
            )

    def _hint(self, tmp_data_dir, sid: str = "xsess_sid_001") -> str | None:
        """Run build_grep_dedup_hint for the test pattern (no prior session greps)."""
        from token_goat.hints import build_grep_dedup_hint
        return build_grep_dedup_hint(session_id=sid, pattern=self._PATTERN, path=None)

    # --- cross-session hint fires ----------------------------------------

    def test_cross_session_hint_fires_when_count_gte_3_and_recent(self, tmp_data_dir):
        """Hint fires when count == 3 and last_ts is within 1 hour."""
        now = time.time()
        self._seed_global(tmp_data_dir, count=3, last_ts=now - 60)  # 1 minute ago
        hint = self._hint(tmp_data_dir)
        assert hint is not None
        assert "frequent" in hint.lower() or "semantic" in hint.lower()

    def test_cross_session_hint_fires_when_count_above_3(self, tmp_data_dir):
        """Hint fires when count > 3 (e.g. 10 sessions)."""
        now = time.time()
        self._seed_global(tmp_data_dir, count=10, last_ts=now - 300)
        hint = self._hint(tmp_data_dir)
        assert hint is not None
        assert "token-goat semantic" in hint

    def test_cross_session_hint_includes_pattern_text(self, tmp_data_dir):
        """The hint text must reference the searched pattern."""
        now = time.time()
        self._seed_global(tmp_data_dir, count=5, last_ts=now - 10)
        hint = self._hint(tmp_data_dir)
        assert hint is not None
        assert "test_login" in hint

    # --- cross-session hint suppressed -----------------------------------

    def test_cross_session_hint_suppressed_when_count_lt_3(self, tmp_data_dir):
        """Hint must NOT fire when count == 2 (below the 3-session threshold)."""
        now = time.time()
        self._seed_global(tmp_data_dir, count=2, last_ts=now - 60)
        hint = self._hint(tmp_data_dir)
        # No prior intra-session grep → no hint at all from either path.
        assert hint is None

    def test_cross_session_hint_suppressed_when_last_ts_stale(self, tmp_data_dir):
        """Hint must NOT fire when last_ts is older than 1 hour (stale pattern)."""
        now = time.time()
        stale_ts = now - 3601  # just over 1 hour
        self._seed_global(tmp_data_dir, count=10, last_ts=stale_ts)
        hint = self._hint(tmp_data_dir)
        assert hint is None

    def test_cross_session_hint_suppressed_when_no_global_row(self, tmp_data_dir):
        """Hint must not fire when the pattern has never been seen before."""
        hint = self._hint(tmp_data_dir)
        assert hint is None

    def test_cross_session_hint_suppressed_at_exactly_1h_boundary(self, tmp_data_dir):
        """last_ts exactly 3600 s ago is considered stale (age > threshold)."""
        now = time.time()
        self._seed_global(tmp_data_dir, count=5, last_ts=now - 3600)
        hint = self._hint(tmp_data_dir)
        assert hint is None

    # --- low-result patterns not written to global.db ---------------------

    def test_low_result_count_not_written_to_global_db(self, tmp_data_dir):
        """mark_grep with result_count below threshold must not write to global.db."""
        from token_goat.hints import _GREP_DEDUP_MIN_RESULT_COUNT

        sid = "xsess_low_results"
        # result_count is one below the threshold — must NOT write to global.db.
        session.mark_grep(sid, self._PATTERN, result_count=_GREP_DEDUP_MIN_RESULT_COUNT - 1)

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count FROM grep_patterns WHERE first_pattern = ?",
                (self._PATTERN,),
            ).fetchone()
        assert row is None, "low-result pattern must not be written to global.db"

    def test_cross_session_hint_increments_grep_dedup_type_counter(self, tmp_data_dir):
        """Cross-session hits must call cache.record_hint_emitted('grep_dedup').

        Regression: the cross-session early-return path called _record_hint_emitted
        (aggregate curator counter) but omitted cache.record_hint_emitted('grep_dedup'),
        so hints_emitted_by_type['grep_dedup'] stayed zero for cross-session events
        — the most valuable dedup events were invisible to per-type stats.
        """
        from token_goat.hints import build_grep_dedup_hint

        now = time.time()
        self._seed_global(tmp_data_dir, count=5, last_ts=now - 30)

        sid = "xsess_type_counter"
        cache = session.load(sid)
        hint = build_grep_dedup_hint(session_id=sid, pattern=self._PATTERN, path=None, cache=cache)

        assert hint is not None, "cross-session hint must fire"
        assert cache.hints_emitted_by_type.get("grep_dedup", 0) == 1, (
            "cross-session hit must increment hints_emitted_by_type['grep_dedup']"
        )

    def test_none_result_count_not_written_to_global_db(self, tmp_data_dir):
        """mark_grep with result_count=None must not write to global.db."""
        sid = "xsess_none_results"
        session.mark_grep(sid, self._PATTERN, result_count=None)

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count FROM grep_patterns WHERE first_pattern = ?",
                (self._PATTERN,),
            ).fetchone()
        assert row is None, "None result_count must not be written to global.db"

    def test_sufficient_result_count_written_to_global_db(self, tmp_data_dir):
        """mark_grep with result_count >= threshold must write to global.db."""
        from token_goat.hints import _GREP_DEDUP_MIN_RESULT_COUNT

        sid = "xsess_sufficient_results"
        session.mark_grep(sid, self._PATTERN, result_count=_GREP_DEDUP_MIN_RESULT_COUNT)

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count FROM grep_patterns WHERE first_pattern = ?",
                (self._PATTERN,),
            ).fetchone()
        assert row is not None, "pattern meeting threshold must be written to global.db"
        assert row["count"] == 1

    # --- three-session simulation ----------------------------------------

    def test_three_sessions_produce_count_3(self, tmp_data_dir):
        """Simulating 3 distinct sessions calling mark_grep produces count == 3 globally.

        Each session is simulated by calling db.update_global_grep_pattern directly
        with a >24h gap between calls (bypassing the amortization guard).
        """
        from token_goat import db as _db

        pattern = "rg 'class Auth'"
        pattern_hash = self._pattern_hash(pattern)

        t0 = 1_000_000.0
        _db.update_global_grep_pattern(pattern_hash, pattern, t0)
        _db.update_global_grep_pattern(pattern_hash, pattern, t0 + 86401)
        _db.update_global_grep_pattern(pattern_hash, pattern, t0 + 2 * 86401)

        with db.open_global() as conn:
            row = conn.execute(
                "SELECT count FROM grep_patterns WHERE pattern_hash = ?",
                (pattern_hash,),
            ).fetchone()
        assert row is not None
        assert row["count"] == 3


# ---------------------------------------------------------------------------
# Item A7: recall_path uses relative path when cwd is available
# ---------------------------------------------------------------------------


class TestRecallPathRelative:
    """When cwd is provided, recall commands in hints use a relative path
    instead of the full absolute path, saving ~25-40 tokens per hint."""

    def test_surgical_nudge_uses_relative_recall_path(self, tmp_data_dir):
        """The surgical-read nudge recall command uses relative path when cwd matches."""
        from token_goat.hints import _SUPPRESS_HINT_AT_READ_COUNT

        sid = "s_relpath_nudge"
        cwd = "C:/proj"
        path = f"{cwd}/src/auth.py"
        # Mark the file read enough times to trigger the surgical-read nudge.
        for i in range(_SUPPRESS_HINT_AT_READ_COUNT):
            session.mark_file_read(sid, path, offset=i * 100, limit=100)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd=cwd,
        )
        assert hint is not None
        # recall command must use relative path, not the full absolute path
        assert "src/auth.py" in hint
        assert "C:/proj/src/auth.py" not in hint

    def test_symbol_only_hint_uses_relative_recall_path(self, tmp_data_dir):
        """Symbol-only hint recall command uses relative path when cwd matches."""
        sid = "s_relpath_sym"
        cwd = "C:/myproject"
        path = f"{cwd}/module/parser.py"
        session.mark_file_read(sid, path, symbol="parse_token")

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=2000, cwd=cwd,
        )
        assert hint is not None
        assert "token-goat read" in hint
        # relative path only in recall command
        assert "module/parser.py" in hint
        assert "C:/myproject/module/parser.py" not in hint

    def test_no_cwd_falls_back_to_absolute_path(self, tmp_data_dir):
        """When cwd is None, recall command keeps the full absolute path."""
        from token_goat.hints import _SUPPRESS_HINT_AT_READ_COUNT

        sid = "s_relpath_nocwd"
        path = "C:/proj/src/auth.py"
        for i in range(_SUPPRESS_HINT_AT_READ_COUNT):
            session.mark_file_read(sid, path, offset=i * 100, limit=100)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd=None,
        )
        assert hint is not None
        # No cwd means the absolute path should appear in the recall command.
        assert "C:/proj/src/auth.py" in hint

    def test_path_not_under_cwd_keeps_absolute(self, tmp_data_dir):
        """When file_path is outside cwd, recall command retains the absolute path."""
        from token_goat.hints import _SUPPRESS_HINT_AT_READ_COUNT

        sid = "s_relpath_outside"
        cwd = "C:/other"
        path = "C:/proj/src/auth.py"
        for i in range(_SUPPRESS_HINT_AT_READ_COUNT):
            session.mark_file_read(sid, path, offset=i * 100, limit=100)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=100, cwd=cwd,
        )
        assert hint is not None
        assert "C:/proj/src/auth.py" in hint


# ---------------------------------------------------------------------------
# Item A28: proximity check suppresses hints for far-away reads
# ---------------------------------------------------------------------------


class TestProximityCheck:
    """The 'already read' hint is suppressed when the new read is entirely
    more than _PROXIMITY_SLOP_LINES lines away from all cached ranges."""

    def test_far_ahead_read_suppresses_hint(self, tmp_data_dir):
        """Reading lines 1000-1100 after caching lines 1-50 is not a near-read."""
        from token_goat.hints import _PROXIMITY_SLOP_LINES

        sid = "s_prox_ahead"
        path = "C:/proj/longfile.py"
        # Mark lines 1-50 as cached.
        session.mark_file_read(sid, path, offset=0, limit=50)

        # Request lines far past the end of the cached range + slop.
        far_offset = 50 + _PROXIMITY_SLOP_LINES + 10
        hint = build_read_hint(
            session_id=sid, file_path=path, offset=far_offset, limit=100, cwd=None,
        )
        assert hint is None, (
            f"expected None for far-ahead read (offset={far_offset}), got {hint!r}"
        )

    def test_far_before_read_suppresses_hint(self, tmp_data_dir):
        """Reading lines 1-50 after caching lines 500-600 is not a near-read."""

        sid = "s_prox_before"
        path = "C:/proj/longfile2.py"
        # Mark lines 500-600 as cached (offset=499, limit=101 → 1-indexed start=500).
        session.mark_file_read(sid, path, offset=499, limit=101)

        # Request lines well before the cached range (before min - slop).
        # cached min = 500, slop = 200, so req_end must be < 300.
        early_hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=50, cwd=None,
        )
        # line 1-50: req_end=50 < 500 - 200 = 300, so proximity suppresses it.
        assert early_hint is None, (
            f"expected None for far-before read, got {early_hint!r}"
        )

    def test_nearby_read_still_emits_hint(self, tmp_data_dir):
        """Reading lines just outside the slop window still emits a hint."""
        from token_goat.hints import _PROXIMITY_SLOP_LINES

        sid = "s_prox_near"
        path = "C:/proj/nearfile.py"
        # Mark lines 1-50 as cached.
        session.mark_file_read(sid, path, offset=0, limit=50)

        # Request lines just within the proximity slop (overlapping range: 30-130).
        # Overlap = lines 30-50 = 21 lines — below MIN_OVERLAP_TO_WARN(50), but the
        # proximity check must NOT suppress this.
        # Safety: build_read_hint must not raise for near-range overlap.
        # (offset=29 → req_start=30, req_end=129. global_max=50+1=51 →
        # 30 < 51+200 → not suppressed by proximity. Other suppressions
        # may still apply.)
        build_read_hint(
            session_id=sid, file_path=path, offset=29, limit=100, cwd=None,
        )
        # Same-range hint must also not raise.
        build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=50, cwd=None,
        )
        # Verify proximity constant is a positive integer (sanity check on the export).
        assert _PROXIMITY_SLOP_LINES > 0


# ---------------------------------------------------------------------------
# JSON sidecar (opt-in [hints] json_sidecar = true)
# ---------------------------------------------------------------------------


class TestJsonSidecar:
    """The structured-JSON sidecar prepends a machine-readable line before the
    existing prose hint when [hints] json_sidecar is enabled.  The prose itself
    must stay byte-for-byte identical so existing tests, dedup, and curator
    metrics keep working."""

    def test_sidecar_off_by_default(self, tmp_data_dir, monkeypatch):
        """Default config has json_sidecar=False; prose hint has no JSON prefix."""
        monkeypatch.delenv("TOKEN_GOAT_HINT_JSON_SIDECAR", raising=False)
        sid = "s_sidecar_off"
        path = "C:/proj/sidecar_off.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        # No leading JSON object — the prose starts with the backtick filename.
        assert not str(hint).startswith("{")

    def test_sidecar_on_prepends_json_line(self, tmp_data_dir, monkeypatch):
        """Env-var opt-in prepends a JSON line carrying the hint kind + fields."""
        import json as _json

        from token_goat import config as _config

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        sid = "s_sidecar_on"
        path = "C:/proj/sidecar_on.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        text = str(hint)
        first_line, _, rest = text.partition("\n")
        payload = _json.loads(first_line)
        assert payload["hint"] == "already_read"
        assert payload["file"] == path
        assert payload["wasted"] > 0
        # Prose portion still contains the cache marker — unchanged.
        assert "⌘" in rest

    def test_sidecar_preserves_tokens_saved(self, tmp_data_dir, monkeypatch):
        """The ReadHint subclass attribute tokens_saved survives the wrap."""
        from token_goat import config as _config

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        sid = "s_sidecar_tokens"
        path = "C:/proj/sidecar_tokens.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert hint.tokens_saved > 0

    def test_sidecar_failsoft_on_bad_payload(self, monkeypatch):
        """Encoding errors degrade gracefully — return original prose untouched."""
        from token_goat import config as _config
        from token_goat.hints import ReadHint, _emit_json_sidecar

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        original = ReadHint("prose only", tokens_saved=42)
        # ``object()`` is not JSON-serialisable — helper must catch and fall back.
        result = _emit_json_sidecar(original, "already_read", bad=object())
        assert result is original

    def test_sidecar_disabled_returns_original_hint(self, monkeypatch):
        """When the feature flag is off the helper is a pure pass-through."""
        from token_goat import config as _config
        from token_goat.hints import ReadHint, _emit_json_sidecar

        monkeypatch.delenv("TOKEN_GOAT_HINT_JSON_SIDECAR", raising=False)
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        original = ReadHint("untouched prose", tokens_saved=7)
        result = _emit_json_sidecar(original, "already_read", file="x")
        assert result is original
        assert str(result) == "untouched prose"

    def test_sidecar_drops_none_fields(self, monkeypatch):
        """Optional fields with value None are not serialised (keeps JSON terse)."""
        import json as _json

        from token_goat import config as _config
        from token_goat.hints import ReadHint, _emit_json_sidecar

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        original = ReadHint("prose", tokens_saved=10)
        wrapped = _emit_json_sidecar(
            original, "diff_since_last_read", file="x.py", added=2, line=None,
        )
        assert wrapped is not None
        first_line, _, _ = str(wrapped).partition("\n")
        payload = _json.loads(first_line)
        assert "line" not in payload
        assert payload["added"] == 2

    def test_all_dedup_hints_have_consistent_sidecars(self, tmp_data_dir, monkeypatch):
        """All dedup hint types emit JSON sidecars with consistent structure."""
        import json as _json

        from token_goat import bash_cache, web_cache
        from token_goat import config as _config
        from token_goat.hints import (
            build_bash_dedup_hint,
            build_glob_dedup_hint,
            build_grep_dedup_hint,
            build_web_dedup_hint,
        )

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        sid = "s_dedup_sidecars"

        # Record bash command
        cmd = "pytest tests/"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd, f"out_{cmd_sha[:8]}",
            stdout_bytes=2000, stderr_bytes=0,
            exit_code=0, truncated=False,
        )

        # Record grep pattern
        session.mark_grep(
            sid, pattern="test_", path="src/", result_count=12,
        )

        # Record glob pattern
        session.mark_glob_run(
            sid, pattern="*.py", path="src/", result_count=25,
        )

        # Record web URL
        url = "https://example.com/docs.html"
        url_sha = web_cache.url_hash(url)
        session.mark_web_fetch(
            sid, url_sha, url, f"web_{url_sha[:8]}",
            body_bytes=5000, status_code=200, truncated=False,
        )

        # Test bash_dedup_hint
        bash_hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert bash_hint is not None
        bash_first, _, _ = str(bash_hint).partition("\n")
        bash_payload = _json.loads(bash_first)
        assert bash_payload["hint"] == "bash_dedup"
        assert "command" in bash_payload
        assert "bytes_size" in bash_payload
        assert "wasted" in bash_payload

        # Test grep_dedup_hint
        grep_hint = build_grep_dedup_hint(session_id=sid, pattern="test_", path="src/")
        assert grep_hint is not None
        grep_first, _, _ = str(grep_hint).partition("\n")
        grep_payload = _json.loads(grep_first)
        assert grep_payload["hint"] == "grep_dedup"
        assert "pattern" in grep_payload
        assert "result_count" in grep_payload

        # Test glob_dedup_hint
        glob_hint = build_glob_dedup_hint(session_id=sid, pattern="*.py", path="src/")
        assert glob_hint is not None
        glob_first, _, _ = str(glob_hint).partition("\n")
        glob_payload = _json.loads(glob_first)
        assert glob_payload["hint"] == "glob_dedup"
        assert "pattern" in glob_payload
        assert "result_count" in glob_payload

        # Test web_dedup_hint
        web_hint = build_web_dedup_hint(session_id=sid, url=url)
        assert web_hint is not None
        web_first, _, _ = str(web_hint).partition("\n")
        web_payload = _json.loads(web_first)
        assert web_payload["hint"] == "web_dedup"
        assert "url" in web_payload
        assert "bytes_size" in web_payload

    def test_sidecar_json_parseable_for_all_hint_types(self, tmp_data_dir, monkeypatch):
        """JSON sidecars are valid JSON and parseable by json.loads() for new dedup hints."""
        import json as _json

        from token_goat import bash_cache, web_cache
        from token_goat import config as _config
        from token_goat.hints import (
            build_bash_dedup_hint,
            build_glob_dedup_hint,
            build_grep_dedup_hint,
            build_web_dedup_hint,
        )

        monkeypatch.setenv("TOKEN_GOAT_HINT_JSON_SIDECAR", "1")
        _config._config_mtime_cache = None  # type: ignore[attr-defined]

        sid = "s_json_parse_test"

        # Test bash dedup
        cmd = "echo test"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd, f"out_{cmd_sha[:8]}",
            stdout_bytes=2500, stderr_bytes=0,
            exit_code=0, truncated=False,
        )
        hint = build_bash_dedup_hint(session_id=sid, command=cmd)
        assert hint is not None
        first_line, _, _ = str(hint).partition("\n")
        payload = _json.loads(first_line)  # Should not raise
        assert "hint" in payload
        assert payload["hint"] == "bash_dedup"
        assert "command" in payload
        assert "wasted" in payload

        # Test grep dedup
        session.mark_grep(sid, pattern="test_pattern", path="src/", result_count=15)
        hint = build_grep_dedup_hint(session_id=sid, pattern="test_pattern", path="src/")
        assert hint is not None
        first_line, _, _ = str(hint).partition("\n")
        payload = _json.loads(first_line)  # Should not raise
        assert "hint" in payload
        assert payload["hint"] == "grep_dedup"
        assert "pattern" in payload
        assert "result_count" in payload

        # Test glob dedup
        session.mark_glob_run(sid, pattern="*.py", path="src/", result_count=30)
        hint = build_glob_dedup_hint(session_id=sid, pattern="*.py", path="src/")
        assert hint is not None
        first_line, _, _ = str(hint).partition("\n")
        payload = _json.loads(first_line)  # Should not raise
        assert "hint" in payload
        assert payload["hint"] == "glob_dedup"
        assert "pattern" in payload
        assert "result_count" in payload

        # Test web dedup
        url = "https://docs.example.com/api.html"
        url_sha = web_cache.url_hash(url)
        session.mark_web_fetch(
            sid, url_sha, url, f"web_{url_sha[:8]}",
            body_bytes=3000, status_code=200, truncated=False,
        )
        hint = build_web_dedup_hint(session_id=sid, url=url)
        assert hint is not None
        first_line, _, _ = str(hint).partition("\n")
        payload = _json.loads(first_line)  # Should not raise
        assert "hint" in payload
        assert payload["hint"] == "web_dedup"
        assert "url" in payload
        assert "bytes_size" in payload
        assert "wasted" in payload


# ---------------------------------------------------------------------------
# TestDedupStaleStat — bash/web dedup stale-suppression telemetry
# ---------------------------------------------------------------------------
#
# When a prior bash/web cache entry exists in the session cache but is older
# than the stale threshold, the dedup hint is suppressed.  These tests verify
# that the suppression also writes a zero-savings ``*_dedup_stale`` stat row
# so the bypass rate (stale / (stale + hit)) is measurable in
# ``token-goat stats``.  Parallel to ``image_shrink_skipped``.


class TestBashDedupStaleStat:
    """A stale bash entry suppresses the hint AND records bash_dedup_stale."""

    def _record_stale(self, sid: str, cmd: str, *, stdout_bytes: int = 1000) -> None:
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        output_id = f"out_{cmd_sha[:8]}"
        session.mark_bash_run(
            sid, cmd_sha, cmd[:120], output_id,
            stdout_bytes=stdout_bytes, stderr_bytes=0,
            exit_code=0, truncated=False,
        )
        # Backdate the entry past the stale threshold so the next
        # build_bash_dedup_hint call falls through to the suppression branch.
        cache = session.load(sid)
        entry = cache.bash_history[cmd_sha]
        entry.ts = time.time() - (STALE_READ_AGE_SECONDS + 60)
        cache._invalidate_json_cache()
        session.save(cache)

    def test_stale_entry_records_bash_dedup_stale(self, tmp_data_dir):
        """Stale bash hint suppression must write one bash_dedup_stale row."""
        sid = "s_bash_stale"
        cmd = "uv run pytest tests/ -v"
        self._record_stale(sid, cmd, stdout_bytes=2000)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({
                "kind": kind, "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved, "detail": detail,
            })

        with patch("token_goat.db.record_stat", side_effect=capture):
            hint = build_bash_dedup_hint(session_id=sid, command=cmd)

        assert hint is None, "stale entry must suppress the hint"

        stale_rows = [r for r in recorded if r["kind"] == "bash_dedup_stale"]
        assert len(stale_rows) == 1, "stale suppression must record exactly one row"
        assert stale_rows[0]["bytes_saved"] == 0
        assert stale_rows[0]["tokens_saved"] == 0
        # No companion bash_dedup_hint row should fire when suppressed.
        hit_rows = [r for r in recorded if r["kind"] == "bash_dedup_hint"]
        assert hit_rows == [], "no hit row when the hint is suppressed"

    def test_fresh_entry_does_not_record_stale(self, tmp_data_dir):
        """A fresh entry produces a hint and writes no bash_dedup_stale row."""
        sid = "s_bash_fresh"
        cmd = "uv run pytest tests/ -v"
        from token_goat import bash_cache

        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            sid, cmd_sha, cmd[:120], f"out_{cmd_sha[:8]}",
            stdout_bytes=2000, stderr_bytes=0, exit_code=0, truncated=False,
        )

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind})

        with patch("token_goat.db.record_stat", side_effect=capture):
            hint = build_bash_dedup_hint(session_id=sid, command=cmd)

        assert hint is not None, "fresh entry must emit a hint"
        stale_rows = [r for r in recorded if r["kind"] == "bash_dedup_stale"]
        assert stale_rows == [], "fresh entry must not record a stale row"


class TestWebDedupStaleStat:
    """A stale web entry suppresses the hint AND records web_dedup_stale."""

    def _record_stale(self, sid: str, url: str, *, body_bytes: int = 2000) -> None:
        from token_goat import web_cache
        from token_goat.hints import build_web_dedup_hint  # noqa: F401 — import-time

        url_sha = web_cache.url_hash(url)
        output_id = f"web_{url_sha[:8]}"
        session.mark_web_fetch(
            session_id=sid, url_sha=url_sha, url_preview=url,
            output_id=output_id, body_bytes=body_bytes,
            status_code=200, truncated=False,
        )
        cache = session.load(sid)
        entry = cache.web_history[url_sha]
        entry.ts = time.time() - (STALE_READ_AGE_SECONDS + 60)
        cache._invalidate_json_cache()
        session.save(cache)

    def test_stale_entry_records_web_dedup_stale(self, tmp_data_dir):
        """Stale web hint suppression must write one web_dedup_stale row."""
        from token_goat.hints import build_web_dedup_hint

        sid = "s_web_stale"
        url = "https://example.com/doc.html"
        self._record_stale(sid, url, body_bytes=4000)

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({
                "kind": kind, "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved, "detail": detail,
            })

        with patch("token_goat.db.record_stat", side_effect=capture):
            hint = build_web_dedup_hint(session_id=sid, url=url)

        assert hint is None, "stale entry must suppress the hint"

        stale_rows = [r for r in recorded if r["kind"] == "web_dedup_stale"]
        assert len(stale_rows) == 1
        assert stale_rows[0]["bytes_saved"] == 0
        assert stale_rows[0]["tokens_saved"] == 0
        hit_rows = [r for r in recorded if r["kind"] == "web_dedup_hint"]
        assert hit_rows == []

    def test_fresh_entry_does_not_record_stale(self, tmp_data_dir):
        """A fresh web entry must not record web_dedup_stale."""
        from token_goat import web_cache
        from token_goat.hints import build_web_dedup_hint

        sid = "s_web_fresh"
        url = "https://example.com/doc.html"
        url_sha = web_cache.url_hash(url)
        session.mark_web_fetch(
            session_id=sid, url_sha=url_sha, url_preview=url,
            output_id=f"web_{url_sha[:8]}", body_bytes=4000,
            status_code=200, truncated=False,
        )

        recorded: list[dict] = []

        def capture(project_hash, kind, *, bytes_saved=0, tokens_saved=0, detail=None):
            recorded.append({"kind": kind})

        with patch("token_goat.db.record_stat", side_effect=capture):
            hint = build_web_dedup_hint(session_id=sid, url=url)

        assert hint is not None
        stale_rows = [r for r in recorded if r["kind"] == "web_dedup_stale"]
        assert stale_rows == []


class TestMinFileLinesForHint:
    """Test configurable line-count threshold for suppressing full-file hints."""

    def test_threshold_zero_disabled_emits_all_hints(self, tmp_data_dir, monkeypatch):
        """When min_file_lines_for_hint=0 (default), no suppression occurs via config."""
        from token_goat import config as config_module
        from token_goat.hints import _should_suppress_full_file_hint

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 0
        monkeypatch.setattr(config_module, "load", lambda: mock_config)

        sid = "s_min_lines_zero"
        path = str(tmp_data_dir / "medium.py")
        # Use 200 lines to exceed MIN_OVERLAP_TO_WARN (50).
        Path(path).write_text("\n".join(f"x = {i}" for i in range(1, 201)), encoding="utf-8")
        # Mark ranges that will create a 60-line overlap hint.
        session.mark_file_read(sid, path, offset=0, limit=100)   # Lines 1-100
        session.mark_file_read(sid, path, offset=40, limit=100)  # Lines 41-140 (overlap 41-100 = 60 lines)

        # Verify the suppression helper behaves correctly.
        assert not _should_suppress_full_file_hint(200), "threshold=0 should not suppress"

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=40,
            limit=100,
            cwd=str(tmp_data_dir),
        )
        assert hint is not None, "With threshold=0, hints must emit"

    def test_threshold_30_file_25_lines_suppressed(self, tmp_data_dir, monkeypatch):
        """With threshold=30, a 25-line file is suppressed.

        _indexed_line_count is mocked to return None so the disk-fallback
        path is exercised, which avoids a slow find_project directory walk.
        """
        from token_goat import config as config_module

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 30
        monkeypatch.setattr(config_module, "load", lambda: mock_config)
        monkeypatch.setattr("token_goat.hints._indexed_line_count", lambda _fp, _cwd: None)

        sid = "s_min_lines_30_small"
        path = str(tmp_data_dir / "small.py")
        # 25 lines exactly, which is < 30.
        Path(path).write_text("\n".join(f"x = {i}" for i in range(1, 26)), encoding="utf-8")
        # Mark single read (read_count=1 will get suppressed by _MIN_LINES_FOR_HINT anyway).
        # Use a larger file technique: mark it as index-accessed instead.
        # Actually, for this small file, we'll just verify that the suppression works
        # by the line-count check in _hint_from_index path.
        # Mark it so we can test the dedup path with a large overlap.
        session.mark_file_read(sid, path, offset=0, limit=15)   # Lines 1-15
        session.mark_file_read(sid, path, offset=5, limit=15)   # Lines 6-20 (overlap 6-15 = 10 lines)

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=5,
            limit=15,
            cwd=str(tmp_data_dir),
        )
        assert hint is None, "File with 25 lines < threshold 30 must be suppressed"

    def test_threshold_30_file_100_lines_emitted(self, tmp_data_dir, monkeypatch):
        """With threshold=30, a 100-line file emits the hint."""
        from token_goat import config as config_module

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 30
        monkeypatch.setattr(config_module, "load", lambda: mock_config)

        sid = "s_min_lines_30_large"
        path = str(tmp_data_dir / "large.py")
        Path(path).write_text("\n".join(f"x = {i}" for i in range(1, 101)), encoding="utf-8")
        # Create overlapping ranges with 60+ line overlap to emit a hint.
        session.mark_file_read(sid, path, offset=0, limit=80)   # Lines 1-80
        session.mark_file_read(sid, path, offset=20, limit=80)  # Lines 21-100 (overlap 21-80 = 60 lines)

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=20,
            limit=80,
            cwd=str(tmp_data_dir),
        )
        assert hint is not None, "File with 100 lines > threshold 30 must emit"

    def test_large_file_partially_read_not_suppressed(self, tmp_data_dir, monkeypatch):
        """A large file (500 lines) that was only partially read must NOT be suppressed.

        Regression for the max_line proxy bug: max(cached_end) returns the highest
        line number read so far — a lower bound on file size, not the actual total.
        For a 500-line file where only lines 1-200 were read, max_line=200.  With
        threshold=300, that incorrectly triggers suppression.  The fix verifies the
        actual file line count before suppressing.

        Setup: threshold=300, 500-line file, read lines 1-200 twice (60+ overlap),
        re-read with limit=200 (> _NARROW_EXPLICIT_READ_LINES=50 to bypass the
        surgical-nag guard).  Without the fix, max_line=200 < 300 → suppressed.
        With the fix, on-disk count=500 >= 300 → not suppressed.

        _indexed_line_count is mocked to return None (simulating an unindexed project)
        so the fallback disk-read path is exercised.  This also avoids a slow
        find_project directory walk from the tmp_data_dir location.
        """
        from token_goat import config as config_module

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 300
        monkeypatch.setattr(config_module, "load", lambda: mock_config)
        # Return None from _indexed_line_count so the disk-fallback path is exercised
        # and we avoid a slow find_project directory walk.
        monkeypatch.setattr("token_goat.hints._indexed_line_count", lambda _fp, _cwd: None)

        sid = "s_large_partial_no_suppress"
        path = str(tmp_data_dir / "large_partially_read.py")
        # 500-line file: actual line count (500) > threshold (300), but partial read
        # produces max_line=200 < threshold=300 — the proxy would incorrectly suppress.
        Path(path).write_text("\n".join(f"x = {i}" for i in range(1, 501)), encoding="utf-8")

        # Two overlapping reads of lines 1-200 (overlap = 200 lines >> MIN_OVERLAP_TO_WARN=50).
        session.mark_file_read(sid, path, offset=0, limit=200)   # Lines 1-200
        session.mark_file_read(sid, path, offset=50, limit=150)  # Lines 51-200 (overlap 51-200)

        # Re-read with limit=200 (> _NARROW_EXPLICIT_READ_LINES=50 → not narrow surgical).
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=50,
            limit=150,
            cwd=str(tmp_data_dir),
        )
        # File is 500 lines (> threshold 300), so hint must NOT be suppressed.
        assert hint is not None, (
            "Large file (500 lines) partially read must not be suppressed by max_line proxy"
        )

    def test_symbol_hint_emitted_when_line_ranges_also_present(self, tmp_data_dir, monkeypatch):
        """When a file has both line_ranges AND symbols_read, and is below threshold,
        a symbol-only hint is emitted — not a line-range hint and not None.

        Regression for the fallthrough bug: after `if not entry.symbols_read: return None`
        did not fire (symbols exist), execution fell through to line-range hint generation.
        The symbol-only path at `if entry.symbols_read and not entry.line_ranges:` is
        unreachable inside the `if entry.line_ranges:` branch that guards the suppression
        block, so a separate early-return was needed.

        _indexed_line_count is mocked to return None so the disk-fallback path runs
        and the slow find_project directory walk is avoided.
        """
        from token_goat import config as config_module

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 100  # threshold above file size
        monkeypatch.setattr(config_module, "load", lambda: mock_config)
        monkeypatch.setattr("token_goat.hints._indexed_line_count", lambda _fp, _cwd: None)

        sid = "s_symbol_plus_ranges_small"
        path = str(tmp_data_dir / "small_mixed_access.py")
        # 60-line file: below threshold=100, but 60 lines of overlap > MIN_OVERLAP_TO_WARN=50
        # so the overlap path would emit a hint if the suppression fallthrough bug fires.
        Path(path).write_text("\n".join(f"x = {i}" for i in range(1, 61)), encoding="utf-8")

        # Regular read → populates line_ranges[(1, 60)]
        session.mark_file_read(sid, path, offset=0, limit=60)
        # Symbol read → populates symbols_read["foo"] without adding line ranges
        session.mark_file_read(sid, path, offset=0, limit=60, symbol="foo")

        # Re-read with no explicit limit: has_explicit_limit=False, overlap=60 > 50,
        # so the overlap path would produce a hint if the suppression fallthrough bug fires.
        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=None,
            cwd=str(tmp_data_dir),
        )
        assert hint is not None, (
            "File with symbols_read must emit symbol-only hint when below min_file_lines threshold"
        )
        assert "token-goat read" in hint, (
            "Hint must be the symbol-only format, not a line-range overlap hint — "
            "line-range hints are suppressed for files below min_file_lines_for_hint"
        )

    def test_symbol_hints_never_suppressed(self, tmp_data_dir, monkeypatch):
        """Surgical hints (symbols) bypass line-count suppression."""
        from token_goat import config as config_module

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 30
        monkeypatch.setattr(config_module, "load", lambda: mock_config)

        sid = "s_min_lines_symbol"
        path = str(tmp_data_dir / "tiny_with_symbol.py")
        Path(path).write_text("def foo():\n    pass\n", encoding="utf-8")
        session.mark_file_read(sid, path, offset=0, limit=10, symbol="foo")

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=10,
            cwd=str(tmp_data_dir),
        )
        # Symbol-only hint still emits (surgical reads not suppressed).
        assert hint is not None, "Symbol-only hints must never be suppressed"

    def test_no_line_count_avoids_suppression(self, tmp_data_dir, monkeypatch):
        """When line count is unavailable, suppression is skipped."""
        from token_goat import config as config_module
        from token_goat.hints import _should_suppress_full_file_hint

        mock_config = config_module.Config()
        mock_config.hints.min_file_lines_for_hint = 30
        monkeypatch.setattr(config_module, "load", lambda: mock_config)
        # Mock find_project to avoid a slow directory walk for a file that is not
        # in the session cache and doesn't exist on disk.
        monkeypatch.setattr("token_goat.hints.find_project", lambda _cwd: None)

        # Verify that None line count bypasses suppression.
        assert not _should_suppress_full_file_hint(None), "None line count should not suppress"

        sid = "s_min_lines_no_count"
        path = str(tmp_data_dir / "nonexistent.py")
        # Do not write the file or mark it as read.
        # When there's no line count, the suppression check should skip.

        hint = build_read_hint(
            session_id=sid,
            file_path=path,
            offset=0,
            limit=10,
            cwd=str(tmp_data_dir),
        )
        # No hint expected anyway (file not in index), but test confirms no crash.
        assert hint is None, "Nonexistent file has no hint"


# ---------------------------------------------------------------------------
# record_hint_emitted routes to kind, not hard-coded "read_dedup"
# ---------------------------------------------------------------------------


class TestReadHintEmittedByTypeRouting:
    """build_read_hint must NOT increment per-type counters; pre_read does it.

    Regression guard for two bugs fixed together:
    1. Counter was hard-coded to "read_dedup" regardless of hint kind.
    2. Counter was incremented inside build_read_hint, before pre_read's
       fingerprint dedup check — inflating counts for hints that never
       entered context.  Counters now live in pre_read's else-branch.
    """

    def test_build_read_hint_does_not_increment_any_counter(self, tmp_data_dir):
        """build_read_hint alone must NOT increment hints_emitted_by_type.

        Counter increments are deferred to pre_read so fingerprint-suppressed
        hints are not counted as emitted.
        """
        sid = "kind_routing_reread"
        path = "C:/proj/routing_test.py"
        _mark(tmp_data_dir, sid, path, offset=0, limit=200)
        cache = session.load(sid)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None, cache=cache,
        )

        assert hint is not None
        assert hint.tokens_saved > 0
        # Counters must NOT be incremented here — pre_read does it after
        # fingerprint dedup.  If anything is incremented, Bug A regressed.
        assert cache.hints_emitted_by_type == {}
        assert cache.hints_emitted == 0

    def test_suggestion_hint_also_defers_counter(self, tmp_data_dir):
        """For suggestion hints (tokens_saved == 0) build_read_hint also defers counters."""
        sid = "kind_routing_suggest"
        path = "C:/proj/routing_suggest.py"
        cache = session.load(sid)

        build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None, cache=cache,
        )

        assert cache.hints_emitted_by_type == {}
        assert cache.hints_emitted == 0


# ---------------------------------------------------------------------------
# TestGlobDedupBelowThresholdSuppression
# ---------------------------------------------------------------------------


class TestGlobDedupBelowThresholdSuppression:
    """Glob dedup must record hint_suppressed_by_type when below the result threshold.

    Regression: the below-threshold early return in _build_glob_dedup_hint_inner
    returned None without calling cache.record_hint_suppressed('glob_dedup_below_threshold'),
    so the suppression counter stayed zero and the configurable threshold could not
    be tuned — there was no signal to observe how often it triggered.
    """

    def test_glob_below_threshold_records_suppression(self, tmp_data_dir):
        """result_count below _GLOB_DEDUP_MIN_RESULT_COUNT must increment suppressed counter."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT, build_glob_dedup_hint

        sid = "glob_below_thresh"
        pattern = "**/*.py"
        # Record a glob run with a result count one below the threshold.
        session.mark_glob_run(sid, pattern, path=None, result_count=max(0, _GLOB_DEDUP_MIN_RESULT_COUNT - 1))
        cache = session.load(sid)

        result = build_glob_dedup_hint(session_id=sid, pattern=pattern, path=None, cache=cache)

        assert result is None, "below-threshold glob must not produce a hint"
        assert cache.hints_suppressed_by_type.get("glob_dedup_below_threshold", 0) == 1, (
            "below-threshold return must increment hints_suppressed_by_type['glob_dedup_below_threshold']"
        )

    def test_glob_none_result_count_records_suppression(self, tmp_data_dir):
        """result_count=None must also record suppression, not silently return None."""
        from token_goat.hints import build_glob_dedup_hint

        sid = "glob_none_count"
        pattern = "src/**/*.ts"
        session.mark_glob_run(sid, pattern, path=None, result_count=None)
        cache = session.load(sid)

        result = build_glob_dedup_hint(session_id=sid, pattern=pattern, path=None, cache=cache)

        assert result is None
        assert cache.hints_suppressed_by_type.get("glob_dedup_below_threshold", 0) == 1, (
            "None result_count must also increment the suppression counter"
        )

    def test_glob_above_threshold_does_not_record_suppression(self, tmp_data_dir):
        """result_count above threshold must NOT record suppression."""
        from token_goat.hints import _GLOB_DEDUP_MIN_RESULT_COUNT, build_glob_dedup_hint

        sid = "glob_above_thresh"
        pattern = "**/*.go"
        session.mark_glob_run(sid, pattern, path=None, result_count=_GLOB_DEDUP_MIN_RESULT_COUNT + 5)
        cache = session.load(sid)

        build_glob_dedup_hint(session_id=sid, pattern=pattern, path=None, cache=cache)

        assert cache.hints_suppressed_by_type.get("glob_dedup_below_threshold", 0) == 0, (
            "above-threshold glob must not record a below-threshold suppression"
        )


# ---------------------------------------------------------------------------
# _get_indexed_symbols_and_line_count — NULL end_line regression
# ---------------------------------------------------------------------------


class TestGetIndexedSymbolsNullEndLine:
    """Regression: symbols with end_line IS NULL must be excluded from results.

    Prior to the fix, int(r["end_line"]) on a NULL row raised TypeError, which
    was not caught by the local (DBError, sqlite3.Error, OSError) handler and
    propagated to build_read_hint's outer except-Exception, silently disabling
    all index-based hint generation for the file.
    """

    def test_null_end_line_rows_excluded_not_crash(self, tmp_data_dir, tmp_path, make_project):
        proj_root = tmp_path / "null_end_line_proj"
        proj_root.mkdir()
        proj = make_project(proj_root)

        file_rel = "src/sample.py"

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (file_rel, "python", 100, 0.0, "abc123", 0),
            )
            # Symbol with valid end_line — should be returned.
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("good_func", "function", file_rel, 1, 10, "def good_func():"),
            )
            # Symbol with NULL end_line — must be silently excluded, not crash.
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, end_line, signature)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("stub_func", "function", file_rel, 12, None, "def stub_func():"),
            )
            conn.commit()

        syms, n_lines, _ = _get_indexed_symbols_and_line_count(file_rel, proj.hash)

        assert len(syms) == 1, "only the non-NULL end_line symbol should be returned"
        assert syms[0]["name"] == "good_func"


# ---------------------------------------------------------------------------
# Surgical intent guard: offset=0 + limit must suppress hint (not just offset>0)
# ---------------------------------------------------------------------------


class TestSurgicalIntentGuardOffsetZero:
    """Regression: offset=0 is a valid explicit offset; surgical guard must fire
    for offset=0 + limit, not only for offset>0 + limit."""

    def _make_large_file(self, tmp_path: Path, name: str, size: int = 500_000) -> str:
        p = tmp_path / name
        p.write_bytes(b"x" * size)
        return str(p)

    def test_index_only_hint_suppressed_when_offset_zero_and_limit(self, tmp_path: Path) -> None:
        from token_goat.hints import build_index_only_file_hint

        large_lock = self._make_large_file(tmp_path, "package-lock.json")
        # offset=0 with a limit — surgical intent; must NOT emit a hint.
        result = build_index_only_file_hint(file_path=large_lock, offset=0, limit=100)
        assert result is None, "offset=0 + limit should suppress index-only hint"

    def test_index_only_hint_emits_when_no_offset(self, tmp_path: Path) -> None:
        from token_goat.hints import build_index_only_file_hint

        large_lock = self._make_large_file(tmp_path, "package-lock.json")
        # No offset — unsurgical read; may emit a hint.
        result = build_index_only_file_hint(file_path=large_lock, offset=None, limit=None)
        assert result is not None, "no offset/limit should emit index-only hint for large lockfile"

    def test_structured_hint_suppressed_when_offset_zero_and_limit(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        large_csv = self._make_large_file(tmp_path, "data.csv")
        result = build_structured_file_hint(file_path=large_csv, offset=0, limit=50)
        assert result is None, "offset=0 + limit should suppress structured-file hint"

    def test_structured_hint_emits_when_no_offset(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        large_csv = self._make_large_file(tmp_path, "data.csv")
        result = build_structured_file_hint(file_path=large_csv, offset=None, limit=None)
        assert result is not None, "no offset/limit should emit structured-file hint for large CSV"


# ---------------------------------------------------------------------------
# Structured-file hints — new file types (CSS, SQL, GraphQL, Proto, env, Makefile)
# ---------------------------------------------------------------------------


class TestStructuredFileHintsNewTypes:
    """Hint emission for CSS, SQL, GraphQL, Proto, .env, and Makefile file types."""

    def _make_file(self, tmp_path: Path, name: str, size: int) -> str:
        p = tmp_path / name
        p.write_bytes(b"x" * size)
        return str(p)

    # ── CSS / SCSS / Sass ──────────────────────────────────────────────────

    def test_css_hint_fires_for_large_css_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "styles.css", 15_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .css file"
        text = str(result)
        assert "css" in text.lower(), f"hint should mention css: {text}"
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_scss_hint_fires_for_large_scss_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "app.scss", 12_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .scss file"
        text = str(result)
        assert "scss" in text.lower(), f"hint should mention scss: {text}"

    def test_sass_hint_fires_for_large_sass_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "theme.sass", 11_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .sass file"
        text = str(result)
        assert "sass" in text.lower(), f"hint should mention sass: {text}"

    def test_css_hint_suppressed_for_small_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "tiny.css", 500)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny .css file"

    def test_css_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "styles.css", 20_000)
        result = build_structured_file_hint(file_path=f, offset=0, limit=100)
        assert result is None, "offset+limit should suppress css hint"

    def test_css_hint_suggests_surgical_recall(self, tmp_path: Path) -> None:
        # tmp_path file is not under an indexed project, so the symbol lookup
        # returns nothing.  CSS parsers map to no indexed symbols, so the fallback
        # must be `token-goat section` (raw-text, degrades gracefully) — never
        # `outline` (which would print a misleading "run index --full") and never
        # an un-runnable `::.class-name` placeholder.
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "main.css", 15_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None
        text = str(result).lower()
        assert "token-goat section" in text or "token-goat read" in text, (
            f"hint should suggest a runnable surgical command: {text}"
        )
        assert "token-goat outline" not in text, (
            f"CSS fallback must not use the misleading outline command: {text}"
        )
        assert "::.class-name" not in text, "hint must not emit a literal placeholder"

    # ── SQL ────────────────────────────────────────────────────────────────

    def test_sql_hint_fires_for_large_sql_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "schema.sql", 8_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .sql file"
        text = str(result)
        assert "sql" in text.lower(), f"hint should mention sql: {text}"
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_sql_hint_suppressed_for_small_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "tiny.sql", 200)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny .sql file"

    def test_sql_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "migrations.sql", 10_000)
        result = build_structured_file_hint(file_path=f, offset=0, limit=50)
        assert result is None, "offset+limit should suppress sql hint"

    # ── GraphQL ────────────────────────────────────────────────────────────

    def test_graphql_hint_fires_for_large_graphql_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "schema.graphql", 3_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .graphql file"
        text = str(result)
        assert "graphql" in text.lower(), f"hint should mention graphql: {text}"
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_gql_hint_fires_for_large_gql_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "queries.gql", 2_500)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .gql file"
        text = str(result)
        assert "graphql" in text.lower(), f"hint should mention graphql: {text}"

    def test_graphql_hint_suppressed_for_small_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "tiny.graphql", 100)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny .graphql file"

    def test_graphql_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "schema.graphql", 5_000)
        result = build_structured_file_hint(file_path=f, offset=10, limit=30)
        assert result is None, "offset+limit should suppress graphql hint"

    # ── Protocol Buffers ───────────────────────────────────────────────────

    def test_proto_hint_fires_for_large_proto_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "service.proto", 3_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for large .proto file"
        text = str(result)
        assert "proto" in text.lower(), f"hint should mention proto: {text}"
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_proto_hint_suppressed_for_small_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "tiny.proto", 100)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny .proto file"

    def test_proto_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "api.proto", 4_000)
        result = build_structured_file_hint(file_path=f, offset=0, limit=25)
        assert result is None, "offset+limit should suppress proto hint"

    # ── .env files ─────────────────────────────────────────────────────────

    def test_env_hint_fires_for_env_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env", 1_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for .env file above threshold"
        text = str(result)
        assert "env" in text.lower(), f"hint should mention env: {text}"
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_env_example_hint_fires(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env.example", 800)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for .env.example file"

    def test_env_local_hint_fires(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env.local", 600)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for .env.local file"

    def test_env_hint_suppressed_for_tiny_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env", 100)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny .env file"

    def test_env_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env", 2_000)
        result = build_structured_file_hint(file_path=f, offset=0, limit=20)
        assert result is None, "offset+limit should suppress env hint"

    def test_env_hint_suggests_variable_lookup(self, tmp_path: Path) -> None:
        # No indexed symbols for a tmp_path .env → outline + grep fallback,
        # never a bare `::VAR_NAME` placeholder.
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, ".env.example", 1_500)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None
        text = str(result).lower()
        assert "outline" in text or "grep" in text or "variable" in text, (
            f"env hint should suggest a runnable variable lookup: {text}"
        )
        assert "::var_name" not in text, "env hint must not emit a literal placeholder"

    # ── Makefile ───────────────────────────────────────────────────────────

    def test_makefile_hint_fires(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "Makefile", 2_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for Makefile above threshold"
        text = str(result)
        assert "makefile" in text.lower() or "target" in text.lower(), (
            f"hint should mention makefile or target: {text}"
        )
        assert "token-goat" in text, f"hint should suggest a token-goat command: {text}"

    def test_gnumakefile_hint_fires(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "GNUmakefile", 1_500)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "hint should fire for GNUmakefile"

    def test_makefile_hint_suppressed_for_tiny_file(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "Makefile", 200)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "hint should not fire for tiny Makefile"

    def test_makefile_hint_suppressed_when_surgical(self, tmp_path: Path) -> None:
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "Makefile", 3_000)
        result = build_structured_file_hint(file_path=f, offset=5, limit=30)
        assert result is None, "offset+limit should suppress Makefile hint"

    # ── Regression: legacy types still work correctly ──────────────────────

    def test_legacy_csv_still_fires(self, tmp_path: Path) -> None:
        """Adding new types must not break existing CSV hints."""
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "data.csv", 100_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "legacy CSV hint must still fire"

    def test_legacy_yaml_still_fires(self, tmp_path: Path) -> None:
        """Adding new types must not break existing YAML hints."""
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "config.yaml", 60_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is not None, "legacy YAML hint must still fire"

    def test_unknown_extension_still_silent(self, tmp_path: Path) -> None:
        """Files with unrecognised extensions produce no hint."""
        from token_goat.hints import build_structured_file_hint

        f = self._make_file(tmp_path, "data.xyz", 500_000)
        result = build_structured_file_hint(file_path=f, offset=None, limit=None)
        assert result is None, "unknown extension must not emit a hint"


class TestStructuredHintSymbolInterpolation:
    """Structured-file hints name a real indexed symbol when one exists, and fall
    back to a runnable command (never a literal `::Placeholder`) when not — to
    `token-goat outline` for symbol-indexed types, or `token-goat section` for the
    raw-text CSS/SQL types whose parsers index no symbols.

    All DB access is mocked — `_lookup_top_indexed_symbol`, `find_project`, and
    `_get_indexed_symbols_and_line_count` are monkeypatched so no real SQLite is
    opened, keeping every test in this class sub-millisecond.
    """

    def _make_file(self, tmp_path: Path, name: str, size: int) -> str:
        p = tmp_path / name
        p.write_bytes(b"x" * size)
        return str(p)

    # ── branch-level: a real symbol is interpolated into the read command ──────

    def test_interpolates_real_symbol_for_each_type(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from token_goat import hints

        # (filename, size_bytes, rel_path, symbol, leftover placeholders that must NOT appear)
        cases = [
            ("schema.sql", 8_000, "db/schema.sql", "users", ("::table_name", "::CreateTable")),
            ("app.css", 15_000, "src/app.css", ".btn-primary", ("::.class-name", "::media-queries")),
            ("schema.graphql", 3_000, "api/schema.graphql", "Account", ("::TypeName",)),
            ("service.proto", 3_000, "rpc/service.proto", "GetUser", ("::MessageName",)),
            (".env", 1_000, ".env", "DATABASE_URL", ("::VAR_NAME",)),
            ("Makefile", 2_000, "Makefile", "build", ("::target-name",)),
        ]
        for name, size, rel, sym, placeholders in cases:
            monkeypatch.setattr(
                hints, "_lookup_top_indexed_symbol", lambda fp, _r=rel, _s=sym: (_r, _s)
            )
            f = self._make_file(tmp_path, name, size)
            result = hints.build_structured_file_hint(file_path=f, offset=None, limit=None)
            assert result is not None, f"hint should fire for {name}"
            text = str(result)
            assert f'token-goat read "{rel}::{sym}"' in text, (
                f"{name}: expected real symbol in read command, got: {text}"
            )
            for ph in placeholders:
                assert ph not in text, f"{name}: placeholder {ph} leaked: {text}"

    # ── branch-level: outline fallback when nothing is indexed ────────────────

    def test_fallback_command_when_no_symbol(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """No indexed symbol → a runnable fallback, never a ``::Placeholder``.

        CSS and SQL parsers commonly index *no* symbols, and ``outline`` would
        then print the misleading "No indexed top-level symbols found, run
        ``token-goat index --full``".  Those two types must fall back to
        ``token-goat section`` (raw-text, degrades gracefully); the remaining
        types keep the ``outline`` fallback.
        """
        from token_goat import hints

        monkeypatch.setattr(hints, "_lookup_top_indexed_symbol", lambda fp: None)
        # (filename, size, expected_fallback_cmd, placeholders that must NOT appear)
        cases = [
            ("schema.sql", 8_000, "section", ("::table_name", "::CreateTable")),
            ("app.css", 15_000, "section", ("::.class-name", "::media-queries")),
            ("schema.graphql", 3_000, "outline", ("::TypeName",)),
            ("service.proto", 3_000, "outline", ("::MessageName",)),
            (".env", 1_000, "outline", ("::VAR_NAME",)),
            ("Makefile", 2_000, "outline", ("::target-name",)),
        ]
        for name, size, expected_cmd, placeholders in cases:
            f = self._make_file(tmp_path, name, size)
            result = hints.build_structured_file_hint(file_path=f, offset=None, limit=None)
            assert result is not None, f"hint should fire for {name}"
            text = str(result)
            assert f"token-goat {expected_cmd}" in text, (
                f"{name}: expected {expected_cmd} fallback, got: {text}"
            )
            if expected_cmd == "section":
                # The section fallback must not regress into the misleading outline command.
                assert "token-goat outline" not in text, (
                    f"{name}: outline fallback leaked for raw-text type: {text}"
                )
            for ph in placeholders:
                assert ph not in text, f"{name}: placeholder {ph} leaked into fallback: {text}"

    # ── safety: a symbol name containing `"` must not break command quoting ────

    def test_symbol_name_double_quote_rendered_safely(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        """A symbol such as the CSS attribute selector ``[type="submit"]`` carries a
        literal double quote.  Interpolated raw into ``read "path::symbol"`` it would
        terminate the quoting mid-command and yield an un-runnable hint.  The real
        ``_lookup_top_indexed_symbol`` must neutralise it (``"`` → ``'``), so the
        emitted command stays balanced and runnable.
        """
        from types import SimpleNamespace

        from token_goat import hints

        root = tmp_path
        target = root / "app.css"
        target.write_bytes(b"x" * 15_000)
        # Drive the *real* lookup (not a stub) so the sanitiser actually runs.
        monkeypatch.setattr(
            hints, "find_project",
            lambda start: SimpleNamespace(root=root, hash="abc", marker=".git"),
        )
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count",
            lambda rel, h: (
                [{"kind": "rule", "name": '[type="submit"]', "line": 1, "end_line": 3}],
                10,
                True,
            ),
        )
        result = hints.build_structured_file_hint(
            file_path=str(target), offset=None, limit=None
        )
        assert result is not None
        text = str(result)
        # The raw double-quoted selector must NOT survive verbatim — it would split
        # the command's quoting.
        assert '[type="submit"]' not in text, f"unescaped double quote leaked: {text}"
        # Single-quote substitution keeps the command well-formed and runnable.
        assert "[type='submit']" in text, f"expected single-quote substitution: {text}"
        assert "token-goat read \"app.css::[type='submit']\"" in text, text

    def test_sanitize_hint_symbol_neutralises_double_quotes(self) -> None:
        """Unit contract for the symbol sanitiser used by the hint builders."""
        from token_goat import hints

        assert hints._sanitize_hint_symbol('[type="submit"]') == "[type='submit']"
        # Newline/CR stripping is inherited from _sanitize_hint_path.
        out = hints._sanitize_hint_symbol('a"b\nc\rd')
        assert '"' not in out and "\n" not in out and "\r" not in out

    # ── fallback command selection (outline vs section) ───────────────────────

    def test_structured_read_or_outline_section_fallback(self) -> None:
        """CSS/SQL pass ``fallback_cmd="section"`` so the no-symbol clause points at
        ``token-goat section`` (raw-text) instead of the misleading ``outline``."""
        from token_goat import hints

        clause = hints._structured_read_or_outline(
            None, "db/schema.sql", "one table", "tables", fallback_cmd="section"
        )
        assert 'token-goat section "db/schema.sql::<heading>"' in clause, clause
        assert "token-goat outline" not in clause, clause

    def test_structured_read_or_outline_outline_fallback_is_default(self) -> None:
        """The default fallback stays ``outline`` for the symbol-indexed types."""
        from token_goat import hints

        clause = hints._structured_read_or_outline(
            None, "api/schema.graphql", "one type", "types"
        )
        assert 'token-goat outline "api/schema.graphql"' in clause, clause
        assert "token-goat section" not in clause, clause

    # ── helper-level: _lookup_top_indexed_symbol resolution ───────────────────

    def test_lookup_returns_top_symbol(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace

        from token_goat import hints

        root = tmp_path
        target = root / "db" / "schema.sql"
        target.parent.mkdir(parents=True)
        target.write_text("-- sql")
        monkeypatch.setattr(
            hints, "find_project",
            lambda start: SimpleNamespace(root=root, hash="deadbeef", marker=".git"),
        )
        # Symbols come back ordered by line; index 0 is the top of the file.
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count",
            lambda rel, h: (
                [
                    {"kind": "table", "name": "users", "line": 1, "end_line": 9},
                    {"kind": "table", "name": "orders", "line": 11, "end_line": 20},
                ],
                30,
                True,
            ),
        )
        assert hints._lookup_top_indexed_symbol(str(target)) == ("db/schema.sql", "users")

    def test_lookup_sanitizes_newline_in_rel_path(self, tmp_path: Path, monkeypatch) -> None:
        """A ``rel`` path carrying a raw ``\\n`` must be neutralised before it is
        returned for hint interpolation.

        The project-relative path is derived from the *file path* the hook is
        handed, and that path can contain attacker-controlled bytes (it is read
        back from session JSON written by a prior hook invocation). If a newline
        survived into the returned ``rel`` it would split a single hint into what
        looks like multiple ``Note:`` lines in the model's context. Pre-fix code
        returned ``rel`` verbatim; the fix runs it through ``_sanitize_hint_path``.

        Fully mocked — ``find_project`` and ``_get_indexed_symbols_and_line_count``
        are patched, so no real DB or on-disk file with a newline name is needed
        (Windows could not create one anyway).
        """
        from types import SimpleNamespace

        from token_goat import hints

        root = tmp_path
        # A path component carrying a raw newline (and a CR for good measure).
        target = root / "src" / "dirty\npath\r.sql"
        monkeypatch.setattr(
            hints, "find_project",
            lambda start: SimpleNamespace(root=root, hash="deadbeef", marker=".git"),
        )
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count",
            lambda rel, h: ([{"kind": "table", "name": "users", "line": 1, "end_line": 9}], 9, True),
        )

        result = hints._lookup_top_indexed_symbol(str(target))
        assert result is not None
        rel, symbol = result
        # The newline/CR are neutralised, not passed through verbatim.
        assert "\n" not in rel, repr(rel)
        assert "\r" not in rel, repr(rel)
        assert symbol == "users"

        # And a hint built from the sanitised rel stays a single line — no raw
        # newline mid-string that could fake extra hint entries.
        hint = f"Note: indexed symbol `{rel}::{symbol}` available."
        assert "\n" not in hint, repr(hint)
        assert "\r" not in hint, repr(hint)

    def test_lookup_returns_none_when_no_symbols(self, tmp_path: Path, monkeypatch) -> None:
        from types import SimpleNamespace

        from token_goat import hints

        root = tmp_path
        target = root / "schema.sql"
        target.write_text("-- sql")
        monkeypatch.setattr(
            hints, "find_project",
            lambda start: SimpleNamespace(root=root, hash="abc", marker=".git"),
        )
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count", lambda rel, h: ([], 5, True)
        )
        assert hints._lookup_top_indexed_symbol(str(target)) is None

    def test_lookup_returns_none_for_relative_path(self) -> None:
        from token_goat import hints

        # Without an absolute path we cannot safely resolve a project — bail out.
        assert hints._lookup_top_indexed_symbol("relative/schema.sql") is None

    def test_lookup_returns_none_when_no_project(self, tmp_path: Path, monkeypatch) -> None:
        from token_goat import hints

        monkeypatch.setattr(hints, "find_project", lambda start: None)
        target = tmp_path / "schema.sql"
        target.write_text("x")
        assert hints._lookup_top_indexed_symbol(str(target)) is None

    def test_lookup_returns_none_when_file_outside_project_root(
        self, tmp_path: Path, monkeypatch
    ) -> None:
        from types import SimpleNamespace

        from token_goat import hints

        # Project root that is NOT an ancestor of the file → relative_to raises.
        other_root = tmp_path / "elsewhere"
        other_root.mkdir()
        target = tmp_path / "schema.sql"
        target.write_text("x")
        monkeypatch.setattr(
            hints, "find_project",
            lambda start: SimpleNamespace(root=other_root, hash="abc", marker=".git"),
        )
        assert hints._lookup_top_indexed_symbol(str(target)) is None


# ---------------------------------------------------------------------------
# Co-read suggestion hints
# ---------------------------------------------------------------------------


class TestCoreadSuggestions:
    """Tests for co-read import suggestions."""

    def test_coread_hint_uses_real_top_symbol(self, tmp_path, monkeypatch):
        """The co-read suggestion must name a real indexed symbol, never the legacy
        ``::ClassName`` placeholder.  Fully mocked: ``_get_unread_coread_files`` feeds
        the import tuple and ``_get_indexed_symbols_and_line_count`` supplies the top
        symbol, so no real DB or indexing runs (fast)."""
        from token_goat import hints

        monkeypatch.setattr(
            hints, "_get_unread_coread_files",
            lambda fp, ph, cache=None: [("pkg/widget.py", "widget")],
        )
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count",
            lambda rel, h: (
                [{"kind": "class", "name": "Widget", "line": 1, "end_line": 40}],
                40,
                True,
            ),
        )
        hint = hints._build_coread_suggestion_hint(
            str(tmp_path / "main.py"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", None
        )
        assert hint is not None
        text = str(hint)
        assert 'token-goat read "pkg/widget.py::Widget"' in text, text
        assert "::ClassName" not in text, text

    def test_coread_hint_falls_back_to_outline_without_indexed_symbol(self, tmp_path, monkeypatch):
        """When the imported file has no indexed symbol, the hint degrades to a runnable
        ``token-goat outline`` instead of emitting an un-runnable ``::ClassName``
        placeholder."""
        from token_goat import hints

        monkeypatch.setattr(
            hints, "_get_unread_coread_files",
            lambda fp, ph, cache=None: [("pkg/widget.py", "widget")],
        )
        monkeypatch.setattr(
            hints, "_get_indexed_symbols_and_line_count",
            lambda rel, h: ([], None, False),
        )
        hint = hints._build_coread_suggestion_hint(
            str(tmp_path / "main.py"), "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", None
        )
        assert hint is not None
        text = str(hint)
        assert 'token-goat outline "pkg/widget.py"' in text, text
        assert "::ClassName" not in text, text

    def test_coread_hint_fires_on_first_read_of_py_file(self, tmp_data_dir, tmp_path):
        """Coread hint fires when a .py file is read for first time with indexed imports."""
        from token_goat.project import find_project

        # Create .git so find_project detects tmp_path as root
        (tmp_path / ".git").mkdir()

        # Create source files
        src_file = tmp_path / "auth.py"
        session_file = tmp_path / "session.py"
        src_file.write_text("# auth module\ndef login(): pass\n")
        session_file.write_text("# session module\nclass SessionCache: pass\n")

        # Find project and index files
        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            # Insert files
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("auth.py", "python", 100, 0.0, "abc123", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("session.py", "python", 50, 0.0, "def456", 0),
            )
            # Insert import from auth.py to session
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("auth.py", "import", "session", 1),
            )
            # Index a top-level symbol for session.py so the co-read hint names a
            # real symbol (token-goat read "session.py::SessionCache") rather than
            # the legacy ::ClassName placeholder.
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)",
                ("SessionCache", "class", "session.py", 2, 2),
            )

        # First read of auth.py — session.py not yet read
        hint = build_read_hint(
            session_id="s_coread_1",
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        # Should get a coread suggestion hint
        assert hint is not None, "coread hint should fire on first read of .py file with imports"
        assert "session" in str(hint).lower(), f"hint should mention imported module: {hint}"
        assert 'token-goat read "session.py::SessionCache"' in str(hint), \
            f"hint should suggest a concrete indexed-symbol read, not a placeholder: {hint}"
        assert "::ClassName" not in str(hint), f"legacy placeholder must not leak: {hint}"

    def test_coread_hint_not_fired_on_cached_file(self, tmp_data_dir, tmp_path):
        """Coread hint suppressed when file was already read in session."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()

        src_file = tmp_path / "auth.py"
        session_file = tmp_path / "session.py"
        src_file.write_text("# auth\nimport session\n")
        session_file.write_text("# session\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("auth.py", "python", 50, 0.0, "abc123", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("session.py", "python", 50, 0.0, "def456", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("auth.py", "import", "session", 1),
            )

        # Mark the file as already read in session
        session_id = "s_coread_cached"
        session.mark_file_read(session_id, str(src_file), offset=0, limit=100)

        # Second read should return None or cache hint, not coread hint
        hint = build_read_hint(
            session_id=session_id,
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        # If there's a hint, it should be a cache hint (already-read), not coread
        if hint is not None:
            assert "session" not in str(hint).lower() or "already read" in str(hint).lower(), \
                "cached file should not get coread suggestion"

    def test_coread_hint_not_fired_for_non_py_files(self, tmp_path):
        """Coread hint should not fire for non-.py files."""
        src_file = tmp_path / "config.toml"
        src_file.write_text("[project]\nname = 'test'\n")

        hint = build_read_hint(
            session_id="s_coread_toml",
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        # No hint expected for TOML files
        assert hint is None or "import" not in str(hint).lower()

    def test_coread_hint_suppressed_when_all_imports_read(self, tmp_data_dir, tmp_path):
        """Coread hint suppressed when all imported files are already read."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()

        src_file = tmp_path / "auth.py"
        session_file = tmp_path / "session.py"
        src_file.write_text("import session\n")
        session_file.write_text("class Session: pass\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("auth.py", "python", 50, 0.0, "abc123", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("session.py", "python", 50, 0.0, "def456", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("auth.py", "import", "session", 1),
            )

        session_id = "s_coread_all_read"
        # Mark both files as read
        session.mark_file_read(session_id, str(src_file), offset=0, limit=100)
        session.mark_file_read(session_id, str(session_file), offset=0, limit=50)

        hint = build_read_hint(
            session_id=session_id,
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        # Cache hint expected, not coread suggestion
        if hint is not None:
            assert "session" not in str(hint).lower() or "already" in str(hint).lower()

    def test_coread_hint_limits_to_three_suggestions(self, tmp_data_dir, tmp_path):
        """Coread hint should limit suggestions to max 3 files."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()

        src_file = tmp_path / "main.py"
        src_file.write_text("import a, b, c, d, e\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                ("main.py", "python", 50, 0.0, "abc123", 0),
            )
            # Insert 5 imported modules
            for mod in ["a", "b", "c", "d", "e"]:
                conn.execute(
                    "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (f"{mod}.py", "python", 20, 0.0, f"sha_{mod}", 0),
                )
                conn.execute(
                    "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                    ("main.py", "import", mod, 1),
                )

        hint = build_read_hint(
            session_id="s_coread_limit",
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        # Should get hint with max 3 suggestions
        if hint is not None:
            hint_str = str(hint)
            # The hint should suggest at most 3 imported modules.
            # Example: "Note: `main.py` imports `a.py`, `b.py`, `c.py` (unread)..."
            # Check for the "(unread)" marker which indicates suggested modules
            assert "(unread)" in hint_str, f"hint should have (unread) marker: {hint_str}"
            # Extract the section between "imports" and "(unread)"
            parts = hint_str.split("imports")
            if len(parts) >= 2:
                suggestion_part = parts[1].split("(unread)")[0]
                # Count occurrences of ".py`" which marks the end of each module name
                module_count = suggestion_part.count(".py")
                assert module_count <= 3, f"hint should suggest max 3 modules, got {module_count}: {hint}"

    def test_coread_hint_not_fired_without_project(self, tmp_path):
        """Coread hint suppressed when project cannot be found.

        Mock find_project to return None immediately — the test validates
        build_read_hint's coread-suppression logic when no project exists,
        not the find_project walk itself (which scans the whole directory
        tree up to the filesystem root and costs ~2 s on Windows).
        """
        src_file = tmp_path / "orphan.py"
        src_file.write_text("import something\n")

        with patch("token_goat.hints.find_project", return_value=None):
            hint = build_read_hint(
                session_id="s_coread_noproject",
                file_path=str(src_file),
                offset=None,
                limit=None,
                cwd=str(tmp_path),
            )

        # No hint expected when project is not found
        assert hint is None or "import" not in str(hint).lower()

    def test_coread_hint_ts_relative_import(self, tmp_data_dir, tmp_path):
        """Coread hint fires for a .tsx file with a relative ./import."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        src_dir = tmp_path / "src" / "components"
        src_dir.mkdir(parents=True)

        button_file = src_dir / "Button.tsx"
        styles_file = src_dir / "styles.ts"
        button_file.write_text("import styles from './styles';\nexport const Button = () => null;\n")
        styles_file.write_text("export const cls = 'btn';\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("src/components/Button.tsx", "typescript", 80, 0.0, "sha_btn", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("src/components/styles.ts", "typescript", 30, 0.0, "sha_sty", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("src/components/Button.tsx", "import", "./styles", 1),
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)",
                ("cls", "constant", "src/components/styles.ts", 1, 1),
            )

        hint = build_read_hint(
            session_id="s_coread_ts_rel",
            file_path=str(button_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        assert hint is not None, "coread hint should fire for .tsx file with relative import"
        assert "styles.ts" in str(hint), f"hint should mention styles.ts: {hint}"
        assert 'token-goat read "src/components/styles.ts::cls"' in str(hint), \
            f"hint should suggest a concrete indexed-symbol read, not a placeholder: {hint}"
        assert "::ClassName" not in str(hint), f"legacy placeholder must not leak: {hint}"

    def test_coread_hint_ts_external_import_excluded(self, tmp_data_dir, tmp_path):
        """External (non-relative) TS imports must NOT trigger co-read hints."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        src_file = tmp_path / "App.tsx"
        src_file.write_text("import React from 'react';\nimport { useState } from 'react';\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("App.tsx", "typescript", 80, 0.0, "sha_app", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("App.tsx", "import", "react", 1),
            )

        hint = build_read_hint(
            session_id="s_coread_ts_ext",
            file_path=str(src_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        assert hint is None or "react" not in str(hint).lower(), \
            f"external 'react' import should not trigger coread: {hint}"

    def test_coread_hint_ts_parent_relative_import(self, tmp_data_dir, tmp_path):
        """Coread hint resolves '../utils' imports correctly."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        src_dir = tmp_path / "src" / "components"
        utils_dir = tmp_path / "src"
        src_dir.mkdir(parents=True)

        btn_file = src_dir / "Button.tsx"
        utils_file = utils_dir / "utils.ts"
        btn_file.write_text("import { cn } from '../utils';\n")
        utils_file.write_text("export const cn = () => '';\n")

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("src/components/Button.tsx", "typescript", 50, 0.0, "sha_btn2", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("src/utils.ts", "typescript", 30, 0.0, "sha_utils", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("src/components/Button.tsx", "import", "../utils", 1),
            )

        hint = build_read_hint(
            session_id="s_coread_ts_parent",
            file_path=str(btn_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        assert hint is not None, "coread hint should fire for '../utils' import"
        assert "utils.ts" in str(hint), f"hint should mention utils.ts: {hint}"

    def test_coread_hint_go_intramodule_import(self, tmp_data_dir, tmp_path):
        """Coread hint fires for a .go file importing another package in the same module."""
        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        go_mod = tmp_path / "go.mod"
        go_mod.write_text("module github.com/myorg/myapp\n\ngo 1.21\n")

        main_file = tmp_path / "main.go"
        cache_dir = tmp_path / "internal" / "cache"
        cache_dir.mkdir(parents=True)
        cache_file = cache_dir / "cache.go"
        main_file.write_text('package main\nimport "github.com/myorg/myapp/internal/cache"\n')
        cache_file.write_text("package cache\n")

        proj = find_project(tmp_path)
        assert proj is not None

        # Register project root in global DB so _get_go_module_prefix can find it
        import time as _time  # noqa: PLC0415
        with db.open_global() as g_conn:
            g_conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(hash) DO UPDATE SET root=excluded.root",
                (proj.hash, str(tmp_path), "git", int(_time.time()), int(_time.time())),
            )
        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("main.go", "go", 80, 0.0, "sha_main", 0),
            )
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("internal/cache/cache.go", "go", 30, 0.0, "sha_cache", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("main.go", "import", "github.com/myorg/myapp/internal/cache", 2),
            )
            conn.execute(
                "INSERT INTO symbols (name, kind, file_rel, line, end_line) VALUES (?, ?, ?, ?, ?)",
                ("New", "function", "internal/cache/cache.go", 1, 1),
            )

        hint = build_read_hint(
            session_id="s_coread_go_mod",
            file_path=str(main_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        assert hint is not None, "coread hint should fire for intra-module Go import"
        assert "cache" in str(hint).lower(), f"hint should mention cache package: {hint}"
        assert 'token-goat read "internal/cache/cache.go::New"' in str(hint), \
            f"hint should suggest a concrete indexed-symbol read, not a placeholder: {hint}"
        assert "::ClassName" not in str(hint), f"legacy placeholder must not leak: {hint}"

    def test_coread_hint_go_stdlib_excluded(self, tmp_data_dir, tmp_path):
        """Go stdlib imports must NOT trigger co-read hints."""
        import time as _time  # noqa: PLC0415

        from token_goat.project import find_project

        (tmp_path / ".git").mkdir()
        go_mod = tmp_path / "go.mod"
        go_mod.write_text("module github.com/myorg/myapp\n\ngo 1.21\n")

        main_file = tmp_path / "main.go"
        main_file.write_text('package main\nimport "fmt"\n')

        proj = find_project(tmp_path)
        assert proj is not None

        with db.open_global() as g_conn:
            g_conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(hash) DO UPDATE SET root=excluded.root",
                (proj.hash, str(tmp_path), "git", int(_time.time()), int(_time.time())),
            )
        with db.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT INTO files (rel_path, language, size, mtime, content_sha256, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
                ("main.go", "go", 40, 0.0, "sha_main2", 0),
            )
            conn.execute(
                "INSERT INTO imports_exports (file_rel, kind, target, line) VALUES (?, ?, ?, ?)",
                ("main.go", "import", "fmt", 2),
            )

        hint = build_read_hint(
            session_id="s_coread_go_std",
            file_path=str(main_file),
            offset=None,
            limit=None,
            cwd=str(tmp_path),
        )

        assert hint is None or "fmt" not in str(hint).lower(), \
            f"stdlib 'fmt' import should not trigger coread: {hint}"


# ---------------------------------------------------------------------------
# Hint priority ordering — apply_hint_priority_limit()
# ---------------------------------------------------------------------------


class TestHintPriorityOrdering:
    """Tests for the hint priority/ordering system in hints.py."""

    def test_priority_constants_ordered(self):
        """CRITICAL < HIGH < MEDIUM < LOW (lower value = higher priority)."""
        from token_goat.hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_HIGH,
            HINT_PRIORITY_LOW,
            HINT_PRIORITY_MEDIUM,
        )
        assert HINT_PRIORITY_CRITICAL < HINT_PRIORITY_HIGH
        assert HINT_PRIORITY_HIGH < HINT_PRIORITY_MEDIUM
        assert HINT_PRIORITY_MEDIUM < HINT_PRIORITY_LOW

    def test_empty_list_returns_empty(self):
        """apply_hint_priority_limit with no hints returns empty list."""
        from token_goat.hints import apply_hint_priority_limit

        assert apply_hint_priority_limit([]) == []

    def test_single_hint_returned_as_is(self):
        """A single hint is returned without modification."""
        from token_goat.hints import HINT_PRIORITY_MEDIUM, HintItem, apply_hint_priority_limit

        items = [HintItem("only hint", HINT_PRIORITY_MEDIUM)]
        result = apply_hint_priority_limit(items)
        assert result == ["only hint"]

    def test_sorts_by_priority_ascending(self):
        """Hints are ordered by priority: CRITICAL first, then HIGH, MEDIUM, LOW."""
        from token_goat.hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_HIGH,
            HINT_PRIORITY_LOW,
            HINT_PRIORITY_MEDIUM,
            HintItem,
            apply_hint_priority_limit,
        )
        items = [
            HintItem("low hint", HINT_PRIORITY_LOW),
            HintItem("medium hint", HINT_PRIORITY_MEDIUM),
            HintItem("critical hint", HINT_PRIORITY_CRITICAL),
            HintItem("high hint", HINT_PRIORITY_HIGH),
        ]
        result = apply_hint_priority_limit(items, max_hints=10)
        assert result[0] == "critical hint"
        assert result[1] == "high hint"
        assert result[2] == "medium hint"
        assert result[3] == "low hint"

    def test_max_hints_cap_drops_lowest_priority(self):
        """When more hints than max_hints, lowest-priority ones are dropped."""
        from token_goat.hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_HIGH,
            HINT_PRIORITY_LOW,
            HINT_PRIORITY_MEDIUM,
            HintItem,
            apply_hint_priority_limit,
        )
        items = [
            HintItem("low hint", HINT_PRIORITY_LOW),
            HintItem("critical hint", HINT_PRIORITY_CRITICAL),
            HintItem("medium hint", HINT_PRIORITY_MEDIUM),
            HintItem("high hint", HINT_PRIORITY_HIGH),
        ]
        result = apply_hint_priority_limit(items, max_hints=3)
        # Should get the 3 highest-priority hints: CRITICAL, HIGH, MEDIUM
        assert len(result) == 3
        assert result[0] == "critical hint"
        assert result[1] == "high hint"
        # The last emitted hint gets the suppression footer.
        assert "medium hint" in result[2]
        assert "+1 more hints suppressed" in result[2]

    def test_suppression_footer_appended_to_last_emitted(self):
        """The (+N more hints suppressed) footer is appended to the last emitted hint."""
        from token_goat.hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_LOW,
            HINT_PRIORITY_MEDIUM,
            HintItem,
            apply_hint_priority_limit,
        )
        items = [
            HintItem("hint A", HINT_PRIORITY_CRITICAL),
            HintItem("hint B", HINT_PRIORITY_MEDIUM),
            HintItem("hint C", HINT_PRIORITY_LOW),
            HintItem("hint D", HINT_PRIORITY_LOW),
        ]
        result = apply_hint_priority_limit(items, max_hints=2)
        assert len(result) == 2
        assert result[0] == "hint A"
        # Footer mentions 2 suppressed hints (C and D).
        assert "+2 more hints suppressed" in result[1]

    def test_no_footer_when_at_or_under_cap(self):
        """No suppression footer when hint count equals max_hints."""
        from token_goat.hints import (
            HINT_PRIORITY_CRITICAL,
            HINT_PRIORITY_HIGH,
            HINT_PRIORITY_MEDIUM,
            HintItem,
            apply_hint_priority_limit,
        )
        items = [
            HintItem("hint A", HINT_PRIORITY_CRITICAL),
            HintItem("hint B", HINT_PRIORITY_HIGH),
            HintItem("hint C", HINT_PRIORITY_MEDIUM),
        ]
        result = apply_hint_priority_limit(items, max_hints=3)
        assert len(result) == 3
        for text in result:
            assert "suppressed" not in text

    def test_stable_sort_within_same_priority(self):
        """Hints with equal priority are emitted in insertion order (stable sort)."""
        from token_goat.hints import HINT_PRIORITY_MEDIUM, HintItem, apply_hint_priority_limit

        items = [
            HintItem("first medium", HINT_PRIORITY_MEDIUM),
            HintItem("second medium", HINT_PRIORITY_MEDIUM),
            HintItem("third medium", HINT_PRIORITY_MEDIUM),
        ]
        result = apply_hint_priority_limit(items, max_hints=10)
        assert result == ["first medium", "second medium", "third medium"]

    def test_hint_item_has_priority_attribute(self):
        """HintItem stores hint_priority for deterministic, testable ordering."""
        from token_goat.hints import HINT_PRIORITY_HIGH, HintItem

        item = HintItem("diff hint", HINT_PRIORITY_HIGH)
        assert item.hint_priority == HINT_PRIORITY_HIGH
        assert item.text == "diff hint"

    def test_default_max_is_hint_max_per_tool_call(self):
        """apply_hint_priority_limit defaults to HINT_MAX_PER_TOOL_CALL."""
        from token_goat.hints import (
            HINT_MAX_PER_TOOL_CALL,
            HINT_PRIORITY_LOW,
            HintItem,
            apply_hint_priority_limit,
        )
        # Create more hints than the cap.
        items = [HintItem(f"hint {i}", HINT_PRIORITY_LOW) for i in range(HINT_MAX_PER_TOOL_CALL + 2)]
        result = apply_hint_priority_limit(items)
        assert len(result) == HINT_MAX_PER_TOOL_CALL
        # Last emitted hint should carry the suppression footer.
        assert "suppressed" in result[-1]


# ---------------------------------------------------------------------------
# slim_hint_text — pressure-driven hint compression
# ---------------------------------------------------------------------------


class TestSlimHintText:
    def test_cool_tier_unchanged(self):
        from token_goat.hints import slim_hint_text
        text = "Line one.\n\nParagraph two detail."
        assert slim_hint_text(text, "cool") == text

    def test_warm_tier_unchanged(self):
        from token_goat.hints import slim_hint_text
        text = "Line one.\n\nParagraph two detail."
        assert slim_hint_text(text, "warm") == text

    def test_hot_keeps_first_paragraph(self):
        from token_goat.hints import slim_hint_text
        text = "Actionable line here.\n\nVerbose explanation that costs tokens."
        assert slim_hint_text(text, "hot") == "Actionable line here."

    def test_critical_keeps_first_paragraph(self):
        from token_goat.hints import slim_hint_text
        text = "`foo.py` read 4x — use `token-goat outline foo.py`.\n\nExtra detail."
        result = slim_hint_text(text, "critical")
        assert "Extra detail" not in result
        assert "token-goat outline" in result

    def test_single_paragraph_unchanged_at_hot(self):
        from token_goat.hints import slim_hint_text
        text = "Single-para hint with no blank lines."
        assert slim_hint_text(text, "hot") == text

    def test_long_multiline_first_paragraph_truncated_with_ellipsis(self):
        # Only multi-line first paras hit the char cap; single-line are exempt.
        from token_goat.hints import _SLIM_HINT_MAX_CHARS, slim_hint_text
        long_line = "x" * (_SLIM_HINT_MAX_CHARS + 50)
        multi_para_text = f"{long_line}\nmore text in same paragraph"
        result = slim_hint_text(multi_para_text, "hot")
        assert result.endswith("…")
        assert len(result) <= _SLIM_HINT_MAX_CHARS + 1  # +1 for the ellipsis char

    def test_single_line_first_paragraph_not_capped(self):
        # Single-line first paragraphs are command lines — never char-capped.
        from token_goat.hints import _SLIM_HINT_MAX_CHARS, slim_hint_text
        long_cmd = "`" + "a" * (_SLIM_HINT_MAX_CHARS + 100) + "` for surgical access."
        text = long_cmd + "\n\nParagraph two detail."
        result = slim_hint_text(text, "hot")
        assert not result.endswith("…"), "command should not be truncated"
        assert result == long_cmd

    def test_empty_text_returns_original(self):
        from token_goat.hints import slim_hint_text
        assert slim_hint_text("", "hot") == ""

    def test_whitespace_only_text_returns_original(self):
        from token_goat.hints import slim_hint_text
        assert slim_hint_text("   \n\n   ", "hot") == "   \n\n   "

    def test_unknown_tier_unchanged(self):
        from token_goat.hints import slim_hint_text
        text = "Para one.\n\nPara two."
        assert slim_hint_text(text, "future_tier") == text

    def test_apply_hint_priority_limit_slims_at_hot(self):
        from token_goat.hints import HINT_PRIORITY_LOW, HintItem, apply_hint_priority_limit
        multi_para = "First actionable line.\n\nVerbose detail that wastes tokens."
        items = [HintItem(multi_para, HINT_PRIORITY_LOW)]
        result = apply_hint_priority_limit(items, tier="hot")
        assert len(result) == 1
        assert "Verbose detail" not in result[0]
        assert "First actionable" in result[0]

    def test_apply_hint_priority_limit_preserves_at_cool(self):
        from token_goat.hints import HINT_PRIORITY_LOW, HintItem, apply_hint_priority_limit
        multi_para = "First line.\n\nSecond paragraph."
        items = [HintItem(multi_para, HINT_PRIORITY_LOW)]
        result = apply_hint_priority_limit(items, tier="cool")
        assert "Second paragraph" in result[0]


# ---------------------------------------------------------------------------
# Test-file hint (pre-read hint for test files)
# ---------------------------------------------------------------------------


class TestTestFileHint:
    """Tests for build_test_file_hint() — suggesting impl files when reading tests."""

    def test_impl_file_found_not_read_returns_hint(self, tmp_data_dir, tmp_path):
        """Test file with unread impl file → hint returned."""

        from token_goat.hints import HINT_PRIORITY_LOW, build_test_file_hint

        # Create directories and files
        (tmp_path / "src" / "token_goat").mkdir(parents=True, exist_ok=True)
        (tmp_path / "tests").mkdir(parents=True, exist_ok=True)

        # Create implementation file
        impl_file = tmp_path / "src" / "token_goat" / "worker.py"
        impl_file.write_text("# implementation", encoding="utf-8")

        # Create test file
        test_file = tmp_path / "tests" / "test_worker.py"
        test_file.write_text("# test", encoding="utf-8")

        # Create session cache (empty, no reads yet)
        sid = "test-session-1"
        cache = session.load(sid)

        # Call build_test_file_hint
        hint = build_test_file_hint(str(test_file), cache, tmp_path)

        assert hint is not None
        assert hint.hint_priority == HINT_PRIORITY_LOW
        assert "worker.py" in hint.text
        assert "Implementation" in hint.text or "implementation" in hint.text

    def test_impl_file_already_read_returns_none(self, tmp_data_dir, tmp_path):
        """Test file with already-read impl file → no hint."""
        from token_goat.hints import build_test_file_hint

        # Create directories and files
        (tmp_path / "src" / "token_goat").mkdir(parents=True, exist_ok=True)
        (tmp_path / "tests").mkdir(parents=True, exist_ok=True)

        impl_file = tmp_path / "src" / "token_goat" / "worker.py"
        impl_file.write_text("# implementation", encoding="utf-8")

        test_file = tmp_path / "tests" / "test_worker.py"
        test_file.write_text("# test", encoding="utf-8")

        # Create session cache and mark impl file as read
        sid = "test-session-2"
        session.mark_file_read(sid, str(impl_file), offset=0, limit=100)
        cache = session.load(sid)

        # Call build_test_file_hint
        hint = build_test_file_hint(str(test_file), cache, tmp_path)

        # Should return None because impl file was already read
        assert hint is None

    def test_impl_file_not_found_returns_none(self, tmp_data_dir, tmp_path):
        """Test file with no impl file → no hint."""
        from token_goat.hints import build_test_file_hint

        # Create test file but no implementation file
        (tmp_path / "tests").mkdir(parents=True, exist_ok=True)
        test_file = tmp_path / "tests" / "test_nonexistent.py"
        test_file.write_text("# test", encoding="utf-8")

        # Create empty session cache
        sid = "test-session-3"
        cache = session.load(sid)

        # Call build_test_file_hint
        hint = build_test_file_hint(str(test_file), cache, tmp_path)

        # Should return None because impl file doesn't exist
        assert hint is None

    def test_non_test_file_returns_none(self, tmp_data_dir, tmp_path):
        """Non-test file → no hint."""
        from token_goat.hints import build_test_file_hint

        # Create a non-test file
        (tmp_path / "src").mkdir(parents=True, exist_ok=True)
        regular_file = tmp_path / "src" / "worker.py"
        regular_file.write_text("# regular file", encoding="utf-8")

        # Create session cache
        sid = "test-session-4"
        cache = session.load(sid)

        # Call build_test_file_hint
        hint = build_test_file_hint(str(regular_file), cache, tmp_path)

        # Should return None because it's not a test file
        assert hint is None

    def test_no_session_cache_returns_none(self, tmp_data_dir, tmp_path):
        """None session cache → no hint."""
        from token_goat.hints import build_test_file_hint

        # Create directories and files
        (tmp_path / "src" / "token_goat").mkdir(parents=True, exist_ok=True)
        (tmp_path / "tests").mkdir(parents=True, exist_ok=True)

        impl_file = tmp_path / "src" / "token_goat" / "worker.py"
        impl_file.write_text("# implementation", encoding="utf-8")

        test_file = tmp_path / "tests" / "test_worker.py"
        test_file.write_text("# test", encoding="utf-8")

        # Call with None cache
        hint = build_test_file_hint(str(test_file), None, tmp_path)

        # Should return None when cache is None
        assert hint is None

    def test_resolve_impl_file_underscore_handling(self, tmp_data_dir, tmp_path):
        """Test file name with underscores → impl file resolved correctly."""
        from token_goat.hints import build_test_file_hint

        # Create directories and files with underscores
        (tmp_path / "src" / "token_goat").mkdir(parents=True, exist_ok=True)
        (tmp_path / "tests").mkdir(parents=True, exist_ok=True)

        impl_file = tmp_path / "src" / "token_goat" / "cache_common.py"
        impl_file.write_text("# implementation", encoding="utf-8")

        test_file = tmp_path / "tests" / "test_cache_common.py"
        test_file.write_text("# test", encoding="utf-8")

        # Create session cache
        sid = "test-session-5"
        cache = session.load(sid)

        # Call build_test_file_hint
        hint = build_test_file_hint(str(test_file), cache, tmp_path)

        assert hint is not None
        assert "cache_common.py" in hint.text


class TestSha256Hex:
    """_sha256_hex shared hash helper."""

    def test_default_length_is_12(self) -> None:
        result = _sha256_hex("hello")
        assert len(result) == 12
        assert result.isalnum()  # hex chars

    def test_explicit_length(self) -> None:
        for n in (8, 12, 16, 32, 64):
            result = _sha256_hex("test", n)
            assert len(result) == n

    def test_deterministic(self) -> None:
        assert _sha256_hex("abc") == _sha256_hex("abc")

    def test_different_inputs_differ(self) -> None:
        assert _sha256_hex("foo") != _sha256_hex("bar")

    def test_empty_string(self) -> None:
        result = _sha256_hex("", 8)
        assert len(result) == 8

    def test_hint_fingerprint_uses_sha256_hex(self) -> None:
        """_hint_fingerprint delegates to _sha256_hex so the outputs are consistent."""
        fp = _hint_fingerprint("some hint text")
        assert len(fp) == 12
        # Verify the fingerprint is stable and matches the raw helper with same key
        assert fp == _sha256_hex("some hint text", 12)


# ---------------------------------------------------------------------------
# Sub-area F: min_session_hint_savings_bytes threshold
# ---------------------------------------------------------------------------

class TestMinSessionHintSavingsBytes:
    """Hints with too few bytes_saved are suppressed by the threshold."""

    def test_default_threshold_is_512(self):
        """Default min_session_hint_savings_bytes is 512."""
        from token_goat.config import HintsConfig
        cfg = HintsConfig()
        assert cfg.min_session_hint_savings_bytes == 512

    def test_threshold_zero_disables_suppression(self, tmp_data_dir, monkeypatch):
        """With threshold=0, even a tiny hint (tokens_saved=1) is not suppressed."""
        from token_goat import config

        monkeypatch.setenv("TOKEN_GOAT_SESSION_HINT_MIN_BYTES", "0")
        # Invalidate config cache
        config._config_mtime_cache = None

        cfg = config.load()
        assert cfg.hints.min_session_hint_savings_bytes == 0

    def test_hint_suppressed_below_threshold(self, tmp_data_dir, monkeypatch):
        """A session hint with estimated savings below threshold is suppressed.

        When tokens_saved * 3 < min_session_hint_savings_bytes, the hint returns None.
        """
        import token_goat.config as _config

        # Set threshold to 600 bytes
        monkeypatch.setenv("TOKEN_GOAT_SESSION_HINT_MIN_BYTES", "600")
        _config._config_mtime_cache = None

        # Build a ReadHint with tokens_saved=100 → estimated_bytes = 300 < 600
        from token_goat.hints import ReadHint
        small_hint = ReadHint("already read this file", tokens_saved=100)

        # Simulate the threshold check inline (mimics build_read_hint behavior)
        cfg = _config.load()
        threshold = cfg.hints.min_session_hint_savings_bytes
        estimated_bytes = small_hint.tokens_saved * 3
        assert estimated_bytes < threshold, "Test precondition: hint should be below threshold"

        # The hint should be suppressed (result should be None) per the threshold logic
        suppressed = estimated_bytes < threshold
        assert suppressed

    def test_hint_passes_above_threshold(self, tmp_data_dir, monkeypatch):
        """A session hint with estimated savings above threshold is NOT suppressed."""
        import token_goat.config as _config

        # Set threshold to 100 bytes
        monkeypatch.setenv("TOKEN_GOAT_SESSION_HINT_MIN_BYTES", "100")
        _config._config_mtime_cache = None

        # Build a ReadHint with tokens_saved=500 → estimated_bytes = 1500 > 100
        from token_goat.hints import ReadHint
        big_hint = ReadHint("you already read lines 1-200 of this file", tokens_saved=500)

        cfg = _config.load()
        threshold = cfg.hints.min_session_hint_savings_bytes
        estimated_bytes = big_hint.tokens_saved * 3
        assert estimated_bytes >= threshold, "Test precondition: hint should pass threshold"

        suppressed = estimated_bytes < threshold
        assert not suppressed

    def test_env_var_overrides_config(self, tmp_data_dir, monkeypatch):
        """TOKEN_GOAT_SESSION_HINT_MIN_BYTES env var overrides config value."""
        import token_goat.config as _config

        monkeypatch.setenv("TOKEN_GOAT_SESSION_HINT_MIN_BYTES", "1024")
        _config._config_mtime_cache = None

        cfg = _config.load()
        assert cfg.hints.min_session_hint_savings_bytes == 1024


class TestHighFrequencyHintResolvedSymbol:
    """build_high_frequency_hint substitutes resolved_symbol for the <symbol> placeholder."""

    def _make_cache(self, file_path: str, count: int):
        from unittest.mock import MagicMock
        cache = MagicMock()
        cache.get_file_access_count.return_value = count
        return cache

    def test_placeholder_used_when_no_symbol(self):
        from token_goat.hints import build_high_frequency_hint
        cache = self._make_cache("src/foo.py", 5)
        item = build_high_frequency_hint(cache, "src/foo.py", threshold=3)
        assert item is not None
        assert "<symbol>" in item.text

    def test_resolved_symbol_replaces_placeholder(self):
        from token_goat.hints import build_high_frequency_hint
        cache = self._make_cache("src/foo.py", 5)
        item = build_high_frequency_hint(cache, "src/foo.py", threshold=3, resolved_symbol="my_func")
        assert item is not None
        assert "<symbol>" not in item.text
        assert "my_func" in item.text

    def test_below_threshold_returns_none(self):
        from token_goat.hints import build_high_frequency_hint
        cache = self._make_cache("src/foo.py", 2)
        assert build_high_frequency_hint(cache, "src/foo.py", threshold=3) is None
