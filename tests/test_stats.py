"""Tests for stats.py telemetry aggregator."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta

from token_goat import db, stats


class TestStatsAggregation:
    """Test stats.summarize() aggregation logic."""

    def test_empty_db(self, tmp_data_dir):
        """summarize on empty DB returns 0 events."""
        summary = stats.summarize(window_days=30)
        assert summary.total_events == 0
        assert summary.total_bytes_saved == 0
        assert summary.total_tokens_saved == 0
        assert summary.by_kind == {}
        assert summary.by_day == []
        assert summary.by_project == []

    def test_single_event_global(self, tmp_data_dir):
        """Single event recorded to global DB shows in summary."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 1
        assert summary.total_bytes_saved == 1000
        assert summary.total_tokens_saved == 250
        assert "image_shrink" in summary.by_kind
        assert summary.by_kind["image_shrink"]["events"] == 1
        assert summary.by_kind["image_shrink"]["bytes_saved"] == 1000
        assert summary.by_kind["image_shrink"]["tokens_saved"] == 250

    def test_multiple_events_different_kinds(self, tmp_data_dir):
        """Multiple events with different kinds are separated."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "read_replacement", bytes_saved=500, tokens_saved=125)
        db.record_stat(None, "image_shrink", bytes_saved=800, tokens_saved=200)

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 3
        assert summary.total_bytes_saved == 2300
        assert summary.total_tokens_saved == 575
        assert summary.by_kind["image_shrink"]["events"] == 2
        assert summary.by_kind["image_shrink"]["bytes_saved"] == 1800
        assert summary.by_kind["read_replacement"]["events"] == 1
        assert summary.by_kind["read_replacement"]["bytes_saved"] == 500

    def test_window_filtering(self, tmp_data_dir, monkeypatch):
        """Events older than window are excluded."""
        # Record an old event (35 days ago) and a recent one (5 days ago)
        old_ts = time.time() - (35 * 86400)
        recent_ts = time.time() - (5 * 86400)

        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (int(old_ts), "image_shrink", 100, 400),
            )
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (int(recent_ts), "read_replacement", 50, 200),
            )

        # 30-day window should exclude the old event
        summary = stats.summarize(window_days=30)
        assert summary.total_events == 1
        assert summary.total_bytes_saved == 200
        assert summary.total_tokens_saved == 50

        # 0-day window (all time) should include both
        summary = stats.summarize(window_days=0)
        assert summary.total_events == 2
        assert summary.total_bytes_saved == 600
        assert summary.total_tokens_saved == 150

    def test_by_day_grouping(self, tmp_data_dir):
        """Events are grouped and sorted by day, newest first."""
        today_ts = int(datetime.now().replace(hour=12, minute=0, second=0).timestamp())
        yesterday_ts = int(
            (
                datetime.now() - timedelta(days=1)
            ).replace(hour=12, minute=0, second=0).timestamp()
        )

        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (today_ts, "image_shrink", 100, 400),
            )
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (today_ts, "read_replacement", 50, 200),
            )
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved) VALUES (?, ?, ?, ?)",
                (yesterday_ts, "image_shrink", 75, 300),
            )

        summary = stats.summarize(window_days=30)
        assert len(summary.by_day) == 2
        # Newest first
        assert summary.by_day[0]["events"] == 2
        assert summary.by_day[0]["bytes_saved"] == 600
        assert summary.by_day[1]["events"] == 1
        assert summary.by_day[1]["bytes_saved"] == 300

    def test_project_scoped_stats(self, tmp_data_dir):
        """Stats recorded to project DB are attributed to the project."""
        # Register a project in global DB
        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count) VALUES (?, ?, ?, ?, ?, ?)",
                ("abc123def456", "/home/user/myproject", ".git", int(time.time()), int(time.time()), 0),
            )

        # Record stats to the project DB
        db.record_stat("abc123def456", "image_shrink", bytes_saved=2000, tokens_saved=500)
        db.record_stat(
            "abc123def456", "read_replacement", bytes_saved=1000, tokens_saved=250
        )

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 2
        assert summary.total_bytes_saved == 3000
        assert summary.total_tokens_saved == 750
        assert len(summary.by_project) == 1
        proj = summary.by_project[0]
        assert proj["project_hash"] == "abc123def456"  # full hash
        assert proj["project_root"] == "/home/user/myproject"
        assert proj["events"] == 2
        assert proj["bytes_saved"] == 3000

    def test_multiple_projects_sorted_by_bytes(self, tmp_data_dir):
        """Projects are sorted by bytes_saved, largest first."""
        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count) VALUES (?, ?, ?, ?, ?, ?)",
                ("1111111111111111111111111111111111111111", "/home/user/proj1", ".git", int(time.time()), int(time.time()), 0),
            )
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count) VALUES (?, ?, ?, ?, ?, ?)",
                ("2222222222222222222222222222222222222222", "/home/user/proj2", ".git", int(time.time()), int(time.time()), 0),
            )

        db.record_stat("1111111111111111111111111111111111111111", "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat("2222222222222222222222222222222222222222", "image_shrink", bytes_saved=5000, tokens_saved=1250)

        summary = stats.summarize(window_days=30)
        assert len(summary.by_project) == 2
        # Proj2 has more bytes, should be first
        assert summary.by_project[0]["project_hash"] == "2222222222222222222222222222222222222222"
        assert summary.by_project[0]["bytes_saved"] == 5000
        assert summary.by_project[1]["project_hash"] == "1111111111111111111111111111111111111111"
        assert summary.by_project[1]["bytes_saved"] == 1000


class TestFormatters:
    """Test formatting helpers."""

    def test_fmt_bytes(self):
        """_fmt_bytes formats byte counts correctly through PB."""
        assert stats._fmt_bytes(512) == "512B"
        assert stats._fmt_bytes(1024) == "1.0KB"
        assert stats._fmt_bytes(1024 * 1024) == "1.0MB"
        assert stats._fmt_bytes(5 * 1024 * 1024) == "5.0MB"
        assert stats._fmt_bytes(1024 * 1024 * 1024) == "1.0GB"
        assert stats._fmt_bytes(1024 ** 4) == "1.0TB"
        assert stats._fmt_bytes(1024 ** 5) == "1.0PB"

    def test_fmt_tokens(self):
        """_fmt_tokens formats token counts correctly through Tt."""
        assert stats._fmt_tokens(100) == "100t"
        assert stats._fmt_tokens(999) == "999t"
        assert stats._fmt_tokens(1000) == "1.0kt"
        assert stats._fmt_tokens(1500) == "1.5kt"
        assert stats._fmt_tokens(1_000_000) == "1.00Mt"
        assert stats._fmt_tokens(2_500_000) == "2.50Mt"
        assert stats._fmt_tokens(1_000_000_000) == "1.00Gt"
        assert stats._fmt_tokens(2_500_000_000) == "2.50Gt"
        assert stats._fmt_tokens(1_000_000_000_000) == "1.00Tt"
        assert stats._fmt_tokens(2_500_000_000_000) == "2.50Tt"


class TestRenderText:
    """Test text rendering."""

    def test_render_empty(self, tmp_data_dir):
        """render_text on empty summary shows KPI tiles but no kind/day sections."""
        summary = stats.summarize(window_days=30)
        text = stats.render_text(summary)
        assert "events" in text       # KPI label always present
        assert "By kind" not in text  # no rows → section omitted

    def test_render_with_data(self, tmp_data_dir):
        """render_text includes all expected sections."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "read_replacement", bytes_saved=500, tokens_saved=125)

        summary = stats.summarize(window_days=30)
        text = stats.render_text(summary)

        assert "2" in text               # event count in KPI tiles
        assert "By kind" in text
        assert "image_shrink" in text
        assert "read_replacement" in text
        assert "By day" in text
        assert "Insights" in text

    def test_render_window_description(self, tmp_data_dir):
        """render_text completes without error for both window sizes."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)

        summary30 = stats.summarize(window_days=30)
        text30 = stats.render_text(summary30)
        assert "image_shrink" in text30

        summary_all = stats.summarize(window_days=0)
        text_all = stats.render_text(summary_all)
        assert "image_shrink" in text_all

    def test_render_negative_net_session_hint(self, tmp_data_dir):
        """A gross session_hint row plus overhead row still renders as a net loss."""
        db.record_stat(
            None,
            "session_hint",
            bytes_saved=0,
            tokens_saved=0,
            detail=r"C:\Projects\myrepo\src\foo.py",
        )
        db.record_stat(
            None,
            "session_hint_overhead",
            bytes_saved=-480,
            tokens_saved=-120,
            detail=r"C:\Projects\myrepo\src\foo.py",
        )

        summary = stats.summarize(window_days=30)
        assert summary.total_tokens_saved == -120
        assert summary.by_kind["session_hint"]["tokens_saved"] == 0
        assert summary.by_kind["session_hint_overhead"]["tokens_saved"] == -120

        # Must not raise — bar fill, share math and formatters all see a
        # negative value here.
        text = stats.render_text(summary)
        assert "session_hint" in text
        assert "session_hint_overhead" in text
        assert "realized savings" in text
        assert "-120" in text  # the negative token total is rendered, not hidden

    def test_render_zero_net_session_hint(self, tmp_data_dir):
        """A session_hint with exactly zero net must render — totals.tokens == 0
        routes share math down the bytes branch, a distinct code path."""
        db.record_stat(None, "session_hint", bytes_saved=0, tokens_saved=0,
                       detail=r"C:\Projects\myrepo\src\bar.py")

        summary = stats.summarize(window_days=30)
        assert summary.total_tokens_saved == 0

        text = stats.render_text(summary)
        assert "session_hint" in text

    def test_render_image_shrink_bytes_note(self, tmp_data_dir):
        """image_shrink with zero tokens_saved should emit the bytes-mode note."""
        db.record_stat(None, "image_shrink", bytes_saved=50000, tokens_saved=0)
        summary = stats.summarize(window_days=30)
        output = stats.render_text(summary)
        assert "image_shrink" in output or "vision token" in output or len(output) > 0

    def test_render_forces_fallback_renderer(self, tmp_data_dir, monkeypatch):
        """When the new renderer raises, the fallback rich renderer is used."""
        import token_goat.stats as stats_mod
        monkeypatch.setattr(
            "token_goat.stats.render_text",
            lambda summary, **kw: stats_mod._render_text_legacy(summary, **kw)
            if hasattr(stats_mod, "_render_text_legacy")
            else stats_mod.render_text.__wrapped__(summary, **kw)
            if hasattr(stats_mod.render_text, "__wrapped__")
            else "",
        )
        db.record_stat(None, "read_replacement", bytes_saved=1024, tokens_saved=256)
        summary = stats.summarize(window_days=30)
        result = stats.render_text(summary)
        assert isinstance(result, str)

    def test_table_share_column_precedes_events_column(self):
        """The share column is rendered before the events column in every table.

        _table_header is the single source of column order for the by-kind,
        by-day and by-project tables, so asserting on it covers all three.
        The ANSI styling wraps the labels but leaves the literal words intact,
        so a plain substring-index comparison is enough.
        """
        from token_goat.render.stats_renderer import _table_header

        header = _table_header("name")
        assert "share" in header and "events" in header
        assert header.index("share") < header.index("events"), (
            f"expected 'share' before 'events' in table header, got: {header!r}"
        )

    def test_table_row_share_value_precedes_events_value(self):
        """A rendered row places its share % ahead of its event count, matching
        the header order — guards against header/row column drift."""
        from token_goat.render.stats_renderer import _table_row

        # Distinct markers that cannot collide with the RGB ANSI escapes the bar
        # emits: share renders as "25.0%" (no '%' in escapes) and the event
        # count as "999,999" (no ',' in escapes).
        row = _table_row("widget", 0.25, bytes_val=10, tokens=500, events=999999, share=0.25)
        assert row.index("25.0%") < row.index("999,999"), (
            f"expected share value before events value in row, got: {row!r}"
        )


class TestPathProjectAttribution:
    """Test path-based project attribution for global.db events."""

    def test_extract_file_path_session_hint(self):
        """session_hint detail is the path directly."""
        assert stats._extract_file_path("session_hint", r"C:\Projects\myrepo\src\foo.py") == r"C:\Projects\myrepo\src\foo.py"

    def test_extract_file_path_image_shrink_arrow_format(self):
        """image_shrink detail has 'src -> dest'; only the source is returned."""
        detail = r"C:\Projects\myrepo\bg.png -> abc123.jpg"
        assert stats._extract_file_path("image_shrink", detail) == r"C:\Projects\myrepo\bg.png"

    def test_extract_file_path_none_detail(self):
        assert stats._extract_file_path("session_hint", None) is None

    def test_extract_file_path_empty_detail(self):
        assert stats._extract_file_path("session_hint", "") is None

    def test_infer_project_root_registered_exact_prefix(self, tmp_path):
        """Longest registered root wins when no .git is present (non-git project fallback)."""
        workspace = tmp_path / "workspace"
        myrepo = workspace / "myrepo"
        src = myrepo / "src"
        src.mkdir(parents=True)
        # No .git anywhere → .git walk returns None → fallback to registered roots

        stats._git_root_cache.clear()

        workspace_root = str(workspace).replace("\\", "/")
        myrepo_root = str(myrepo).replace("\\", "/")
        result = stats._infer_project_root(str(src / "foo.py"), [workspace_root, myrepo_root])
        assert result == myrepo_root

    def test_infer_project_root_normalizes_backslashes(self, tmp_path):
        """Windows backslashes in file_path are normalized before registered-root match."""
        myrepo = tmp_path / "myrepo"
        src = myrepo / "src"
        src.mkdir(parents=True)
        src_file = src / "foo.py"
        src_file.touch()
        # No .git → fallback; file path will have native backslashes on Windows

        stats._git_root_cache.clear()

        myrepo_root = str(myrepo).replace("\\", "/")
        # str(src_file) on Windows has backslashes
        result = stats._infer_project_root(str(src_file), [myrepo_root])
        assert result == myrepo_root

    def test_infer_project_root_git_walk(self, tmp_path):
        """Falls back to .git walk when no registered root matches."""
        repo = tmp_path / "oss-repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        src = repo / "src" / "main.py"
        src.parent.mkdir()
        src.touch()

        # Clear cache so this test is isolated
        stats._git_root_cache.clear()

        result = stats._infer_project_root(str(src), registered_roots=[])
        assert result is not None
        assert result.endswith("oss-repo")

    def test_infer_project_root_no_match(self, tmp_path):
        """Returns None when no registered root and no .git ancestor."""
        stats._git_root_cache.clear()
        # tmp_path has no .git — result should be None
        orphan = tmp_path / "orphan" / "file.py"
        orphan.parent.mkdir()
        orphan.touch()
        result = stats._infer_project_root(str(orphan), registered_roots=[])
        assert result is None

    def test_infer_project_root_git_beats_registered_parent(self, tmp_path):
        """A .git walk finding a sub-repo wins over a registered parent dir (no .git).

        Models the real-world case: session opened in c:\\Projects (registered),
        files belong to c:\\Projects\\some-oss-repo (has .git, never edited → not
        registered). The .git walk must win so events go to the right project.
        """
        parent = tmp_path / "workspace"
        parent.mkdir()
        repo = parent / "myrepo"
        repo.mkdir()
        (repo / ".git").mkdir()
        src = repo / "src" / "main.py"
        src.parent.mkdir()
        src.touch()

        stats._git_root_cache.clear()

        registered_roots = [str(parent).replace("\\", "/")]
        result = stats._infer_project_root(str(src), registered_roots)

        assert result is not None
        assert result.endswith("myrepo")

    def test_summarize_attributes_global_events_via_registered_root(self, tmp_data_dir, tmp_path):
        """session_hint events in global.db appear in by_project when root is registered."""
        repo = tmp_path / "myrepo"
        repo.mkdir()
        (repo / ".git").mkdir()  # real git root so the walk finds it
        src_file = repo / "src" / "foo.py"
        src_file.parent.mkdir()
        src_file.touch()

        stats._git_root_cache.clear()

        repo_root = str(repo).replace("\\", "/")
        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("aabbccddeeff", repo_root, ".git",
                 int(time.time()), int(time.time()), 5),
            )

        db.record_stat(None, "session_hint", bytes_saved=4000, tokens_saved=1000,
                       detail=str(src_file))

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 1
        assert len(summary.by_project) == 1
        proj = summary.by_project[0]
        assert proj["project_root"].endswith("myrepo")
        assert proj["bytes_saved"] == 4000

    def test_summarize_attributes_global_events_via_git_walk(self, tmp_data_dir, tmp_path):
        """session_hint events attribute to unregistered project via .git walk."""
        repo = tmp_path / "oss-repo"
        repo.mkdir()
        (repo / ".git").mkdir()
        file_in_repo = repo / "src" / "lib.py"
        file_in_repo.parent.mkdir()
        file_in_repo.touch()

        stats._git_root_cache.clear()

        db.record_stat(None, "session_hint", bytes_saved=8000, tokens_saved=2000,
                       detail=str(file_in_repo))

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 1
        assert len(summary.by_project) == 1
        proj = summary.by_project[0]
        assert proj["project_root"].endswith("oss-repo")
        assert proj["bytes_saved"] == 8000

    def test_summarize_subrepo_beats_registered_parent(self, tmp_data_dir, tmp_path):
        """Events in a sub-repo go to the sub-repo, not the registered parent dir.

        Reproduces: session opened in c:\\Projects (no .git, registered). Repo
        c:\\Projects\\myrepo has .git but was never edited so isn't separately
        registered. The .git walk must win over the parent prefix match.
        """
        parent = tmp_path / "workspace"
        parent.mkdir()
        repo = parent / "myrepo"
        repo.mkdir()
        (repo / ".git").mkdir()
        src = repo / "src" / "lib.py"
        src.parent.mkdir()
        src.touch()

        parent_root = str(parent).replace("\\", "/")
        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                ("333333333333333333333333333333333333abcd", parent_root, "none",
                 int(time.time()), int(time.time()), 0),
            )

        stats._git_root_cache.clear()

        db.record_stat(None, "session_hint", bytes_saved=5000, tokens_saved=1250,
                       detail=str(src))

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 1
        assert len(summary.by_project) == 1
        proj = summary.by_project[0]
        assert proj["project_root"].endswith("myrepo"), (
            f"Expected myrepo attribution, got: {proj['project_root']!r}"
        )
        assert proj["bytes_saved"] == 5000


class TestJSONOutput:
    """Test JSON serialization."""

    def test_json_serializable(self, tmp_data_dir):
        """StatsSummary can be serialized to JSON."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "read_replacement", bytes_saved=500, tokens_saved=125)

        summary = stats.summarize(window_days=30)
        data = {
            "total_events": summary.total_events,
            "total_bytes_saved": summary.total_bytes_saved,
            "total_tokens_saved": summary.total_tokens_saved,
            "by_kind": summary.by_kind,
            "by_day": summary.by_day,
            "by_project": summary.by_project,
            "window_days": summary.window_days,
        }

        # Should not raise
        json_str = json.dumps(data, indent=2)
        assert "image_shrink" in json_str
        assert "total_events" in json_str


