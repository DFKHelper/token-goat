"""Tests for the web_cache disk store + post_fetch / pre_fetch dedup."""
from __future__ import annotations

from hook_helpers import assert_continue as _assert_continue

from token_goat import hooks_fetch, session, web_cache


class TestStoreAndLoad:
    def test_small_round_trip(self, tmp_data_dir):
        meta = web_cache.store_output(
            "sess1", "https://example.com/page", "page body" * 200, 200,
        )
        assert meta is not None
        assert meta.status_code == 200
        body = web_cache.load_output(meta.output_id)
        assert body is not None and "page body" in body
        assert meta.truncated is False

    def test_large_output_is_tail_preserved(self, tmp_data_dir):
        big = "B" * (3 * 1024 * 1024)
        meta = web_cache.store_output("sess2", "https://big.example", big, 200)
        assert meta is not None and meta.truncated is True
        body = web_cache.load_output(meta.output_id)
        assert body is not None and body.endswith("B")
        assert "token-goat: web output truncated" in body

    def test_sidecar_round_trip(self, tmp_data_dir):
        meta = web_cache.store_output("sess3", "https://a.example", "X" * 2000, 404)
        assert meta is not None
        web_cache.write_sidecar(meta)
        loaded = web_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.status_code == 404
        assert loaded.url_sha == meta.url_sha

    def test_evict_removes_paired_sidecars(self, tmp_data_dir):
        metas = []
        for i in range(5):
            m = web_cache.store_output(
                f"sess{i}", f"https://e.example/{i}", "X" * 200_000, 200,
            )
            assert m is not None
            web_cache.write_sidecar(m)
            metas.append(m)

        web_cache.evict_old_entries(max_total_bytes=300_000)

        from pathlib import Path as _Path

        for m in metas:
            body = _Path(web_cache._web_outputs_dir()) / f"{m.output_id}.txt"
            sidecar = web_cache.sidecar_meta_path(m.output_id)
            assert sidecar is not None
            if not body.exists():
                assert not sidecar.exists()

    def test_evict_by_file_count(self, tmp_data_dir):
        """Eviction removes oldest entries when file count cap is exceeded."""
        metas = []
        for i in range(5):
            m = web_cache.store_output(
                f"sess{i}", f"https://f.example/{i}", "X" * 10_000, 200,
            )
            assert m is not None
            metas.append(m)

        removed = web_cache.evict_old_entries(max_file_count=3, max_total_bytes=10 * 1024 * 1024)
        assert removed >= 2  # At least the two oldest should be evicted

        from pathlib import Path as _Path
        remaining = 0
        for m in metas:
            body = _Path(web_cache._web_outputs_dir()) / f"{m.output_id}.txt"
            if body.exists():
                remaining += 1
        assert remaining <= 3

    def test_evict_by_byte_cap(self, tmp_data_dir):
        """Eviction removes oldest entries when byte cap is exceeded."""
        metas = []
        for i in range(5):
            m = web_cache.store_output(
                f"sess{i}", f"https://b.example/{i}", "X" * 50_000, 200,
            )
            assert m is not None
            metas.append(m)

        removed = web_cache.evict_old_entries(max_total_bytes=100_000, max_file_count=100)
        assert removed >= 2  # At least the two oldest should be evicted

        from pathlib import Path as _Path
        total_size = 0
        for m in metas:
            body = _Path(web_cache._web_outputs_dir()) / f"{m.output_id}.txt"
            if body.exists():
                total_size += body.stat().st_size
        assert total_size <= 100_000

    def test_store_output_eviction_oserror_does_not_discard_write(self, tmp_data_dir, monkeypatch):
        """A confirmed write must return metadata even if eviction raises OSError.

        Regression: evict_old_entries previously ran inside safe_cache_op, so an OSError
        during the directory walk caused the context manager to suppress the exception and
        return None — discarding a successful write even though the file was on disk.
        """
        def _bad_evict(**kwargs):
            raise OSError("antivirus lock simulation")

        monkeypatch.setattr(web_cache, "evict_old_entries", _bad_evict)

        meta = web_cache.store_output("sess_evict_err", "https://example.com/test", "page content", 200)
        assert meta is not None, "store_output must succeed even when eviction raises OSError"
        body = web_cache.load_output(meta.output_id)
        assert body is not None and "page content" in body


class TestPostFetchHook:
    def test_small_body_skipped(self, tmp_data_dir):
        payload = {
            "session_id": "pf-1",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/page"},
            "tool_response": {"output": "short", "status_code": 200},
        }
        _assert_continue(hooks_fetch.post_fetch(payload))
        cache = session.load("pf-1")
        assert not cache.web_history

    def test_large_body_cached(self, tmp_data_dir):
        body = "X" * 5000
        payload = {
            "session_id": "pf-2",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/big"},
            "tool_response": {"output": body, "status_code": 200},
        }
        _assert_continue(hooks_fetch.post_fetch(payload))
        cache = session.load("pf-2")
        assert len(cache.web_history) == 1
        entry = next(iter(cache.web_history.values()))
        assert entry.body_bytes == 5000
        assert entry.status_code == 200
        loaded = web_cache.load_output(entry.output_id)
        assert loaded is not None and loaded.startswith("X")

    def test_image_url_not_cached(self, tmp_data_dir):
        """Image URLs are handled by the existing image-cache; not double-cached here."""
        payload = {
            "session_id": "pf-3",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/photo.png"},
            "tool_response": {"output": "X" * 5000, "status_code": 200},
        }
        _assert_continue(hooks_fetch.post_fetch(payload))
        cache = session.load("pf-3")
        assert not cache.web_history

    def test_non_webfetch_tool_skipped(self, tmp_data_dir):
        payload = {
            "session_id": "pf-4",
            "tool_name": "Bash",
            "tool_input": {"command": "ls"},
            "tool_response": {"stdout": "X" * 5000, "exit_code": 0},
        }
        _assert_continue(hooks_fetch.post_fetch(payload))

    def test_content_array_response(self, tmp_data_dir):
        """An MCP content-array response shape is concatenated into the body."""
        payload = {
            "session_id": "pf-5",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/api"},
            "tool_response": {
                "output": [
                    {"type": "text", "text": "X" * 3000},
                    {"type": "text", "text": "Y" * 3000},
                ],
                "status": 201,
            },
        }
        _assert_continue(hooks_fetch.post_fetch(payload))
        cache = session.load("pf-5")
        assert len(cache.web_history) == 1
        entry = next(iter(cache.web_history.values()))
        assert entry.body_bytes == 6000
        assert entry.status_code == 201


