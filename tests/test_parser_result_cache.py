"""Tests for the SHA-keyed extraction result LRU cache in parser.py.

These tests focus on call-count assertions rather than wall-clock — the
cache's value is "we don't call the extractor twice for the same bytes",
which is invariant across hardware.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest

from token_goat import parser
from token_goat.parser import (
    ImpExp,
    Ref,
    Section,
    Symbol,
    index_file,
    parser_cache_clear,
    parser_cache_stats,
    register_extractor,
)


@pytest.fixture(autouse=True)
def _isolate_result_cache():
    """Reset the parser result cache and extractor registry around each test."""
    parser_cache_clear()
    # Snapshot the extractor registry / cache so tests that register fake
    # extractors don't leak into later tests.
    saved_registry = dict(parser._EXTRACTOR_REGISTRY)
    saved_cache = dict(parser._EXTRACTOR_CACHE)
    yield
    parser._EXTRACTOR_REGISTRY.clear()
    parser._EXTRACTOR_REGISTRY.update(saved_registry)
    parser._EXTRACTOR_CACHE.clear()
    parser._EXTRACTOR_CACHE.update(saved_cache)
    parser_cache_clear()


def test_result_cache_starts_empty():
    stats = parser_cache_stats()
    assert stats == {"hits": 0, "misses": 0, "evictions": 0, "size": 0}


def test_same_bytes_hits_cache_and_skips_extractor(py_project_unindexed):
    """Indexing the same file twice must only invoke the extractor once."""
    proj = py_project_unindexed
    file_path = next(proj.root.rglob("*.py"))

    call_count = {"n": 0}
    real_extract = parser.get_extractor("python")
    assert real_extract is not None

    def counting_extract(source: bytes, rel: str):
        call_count["n"] += 1
        return real_extract(source, rel)

    register_extractor("python", lambda: counting_extract)

    fi1 = index_file(proj, file_path)
    fi2 = index_file(proj, file_path)

    assert fi1 is not None and fi2 is not None
    assert call_count["n"] == 1, "second index_file must reuse cached extraction"
    assert parser_cache_stats()["hits"] == 1
    assert parser_cache_stats()["misses"] == 1
    # Cached result mirrors the live result
    assert {s.name for s in fi1.symbols} == {s.name for s in fi2.symbols}


def test_content_change_misses_cache(py_project_unindexed):
    """Different bytes produce a different SHA — the cache must NOT short-circuit."""
    proj = py_project_unindexed
    file_path = next(proj.root.rglob("*.py"))
    original = file_path.read_bytes()

    call_count = {"n": 0}

    def fake_extract(source: bytes, rel: str):
        call_count["n"] += 1
        return [Symbol(name="x", kind="function", line=1)], [], [], []

    register_extractor("python", lambda: fake_extract)
    parser._EXTRACTOR_CACHE.pop("python", None)

    index_file(proj, file_path)
    file_path.write_bytes(original + b"\n# tweak\n")
    index_file(proj, file_path)

    assert call_count["n"] == 2
    stats = parser_cache_stats()
    assert stats["misses"] == 2
    assert stats["hits"] == 0


def test_cache_returns_independent_lists(py_project_unindexed):
    """Cached payload must be copy-safe: mutating one FileIndex's list must
    not corrupt subsequent cache hits."""
    proj = py_project_unindexed
    file_path = next(proj.root.rglob("*.py"))

    fi1 = index_file(proj, file_path)
    assert fi1 is not None
    fi1.symbols.clear()
    fi1.refs.clear()
    fi2 = index_file(proj, file_path)
    assert fi2 is not None
    # Second hit must still have full symbol/ref payloads.
    assert len(fi2.symbols) > 0 or len(fi2.refs) > 0


def test_lru_evicts_oldest_entry():
    """When the LRU exceeds _RESULT_CACHE_MAX, the least-recently-used entry evicts."""
    original_max = parser._RESULT_CACHE_MAX
    try:
        # Shrink ceiling for the test.  Direct module attr access is OK because
        # the cache code reads _RESULT_CACHE_MAX dynamically inside _put.
        parser._RESULT_CACHE_MAX = 3  # type: ignore[misc]
        for i in range(5):
            parser._result_cache_put(
                "fake",
                f"sha{i}",
                ([Symbol(name=f"s{i}", kind="var", line=1)], [], [], []),
            )
        stats = parser_cache_stats()
        assert stats["size"] == 3
        assert stats["evictions"] == 2
        # Earliest entries should be gone, most recent should remain.
        assert parser._result_cache_get("fake", "sha0") is None
        assert parser._result_cache_get("fake", "sha4") is not None
    finally:
        parser._RESULT_CACHE_MAX = original_max  # type: ignore[misc]


def test_parser_cache_clear_resets_stats():
    parser._result_cache_put(
        "x", "abc", ([Symbol(name="a", kind="var", line=1)], [], [], [])
    )
    parser._result_cache_get("x", "abc")  # hit
    parser._result_cache_get("x", "missing")  # miss
    s_before = parser_cache_stats()
    assert s_before["hits"] >= 1 and s_before["misses"] >= 1

    parser_cache_clear()
    s_after = parser_cache_stats()
    assert s_after == {"hits": 0, "misses": 0, "evictions": 0, "size": 0}


def test_cache_key_includes_language():
    """Same bytes-SHA but different language must be cached independently."""
    sha = "deadbeef"
    payload_a: tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]] = (
        [Symbol(name="A", kind="function", line=1)], [], [], []
    )
    payload_b: tuple[list[Symbol], list[Ref], list[ImpExp], list[Section]] = (
        [Symbol(name="B", kind="class", line=1)], [], [], []
    )
    parser._result_cache_put("python", sha, payload_a)
    parser._result_cache_put("typescript", sha, payload_b)

    hit_a = parser._result_cache_get("python", sha)
    hit_b = parser._result_cache_get("typescript", sha)
    assert hit_a is not None and hit_a[0][0].name == "A"
    assert hit_b is not None and hit_b[0][0].name == "B"


def test_extractor_failure_is_not_cached(py_project_unindexed):
    """When the extractor crashes, the next call must retry — never cache a
    failed parse, otherwise a transient bug becomes sticky."""
    proj = py_project_unindexed
    file_path = next(proj.root.rglob("*.py"))

    call_count = {"n": 0}

    def crashing_extract(source: bytes, rel: str):
        call_count["n"] += 1
        raise RuntimeError("simulated grammar fault")

    register_extractor("python", lambda: crashing_extract)
    parser._EXTRACTOR_CACHE.pop("python", None)

    with patch.object(parser._LOG, "exception"):
        index_file(proj, file_path)
        index_file(proj, file_path)

    assert call_count["n"] == 2, "crashing extractor must be retried, not cached"
    assert parser_cache_stats()["hits"] == 0