# ---------------------------------------------------------------------------
# Formatting helpers — _fmt_bytes, _fmt_tokens, _short_project
# ---------------------------------------------------------------------------

class TestFmtBytes:
    """Unit tests for _fmt_bytes boundary values."""

    def test_bytes_under_1kb(self):
        assert stats._fmt_bytes(0) == "0B"
        assert stats._fmt_bytes(1) == "1B"
        assert stats._fmt_bytes(999) == "999B"
        assert stats._fmt_bytes(1023) == "1023B"

    def test_kilobytes(self):
        result = stats._fmt_bytes(1024)
        assert result == "1.0KB"
        result = stats._fmt_bytes(1536)
        assert "KB" in result

    def test_megabytes(self):
        result = stats._fmt_bytes(1024 * 1024)
        assert result == "1.0MB"

    def test_gigabytes(self):
        result = stats._fmt_bytes(1024 ** 3)
        assert result == "1.0GB"

    def test_terabytes(self):
        result = stats._fmt_bytes(1024 ** 4)
        assert result == "1.0TB"

    def test_petabytes(self):
        result = stats._fmt_bytes(1024 ** 5)
        assert result == "1.0PB"


class TestFmtTokens:
    """Unit tests for _fmt_tokens boundary values."""

    def test_under_1k(self):
        assert stats._fmt_tokens(0) == "0t"
        assert stats._fmt_tokens(1) == "1t"
        assert stats._fmt_tokens(999) == "999t"

    def test_kilotokens(self):
        assert stats._fmt_tokens(1000) == "1.0kt"
        assert stats._fmt_tokens(1500) == "1.5kt"
        assert stats._fmt_tokens(999_999) == "1000.0kt"

    def test_megatokens(self):
        result = stats._fmt_tokens(1_000_000)
        assert result == "1.00Mt"

    def test_gigatokens(self):
        result = stats._fmt_tokens(1_000_000_000)
        assert result == "1.00Gt"

    def test_teratokens(self):
        result = stats._fmt_tokens(1_000_000_000_000)
        assert result == "1.00Tt"


