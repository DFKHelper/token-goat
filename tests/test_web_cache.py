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
            # Disable compression so the on-disk size matches the input size for
            # predictable eviction assertions.
            m = web_cache.store_output(
                f"sess{i}", f"https://b.example/{i}", "X" * 50_000, 200,
                compress_bodies=False,
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


class TestGetOutputSize:
    def test_size_from_sidecar(self, tmp_data_dir):
        """get_output_size returns body_bytes from sidecar metadata."""
        body = "X" * 15_000
        meta = web_cache.store_output("sess-size-1", "https://example.com/doc", body, 200)
        assert meta is not None
        web_cache.write_sidecar(meta)

        size = web_cache.get_output_size(meta.output_id)
        assert size is not None
        assert size == 15_000, f"Expected 15000 bytes, got {size}"

    def test_size_fallback_to_disk(self, tmp_data_dir):
        """get_output_size falls back to file size when sidecar is absent."""
        body = "Y" * 12_000
        meta = web_cache.store_output("sess-size-2", "https://example.com/api", body, 200)
        assert meta is not None
        # Deliberately do not write sidecar; should fall back to disk file size

        size = web_cache.get_output_size(meta.output_id)
        assert size is not None
        # File size may be slightly different due to encoding; check it's in range
        assert 11_900 < size < 12_100, f"Expected ~12000 bytes, got {size}"

    def test_size_for_missing_output(self, tmp_data_dir):
        """get_output_size returns None for non-existent output."""
        size = web_cache.get_output_size("nonexistent-id-12345")
        assert size is None

    def test_size_for_truncated_output(self, tmp_data_dir):
        """get_output_size returns original body_bytes even for truncated outputs."""
        # Create a response larger than max_stored_bytes
        big_body = "Z" * (3 * 1024 * 1024)  # 3 MB, will be truncated to ~2 MB on disk
        meta = web_cache.store_output("sess-size-3", "https://example.com/large", big_body, 200)
        assert meta is not None
        assert meta.truncated is True
        web_cache.write_sidecar(meta)

        # get_output_size should return the original body_bytes, not the truncated size
        size = web_cache.get_output_size(meta.output_id)
        assert size is not None
        assert size == 3 * 1024 * 1024, f"Expected original 3MB, got {size} bytes"


class TestGzipCompression:
    """Tests for gzip-compressed web cache storage (compress_bodies=True)."""

    def test_large_body_stored_compressed(self, tmp_data_dir):
        """Bodies above compress_min_bytes threshold are stored as .gz files."""
        from pathlib import Path

        body = "Large web page content. " * 1000  # ~24 KB — above 16 KB default threshold
        meta = web_cache.store_output(
            "sess-gz-1",
            "https://example.com/large-page",
            body,
            200,
            compress_bodies=True,
            compress_min_bytes=16 * 1024,
        )
        assert meta is not None

        cache_dir = web_cache._web_outputs_dir()
        gz_path = Path(cache_dir) / (meta.output_id + ".gz")
        txt_path = Path(cache_dir) / (meta.output_id + ".txt")

        assert gz_path.exists(), ".gz file must exist for large compressed body"
        assert txt_path.exists(), ".txt stub must exist for eviction machinery"
        # Compressed file must be smaller than the raw body
        assert gz_path.stat().st_size < len(body.encode("utf-8")), "gzip file should be smaller than raw body"

    def test_compressed_body_transparent_read(self, tmp_data_dir):
        """load_output transparently decompresses .gz stored bodies."""
        body = "Readable page content with text. " * 600  # ~20 KB
        meta = web_cache.store_output(
            "sess-gz-2",
            "https://example.com/readable",
            body,
            200,
            compress_bodies=True,
            compress_min_bytes=8 * 1024,
        )
        assert meta is not None

        loaded = web_cache.load_output(meta.output_id)
        assert loaded is not None
        assert "Readable page content" in loaded

    def test_small_body_not_compressed(self, tmp_data_dir):
        """Bodies below compress_min_bytes are stored as plain text, not compressed."""
        from pathlib import Path

        body = "Short page"  # well below 16 KB threshold
        meta = web_cache.store_output(
            "sess-gz-3",
            "https://example.com/short",
            body,
            200,
            compress_bodies=True,
            compress_min_bytes=16 * 1024,
        )
        assert meta is not None

        cache_dir = web_cache._web_outputs_dir()
        gz_path = Path(cache_dir) / (meta.output_id + ".gz")
        txt_path = Path(cache_dir) / (meta.output_id + ".txt")

        assert txt_path.exists(), ".txt file must exist for small (uncompressed) body"
        assert not gz_path.exists(), ".gz file must NOT exist for small body"

        loaded = web_cache.load_output(meta.output_id)
        assert loaded is not None and "Short page" in loaded

    def test_compress_disabled_stores_plain_text(self, tmp_data_dir):
        """When compress_bodies=False, bodies are always stored as plain text."""
        from pathlib import Path

        body = "Large page body for testing. " * 2000  # ~60 KB — above any threshold
        meta = web_cache.store_output(
            "sess-gz-4",
            "https://example.com/no-compress",
            body,
            200,
            compress_bodies=False,
            compress_min_bytes=16 * 1024,
        )
        assert meta is not None

        cache_dir = web_cache._web_outputs_dir()
        gz_path = Path(cache_dir) / (meta.output_id + ".gz")
        txt_path = Path(cache_dir) / (meta.output_id + ".txt")

        assert txt_path.exists(), ".txt file must exist when compression is disabled"
        assert not gz_path.exists(), ".gz file must NOT exist when compression is disabled"

        loaded = web_cache.load_output(meta.output_id)
        assert loaded is not None and "Large page body" in loaded

    def test_load_output_falls_back_to_plain_when_no_gz(self, tmp_data_dir):
        """load_output still reads plain .txt files (backward compat with pre-compression entries)."""
        # Store without compression to simulate an old cache entry
        body = "Old cache entry without compression. " * 300
        meta = web_cache.store_output(
            "sess-gz-5",
            "https://example.com/old-entry",
            body,
            200,
            compress_bodies=False,
        )
        assert meta is not None

        # load_output must still find and return the plain-text body
        loaded = web_cache.load_output(meta.output_id)
        assert loaded is not None
        assert "Old cache entry" in loaded

    def test_config_compress_bodies_wires_through(self, tmp_data_dir, monkeypatch):
        """compress_bodies from WebFetchConfig is passed through the post_fetch hook."""
        from pathlib import Path

        from token_goat import config

        # Monkeypatch config to disable compression
        original_load = config.load

        def _patched_load():
            cfg = original_load()
            cfg.webfetch.compress_bodies = False
            return cfg

        monkeypatch.setattr(config, "load", _patched_load)

        body = "Substantial page body content. " * 1000  # ~32 KB
        payload = {
            "session_id": "cfg-gz-1",
            "tool_name": "WebFetch",
            "tool_input": {"url": "https://example.com/cfg-test"},
            "tool_response": {"output": body, "status_code": 200},
        }
        _assert_continue(hooks_fetch.post_fetch(payload))

        # Find the cached entry
        from token_goat import session as _session
        cache = _session.load("cfg-gz-1")
        assert len(cache.web_history) == 1
        entry = next(iter(cache.web_history.values()))

        cache_dir = web_cache._web_outputs_dir()
        gz_path = Path(cache_dir) / (entry.output_id + ".gz")
        assert not gz_path.exists(), "When compress_bodies=False in config, .gz must not be created"


# ---------------------------------------------------------------------------
# Sub-area D: content-type routing — JSON compressor
# ---------------------------------------------------------------------------

class TestIsJsonResponse:
    """_is_json_response detects JSON via content-type or body prefix."""

    def test_json_content_type_returns_true(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response("{}", "application/json") is True

    def test_json_content_type_with_charset(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response("{}", "application/json; charset=utf-8") is True

    def test_object_body_without_content_type(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response('{"key": "val"}', None) is True

    def test_array_body_without_content_type(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response('[{"a": 1}]', None) is True

    def test_html_body_returns_false(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response("<html></html>", "text/html") is False

    def test_plain_text_returns_false(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response("just text", None) is False

    def test_whitespace_before_brace_detected(self):
        from token_goat.web_cache import _is_json_response
        assert _is_json_response('   {"a": 1}', None) is True


class TestCompressJsonBody:
    """_compress_json_body preserves keys but truncates long string values."""

    def test_short_strings_are_preserved(self):
        import json

        from token_goat.web_cache import _compress_json_body
        body = json.dumps({"name": "Alice", "age": 30})
        result = _compress_json_body(body, max_string_chars=200)
        data = json.loads(result)
        assert data["name"] == "Alice"
        assert data["age"] == 30

    def test_long_string_is_truncated(self):
        import json

        from token_goat.web_cache import _compress_json_body
        long_val = "X" * 500
        body = json.dumps({"data": long_val, "name": "Bob"})
        result = _compress_json_body(body, max_string_chars=200)
        data = json.loads(result)
        # data key preserved, string truncated
        assert "data" in data
        assert len(data["data"]) < len(long_val)
        assert "more chars" in data["data"]
        # Short string preserved
        assert data["name"] == "Bob"

    def test_nested_objects_have_strings_truncated(self):
        import json

        from token_goat.web_cache import _compress_json_body
        body = json.dumps({"outer": {"inner": "A" * 300}})
        result = _compress_json_body(body, max_string_chars=50)
        data = json.loads(result)
        assert "more chars" in data["outer"]["inner"]

    def test_list_values_truncated(self):
        import json

        from token_goat.web_cache import _compress_json_body
        body = json.dumps(["short", "B" * 300])
        result = _compress_json_body(body, max_string_chars=100)
        data = json.loads(result)
        assert data[0] == "short"
        assert "more chars" in data[1]

    def test_invalid_json_returned_unchanged(self):
        from token_goat.web_cache import _compress_json_body
        not_json = "this is not json {broken}"
        result = _compress_json_body(not_json)
        assert result == not_json

    def test_non_string_values_preserved(self):
        import json

        from token_goat.web_cache import _compress_json_body
        body = json.dumps({"count": 42, "flag": True, "nothing": None, "pi": 3.14})
        result = _compress_json_body(body)
        data = json.loads(result)
        assert data["count"] == 42
        assert data["flag"] is True
        assert data["nothing"] is None


class TestStoreOutputJsonRouting:
    """store_output applies JSON compressor when content-type is JSON."""

    def test_json_response_has_string_values_truncated(self, tmp_data_dir):
        """store_output compresses long JSON string values before caching."""
        import json

        from token_goat import web_cache

        big_json = json.dumps({"key": "V" * 1000, "short": "ok"})
        meta = web_cache.store_output(
            "sess-json-1", "https://api.example.com/data", big_json, 200,
            content_type="application/json",
        )
        assert meta is not None
        body = web_cache.load_output(meta.output_id)
        assert body is not None
        # The stored body should have the long value truncated
        data = json.loads(body)
        assert "more chars" in data["key"]
        # Short value preserved
        assert data["short"] == "ok"

    def test_html_response_not_json_compressed(self, tmp_data_dir):
        """HTML responses bypass the JSON compressor (stored as-is)."""
        from token_goat import web_cache

        html = "<html><body>" + "X" * 500 + "</body></html>"
        meta = web_cache.store_output(
            "sess-html-1", "https://example.com/page", html, 200,
            content_type="text/html",
        )
        assert meta is not None
        body = web_cache.load_output(meta.output_id)
        assert body is not None
        # HTML body should NOT have JSON truncation markers
        assert "more chars" not in body
        assert "X" * 100 in body  # content preserved


class TestSidecarContentType:
    """content_type is stored in the sidecar JSON and round-tripped by read_sidecar."""

    def test_content_type_preserved_in_sidecar_round_trip(self, tmp_data_dir):
        """read_sidecar returns the content_type that was stored by store_output."""
        meta = web_cache.store_output(
            "sess-ct-1",
            "https://api.example.com/data",
            '{"key": "value"}' * 200,
            200,
            content_type="application/json",
        )
        assert meta is not None
        assert meta.content_type == "application/json"
        web_cache.write_sidecar(meta)
        loaded = web_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.content_type == "application/json"

    def test_content_type_html_round_trip(self, tmp_data_dir):
        """read_sidecar preserves text/html content_type."""
        body = "<html><body>" + "X" * 2000 + "</body></html>"
        meta = web_cache.store_output(
            "sess-ct-2",
            "https://example.com/page",
            body,
            200,
            content_type="text/html; charset=utf-8",
        )
        assert meta is not None
        assert meta.content_type == "text/html; charset=utf-8"
        web_cache.write_sidecar(meta)
        loaded = web_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.content_type == "text/html; charset=utf-8"

    def test_content_type_none_when_not_provided(self, tmp_data_dir):
        """read_sidecar returns None for content_type when not stored."""
        meta = web_cache.store_output(
            "sess-ct-3",
            "https://example.com/unknown",
            "some body content " * 200,
            200,
        )
        assert meta is not None
        assert meta.content_type is None
        web_cache.write_sidecar(meta)
        loaded = web_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.content_type is None

    def test_content_type_absent_in_old_sidecar_returns_none(self, tmp_data_dir):
        """Older sidecars without a content_type field are tolerated (field defaults to None)."""
        import json

        # Write a sidecar JSON manually without the content_type key (simulates old format)
        meta = web_cache.store_output(
            "sess-ct-4",
            "https://legacy.example.com/",
            "legacy body " * 200,
            200,
            content_type="text/plain",
        )
        assert meta is not None
        # Write sidecar and then patch out content_type from the JSON
        web_cache.write_sidecar(meta)
        from token_goat.web_cache import sidecar_meta_path
        p = sidecar_meta_path(meta.output_id)
        assert p is not None and p.exists()
        data = json.loads(p.read_text(encoding="utf-8"))
        data.pop("content_type", None)
        p.write_text(json.dumps(data), encoding="utf-8")

        loaded = web_cache.read_sidecar(meta.output_id)
        assert loaded is not None
        assert loaded.content_type is None  # gracefully defaults to None
