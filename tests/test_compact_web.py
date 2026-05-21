"""Tests for the Web Fetches section in the compaction manifest."""
from __future__ import annotations

import time

from token_goat import compact, session


def _make_mature(sid: str, age_seconds: float = 7200.0) -> None:
    """Backdate created_ts so the session is treated as 'mature' by age-tier logic."""
    cache = session.load(sid)
    cache.created_ts = time.time() - age_seconds
    session.save(cache)


def _seed_web(
    sid: str,
    url: str,
    *,
    body_bytes: int = 10_000,
    status_code: int = 200,
    truncated: bool = False,
) -> str:
    """Record a fake WebFetch invocation in the session and return the url_sha."""
    import hashlib

    url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
    session.mark_web_fetch(
        session_id=sid,
        url_sha=url_sha,
        url_preview=url[:200],
        output_id=f"web-{url_sha}",
        body_bytes=body_bytes,
        status_code=status_code,
        truncated=truncated,
    )
    return url_sha


class TestWebSection:
    def test_web_section_emitted_for_mature_session(self, tmp_data_dir):
        sid = "wm-1"
        session.mark_file_edited(sid, "/project/src/main.py")
        _seed_web(sid, "https://docs.example.com/api", body_bytes=12_000, status_code=200)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "Web Fetches" in m
        assert "docs.example.com/api" in m
        assert "200" in m

    def test_web_section_includes_cache_id(self, tmp_data_dir):
        sid = "wm-2"
        session.mark_file_edited(sid, "/project/src/main.py")
        url = "https://docs.example.com/reference"
        _seed_web(sid, url, body_bytes=8_000)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        import hashlib
        url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
        assert f"id=web-{url_sha}" in m

    def test_tiny_web_fetch_skipped(self, tmp_data_dir):
        sid = "wm-3"
        session.mark_file_edited(sid, "/project/src/main.py")
        _seed_web(sid, "https://example.com/ping", body_bytes=50)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "Web Fetches" not in m

    def test_web_section_suppressed_for_young_session(self, tmp_data_dir):
        sid = "wm-4"
        session.mark_file_edited(sid, "/project/src/main.py")
        _seed_web(sid, "https://docs.example.com/api", body_bytes=15_000)
        # Do NOT call _make_mature — default created_ts is now, so session is "young"
        m = compact.build_manifest(sid, max_tokens=400)
        assert "Web Fetches" not in m

    def test_web_section_shows_status_code(self, tmp_data_dir):
        sid = "wm-5"
        session.mark_file_edited(sid, "/project/src/main.py")
        _seed_web(sid, "https://api.example.com/gone", body_bytes=500, status_code=404)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "404" in m

    def test_web_section_shows_truncated_marker(self, tmp_data_dir):
        sid = "wm-6"
        session.mark_file_edited(sid, "/project/src/main.py")
        _seed_web(sid, "https://big.example.com/doc", body_bytes=200_000, truncated=True)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=400)
        assert "truncated" in m

    def test_web_and_bash_coexist(self, tmp_data_dir):
        sid = "wm-7"
        session.mark_file_edited(sid, "/project/src/main.py")
        from token_goat import bash_cache
        cmd = "pytest -v tests/"
        cmd_sha = bash_cache.command_hash(cmd)
        session.mark_bash_run(
            session_id=sid,
            cmd_sha=cmd_sha,
            cmd_preview=cmd,
            output_id=f"out-{cmd_sha}",
            stdout_bytes=8_000,
            stderr_bytes=0,
            exit_code=0,
            truncated=False,
        )
        _seed_web(sid, "https://docs.example.com/api", body_bytes=10_000)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=600)
        assert "Commands Run" in m
        assert "Web Fetches" in m

    def test_only_web_still_renders_manifest(self, tmp_data_dir):
        sid = "wm-8"
        _seed_web(sid, "https://docs.example.com/guide", body_bytes=20_000)
        _make_mature(sid)
        # build_manifest does not enforce min_events; the render path always runs.
        m = compact.build_manifest(sid, max_tokens=400)
        assert "Web Fetches" in m

    def test_multiple_web_entries_capped_at_max(self, tmp_data_dir):
        sid = "wm-9"
        session.mark_file_edited(sid, "/project/src/main.py")
        urls = [f"https://docs.example.com/page{i}" for i in range(8)]
        for url in urls:
            _seed_web(sid, url, body_bytes=5_000)
        _make_mature(sid)
        m = compact.build_manifest(sid, max_tokens=800)
        # _MAX_WEB_ENTRIES == 4; at most 4 entries should appear
        count = m.count("🌐")
        assert count <= compact._MAX_WEB_ENTRIES

    def test_web_entry_recency_ranked(self, tmp_data_dir):
        """Most recently fetched URL should appear before older ones when both fit."""
        sid = "wm-10"
        session.mark_file_edited(sid, "/project/src/main.py")

        import hashlib
        old_url = "https://old.example.com/doc"
        old_sha = hashlib.sha256(old_url.encode()).hexdigest()[:12]
        new_url = "https://new.example.com/doc"
        new_sha = hashlib.sha256(new_url.encode()).hexdigest()[:12]

        # Manually insert with controlled timestamps
        cache = session.load(sid)
        from token_goat.session import WebEntry
        cache.web_history[old_sha] = WebEntry(
            url_sha=old_sha,
            url_preview=old_url,
            output_id=f"web-{old_sha}",
            ts=time.time() - 3600,  # 1 hour ago
            body_bytes=10_000,
            status_code=200,
        )
        cache.web_history[new_sha] = WebEntry(
            url_sha=new_sha,
            url_preview=new_url,
            output_id=f"web-{new_sha}",
            ts=time.time() - 60,  # 1 minute ago
            body_bytes=10_000,
            status_code=200,
        )
        cache.created_ts = time.time() - 7200
        session.save(cache)

        # Use a large budget so both entries fit in the web section.
        m = compact.build_manifest(sid, max_tokens=800)
        assert "Web Fetches" in m
        old_pos = m.find("old.example.com")
        new_pos = m.find("new.example.com")
        # Both URLs present — newer one comes first (higher ts = ranked first)
        assert old_pos != -1, "old URL should appear in manifest at 800-token budget"
        assert new_pos != -1, "new URL should appear in manifest at 800-token budget"
        assert new_pos < old_pos, "more-recent URL should appear before older URL"