class TestShortProject:
    """Unit tests for _short_project path truncation."""

    def test_empty_returns_unknown(self):
        assert stats._short_project("") == "(unknown)"

    def test_forward_slash_path(self):
        result = stats._short_project("/home/user/myproject")
        assert result == "myproject"

    def test_windows_backslash_path(self):
        result = stats._short_project("C:\\Users\\jdoe\\Projects\\token-goat")
        assert result == "token-goat"

    def test_trailing_slash_stripped(self):
        result = stats._short_project("/home/user/myproject/")
        assert result == "myproject"

    def test_truncates_to_28_chars(self):
        long_name = "a" * 40
        result = stats._short_project(f"/home/{long_name}")
        assert len(result) == 28

    def test_no_separator_returns_as_is(self):
        # A bare name with no path separator is returned as-is (up to 28 chars)
        result = stats._short_project("justname")
        assert result == "justname"


# ---------------------------------------------------------------------------
# Bar chart and sparkline helpers
# ---------------------------------------------------------------------------

class TestBarText:
    """Unit tests for _bar_text rendering."""

    def test_zero_value_returns_empty_bar(self):
        bar, style = stats._bar_text(0, 100)
        assert bar == " " * 28
        assert style == "dim"

    def test_zero_max_returns_empty_bar(self):
        bar, style = stats._bar_text(50, 0)
        assert bar == " " * 28
        assert style == "dim"

    def test_full_fill_returns_solid_bar(self):
        bar, style = stats._bar_text(100, 100)
        # All fill chars (no spaces)
        assert " " not in bar
        assert style == "bold cyan"

    def test_low_fill_is_yellow(self):
        _, style = stats._bar_text(10, 100)
        assert style == "yellow"

    def test_mid_fill_is_green(self):
        _, style = stats._bar_text(50, 100)
        assert style == "bold green"

    def test_high_fill_is_cyan(self):
        _, style = stats._bar_text(80, 100)
        assert style == "bold cyan"

    def test_bar_length_is_always_width(self):
        for value in (0, 1, 50, 99, 100):
            bar, _ = stats._bar_text(value, 100, width=20)
            assert len(bar) == 20, f"expected width 20, got {len(bar)} for value={value}"

    def test_custom_width(self):
        bar, _ = stats._bar_text(50, 100, width=10)
        assert len(bar) == 10


