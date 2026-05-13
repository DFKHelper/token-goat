"""Tests for stats.py telemetry aggregator."""
from __future__ import annotations

import json
import time
from datetime import datetime, timedelta

from tokenwise import db, stats


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
                ("proj1111111111", "/home/user/proj1", ".git", int(time.time()), int(time.time()), 0),
            )
            conn.execute(
                "INSERT INTO projects (hash, root, marker, first_seen, last_seen, file_count) VALUES (?, ?, ?, ?, ?, ?)",
                ("proj2222222222", "/home/user/proj2", ".git", int(time.time()), int(time.time()), 0),
            )

        db.record_stat("proj1111111111", "image_shrink", bytes_saved=1000, tokens_saved=250)
        db.record_stat("proj2222222222", "image_shrink", bytes_saved=5000, tokens_saved=1250)

        summary = stats.summarize(window_days=30)
        assert len(summary.by_project) == 2
        # Proj2 has more bytes, should be first
        assert summary.by_project[0]["project_hash"] == "proj2222222222"
        assert summary.by_project[0]["bytes_saved"] == 5000
        assert summary.by_project[1]["project_hash"] == "proj1111111111"
        assert summary.by_project[1]["bytes_saved"] == 1000


class TestFormatters:
    """Test formatting helpers."""

    def test_fmt_bytes(self):
        """_fmt_bytes formats byte counts correctly."""
        assert stats._fmt_bytes(512) == "512B"
        assert stats._fmt_bytes(1024) == "1.0KB"
        assert stats._fmt_bytes(1024 * 1024) == "1.0MB"
        assert stats._fmt_bytes(5 * 1024 * 1024) == "5.0MB"
        assert stats._fmt_bytes(1024 * 1024 * 1024) == "1.0GB"

    def test_fmt_tokens(self):
        """_fmt_tokens formats token counts correctly."""
        assert stats._fmt_tokens(100) == "100t"
        assert stats._fmt_tokens(999) == "999t"
        assert stats._fmt_tokens(1000) == "1.0kt"
        assert stats._fmt_tokens(1500) == "1.5kt"
        assert stats._fmt_tokens(1_000_000) == "1.00Mt"
        assert stats._fmt_tokens(2_500_000) == "2.50Mt"


class TestRenderText:
    """Test text rendering."""

    def test_render_empty(self, tmp_data_dir):
        """render_text on empty summary includes helpful message."""
        summary = stats.summarize(window_days=30)
        text = stats.render_text(summary)
        assert "no recorded savings yet" in text
        assert "events" in text  # KPI label always present

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
        assert "By day (top" in text
        assert "no recorded savings yet" not in text

    def test_render_window_description(self, tmp_data_dir):
        """render_text completes without error for both window sizes."""
        db.record_stat(None, "image_shrink", bytes_saved=1000, tokens_saved=250)

        summary30 = stats.summarize(window_days=30)
        text30 = stats.render_text(summary30)
        assert "image_shrink" in text30

        summary_all = stats.summarize(window_days=0)
        text_all = stats.render_text(summary_all)
        assert "image_shrink" in text_all


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
        assert summary.total_events == 2
