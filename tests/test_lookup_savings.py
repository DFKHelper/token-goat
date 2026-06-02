"""Tests for lookup-command bytes_saved accounting.

Covers:
- _sum_file_sizes helper (DB query correctness)
- _total_project_bytes helper (sum-all path)
- _record_lookup_stat accepts and stores bytes_saved
- By-kind grouping in _render_by_kind_section
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from unittest.mock import MagicMock, patch

import pytest

from token_goat.render.ansi import strip_ansi
from token_goat.render.stats_renderer import (
    _kind_group_label,
    _render_by_kind_section,
)
from token_goat.render.types import KindStat, StatsData, TotalStats

# ---------------------------------------------------------------------------
# _kind_group_label
# ---------------------------------------------------------------------------

class TestKindGroupLabel:
    """_kind_group_label maps kinds to their category strings."""

    @pytest.mark.parametrize("kind,expected", [
        ("read_replacement", "Read savings"),
        ("section_replacement", "Read savings"),
        ("symbol_read", "Read savings"),
        ("stub_view", "Read savings"),
        ("outline", "Read savings"),
        ("exports", "Read savings"),
        ("symbol_lookup", "Lookups"),
        ("semantic_search", "Lookups"),
        ("map_lookup", "Lookups"),
        ("image_shrink", "Images"),
        ("gdrive_image", "Images"),
        ("session_hint", "Hints"),
        ("read_dedup_hint", "Hints"),
        ("bash_dedup_hint", "Bash"),
        ("bash_output_cached", "Bash"),
        ("bash_compress:pytest", "Bash"),
        ("bash_compress:npm", "Bash"),
        ("web_dedup_hint", "Web"),
        ("web_output_cached", "Web"),
        ("compact_manifest", "Compact / Skills"),
        ("skill_body_recall", "Compact / Skills"),
        ("resume_packet", "Compact / Skills"),
        ("totally_unknown_kind", "Other"),
        ("", "Other"),
    ])
    def test_group_label(self, kind, expected):
        assert _kind_group_label(kind) == expected, (
            f"kind={kind!r}: expected {expected!r}, got {_kind_group_label(kind)!r}"
        )


# ---------------------------------------------------------------------------
# _render_by_kind_section with grouping
# ---------------------------------------------------------------------------

def _make_grouped_stats() -> StatsData:
    """Return a StatsData with kinds spread across multiple groups."""
    return StatsData(
        period_start=None,  # type: ignore[arg-type]
        period_end=None,    # type: ignore[arg-type]
        totals=TotalStats(events=10, bytes=15_000, tokens=3_000),
        by_kind=[
            KindStat(kind="read_replacement",  bytes=5_000, tokens=1_250, events=3),
            KindStat(kind="symbol_lookup",     bytes=3_000, tokens=750,   events=5),
            KindStat(kind="image_shrink",      bytes=4_000, tokens=0,     events=2, bytes_mode_only=True),
            KindStat(kind="compact_manifest",  bytes=3_000, tokens=750,   events=2),
        ],
        by_day=[],
        by_project=[],
    )


class TestByKindGrouping:
    """The by-kind section renders group separator headers before each category."""

    def test_group_labels_present(self):
        """Group headings appear in the rendered output."""
        out = strip_ansi("\n".join(_render_by_kind_section(_make_grouped_stats())))
        assert "Read savings" in out
        assert "Lookups" in out
        assert "Images" in out
        assert "Compact / Skills" in out

    def test_group_order_canonical(self):
        """Read savings group appears before Lookups which appears before Images."""
        out = strip_ansi("\n".join(_render_by_kind_section(_make_grouped_stats())))
        assert out.index("Read savings") < out.index("Lookups")
        assert out.index("Lookups") < out.index("Images")
        assert out.index("Images") < out.index("Compact / Skills")

    def test_kind_appears_after_its_group_header(self):
        """Each kind name appears after its own group header, not before it."""
        out = strip_ansi("\n".join(_render_by_kind_section(_make_grouped_stats())))
        assert out.index("read_replacement") > out.index("Read savings")
        assert out.index("symbol_lookup") > out.index("Lookups")
        assert out.index("image_shrink") > out.index("Images")
        assert out.index("compact_manifest") > out.index("Compact / Skills")

    def test_empty_groups_omitted(self):
        """Groups with no data must not produce a header in the output."""
        out = strip_ansi("\n".join(_render_by_kind_section(_make_grouped_stats())))
        # The test data has no Bash, Web, or Hints entries.
        assert "Bash" not in out
        assert "Web" not in out
        assert "Hints" not in out

    def test_by_kind_section_still_renders_kind_names(self):
        """All four kind names must still appear in the output."""
        out = strip_ansi("\n".join(_render_by_kind_section(_make_grouped_stats())))
        for kind in ("read_replacement", "symbol_lookup", "image_shrink", "compact_manifest"):
            assert kind in out, f"{kind!r} missing from rendered output"

    def test_unknown_kind_falls_into_other_group(self):
        """A kind not in any static group falls into the 'Other' category."""
        stats = _make_grouped_stats()
        stats.by_kind = [
            KindStat(kind="totally_new_kind", bytes=1_000, tokens=250, events=1),
        ]
        out = strip_ansi("\n".join(_render_by_kind_section(stats)))
        assert "Other" in out
        assert "totally_new_kind" in out


# ---------------------------------------------------------------------------
# _sum_file_sizes helper
# ---------------------------------------------------------------------------

class TestSumFileSizes:
    """_sum_file_sizes returns the sum of file sizes from the project DB."""

    def _make_db(self) -> sqlite3.Connection:
        """Return an in-memory SQLite connection with a minimal files table."""
        conn = sqlite3.connect(":memory:")
        conn.execute(
            "CREATE TABLE files (rel_path TEXT PRIMARY KEY, size INTEGER NOT NULL,"
            " language TEXT, mtime REAL, content_sha256 TEXT, indexed_at INTEGER)"
        )
        conn.executemany(
            "INSERT INTO files (rel_path, size, language, mtime, content_sha256, indexed_at) VALUES (?,?,?,?,?,?)",
            [
                ("src/a.py", 1_000, "python", 0.0, "abc", 0),
                ("src/b.py", 2_000, "python", 0.0, "def", 0),
                ("src/c.py", 3_000, "python", 0.0, "ghi", 0),
            ],
        )
        conn.commit()
        conn.row_factory = sqlite3.Row
        return conn

    def test_returns_sum_for_requested_rels(self):
        """Returns sum of sizes for exactly the requested file_rels."""
        from token_goat.cli import _sum_file_sizes

        conn = self._make_db()

        @contextmanager
        def _fake_open(ph: str):
            yield conn

        with patch("token_goat.cli._lazy_import") as mock_lazy:
            mock_db = MagicMock()
            mock_db.open_project_readonly = _fake_open
            mock_lazy.return_value = mock_db
            result = _sum_file_sizes("fakehash", ["src/a.py", "src/b.py"])

        assert result == 3_000

    def test_deduplicates_file_rels(self):
        """Duplicate file_rels are counted once."""
        from token_goat.cli import _sum_file_sizes

        conn = self._make_db()

        @contextmanager
        def _fake_open(ph: str):
            yield conn

        with patch("token_goat.cli._lazy_import") as mock_lazy:
            mock_db = MagicMock()
            mock_db.open_project_readonly = _fake_open
            mock_lazy.return_value = mock_db
            result = _sum_file_sizes("fakehash", ["src/a.py", "src/a.py", "src/b.py"])

        assert result == 3_000

    def test_returns_zero_for_empty_list(self):
        """Empty file_rels returns 0 without touching the DB."""
        from token_goat.cli import _sum_file_sizes
        result = _sum_file_sizes("fakehash", [])
        assert result == 0

    def test_returns_zero_on_db_error(self):
        """DB errors return 0 (best-effort contract)."""
        from token_goat.cli import _sum_file_sizes

        with patch("token_goat.cli._lazy_import", side_effect=RuntimeError("db gone")):
            result = _sum_file_sizes("fakehash", ["src/a.py"])

        assert result == 0


# ---------------------------------------------------------------------------
# _record_lookup_stat stores non-zero bytes_saved
# ---------------------------------------------------------------------------

class TestRecordLookupStatSavings:
    """_record_lookup_stat stores the bytes_saved value it receives."""

    def test_nonzero_bytes_saved_stored(self):
        """When bytes_saved > 0, the stat row gets the value and non-zero tokens_saved."""
        from token_goat.cli import _record_lookup_stat

        captured: list[dict] = []

        def _fake_record_stat(ph, kind, *, bytes_saved, tokens_saved, detail):
            captured.append({
                "project_hash": ph,
                "kind": kind,
                "bytes_saved": bytes_saved,
                "tokens_saved": tokens_saved,
                "detail": detail,
            })

        with patch("token_goat.cli._lazy_import") as mock_lazy:
            mock_db = MagicMock()
            mock_db.record_stat = _fake_record_stat
            mock_lazy.return_value = mock_db
            _record_lookup_stat(
                "symbol_lookup", "my_func", 2,
                scope="project", project_hash="abc123", bytes_saved=5_000,
            )

        assert len(captured) == 1
        row = captured[0]
        assert row["bytes_saved"] == 5_000
        assert row["tokens_saved"] > 0
        assert row["kind"] == "symbol_lookup"

    def test_zero_bytes_saved_default(self):
        """Default bytes_saved=0 stores zero in both fields."""
        from token_goat.cli import _record_lookup_stat

        captured: list[dict] = []

        def _fake_record_stat(ph, kind, *, bytes_saved, tokens_saved, detail):
            captured.append({"bytes_saved": bytes_saved, "tokens_saved": tokens_saved})

        with patch("token_goat.cli._lazy_import") as mock_lazy:
            mock_db = MagicMock()
            mock_db.record_stat = _fake_record_stat
            mock_lazy.return_value = mock_db
            _record_lookup_stat("map_lookup", "budget=300", 5, scope="project")

        assert captured[0]["bytes_saved"] == 0
        assert captured[0]["tokens_saved"] == 0