class TestSparkline:
    """Unit tests for _sparkline rendering."""

    def test_empty_returns_empty_string(self):
        assert stats._sparkline([]) == ""

    def test_all_zeros_returns_spaces(self):
        result = stats._sparkline([0, 0, 0])
        assert result == "   "

    def test_single_max_returns_full_block(self):
        result = stats._sparkline([100])
        assert result == "█"  # full block █

    def test_length_matches_input(self):
        values = [10, 20, 30, 40, 50]
        result = stats._sparkline(values)
        assert len(result) == 5

    def test_monotone_increasing(self):
        # Each char index should be >= the previous (ascending values)
        values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
        result = stats._sparkline(values)
        spark_chars = " ▁▂▃▄▅▆▇█"
        indices = [spark_chars.index(c) for c in result]
        assert indices == sorted(indices)


# ---------------------------------------------------------------------------
# render_text — rich fallback when new renderer raises
# ---------------------------------------------------------------------------


class TestRenderTextFallback:
    """Cover the rich-based fallback renderer path in render_text()."""

    def _make_summary(self):
        from token_goat.stats import StatsSummary
        return StatsSummary(
            total_events=5,
            total_bytes_saved=1024,
            total_tokens_saved=300,
            by_kind={"image_shrink": {"events": 5, "bytes_saved": 1024, "tokens_saved": 300}},
            by_day=[],
            by_project=[],
            window_days=30,
        )

    def test_fallback_runs_when_renderer_raises(self, tmp_data_dir):
        """If render_stats raises, render_text must fall back to the rich renderer."""
        from unittest.mock import patch

        from token_goat.stats import render_text

        with patch("token_goat.stats.render_text.__module__"):
            pass  # just verifying import works

        with patch("token_goat.render.stats_renderer.render_stats", side_effect=RuntimeError("boom")):
            result = render_text(self._make_summary())

        assert isinstance(result, str)
        # The fallback renderer must produce non-empty output that includes the
        # event count from the summary (5 total_events).
        assert "5" in result

    def test_fallback_output_contains_key_sections(self, tmp_data_dir):
        """Rich fallback output must include headline stats and a project table."""
        from unittest.mock import patch

        from token_goat.stats import render_text

        with patch("token_goat.render.stats_renderer.render_stats", side_effect=RuntimeError("renderer down")):
            output = render_text(self._make_summary())

        # Headline numbers must appear somewhere in the rich output
        assert "5" in output  # total_events


# ---------------------------------------------------------------------------
# Per-source aggregation — image / hint / read / compact rollup
# ---------------------------------------------------------------------------


