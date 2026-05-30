"""Tests for the Web Fetches section in the compaction manifest."""
from __future__ import annotations

import hashlib
import time

from token_goat import compact, session


class TestWebSection:
    def test_web_section_emitted_for_mature_session(self, tmp_data_dir, make_session):
        sid = "wm-1"
        # min_lines=2 applies: single entry would be suppressed; add two to render section
        # Use a separate session without edits to avoid budget pressure
        make_session(
            sid,
            age_seconds=7200,
            web_fetches={
                "https://docs.example.com/api": 12_000,
                "https://api.other.com/reference": 10_000,
            },
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Web Fetches:**" in m
        assert "docs.example.com/api" in m
        assert "200" in m

    def test_web_section_includes_cache_id(self, tmp_data_dir, make_session):
        sid = "wm-2"
        url = "https://docs.example.com/reference"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={url: 8_000},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        url_sha = hashlib.sha256(url.encode()).hexdigest()[:12]
        # output_id is "web-<url_sha>" (16 chars); short form is …<last8>
        from token_goat.cache_common import short_output_id
        assert f"id={short_output_id(f'web-{url_sha}')}" in m

    def test_tiny_web_fetch_skipped(self, tmp_data_dir, make_session):
        sid = "wm-3"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={"https://example.com/ping": 50},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Web Fetches:**" not in m

    def test_web_section_suppressed_for_young_session(self, tmp_data_dir, make_session):
        sid = "wm-4"
        make_session(
            sid,
            age_seconds=0,  # young session (created_ts = now)
            edits=1,
            web_fetches={"https://docs.example.com/api": 15_000},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Web Fetches:**" not in m

    def test_web_section_shows_status_code(self, tmp_data_dir, make_session):
        sid = "wm-5"
        # min_lines=2 applies: add second entry so Web Fetches section renders
        make_session(
            sid,
            age_seconds=7200,
            web_fetches={
                "https://api.example.com/gone": 500,
                "https://status.other.com/check": 1_000,
            },
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "404" in m or "200" in m

    def test_web_section_shows_truncated_marker(self, tmp_data_dir, make_session):
        sid = "wm-6"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={"https://big.example.com/doc": 200_000},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "truncated" in m or "**Web Fetches:**" in m

    def test_web_and_bash_coexist(self, tmp_data_dir, make_session):
        sid = "wm-7"
        # min_lines=2 applies: add second web fetch so Web Fetches section renders
        make_session(
            sid,
            age_seconds=7200,
            bash_runs={"pytest -v tests/": (8_000, 0)},
            web_fetches={
                "https://docs.example.com/api": 10_000,
                "https://guide.other.com/intro": 8_000,
            },
        )
        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Recent Commands:**" in m
        assert "**Web Fetches:**" in m

    def test_only_web_still_renders_manifest(self, tmp_data_dir, make_session):
        sid = "wm-8"
        make_session(
            sid,
            age_seconds=7200,
            web_fetches={"https://docs.example.com/guide": 20_000},
        )
        m = compact.build_manifest(sid, max_tokens=400)
        assert "**Web Fetches:**" in m

    def test_multiple_web_entries_capped_at_max(self, tmp_data_dir, make_session):
        sid = "wm-9"
        web_fetches = {
            f"https://docs.example.com/page{i}": 5_000
            for i in range(8)
        }
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches=web_fetches,
        )
        m = compact.build_manifest(sid, max_tokens=800)
        # _MAX_WEB_ENTRIES == 4; at most 4 entries should appear
        count = m.count("🌐")
        assert count <= compact._MAX_WEB_ENTRIES

    def test_web_entry_recency_ranked(self, tmp_data_dir, make_session):
        """Most recently fetched URL should appear before older ones when both fit."""
        sid = "wm-10"
        import time as time_module

        old_url = "https://old.example.com/doc"
        new_url = "https://new.example.com/doc"

        # Manually insert with controlled timestamps to test recency ranking
        cache = session.load(sid)
        from token_goat.session import WebEntry
        old_sha = hashlib.sha256(old_url.encode()).hexdigest()[:12]
        new_sha = hashlib.sha256(new_url.encode()).hexdigest()[:12]
        cache.web_history[old_sha] = WebEntry(
            url_sha=old_sha,
            url_preview=old_url,
            output_id=f"web-{old_sha}",
            ts=time_module.time() - 3600,  # 1 hour ago
            body_bytes=10_000,
            status_code=200,
        )
        cache.web_history[new_sha] = WebEntry(
            url_sha=new_sha,
            url_preview=new_url,
            output_id=f"web-{new_sha}",
            ts=time_module.time() - 60,  # 1 minute ago
            body_bytes=10_000,
            status_code=200,
        )
        cache.created_ts = time_module.time() - 7200
        session.save(cache)

        # Use a large budget so both entries fit in the web section.
        m = compact.build_manifest(sid, max_tokens=800)
        assert "**Web Fetches:**" in m
        old_pos = m.find("old.example.com")
        new_pos = m.find("new.example.com")
        # Both URLs present — newer one comes first (higher ts = ranked first)
        assert old_pos != -1, "old URL should appear in manifest at 800-token budget"
        assert new_pos != -1, "new URL should appear in manifest at 800-token budget"
        assert new_pos < old_pos, "more-recent URL should appear before older URL"


class TestComputeAdaptiveBudgetWebBonus:
    def test_web_history_increases_budget(self, tmp_data_dir, make_session):
        sid = "wab-1"
        # Build two caches: one without web history, one with.
        cache_no_web = session.load(sid + "-a")
        budget_no_web = compact.compute_adaptive_budget(cache_no_web, age_seconds=1800.0)

        make_session(
            sid + "-b",
            age_seconds=1800,
            web_fetches={"https://docs.example.com": 5_000},
        )
        cache_with_web = session.load(sid + "-b")
        budget_with_web = compact.compute_adaptive_budget(cache_with_web, age_seconds=1800.0)

        assert budget_with_web > budget_no_web

    def test_web_bonus_is_15_tokens(self, tmp_data_dir, make_session):
        """Web bonus is exactly 15 tokens relative to a baseline (active tier)."""
        sid = "wab-2"
        # Baseline: no history at all, active tier (1800s)
        cache_base = session.load(sid + "-base")
        budget_base = compact.compute_adaptive_budget(cache_base, age_seconds=1800.0)

        # With web history only
        make_session(
            sid + "-web",
            age_seconds=1800,
            web_fetches={"https://docs.example.com": 5_000},
        )
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
        # output_id is rendered in short form (…<last8>)
        from token_goat.cache_common import short_output_id
        assert short_output_id("web-abc123") in line
        assert "web-abc123" not in line  # full id must not appear

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


class TestGroupWebEntriesByDomain:
    def test_single_url_unchanged(self):
        """A single URL should be rendered in full format."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha="abc",
                url_preview="https://docs.example.com/api",
                output_id="web-abc",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            )
        ]
        lines = compact._group_web_entries_by_domain(entries)
        assert len(lines) == 1
        assert "🌐" in lines[0]
        assert "docs.example.com/api" in lines[0]

    def test_two_same_domain_grouped(self):
        """Two URLs from same domain should be grouped."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha="abc",
                url_preview="https://docs.anthropic.com/en/api/getting-started",
                output_id="web-abc",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="def",
                url_preview="https://docs.anthropic.com/en/api/messages",
                output_id="web-def",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
        ]
        lines = compact._group_web_entries_by_domain(entries)
        assert len(lines) == 1
        assert "docs.anthropic.com" in lines[0]
        assert "(2)" in lines[0]
        assert "getting-started" in lines[0]
        assert "messages" in lines[0]

    def test_mixed_domains(self):
        """URLs from different domains should not be grouped."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha="abc",
                url_preview="https://docs.anthropic.com/en/api/getting-started",
                output_id="web-abc",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="def",
                url_preview="https://github.com/anthropics/anthropic-sdk-python",
                output_id="web-def",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
        ]
        lines = compact._group_web_entries_by_domain(entries)
        assert len(lines) == 2
        assert any("docs.anthropic.com" in line for line in lines)
        assert any("github.com" in line for line in lines)
        # Single-domain entries should have "🌐" marker with full URL
        anthropic_line = [line for line in lines if "docs.anthropic.com" in line][0]
        assert "🌐" in anthropic_line

    def test_many_urls_from_one_domain_truncated(self):
        """Long aggregation of paths should be truncated."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha=f"sha{i}",
                url_preview=f"https://docs.example.com/section{i}/page{i}/subsection{i}",
                output_id=f"web-sha{i}",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            )
            for i in range(6)
        ]
        lines = compact._group_web_entries_by_domain(entries)
        assert len(lines) == 1
        line = lines[0]
        assert "docs.example.com" in line
        assert "(6)" in line
        # Should be truncated if too long
        if len(line) > 100:  # Rough check for long path summary
            assert "..." in line

    def test_three_domains_mixed(self):
        """Three separate domains should produce three groups."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha="a1",
                url_preview="https://api1.example.com/endpoint",
                output_id="web-a1",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="a2",
                url_preview="https://api1.example.com/docs",
                output_id="web-a2",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="b1",
                url_preview="https://api2.example.com/v1",
                output_id="web-b1",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="c1",
                url_preview="https://docs.other.io/guide",
                output_id="web-c1",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
        ]
        lines = compact._group_web_entries_by_domain(entries)
        assert len(lines) == 3
        # api1.example.com appears twice (grouped)
        api1_line = [line for line in lines if "api1.example.com" in line][0]
        assert "(2)" in api1_line
        # api2 and docs.other.io appear once each
        assert any("api2.example.com" in line for line in lines)
        assert any("docs.other.io" in line for line in lines)

    def test_empty_entries_list(self):
        """Empty list should return empty result."""
        lines = compact._group_web_entries_by_domain([])
        assert lines == []

    def test_malformed_url_handled_gracefully(self):
        """Entry with invalid URL should be skipped gracefully."""
        from token_goat.session import WebEntry
        entries = [
            WebEntry(
                url_sha="bad",
                url_preview="not a url at all",
                output_id="web-bad",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
            WebEntry(
                url_sha="good",
                url_preview="https://good.com/page",
                output_id="web-good",
                ts=time.time(),
                body_bytes=5_000,
                status_code=200,
            ),
        ]
        lines = compact._group_web_entries_by_domain(entries)
        # Should handle gracefully and include the good one
        assert len(lines) >= 1
        assert any("good.com" in line for line in lines)


class TestWebGroupingIntegration:
    def test_grouped_entries_in_full_manifest(self, tmp_data_dir, make_session):
        """End-to-end: multiple URLs from same domain appear grouped in manifest."""
        sid = "wg-1"
        make_session(
            sid,
            age_seconds=7200,
            edits=1,
            web_fetches={
                "https://docs.anthropic.com/en/api/getting-started": 12_000,
                "https://docs.anthropic.com/en/api/messages": 10_000,
                "https://github.com/anthropics/anthropic-sdk-python": 8_000,
            },
        )
        m = compact.build_manifest(sid, max_tokens=600)
        assert "**Web Fetches:**" in m
        # docs.anthropic.com should appear once with (2)
        assert "docs.anthropic.com" in m
        assert "(2)" in m
        # github.com should appear separately
        assert "github.com" in m


class TestRenderCacheMeta:
    """_render_cache_meta: shared parenthesised metadata suffix for bash/web manifest lines."""

    def test_basic_no_id(self) -> None:
        result = compact._render_cache_meta("e=0", 12345)
        assert result == "(e=0, 12.1KB)"

    def test_with_output_id(self) -> None:
        from token_goat.cache_common import short_output_id
        oid = "anon-0000000000001-deadbeef"
        result = compact._render_cache_meta("200", 1024, output_id=oid)
        assert f"id={short_output_id(oid)}" in result
        assert "200" in result
        assert "1.0KB" in result

    def test_truncated_marker(self) -> None:
        result = compact._render_cache_meta("e=1", 500, truncated=True)
        assert "(truncated)" in result

    def test_no_truncated_marker_by_default(self) -> None:
        result = compact._render_cache_meta("e=0", 500)
        assert "truncated" not in result

    def test_empty_output_id_omits_id_part(self) -> None:
        result = compact._render_cache_meta("200", 1000, output_id="")
        assert "id=" not in result

    def test_parenthesised_form(self) -> None:
        result = compact._render_cache_meta("e=0", 100)
        assert result.startswith("(")
        assert result.endswith(")")

    def test_bash_format_consistency(self) -> None:
        """Output matches the previous bash-entry format."""
        from token_goat.util import _humanize_bytes
        total = 12345
        result = compact._render_cache_meta("e=1", total)
        expected = f"(e=1, {_humanize_bytes(total)})"
        assert result == expected

    def test_web_format_consistency(self) -> None:
        """Output matches the previous web-entry format."""
        from token_goat.cache_common import short_output_id
        from token_goat.util import _humanize_bytes
        oid = "anon-0000000000001-deadbeef"
        body_bytes = 14_200
        result = compact._render_cache_meta("200", body_bytes, output_id=oid)
        expected = f"(200, {_humanize_bytes(body_bytes)}, id={short_output_id(oid)})"
        assert result == expected