class TestComputeAdaptiveBudgetWebBonus:
    def test_web_history_increases_budget(self, tmp_data_dir):
        sid = "wab-1"
        # Build two caches: one without web history, one with.
        cache_no_web = session.load(sid + "-a")
        budget_no_web = compact.compute_adaptive_budget(cache_no_web, age_seconds=1800.0)

        cache_with_web = session.load(sid + "-b")
        _seed_web(sid + "-b", "https://docs.example.com", body_bytes=5_000)
        cache_with_web = session.load(sid + "-b")
        budget_with_web = compact.compute_adaptive_budget(cache_with_web, age_seconds=1800.0)

        assert budget_with_web > budget_no_web

    def test_web_bonus_is_15_tokens(self, tmp_data_dir):
        """Web bonus is exactly 15 tokens relative to a baseline (active tier)."""
        sid = "wab-2"
        # Baseline: no history at all, active tier (1800s)
        cache_base = session.load(sid + "-base")
        budget_base = compact.compute_adaptive_budget(cache_base, age_seconds=1800.0)

        # With web history only
        _seed_web(sid + "-web", "https://docs.example.com", body_bytes=5_000)
        cache_web = session.load(sid + "-web")
        budget_web = compact.compute_adaptive_budget(cache_web, age_seconds=1800.0)

        assert budget_web - budget_base == 15


class TestSelectTopWebEntries:
    def test_empty_web_history(self):
        assert compact._select_top_web_entries(None) == []
        assert compact._select_top_web_entries({}) == []
        assert compact._select_top_web_entries("not a dict") == []

    def test_filters_tiny_entries(self):
        from token_goat.session import WebEntry
        tiny = WebEntry(
            url_sha="abc", url_preview="https://x.com", output_id="o1",
            ts=time.time(), body_bytes=10, status_code=200,
        )
        result = compact._select_top_web_entries({"abc": tiny})
        assert result == []

    def test_keeps_large_entries(self):
        from token_goat.session import WebEntry
        big = WebEntry(
            url_sha="abc", url_preview="https://x.com", output_id="o1",
            ts=time.time(), body_bytes=10_000, status_code=200,
        )
        result = compact._select_top_web_entries({"abc": big})
        assert len(result) == 1

    def test_caps_at_max_web_entries(self):
        from token_goat.session import WebEntry
        history = {
            f"sha{i}": WebEntry(
                url_sha=f"sha{i}",
                url_preview=f"https://example.com/{i}",
                output_id=f"o{i}",
                ts=time.time() - i,
                body_bytes=5_000,
                status_code=200,
            )
            for i in range(10)
        }
        result = compact._select_top_web_entries(history)
        assert len(result) <= compact._MAX_WEB_ENTRIES


class TestFormatWebEntry:
    def test_basic_format(self):
        from token_goat.session import WebEntry
        entry = WebEntry(
            url_sha="abc123",
            url_preview="https://docs.example.com/api",
            output_id="web-abc123",
            ts=time.time(),
            body_bytes=14_336,
            status_code=200,
        )
        line = compact._format_web_entry(entry)
        assert "🌐" in line
        assert "docs.example.com/api" in line
        assert "200" in line
        assert "14.0KB" in line
        assert "web-abc123" in line

    def test_truncated_marker_included(self):
        from token_goat.session import WebEntry
        entry = WebEntry(
            url_sha="abc",
            url_preview="https://x.com",
            output_id="oid",
            ts=time.time(),
            body_bytes=1_000,
            status_code=200,
            truncated=True,
        )
        line = compact._format_web_entry(entry)
        assert "truncated" in line

    def test_unknown_status_code(self):
        from token_goat.session import WebEntry
        entry = WebEntry(
            url_sha="abc",
            url_preview="https://x.com",
            output_id="oid",
            ts=time.time(),
            body_bytes=1_000,
            status_code=None,
        )
        line = compact._format_web_entry(entry)
        assert "?" in line