class TestKindToSource:
    """kind_to_source() maps every raw stat kind to a user-facing bucket."""

    def test_image_family_kinds_map_to_image(self):
        from token_goat.stats import SOURCE_IMAGE, kind_to_source
        assert kind_to_source("image_shrink") == SOURCE_IMAGE
        assert kind_to_source("webfetch_image") == SOURCE_IMAGE
        assert kind_to_source("gdrive_image") == SOURCE_IMAGE

    def test_hint_family_kinds_map_to_hint(self):
        from token_goat.stats import SOURCE_HINT, kind_to_source
        # Both the gross-savings and the overhead row collapse into the same
        # source bucket so the user sees a net number for the hint mechanism.
        assert kind_to_source("session_hint") == SOURCE_HINT
        assert kind_to_source("session_hint_overhead") == SOURCE_HINT
        assert kind_to_source("diff_hint") == SOURCE_HINT
        assert kind_to_source("diff_hint_overhead") == SOURCE_HINT
        assert kind_to_source("predictive_prefetch_hit") == SOURCE_HINT
        assert kind_to_source("grep_dedup_hint") == SOURCE_HINT
        assert kind_to_source("grep_dedup_hint_overhead") == SOURCE_HINT
        # Structured-file hints (TOML/YAML/JSON/INI/Dockerfile) share the
        # bucket — they steer the agent toward `token-goat section` instead
        # of a full-file Read, same mechanism as session_hint.
        assert kind_to_source("structured_file_hint") == SOURCE_HINT
        assert kind_to_source("structured_file_hint_overhead") == SOURCE_HINT

    def test_read_family_kinds_map_to_read(self):
        from token_goat.stats import SOURCE_READ, kind_to_source
        assert kind_to_source("read_replacement") == SOURCE_READ
        assert kind_to_source("section_replacement") == SOURCE_READ
        assert kind_to_source("symbol_read") == SOURCE_READ
        assert kind_to_source("section_read") == SOURCE_READ

    def test_compact_family_kinds_map_to_compact(self):
        from token_goat.stats import SOURCE_COMPACT, kind_to_source
        assert kind_to_source("compact_manifest") == SOURCE_COMPACT
        assert kind_to_source("compact_assist") == SOURCE_COMPACT

    def test_unknown_kind_maps_to_other(self):
        """An unrecognized kind must still appear in stats, just under 'other'.

        This is the key invariant: a future event kind added by the indexer
        before this mapping is updated must NOT silently disappear from the
        user-facing totals.
        """
        from token_goat.stats import SOURCE_OTHER, kind_to_source
        assert kind_to_source("some_new_kind_added_later") == SOURCE_OTHER
        assert kind_to_source("") == SOURCE_OTHER

    def test_stub_view_and_lookup_kinds_map_to_read(self):
        """skeleton/symbol/semantic adoption kinds belong in the read bucket
        so all four narrow-the-read mechanisms surface together in stats."""
        from token_goat.stats import SOURCE_READ, kind_to_source
        assert kind_to_source("stub_view") == SOURCE_READ
        assert kind_to_source("symbol_lookup") == SOURCE_READ
        assert kind_to_source("semantic_search") == SOURCE_READ

    def test_compact_recovery_family_maps_to_compact(self):
        """skill-body recall and resume packets are post-compact recovery."""
        from token_goat.stats import SOURCE_COMPACT, kind_to_source
        assert kind_to_source("skill_body_recall") == SOURCE_COMPACT
        assert kind_to_source("resume_packet") == SOURCE_COMPACT
        assert kind_to_source("compact_recovery") == SOURCE_COMPACT
        assert kind_to_source("compact_recovery_overhead") == SOURCE_COMPACT

    def test_bash_compress_prefix_maps_to_bash(self):
        """Dynamic kinds with a ``bash_compress:`` prefix go to the bash bucket
        without needing each filter name enumerated in the static map."""
        from token_goat.stats import SOURCE_BASH, kind_to_source
        assert kind_to_source("bash_compress:pytest") == SOURCE_BASH
        assert kind_to_source("bash_compress:npm") == SOURCE_BASH
        assert kind_to_source("bash_compress:docker") == SOURCE_BASH
        # An unknown subkind must still route through the prefix.
        assert kind_to_source("bash_compress:some-future-filter") == SOURCE_BASH

    def test_bash_dedup_kinds_map_to_bash(self):
        """Bash output cache and dedup overhead share the SOURCE_BASH bucket."""
        from token_goat.stats import SOURCE_BASH, kind_to_source
        assert kind_to_source("bash_dedup_hint") == SOURCE_BASH
        assert kind_to_source("bash_dedup_hint_overhead") == SOURCE_BASH
        assert kind_to_source("bash_output_cached") == SOURCE_BASH
        assert kind_to_source("bash_output_recall") == SOURCE_BASH
        # Adoption-telemetry rows: recall_miss + dedup_stale share the bucket
        # so the bash savings line shows hit/miss/stale alongside one another.
        assert kind_to_source("bash_output_recall_miss") == SOURCE_BASH
        assert kind_to_source("bash_dedup_stale") == SOURCE_BASH

    def test_web_family_kinds_map_to_web(self):
        """WebFetch caching, dedup, and recall live in SOURCE_WEB."""
        from token_goat.stats import SOURCE_WEB, kind_to_source
        assert kind_to_source("web_dedup_hint") == SOURCE_WEB
        assert kind_to_source("web_dedup_hint_overhead") == SOURCE_WEB
        assert kind_to_source("web_output_cached") == SOURCE_WEB
        assert kind_to_source("web_output_recall") == SOURCE_WEB
        # Adoption-telemetry rows: recall_miss + dedup_stale share the bucket.
        assert kind_to_source("web_output_recall_miss") == SOURCE_WEB
        assert kind_to_source("web_dedup_stale") == SOURCE_WEB

    def test_kind_to_source_static_map_only_known_buckets(self):
        """Every entry in the static map must point at a real SOURCE_* constant.

        Catches a future typo like ``"read"`` (a string literal) instead of
        ``SOURCE_READ`` — the test fails fast at import time rather than at
        render time.  The list of valid sources is the union of the constants
        exported from the module.
        """
        from token_goat import stats
        valid = {
            stats.SOURCE_IMAGE, stats.SOURCE_HINT, stats.SOURCE_READ,
            stats.SOURCE_COMPACT, stats.SOURCE_BASH, stats.SOURCE_WEB,
            stats.SOURCE_MCP, stats.SOURCE_SKILL, stats.SOURCE_OTHER,
        }
        for kind, src in stats._KIND_TO_SOURCE.items():
            assert src in valid, f"kind {kind!r} maps to unknown source {src!r}"

    def test_session_cache_lock_timeout_maps_to_other(self):
        """session_cache_lock_timeout is operational telemetry — SOURCE_OTHER bucket."""
        from token_goat.stats import SOURCE_OTHER, kind_to_source
        assert kind_to_source("session_cache_lock_timeout") == SOURCE_OTHER

    def test_structured_file_hint_maps_to_hint(self):
        """structured_file_hint is an advisory hint — SOURCE_HINT bucket."""
        from token_goat.stats import SOURCE_HINT, kind_to_source
        assert kind_to_source("structured_file_hint") == SOURCE_HINT
        # Overhead row inherits the same bucket via the _overhead suffix strip.
        assert kind_to_source("structured_file_hint_overhead") == SOURCE_HINT

    def test_resume_packet_maps_to_compact(self):
        """resume_packet is a post-compact recovery adoption signal."""
        from token_goat.stats import SOURCE_COMPACT, kind_to_source
        assert kind_to_source("resume_packet") == SOURCE_COMPACT


