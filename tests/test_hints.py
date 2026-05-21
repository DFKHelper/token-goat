"""Tests for hints.build_read_hint() — all hint-generation cases."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

from token_goat import db, session
from token_goat.hints import (
    LARGE_FILE_LINE_THRESHOLD,
    STALE_READ_AGE_SECONDS,
    _est_tokens_from_chars,
    _est_tokens_from_lines,
    _get_indexed_symbols_and_line_count,
    _line_count,
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
        assert "cached" in hint
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
        assert "cached" in hint


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
        session.mark_file_read(sid, path, offset=0, limit=200)
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
        # Sleep a hair so timestamps differ even on coarse clocks.
        time.sleep(0.01)
        session.mark_file_read(sid, path, offset=0, limit=200)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is not None
        assert "cached" in hint

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
        assert "cached" in hint

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
        assert "cached" in hint

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
        assert "cached" in hint


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
        assert "cached" in hint
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
    """Line-range dedup hints are suppressed once read_count reaches the threshold.

    A file read 5+ times is a "working file" — the agent is clearly iterating
    on it and the hint isn't changing behaviour. Suppressing it saves tokens.
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
        assert "cached" in hint

    def test_read_count_5_returns_none(self, tmp_data_dir):
        """read_count=5 hits the threshold — line-range hint suppressed."""
        sid, path = "s_rc5", "C:/proj/rc5.py"
        self._make_entry_with_read_count(sid, path, 5)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is None

    def test_read_count_10_returns_none(self, tmp_data_dir):
        """read_count=10 still suppressed — threshold applies at all higher counts."""
        sid, path = "s_rc10", "C:/proj/rc10.py"
        self._make_entry_with_read_count(sid, path, 10)

        hint = build_read_hint(
            session_id=sid, file_path=path, offset=0, limit=200, cwd=None,
        )
        assert hint is None

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
        assert "cached" in hint

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
