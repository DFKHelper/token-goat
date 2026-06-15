"""Tests for miss-pattern learning: record_miss / get_miss_count / reset_miss."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat import db as tg_db

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fresh_global_db(tmp_path: Path) -> Path:
    """Return a path inside *tmp_path* that becomes the global DB for the test."""
    return tmp_path / "global.db"


# ---------------------------------------------------------------------------
# Unit tests for db-layer functions
# ---------------------------------------------------------------------------

class TestMissCounter:
    """record_miss / get_miss_count / reset_miss operate on the global DB."""

    def test_miss_count_increments_across_calls(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            tg_db.record_miss("mySymbol", "src/foo.py")
            assert tg_db.get_miss_count("mySymbol", "src/foo.py") == 1
            tg_db.record_miss("mySymbol", "src/foo.py")
            assert tg_db.get_miss_count("mySymbol", "src/foo.py") == 2
            tg_db.record_miss("mySymbol", "src/foo.py")
            assert tg_db.get_miss_count("mySymbol", "src/foo.py") == 3

    def test_get_miss_count_returns_zero_for_unknown_needle(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            assert tg_db.get_miss_count("neverSearched", "") == 0

    def test_reset_clears_counter_to_zero(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            tg_db.record_miss("targetFunc", "src/bar.py")
            tg_db.record_miss("targetFunc", "src/bar.py")
            assert tg_db.get_miss_count("targetFunc", "src/bar.py") == 2
            tg_db.reset_miss("targetFunc", "src/bar.py")
            assert tg_db.get_miss_count("targetFunc", "src/bar.py") == 0

    def test_different_needle_file_hint_combos_tracked_independently(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            tg_db.record_miss("alpha", "src/a.py")
            tg_db.record_miss("alpha", "src/a.py")
            tg_db.record_miss("beta", "src/b.py")
            # alpha has 2 misses, beta has 1 — they must not interfere
            assert tg_db.get_miss_count("alpha", "src/a.py") == 2
            assert tg_db.get_miss_count("beta", "src/b.py") == 1
            # same needle, different file_hint — separate row
            tg_db.record_miss("alpha", "src/b.py")
            assert tg_db.get_miss_count("alpha", "src/b.py") == 1
            assert tg_db.get_miss_count("alpha", "src/a.py") == 2

    def test_reset_does_not_affect_sibling_rows(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            tg_db.record_miss("shared", "file1.py")
            tg_db.record_miss("shared", "file2.py")
            tg_db.reset_miss("shared", "file1.py")
            assert tg_db.get_miss_count("shared", "file1.py") == 0
            assert tg_db.get_miss_count("shared", "file2.py") == 1

    def test_last_miss_epoch_updated_on_each_record(self, tmp_path: Path) -> None:
        with patch("token_goat.paths.global_db_path", return_value=_fresh_global_db(tmp_path)):
            before = time.time()
            tg_db.record_miss("ts_needle", "")
            tg_db.record_miss("ts_needle", "")
            after = time.time()
            with tg_db.open_global_readonly() as conn:
                row = conn.execute(
                    "SELECT last_miss_epoch FROM miss_patterns WHERE needle = ? AND file_hint = ?",
                    ("ts_needle", ""),
                ).fetchone()
            assert row is not None
            assert before <= row["last_miss_epoch"] <= after


# ---------------------------------------------------------------------------
# Threshold logic tests: below vs at/above 3 misses
# ---------------------------------------------------------------------------

class TestMissHintThreshold:
    """Hint condition is count >= 3; verify the boundary directly via the db layer."""

    def test_hint_condition_false_at_one_miss(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        tg_db.record_miss("fn_one", "src/a.py")
        assert tg_db.get_miss_count("fn_one", "src/a.py") < 3

    def test_hint_condition_false_at_two_misses(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        tg_db.record_miss("fn_two", "src/b.py")
        tg_db.record_miss("fn_two", "src/b.py")
        assert tg_db.get_miss_count("fn_two", "src/b.py") < 3

    def test_hint_condition_true_at_three_misses(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        tg_db.record_miss("fn_three", "src/c.py")
        tg_db.record_miss("fn_three", "src/c.py")
        tg_db.record_miss("fn_three", "src/c.py")
        assert tg_db.get_miss_count("fn_three", "src/c.py") >= 3

    def test_hint_condition_true_above_threshold(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        for _ in range(5):
            tg_db.record_miss("fn_five", "src/d.py")
        assert tg_db.get_miss_count("fn_five", "src/d.py") >= 3

    def test_reset_drops_count_below_threshold(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        needle, hint = "eventually_found", "src/found.py"
        for _ in range(3):
            tg_db.record_miss(needle, hint)
        assert tg_db.get_miss_count(needle, hint) >= 3
        tg_db.reset_miss(needle, hint)
        assert tg_db.get_miss_count(needle, hint) < 3

    def test_file_miss_and_symbol_miss_tracked_independently(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """File-not-found uses file_hint='' ; symbol-not-found uses rel_path as file_hint."""
        monkeypatch.setattr("token_goat.paths.global_db_path", lambda: _fresh_global_db(tmp_path))
        tg_db.record_miss("missing_file.py", "")
        tg_db.record_miss("missingFunc", "src/present.py")
        assert tg_db.get_miss_count("missing_file.py", "") == 1
        assert tg_db.get_miss_count("missingFunc", "src/present.py") == 1
        assert tg_db.get_miss_count("missing_file.py", "src/present.py") == 0
        assert tg_db.get_miss_count("missingFunc", "") == 0