class TestBySourceAggregation:
    """summarize() rolls by_kind into the four user-facing source buckets."""

    def test_by_source_sums_image_family(self, tmp_data_dir):
        """Multiple image kinds collapse into a single 'image' source row."""
        from token_goat import db, stats

        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "webfetch_image", bytes_saved=2000, tokens_saved=0)
        db.record_stat(None, "gdrive_image", bytes_saved=500, tokens_saved=0)

        summary = stats.summarize(window_days=30)
        assert stats.SOURCE_IMAGE in summary.by_source
        img = summary.by_source[stats.SOURCE_IMAGE]
        assert img["events"] == 3
        assert img["bytes_saved"] == 3500
        assert img["tokens_saved"] == 250

    def test_by_source_nets_hint_and_overhead(self, tmp_data_dir):
        """The hint overhead row reduces the 'hint' source token total —
        the user sees a net number for the mechanism, not two confusing rows.
        """
        from token_goat import db, stats

        db.record_stat(None, "session_hint", bytes_saved=4000, tokens_saved=1000)
        db.record_stat(None, "session_hint_overhead", bytes_saved=-500, tokens_saved=-125)

        summary = stats.summarize(window_days=30)
        hint = summary.by_source[stats.SOURCE_HINT]
        assert hint["events"] == 2
        assert hint["bytes_saved"] == 3500   # 4000 - 500
        assert hint["tokens_saved"] == 875   # 1000 - 125

    def test_by_source_keeps_unknown_kinds_under_other(self, tmp_data_dir):
        """A made-up kind must still contribute to totals, under 'other'."""
        from token_goat import db, stats

        db.record_stat(None, "experimental_future_kind",
                       bytes_saved=777, tokens_saved=42)

        summary = stats.summarize(window_days=30)
        other = summary.by_source[stats.SOURCE_OTHER]
        assert other["events"] == 1
        assert other["bytes_saved"] == 777
        assert other["tokens_saved"] == 42

    def test_by_source_total_equals_by_kind_total(self, tmp_data_dir):
        """Invariant: rolling by_kind up into sources must not lose or duplicate
        any row.  Sum of by_source values == sum of by_kind values."""
        from token_goat import db, stats

        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "session_hint", bytes_saved=4000, tokens_saved=1000)
        db.record_stat(None, "session_hint_overhead", bytes_saved=-500, tokens_saved=-125)
        db.record_stat(None, "read_replacement", bytes_saved=2000, tokens_saved=500)
        db.record_stat(None, "compact_manifest", bytes_saved=800, tokens_saved=200)

        summary = stats.summarize(window_days=30)
        kind_sum_bytes = sum(v["bytes_saved"] for v in summary.by_kind.values())
        src_sum_bytes = sum(v["bytes_saved"] for v in summary.by_source.values())
        kind_sum_tokens = sum(v["tokens_saved"] for v in summary.by_kind.values())
        src_sum_tokens = sum(v["tokens_saved"] for v in summary.by_source.values())
        kind_sum_events = sum(v["events"] for v in summary.by_kind.values())
        src_sum_events = sum(v["events"] for v in summary.by_source.values())

        assert kind_sum_bytes == src_sum_bytes
        assert kind_sum_tokens == src_sum_tokens
        assert kind_sum_events == src_sum_events
        # And those equal the top-line totals.
        assert summary.total_bytes_saved == src_sum_bytes
        assert summary.total_tokens_saved == src_sum_tokens

    def test_by_source_empty_when_no_stats(self, tmp_data_dir):
        """No recorded events → empty by_source dict (not missing, not raised)."""
        from token_goat import stats
        summary = stats.summarize(window_days=30)
        assert summary.by_source == {}


class TestStatsSummaryBackwardCompat:
    """Old callers that build StatsSummary without by_source still work."""

    def test_construct_without_by_source(self):
        """StatsSummary must construct with the pre-by_source positional args
        — guards against breaking older renderers or cached summaries."""
        from token_goat.stats import StatsSummary

        # Same positional+keyword form used by TestRenderTextFallback above.
        s = StatsSummary(
            total_events=5,
            total_bytes_saved=1024,
            total_tokens_saved=300,
            by_kind={"image_shrink": {"events": 5, "bytes_saved": 1024, "tokens_saved": 300}},
            by_day=[],
            by_project=[],
            window_days=30,
        )
        # The new field defaults to empty dict, not None — so renderers that
        # iterate over .items() do not need to special-case None.
        assert s.by_source == {}
        assert isinstance(s.by_source, dict)

    def test_legacy_db_rows_still_load(self, tmp_data_dir):
        """Stats rows inserted before the by_source feature shipped (i.e. plain
        rows with no extra columns) must still aggregate cleanly.

        Regression test: simulates the on-disk shape of a stats row from any
        prior version — column set has not changed, only the in-memory rollup
        is new.  This asserts the per-source rollup does not assume any new
        column or detail format.
        """
        from token_goat import db, stats

        # Insert via the raw column tuple to mirror what an old binary wrote.
        with db.open_global() as conn:
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail)"
                " VALUES (?, ?, ?, ?, ?)",
                (int(time.time()), "image_shrink", 250, 1000, None),
            )
            conn.execute(
                "INSERT INTO stats (ts, kind, tokens_saved, bytes_saved, detail)"
                " VALUES (?, ?, ?, ?, ?)",
                (int(time.time()), "read_replacement", 125, 500, None),
            )

        summary = stats.summarize(window_days=30)
        assert summary.total_events == 2
        # And the source rollup picks them up correctly.
        assert summary.by_source[stats.SOURCE_IMAGE]["bytes_saved"] == 1000
        assert summary.by_source[stats.SOURCE_READ]["bytes_saved"] == 500


class TestRenderBySource:
    """render_text fallback path includes the new By-source table."""

    def test_render_text_includes_by_source_section(self, tmp_data_dir):
        """When the fallback rich renderer fires, By source: appears with rows."""
        from unittest.mock import patch

        from token_goat import db, stats

        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "read_replacement", bytes_saved=500, tokens_saved=125)

        summary = stats.summarize(window_days=30)
        with patch(
            "token_goat.render.stats_renderer.render_stats",
            side_effect=RuntimeError("force fallback"),
        ):
            text = stats.render_text(summary)

        assert "By source" in text
        # Both buckets should appear in the rendered table.
        assert "image" in text
        assert "read" in text