class TestPreFetchDedup:
    def test_repeat_url_triggers_hint(self, tmp_data_dir):
        # Seed via the post-fetch path so the session + disk cache are
        # populated in the same way real flow would write them.
        hooks_fetch.post_fetch({
            "session_id": "dedup-1",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://docs.example/x"},
            "tool_response": {"output": "X" * 5000, "status_code": 200},
        })
        result = hooks_fetch.pre_fetch({
            "session_id": "dedup-1",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://docs.example/x"},
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        ctx = hso.get("additionalContext", "")
        assert "token-goat web-output" in ctx

    def test_distinct_url_no_hint(self, tmp_data_dir):
        hooks_fetch.post_fetch({
            "session_id": "dedup-2",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://docs.example/a"},
            "tool_response": {"output": "X" * 5000, "status_code": 200},
        })
        result = hooks_fetch.pre_fetch({
            "session_id": "dedup-2",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://docs.example/b"},  # different
        })
        _assert_continue(result)
        assert "hookSpecificOutput" not in result

    def test_image_url_still_redirected(self, tmp_data_dir):
        """Image WebFetch URLs still get the image-redirect treatment."""
        result = hooks_fetch.pre_fetch({
            "session_id": "dedup-3",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/cat.jpg"},
        })
        _assert_continue(result)
        hso = result.get("hookSpecificOutput")
        assert hso is not None
        assert hso.get("permissionDecision") == "deny"


class TestUrlNormalization:
    def test_fragment_stripped(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("https://example.com/page#section")
        assert h1 == h2, "Fragment-only difference should yield the same cache key"

    def test_scheme_case_normalized(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("HTTPS://example.com/page")
        assert h1 == h2, "Scheme case difference should yield the same cache key"

    def test_default_port_stripped_https(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("https://example.com:443/page")
        assert h1 == h2, "Default HTTPS port 443 should be stripped from cache key"

    def test_default_port_stripped_http(self):
        h1 = web_cache.url_hash("http://example.com/page")
        h2 = web_cache.url_hash("http://example.com:80/page")
        assert h1 == h2, "Default HTTP port 80 should be stripped from cache key"

    def test_non_default_port_preserved(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("https://example.com:8443/page")
        assert h1 != h2, "Non-default port should produce a different cache key"

    def test_query_string_preserved(self):
        h1 = web_cache.url_hash("https://example.com/page?q=1")
        h2 = web_cache.url_hash("https://example.com/page?q=2")
        assert h1 != h2, "Different query strings should produce different cache keys"

    def test_trailing_slash_preserved(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("https://example.com/page/")
        assert h1 != h2, "Trailing slash difference should produce different cache keys"

    def test_fragment_and_scheme_combined(self):
        h1 = web_cache.url_hash("https://example.com/page")
        h2 = web_cache.url_hash("HTTPS://example.com/page#anchor")
        assert h1 == h2, "Combined scheme-case and fragment normalization should match"

    def test_normalize_url_returns_string_on_malformed(self):
        malformed = "not a url at all !!!"
        result = web_cache._normalize_url(malformed)
        assert isinstance(result, str)


class TestFindCachedConcurrentDeletion:
    def test_find_cached_for_url_tolerates_concurrent_deletion(self, tmp_data_dir):
        """find_cached_for_url returns a result even if some sidecars are concurrently deleted.

        Regression test for TOCTOU: sorted(..., key=lambda p: p.stat().st_mtime)
        would raise OSError if a sidecar was deleted between glob() and stat().
        The OSError would propagate to safe_cache_op and make the whole function
        return None, silently dropping a valid cache hit.
        """
        from pathlib import Path
        from unittest.mock import patch

        url = "https://example.com/docs/api"
        body = "API docs content " * 100

        # Store two entries for the same URL so there are multiple sidecars.
        meta1 = web_cache.store_output("sess-del-a", url, body, 200)
        assert meta1 is not None
        web_cache.write_sidecar(meta1)
        meta2 = web_cache.store_output("sess-del-b", url, body + " v2", 200)
        assert meta2 is not None
        web_cache.write_sidecar(meta2)

        original_stat = Path.stat

        def flaky_stat(self: Path, **kwargs: object) -> object:
            # Simulate one sidecar being deleted during the sort by raising
            # OSError on the first stat() call inside the sort key.
            if self.suffix == ".json" and "sess-del-a" in self.name:
                raise OSError("simulated concurrent deletion")
            return original_stat(self, **kwargs)

        with patch.object(Path, "stat", flaky_stat):
            result = web_cache.find_cached_for_url(url)

        # The lookup must still succeed using the surviving sidecar.
        assert result is not None
        assert result.url_sha == web_cache.url_hash(url)