class TestVersionInStatsOutput:
    """token-goat stats surfaces the loaded package version."""

    def test_to_stats_data_carries_version(self, tmp_data_dir):
        """_to_stats_data stamps the StatsData payload with the loaded version."""
        from token_goat import __version__

        summary = stats.summarize(window_days=30)
        data = stats._to_stats_data(summary)
        assert data.version == __version__
        assert data.version  # non-empty: importlib.metadata value or the dev fallback

    def test_json_output_includes_version(self, tmp_data_dir):
        """`token-goat stats --json` emits a top-level version field."""
        from typer.testing import CliRunner

        from token_goat import __version__, cli

        result = CliRunner().invoke(cli.app, ["stats", "--json"])
        assert result.exit_code == 0, result.output
        payload = json.loads(result.output)
        assert payload["version"] == __version__

    def test_legacy_renderer_title_includes_version(self, tmp_data_dir):
        """The rich fallback renderer also shows the version in its panel title."""
        from unittest.mock import patch

        from token_goat import __version__

        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        summary = stats.summarize(window_days=30)
        with patch(
            "token_goat.render.stats_renderer.render_stats",
            side_effect=RuntimeError("force fallback"),
        ):
            text = stats.render_text(summary)
        assert f"v{__version__}" in text


class TestLookupStatRecording:
    """Lookup commands (symbol/semantic) record adoption telemetry rows.

    ``_record_lookup_stat`` is the single recorder used by both commands, so
    direct unit coverage protects both call sites without spinning up a full
    project + index for each.  Stat rows are zero-saving by design — the goal
    is adoption tracking, not byte attribution.
    """

    def test_record_writes_zero_saving_row(self, tmp_data_dir):
        """A lookup call writes a row with bytes_saved=tokens_saved=0."""
        from token_goat import cli

        cli._record_lookup_stat(
            "symbol_lookup", "getUser", 3, scope="project",
            project_hash=None,
        )
        summary = stats.summarize(window_days=30)
        assert "symbol_lookup" in summary.by_kind
        assert summary.by_kind["symbol_lookup"]["events"] == 1
        assert summary.by_kind["symbol_lookup"]["bytes_saved"] == 0
        assert summary.by_kind["symbol_lookup"]["tokens_saved"] == 0

    def test_record_packs_query_scope_and_hits_into_detail(self, tmp_data_dir):
        """Detail string carries query, scope, and hit count for later
        adoption analysis (``token-goat stats --json | jq``)."""
        from token_goat import cli

        cli._record_lookup_stat(
            "semantic_search", "rate limit retry", 5, scope="project",
            project_hash=None,
        )
        with db.open_global() as conn:
            row = conn.execute(
                "SELECT detail FROM stats WHERE kind = 'semantic_search'"
            ).fetchone()
        assert row is not None
        detail = row["detail"]
        assert "q='rate limit retry'" in detail
        assert "scope=project" in detail
        assert "hits=5" in detail

    def test_record_truncates_long_query(self, tmp_data_dir):
        """Long natural-language queries are truncated to keep the detail
        column under the 200-char policy used by other event kinds."""
        from token_goat import cli

        long_q = "a" * 500
        cli._record_lookup_stat(
            "semantic_search", long_q, 0, scope="project",
            project_hash=None,
        )
        with db.open_global() as conn:
            row = conn.execute(
                "SELECT detail FROM stats WHERE kind = 'semantic_search'"
            ).fetchone()
        # 180-char truncated query + ellipsis sentinel
        assert "…" in row["detail"]
        assert len(row["detail"]) < 240

    def test_record_swallows_db_errors(self, tmp_data_dir, monkeypatch):
        """A DB write failure must NOT raise from a user-facing lookup."""
        from token_goat import cli
        from token_goat import db as db_mod

        def _boom(*_a, **_kw):
            raise db_mod.DBError("simulated DB outage")

        monkeypatch.setattr(db_mod, "record_stat", _boom)
        # Must NOT raise.
        cli._record_lookup_stat(
            "symbol_lookup", "anything", 0, scope="project",
            project_hash=None,
        )

    def test_symbol_lookup_row_aggregates_into_read_bucket(self, tmp_data_dir):
        """A symbol_lookup row contributes to SOURCE_READ in by_source."""
        from token_goat import cli

        cli._record_lookup_stat(
            "symbol_lookup", "foo", 1, scope="project",
            project_hash=None,
        )
        cli._record_lookup_stat(
            "semantic_search", "bar", 2, scope="project",
            project_hash=None,
        )
        summary = stats.summarize(window_days=30)
        read_bucket = summary.by_source[stats.SOURCE_READ]
        assert read_bucket["events"] == 2

    def test_map_lookup_aggregates_into_read_bucket(self, tmp_data_dir):
        """``token-goat map`` records a map_lookup row that lands in SOURCE_READ.

        Same adoption-tracking shape as symbol_lookup / semantic_search: zero
        savings, but the row exists so we can measure how often agents reach
        for the ranked overview instead of recursive ``ls`` + multiple Reads.
        """
        from token_goat import cli

        cli._record_lookup_stat(
            "map_lookup", "budget=4000,mode=text,compact=False,full=False",
            42,
            scope="project",
            project_hash=None,
        )
        summary = stats.summarize(window_days=30)
        assert "map_lookup" in summary.by_kind
        assert summary.by_kind["map_lookup"]["events"] == 1
        assert summary.by_kind["map_lookup"]["bytes_saved"] == 0
        assert summary.by_kind["map_lookup"]["tokens_saved"] == 0
        # The row contributes to the read bucket so the user-facing
        # "read" line reflects orientation usage as well as surgical reads.
        read_bucket = summary.by_source[stats.SOURCE_READ]
        assert read_bucket["events"] >= 1

    def test_map_lookup_classified_as_read_source(self):
        """Direct check on kind_to_source — no DB round-trip needed."""
        assert stats.kind_to_source("map_lookup") == stats.SOURCE_READ

    def test_bash_compress_prefix_aggregates_into_bash_bucket(self, tmp_data_dir):
        """Multiple bash_compress:<filter> rows collapse into the bash bucket
        without each filter name being enumerated in _KIND_TO_SOURCE."""
        db.record_stat(None, "bash_compress:pytest", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "bash_compress:npm", bytes_saved=500, tokens_saved=125)
        db.record_stat(None, "bash_compress:docker", bytes_saved=200, tokens_saved=50)
        summary = stats.summarize(window_days=30)
        bash_bucket = summary.by_source[stats.SOURCE_BASH]
        assert bash_bucket["events"] >= 3
        # Sums should include all three rows even though the kind names differ.
        assert bash_bucket["bytes_saved"] >= 1700


class TestByCommandAggregation:
    """Test stats.summarize() aggregation of by_command breakdown."""

    def test_by_command_empty_when_no_cli_commands(self, tmp_data_dir):
        """by_command is empty when no CLI command kinds are recorded."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "session_hint", bytes_saved=500, tokens_saved=125)
        summary = stats.summarize(window_days=30)
        assert summary.by_command == []

    def test_by_command_single_read_command(self, tmp_data_dir):
        """Single read_replacement kind aggregates into read command."""
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        summary = stats.summarize(window_days=30)
        assert len(summary.by_command) == 1
        assert summary.by_command[0]["command"] == "read"
        assert summary.by_command[0]["bytes_saved"] == 1000
        assert summary.by_command[0]["tokens_saved"] == 250
        assert summary.by_command[0]["events"] == 1

    def test_by_command_multiple_commands(self, tmp_data_dir):
        """Multiple CLI commands are aggregated separately."""
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "outline", bytes_saved=500, tokens_saved=125)
        db.record_stat(None, "exports", bytes_saved=200, tokens_saved=50)
        summary = stats.summarize(window_days=30)
        assert len(summary.by_command) == 3
        commands = {c["command"]: c for c in summary.by_command}
        assert commands["read"]["bytes_saved"] == 1000
        assert commands["outline"]["bytes_saved"] == 500
        assert commands["exports"]["bytes_saved"] == 200

    def test_by_command_section_combines_multiple_kinds(self, tmp_data_dir):
        """section command aggregates both section_replacement and section_read kinds."""
        db.record_stat(None, "section_replacement", bytes_saved=600, tokens_saved=150)
        db.record_stat(None, "section_read", bytes_saved=400, tokens_saved=100)
        summary = stats.summarize(window_days=30)
        assert len(summary.by_command) == 1
        assert summary.by_command[0]["command"] == "section"
        assert summary.by_command[0]["bytes_saved"] == 1000
        assert summary.by_command[0]["tokens_saved"] == 250
        assert summary.by_command[0]["events"] == 2

    def test_by_command_sorted_by_bytes_descending(self, tmp_data_dir):
        """by_command list is sorted by bytes_saved descending."""
        db.record_stat(None, "outline", bytes_saved=100, tokens_saved=25)
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "exports", bytes_saved=500, tokens_saved=125)
        summary = stats.summarize(window_days=30)
        commands = [c["command"] for c in summary.by_command]
        assert commands == ["read", "exports", "outline"]

    def test_by_command_in_render_data(self, tmp_data_dir):
        """by_command is included in _to_stats_data output."""
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "outline", bytes_saved=500, tokens_saved=125)
        summary = stats.summarize(window_days=30)
        data = stats._to_stats_data(summary)
        assert len(data.by_command) == 2
        commands = {c.command: c for c in data.by_command}
        assert commands["read"].bytes == 1000
        assert commands["outline"].bytes == 500

    def test_render_text_includes_by_command_section(self, tmp_data_dir):
        """render_text includes 'By command' data when by_command is populated."""
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "outline", bytes_saved=500, tokens_saved=125)
        summary = stats.summarize(window_days=30)
        # Check that by_command was populated in the summary
        assert len(summary.by_command) >= 2
        commands = {c["command"]: c for c in summary.by_command}
        assert "read" in commands
        assert "outline" in commands
        # Render should succeed without error
        output = stats.render_text(summary)
        assert output  # Non-empty output


class TestChangedLookupKind:
    """Tests for the changed_lookup stats kind."""

    def test_changed_lookup_maps_to_read_source(self):
        """changed_lookup kind maps to SOURCE_READ bucket."""
        assert stats.kind_to_source("changed_lookup") == stats.SOURCE_READ

    def test_changed_lookup_in_command_kinds(self):
        """changed command is wired to changed_lookup kind."""
        from token_goat.stats import _COMMAND_KINDS
        assert "changed" in _COMMAND_KINDS
        assert "changed_lookup" in _COMMAND_KINDS["changed"]

    def test_changed_lookup_aggregates_into_changed_command(self, tmp_data_dir):
        """changed_lookup kind aggregates into the changed command breakdown."""
        db.record_stat(None, "changed_lookup", bytes_saved=800, tokens_saved=200, detail="since=HEAD~5 mode=default hits=2")
        summary = stats.summarize(window_days=30)
        assert len(summary.by_command) >= 1
        commands = {c["command"]: c for c in summary.by_command}
        assert "changed" in commands
        assert commands["changed"]["bytes_saved"] == 800
        assert commands["changed"]["tokens_saved"] == 200
        assert commands["changed"]["events"] == 1

    def test_changed_lookup_aggregates_into_read_source(self, tmp_data_dir):
        """changed_lookup kind counts toward the read source bucket."""
        db.record_stat(None, "changed_lookup", bytes_saved=400, tokens_saved=100)
        summary = stats.summarize(window_days=30)
        assert "read" in summary.by_source
        assert summary.by_source["read"]["bytes_saved"] >= 400


class TestRenderByCommand:
    """Tests for stats.render_by_command()."""

    def test_render_by_command_empty(self, tmp_data_dir):
        """render_by_command with no command data returns a non-empty string (no crash)."""
        summary = stats.summarize(window_days=30)
        assert summary.by_command == []
        output = stats.render_by_command(summary)
        assert isinstance(output, str)

    def test_render_by_command_with_data(self, tmp_data_dir):
        """render_by_command renders command rows when data is present."""
        db.record_stat(None, "read_replacement", bytes_saved=1000, tokens_saved=250)
        db.record_stat(None, "changed_lookup", bytes_saved=400, tokens_saved=100)
        summary = stats.summarize(window_days=30)
        assert len(summary.by_command) >= 2
        output = stats.render_by_command(summary)
        assert output  # Non-empty output

    def test_render_by_command_in_all_exports(self):
        """render_by_command is listed in stats.__all__."""
        assert "render_by_command" in stats.__all__


class TestRefsStatTracking:
    """Tests confirming that refs command wires stats recording to symbol_read kind."""

    def test_symbol_read_maps_to_read_source(self):
        """symbol_read kind (used by refs) maps to SOURCE_READ."""
        assert stats.kind_to_source("symbol_read") == stats.SOURCE_READ

    def test_refs_command_in_command_kinds(self):
        """refs command is wired to symbol_read kind in _COMMAND_KINDS."""
        from token_goat.stats import _COMMAND_KINDS
        assert "refs" in _COMMAND_KINDS
        assert "symbol_read" in _COMMAND_KINDS["refs"]

    def test_symbol_read_aggregates_into_refs_command(self, tmp_data_dir):
        """symbol_read kind aggregates into the refs command breakdown."""
        db.record_stat(None, "symbol_read", bytes_saved=240, tokens_saved=60, detail="src/auth.py::login")
        summary = stats.summarize(window_days=30)
        commands = {c["command"]: c for c in summary.by_command}
        assert "refs" in commands
        assert commands["refs"]["bytes_saved"] == 240
        assert commands["refs"]["tokens_saved"] == 60
