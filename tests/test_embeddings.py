"""Tests for the embeddings module (Phase 8)."""
from __future__ import annotations

import hashlib
import json
import math
import sqlite3
import struct
from collections.abc import Sequence
from unittest.mock import MagicMock, patch

import pytest

from token_goat import db
from token_goat import embeddings as emb
from token_goat.embeddings import (
    EmbeddingsUnavailable,
    SearchHit,
    _check_vec_available,
    _pack_vec,
    extract_chunks_for_file,
    is_available,
    merge_nearby_hits,
)

# ---------------------------------------------------------------------------
# Unit tests (no model download needed)
# ---------------------------------------------------------------------------

def test_is_available_true():
    """fastembed is listed in deps and installed — must be importable."""
    assert is_available() is True


def test_pack_vec_byte_length():
    """_pack_vec([1.0, 2.0, 3.0]) should produce exactly 12 bytes (3 floats * 4 bytes)."""
    result = _pack_vec([1.0, 2.0, 3.0])
    assert len(result) == 12


def test_pack_vec_round_trips():
    """Bytes packed by _pack_vec unpack back to the original floats."""
    original = [0.1, 0.5, -0.3, 1.0]
    packed = _pack_vec(original)
    unpacked = list(struct.unpack(f"{len(original)}f", packed))
    assert len(unpacked) == len(original)
    for a, b in zip(unpacked, original, strict=True):
        assert abs(a - b) < 1e-5


def test_check_vec_available_true(tmp_data_dir):
    """_check_vec_available returns True when sqlite-vec is loaded."""
    with db.open_project("e0bedded0e0bedded0e0bedded0e0bedded00001") as conn:
        assert _check_vec_available(conn) is True


def test_check_vec_available_false():
    """_check_vec_available returns False when vec_version() isn't callable."""
    conn = MagicMock()
    conn.execute.side_effect = sqlite3.OperationalError("no such function: vec_version")
    assert _check_vec_available(conn) is False


def test_extract_chunks_for_file_finds_symbols(ts_project):
    """extract_chunks_for_file returns chunks for greet, UserService from ts_sample."""
    with db.open_project(ts_project.hash) as conn:
        chunks = extract_chunks_for_file(ts_project, conn, "index.ts")

    assert len(chunks) >= 1
    kinds = {c.kind for c in chunks}
    # Should find at least function/class chunks
    assert kinds & {"function", "class", "method", "interface", "type"}


def test_extract_chunks_greet_content(ts_project):
    """The greet function chunk text contains 'hello'."""
    with db.open_project(ts_project.hash) as conn:
        chunks = extract_chunks_for_file(ts_project, conn, "index.ts")

    greet_chunks = [c for c in chunks if "greet" in c.text and c.kind == "function"]
    assert greet_chunks, "Expected at least one chunk containing greet function"
    assert "hello" in greet_chunks[0].text.lower()


def test_extract_chunks_text_length_bounds(ts_project):
    """All returned chunks respect MIN_CHUNK_CHARS and MAX_CHUNK_CHARS."""
    with db.open_project(ts_project.hash) as conn:
        chunks = extract_chunks_for_file(ts_project, conn, "index.ts")

    for chunk in chunks:
        assert emb.MIN_CHUNK_CHARS <= len(chunk.text) <= emb.MAX_CHUNK_CHARS, (
            f"Chunk out of bounds: {len(chunk.text)} chars, kind={chunk.kind}"
        )


def test_extract_chunks_empty_file(ts_project):
    """extract_chunks_for_file returns [] for an empty file."""
    empty_file = ts_project.root / "empty.ts"
    empty_file.write_text("", encoding="utf-8")
    # File not in DB index — should not crash, just return []
    with db.open_project(ts_project.hash) as conn:
        chunks = extract_chunks_for_file(ts_project, conn, "empty.ts")
    assert chunks == []


def test_extract_chunks_missing_file(ts_project):
    """extract_chunks_for_file returns [] when the file doesn't exist."""
    with db.open_project(ts_project.hash) as conn:
        chunks = extract_chunks_for_file(ts_project, conn, "nonexistent.ts")
    assert chunks == []


def test_embeddings_unavailable_when_fastembed_missing(ts_project):
    """index_project_embeddings raises EmbeddingsUnavailable if fastembed missing."""
    with (
        patch.object(emb, "is_available", return_value=False),
        pytest.raises(EmbeddingsUnavailable, match="fastembed not installed"),
    ):
        emb.index_project_embeddings(ts_project)


def test_semantic_search_unavailable_when_fastembed_missing(ts_project):
    """semantic_search raises EmbeddingsUnavailable if fastembed is not installed."""
    with (
        patch.object(emb, "is_available", return_value=False),
        pytest.raises(EmbeddingsUnavailable, match="fastembed not installed"),
    ):
        emb.semantic_search(ts_project, "hello world")


def test_semantic_search_unavailable_when_vec_missing(ts_project):
    """semantic_search raises EmbeddingsUnavailable when sqlite-vec not loaded."""
    fake_vec = [0.1] * emb.DEFAULT_DIM
    with (
        patch.object(emb, "embed_texts", return_value=[fake_vec]),
        patch.object(emb, "_check_vec_available", return_value=False),
        pytest.raises(EmbeddingsUnavailable, match="sqlite-vec not loaded"),
    ):
        emb.semantic_search(ts_project, "hello world")


# ---------------------------------------------------------------------------
# CLI integration tests (no model download)
# ---------------------------------------------------------------------------

def test_cli_semantic_no_project(tmp_data_dir):
    """token-goat semantic when no project detected exits non-zero with helpful message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    runner = CliRunner()
    with patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(cli.app, ["semantic", "foo bar"], catch_exceptions=False)
    assert result.exit_code != 0
    assert "project" in result.output.lower()


def test_cli_semantic_no_embeddings(ts_project, monkeypatch):
    """token-goat semantic in a project with no embeddings exits 0 with helpful message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.chdir(ts_project.root)
    # Force embed_texts to raise so we exercise the EmbeddingsUnavailable path
    with patch.object(emb, "embed_texts", side_effect=EmbeddingsUnavailable("test")):
        runner = CliRunner()
        result = runner.invoke(cli.app, ["semantic", "test query"], catch_exceptions=False)
    assert result.exit_code == 0
    assert "embeddings unavailable" in result.output.lower()


def test_cli_index_embeddings_no_project(tmp_data_dir):
    """token-goat index --embeddings when no project detected exits non-zero with message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    runner = CliRunner()
    with patch("token_goat.project.find_project", return_value=None):
        result = runner.invoke(cli.app, ["index", "--embeddings"], catch_exceptions=False)
    assert result.exit_code != 0
    assert "no project detected" in result.output.lower()


# ---------------------------------------------------------------------------
# Stub-model integration: exercises the real sqlite-vec storage + query path
# without the ~130 MB fastembed download. The slow tests below cover the real
# model; these guard the storage/search plumbing on every CI run.
# ---------------------------------------------------------------------------

def _stub_embed(
    texts: Sequence[str], *, model_name: str = emb.DEFAULT_MODEL
) -> list[list[float]]:
    """Deterministic stand-in for embed_texts — no model, no download.

    Hashes each text into a fixed DEFAULT_DIM L2-normalized vector. Identical
    text always yields the identical vector (distance 0 on an exact-match
    query), which is enough to verify storage, MATCH/k querying, and distance
    ordering against real sqlite-vec.
    """
    out: list[list[float]] = []
    for text in texts:
        digest = hashlib.sha256(text.encode("utf-8", errors="replace")).digest()
        raw = (digest * (emb.DEFAULT_DIM // len(digest) + 1))[: emb.DEFAULT_DIM]
        vec = [b / 255.0 - 0.5 for b in raw]
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        out.append([x / norm for x in vec])
    return out


def test_embed_and_search_cycle_with_stub(ts_project, monkeypatch):
    """Full index + idempotency + search cycle against real sqlite-vec, stub model."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)

    result = emb.index_project_embeddings(ts_project)
    assert result["chunks_embedded"] > 0
    assert result["files_visited"] >= 1

    # Second pass: every chunk unchanged, so nothing is re-embedded.
    result2 = emb.index_project_embeddings(ts_project)
    assert result2["chunks_embedded"] == 0
    assert result2["chunks_skipped_unchanged"] == result["chunks_embedded"]

    # Searching with the exact text of an indexed chunk must surface that chunk
    # first, at ~0 distance, with results sorted by ascending distance.
    with db.open_project(ts_project.hash) as conn:
        row = conn.execute(
            "SELECT text, file_rel, start_line FROM chunks LIMIT 1"
        ).fetchone()

    hits = emb.semantic_search(ts_project, row["text"], k=5)
    assert hits, "expected at least one hit for an exact-match query"
    assert hits[0].text == row["text"]
    assert hits[0].file_rel == row["file_rel"]
    assert hits[0].distance < 1e-3
    assert hits == sorted(hits, key=lambda h: h.distance)


def test_cli_semantic_with_stub_embeddings(ts_project, monkeypatch):
    """`token-goat semantic` returns results after a stub-model embedding build."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    # The stub model produces ~uniform cosine distances (~1.28) for any
    # non-exact text, which sits above the production threshold of 1.2.
    # Pass a generous threshold so this test exercises CLI output, not the
    # threshold filter (covered separately).
    result = CliRunner().invoke(
        cli.app, ["semantic", "user service greeting", "-k", "3",
                  "--max-distance", "99", "--full"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    assert "d=" in result.output


# ---------------------------------------------------------------------------
# Offline end-to-end embedding cycle
# ---------------------------------------------------------------------------

def test_full_embedding_cycle(ts_project, monkeypatch):
    """Full embed + search cycle on ts_sample with an exact-match query."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    # Run embedding indexing
    result = emb.index_project_embeddings(ts_project)
    assert result["chunks_embedded"] > 0
    assert result["model"] == emb.DEFAULT_MODEL
    assert result["files_visited"] >= 1

    # Run again to verify idempotency (all chunks skipped on second pass)
    result2 = emb.index_project_embeddings(ts_project)
    assert result2["chunks_skipped_unchanged"] == result["chunks_embedded"]
    assert result2["chunks_embedded"] == 0

    # Semantic search — the exact chunk text should surface as the top hit.
    with db.open_project(ts_project.hash) as conn:
        row = conn.execute(
            "SELECT text, file_rel, start_line FROM chunks LIMIT 1"
        ).fetchone()

    hits = emb.semantic_search(ts_project, row["text"], k=5)
    assert len(hits) >= 1

    top = hits[0]
    assert top.text == row["text"]
    assert top.file_rel == row["file_rel"]
    assert 0.0 <= top.distance <= 2.0


def test_cli_semantic_with_embeddings(ts_project, monkeypatch):
    """CLI token-goat semantic returns results after embedding is built."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    runner = CliRunner()
    # See test_cli_semantic_with_stub_embeddings for why we relax the threshold.
    result = runner.invoke(
        cli.app,
        ["semantic", "hello name greeting", "-k", "3",
         "--max-distance", "99", "--full"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # Should print file:line-line (kind, d=...) format
    assert "index.ts" in result.output
    assert "d=" in result.output


# ---------------------------------------------------------------------------
# Re-rank helpers: pure-function unit tests (no DB, no model)
# ---------------------------------------------------------------------------

def test_is_generated_path_segment_match():
    """_is_generated_path matches whole POSIX segments, not substrings."""
    assert emb._is_generated_path("node_modules/foo/bar.js") is True
    assert emb._is_generated_path("a/dist/x.js") is True
    assert emb._is_generated_path("src/__pycache__/x.pyc") is True
    assert emb._is_generated_path("a/.venv/lib/x.py") is True
    # Windows-style paths in stored rel_paths must also match.
    assert emb._is_generated_path("a\\node_modules\\b.js") is True
    # Substring of a generated segment must NOT trigger (e.g. ``my_dist.py``).
    assert emb._is_generated_path("src/my_dist.py") is False
    assert emb._is_generated_path("src/distributed/x.py") is False
    assert emb._is_generated_path("") is False


def test_extract_query_tokens_splits_case_and_drops_short():
    """Camel/Pascal/snake tokens split; tokens < _MIN_TOKEN_LEN dropped."""
    toks = emb._extract_query_tokens("RateLimiter retry of N items")
    assert "rate" in toks
    assert "limiter" in toks
    assert "ratelimiter" in toks
    assert "retry" in toks
    # "of" / "n" should be dropped (under 3 chars).
    assert "of" not in toks
    assert "n" not in toks


def test_extract_query_tokens_empty():
    """Empty / whitespace queries produce an empty token set."""
    assert emb._extract_query_tokens("") == frozenset()
    assert emb._extract_query_tokens("a b c") == frozenset()  # all under min len


def test_verbatim_boost_caps_at_max():
    """A chunk containing every token must not exceed _MAX_VERBATIM_BOOST."""
    tokens = frozenset({"alpha", "beta", "gamma", "delta", "epsilon", "zeta"})
    text = " ".join(tokens)
    boost = emb._verbatim_boost(text, tokens)
    assert boost == pytest.approx(emb._MAX_VERBATIM_BOOST)
    assert boost > 0


def test_verbatim_boost_zero_when_no_overlap():
    """Disjoint tokens and text -> no boost."""
    assert emb._verbatim_boost("nothing relevant here", frozenset({"foo", "bar"})) == 0.0


def _row(file_rel: str, text: str, distance: float, *, start: int = 1, end: int = 5,
         kind: str = "function") -> dict:
    """Mimic the dict-like rows returned by sqlite3.Row for the re-ranker tests."""
    return {
        "file_rel": file_rel,
        "start_line": start,
        "end_line": end,
        "kind": kind,
        "text": text,
        "distance": distance,
    }


def test_rerank_demotes_generated_paths():
    """A real-source hit at the same raw distance must outrank a node_modules hit."""
    rows = [
        _row("node_modules/lib/index.js", "fn doStuff() {}", 0.10),
        _row("src/app.ts", "fn doStuff() {}", 0.12),
    ]
    hits = emb._rerank_hits(
        rows, "doStuff", k=5,
        max_distance=None, boost_verbatim=False, demote_generated=True,
    )
    assert [h.file_rel for h in hits] == ["src/app.ts", "node_modules/lib/index.js"]
    # The generated path's effective distance should be raw + penalty.
    gen_hit = next(h for h in hits if "node_modules" in h.file_rel)
    assert gen_hit.distance == pytest.approx(0.10 + emb._GENERATED_PATH_PENALTY)


def test_rerank_verbatim_boost_lifts_exact_match():
    """A chunk containing exact query tokens beats a higher-scoring paraphrase."""
    rows = [
        _row("src/a.py", "def throttle_helper(): pass", 0.30),       # closer raw match
        _row("src/b.py", "class RateLimiter: ...",     0.40),        # contains the verbatim token
    ]
    hits = emb._rerank_hits(
        rows, "RateLimiter", k=5,
        max_distance=None, boost_verbatim=True, demote_generated=False,
    )
    # b.py contains "ratelimiter", "rate", "limiter" — boost should overtake the
    # 0.10 raw gap.
    assert hits[0].file_rel == "src/b.py"
    assert hits[1].file_rel == "src/a.py"


def test_rerank_threshold_filters_low_confidence():
    """max_distance drops hits whose effective distance is above the threshold."""
    rows = [
        _row("src/a.py", "good match", 0.20),
        _row("src/b.py", "marginal",   0.80),
        _row("src/c.py", "noise",      1.50),
    ]
    hits = emb._rerank_hits(
        rows, "good", k=5,
        max_distance=1.0, boost_verbatim=False, demote_generated=False,
    )
    files = [h.file_rel for h in hits]
    assert "src/a.py" in files
    assert "src/b.py" in files
    assert "src/c.py" not in files  # 1.50 > 1.0 threshold


def test_rerank_threshold_none_disables_filter():
    """max_distance=None means: keep everything (subject to k limit)."""
    rows = [_row(f"src/{i}.py", "x", float(i)) for i in range(5)]
    hits = emb._rerank_hits(
        rows, "x", k=10,
        max_distance=None, boost_verbatim=False, demote_generated=False,
    )
    assert len(hits) == 5


def test_rerank_truncates_to_k():
    """Even with no filtering, output is capped at k entries, sorted ascending."""
    rows = [_row(f"src/{i}.py", "x", float(i) * 0.1) for i in range(10)]
    hits = emb._rerank_hits(
        rows, "x", k=3,
        max_distance=None, boost_verbatim=False, demote_generated=False,
    )
    assert len(hits) == 3
    # Ascending by effective distance.
    assert hits == sorted(hits, key=lambda h: h.distance)


def test_semantic_search_threshold_drops_noise(ts_project, monkeypatch):
    """End-to-end: a tight threshold removes low-confidence hits from the result list."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    # Pick a real chunk and query with its exact text — top hit will be ~0,
    # other hits will be unrelated and (in the stub) sit near distance ~1.
    with db.open_project(ts_project.hash) as conn:
        row = conn.execute(
            "SELECT text, file_rel FROM chunks LIMIT 1"
        ).fetchone()

    # Loose threshold — keep all candidates (subject to k).
    loose = emb.semantic_search(ts_project, row["text"], k=5, max_distance=None)
    # Tight threshold — only the near-exact match should pass.
    tight = emb.semantic_search(ts_project, row["text"], k=5, max_distance=0.05)
    assert tight, "exact-match query must still return its top hit"
    assert tight[0].file_rel == row["file_rel"]
    assert tight[0].distance < 0.05
    assert len(tight) <= len(loose)


def test_cli_semantic_max_distance_flag(ts_project, monkeypatch):
    """--max-distance is parsed and applied; a tiny value collapses results."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    runner = CliRunner()
    result = runner.invoke(
        cli.app,
        ["semantic", "nonsense gibberish xyzzy", "-k", "5",
         "--max-distance", "0.001"],
        catch_exceptions=False,
    )
    # With a near-zero threshold, the gibberish query should leave no survivors.
    assert result.exit_code == 0
    assert "(no results)" in result.output


# ---------------------------------------------------------------------------
# merge_nearby_hits: pure-function unit tests
# ---------------------------------------------------------------------------

def _make_hit(file_rel: str, start: int, end: int, distance: float = 0.5) -> SearchHit:
    return SearchHit(
        file_rel=file_rel, start_line=start, end_line=end,
        kind="function", text="x", distance=distance,
    )


def test_merge_nearby_hits_empty():
    assert merge_nearby_hits([]) == []


def test_merge_nearby_hits_single():
    h = _make_hit("a.py", 1, 10)
    assert merge_nearby_hits([h]) == [h]


def test_merge_nearby_hits_overlapping_same_file():
    hits = [
        _make_hit("a.py", 1, 30, distance=0.3),
        _make_hit("a.py", 25, 50, distance=0.4),
    ]
    merged = merge_nearby_hits(hits)
    assert len(merged) == 1
    assert merged[0].start_line == 1
    assert merged[0].end_line == 50
    assert merged[0].distance == pytest.approx(0.3)


def test_merge_nearby_hits_within_proximity():
    hits = [
        _make_hit("a.py", 1, 10, distance=0.3),
        _make_hit("a.py", 25, 35, distance=0.2),
    ]
    merged = merge_nearby_hits(hits, proximity=20)
    assert len(merged) == 1
    assert merged[0].start_line == 1
    assert merged[0].end_line == 35
    assert merged[0].distance == pytest.approx(0.2)


def test_merge_nearby_hits_beyond_proximity_not_merged():
    hits = [
        _make_hit("a.py", 1, 10),
        _make_hit("a.py", 50, 60),
    ]
    merged = merge_nearby_hits(hits, proximity=20)
    assert len(merged) == 2


def test_merge_nearby_hits_different_files_not_merged():
    hits = [
        _make_hit("a.py", 1, 10),
        _make_hit("b.py", 5, 15),
    ]
    merged = merge_nearby_hits(hits)
    assert len(merged) == 2


def test_merge_nearby_hits_sorted_by_distance():
    hits = [
        _make_hit("a.py", 1, 10, distance=0.8),
        _make_hit("b.py", 1, 10, distance=0.3),
    ]
    merged = merge_nearby_hits(hits)
    assert len(merged) == 2
    assert merged[0].file_rel == "b.py"
    assert merged[1].file_rel == "a.py"


def test_merge_nearby_hits_three_chunk_function():
    hits = [
        _make_hit("a.py", 1, 30, distance=0.4),
        _make_hit("a.py", 25, 60, distance=0.3),
        _make_hit("a.py", 55, 90, distance=0.5),
    ]
    merged = merge_nearby_hits(hits)
    assert len(merged) == 1
    assert merged[0].start_line == 1
    assert merged[0].end_line == 90
    assert merged[0].distance == pytest.approx(0.3)


def test_cli_semantic_keyword_fallback(ts_project, monkeypatch):
    """token-goat semantic falls back to keyword search when embeddings unavailable."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.chdir(ts_project.root)
    with patch.object(emb, "embed_texts", side_effect=EmbeddingsUnavailable("not ready")):
        runner = CliRunner()
        result = runner.invoke(
            cli.app, ["semantic", "greet hello", "-k", "5"],
            catch_exceptions=False,
        )
    assert result.exit_code == 0
    assert "keyword fallback" in result.output.lower()


def test_cli_semantic_keyword_fallback_json(ts_project, monkeypatch):
    """Keyword fallback JSON output includes a 'fallback' key."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.chdir(ts_project.root)
    with patch.object(emb, "embed_texts", side_effect=EmbeddingsUnavailable("not ready")):
        runner = CliRunner()
        result = runner.invoke(
            cli.app, ["semantic", "greet hello", "-k", "5", "--json"],
            catch_exceptions=False,
        )
    assert result.exit_code == 0
    # Find the JSON line (last line that starts with '{')
    json_line = next(
        (line for line in reversed(result.output.splitlines()) if line.startswith("{")),
        None,
    )
    assert json_line is not None, f"no JSON in output: {result.output!r}"
    data = json.loads(json_line)
    assert "fallback" in data


# ---------------------------------------------------------------------------
# Tests for _load_existing_chunk_hashes with file_rels filtering (P1 perf fix)
# ---------------------------------------------------------------------------

def test_load_chunk_hashes_all_files(ts_project, monkeypatch):
    """Full-index path (file_rels=None) returns hashes for every indexed file."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    with db.open_project(ts_project.hash) as conn:
        all_hashes = emb._load_existing_chunk_hashes(conn, None)

    assert len(all_hashes) > 0
    # Every key is a (file_rel, start_line, end_line) triple.
    for key in all_hashes:
        assert len(key) == 3
        assert isinstance(key[0], str)
        assert isinstance(key[1], int)
        assert isinstance(key[2], int)


def test_load_chunk_hashes_specific_file(ts_project, monkeypatch):
    """file_rels=[...] returns only hashes for the requested file, not others."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    with db.open_project(ts_project.hash) as conn:
        # Discover which file_rels actually have chunks.
        all_rels = sorted({
            row["file_rel"]
            for row in conn.execute("SELECT DISTINCT file_rel FROM chunks")
        })

    assert all_rels, "test requires at least one indexed file with chunks"
    target = all_rels[0]

    with db.open_project(ts_project.hash) as conn:
        filtered = emb._load_existing_chunk_hashes(conn, [target])
        full = emb._load_existing_chunk_hashes(conn, None)

    # Every key in filtered belongs to the target file.
    for file_rel, _s, _e in filtered:
        assert file_rel == target

    # The filtered set is a strict subset of the full set.
    assert filtered.items() <= full.items()

    # If there are other files, filtered must be smaller than the full set.
    if len(all_rels) > 1:
        assert len(filtered) < len(full)


def test_load_chunk_hashes_empty_list_returns_empty_no_sql(tmp_data_dir):
    """file_rels=[] returns {} immediately without executing any SQL."""
    conn = MagicMock(spec=sqlite3.Connection)

    result = emb._load_existing_chunk_hashes(conn, [])

    assert result == {}
    conn.execute.assert_not_called()


def test_load_chunk_hashes_large_project_filtered(tmp_data_dir):
    """Querying 10 files out of 1500 synthetic rows returns only those 10 files' chunks.

    Uses direct INSERT to avoid the parser/embedder overhead — this exercises
    the SQL batching path (file_rels list within SQLITE_MAX_VARIABLE_NUMBER) and
    confirms the returned dict is scoped to the requested files.
    """
    import hashlib as _hashlib  # noqa: PLC0415

    from token_goat.project import make_project_at  # noqa: PLC0415

    # Build a minimal project DB.
    proj = make_project_at(tmp_data_dir)

    with db.open_project(proj.hash) as conn:
        # Ensure the chunks table exists (open_project runs DDL on first open).
        # Insert synthetic file + chunk rows for 1500 files, 1 chunk each.
        n_total = 1500
        file_rows = [
            (f"src/file_{i}.py", 0.0, _hashlib.sha256(f"file_{i}".encode()).hexdigest(), 0, 10, 0)
            for i in range(n_total)
        ]
        conn.executemany(
            "INSERT OR IGNORE INTO files(rel_path, mtime, content_sha256, language, size, line_count, indexed_at)"
            " VALUES (?, ?, ?, 'python', ?, ?, ?)",
            file_rows,
        )
        chunk_rows = [
            (f"src/file_{i}.py", 0, 10, _hashlib.sha256(f"chunk_{i}".encode()).hexdigest(), "function", f"def f_{i}(): pass")
            for i in range(n_total)
        ]
        conn.executemany(
            "INSERT OR IGNORE INTO chunks(file_rel, start_line, end_line, content_sha256, kind, text) VALUES (?, ?, ?, ?, ?, ?)",
            chunk_rows,
        )

    # Request only 10 of the 1500 files.
    target_rels = [f"src/file_{i}.py" for i in range(10)]

    with db.open_project(proj.hash) as conn:
        result = emb._load_existing_chunk_hashes(conn, target_rels)

    assert len(result) == 10
    for file_rel, _s, _e in result:
        assert file_rel in target_rels


# ---------------------------------------------------------------------------
# Tests for new file-type embedding coverage (SQL, GraphQL, Proto, CSS, Makefile)
# ---------------------------------------------------------------------------

def test_code_symbol_kinds_includes_new_file_types():
    """_CODE_SYMBOL_KINDS includes domain-specific kinds from new indexers."""
    from token_goat.embeddings import _CODE_SYMBOL_KINDS  # noqa: PLC0415

    # SQL kinds (sql_idx.py)
    assert "sql_table" in _CODE_SYMBOL_KINDS
    assert "sql_view" in _CODE_SYMBOL_KINDS
    assert "sql_function" in _CODE_SYMBOL_KINDS
    assert "sql_trigger" in _CODE_SYMBOL_KINDS

    # GraphQL kinds (graphql_idx.py)
    assert "graphql_type" in _CODE_SYMBOL_KINDS
    assert "graphql_input" in _CODE_SYMBOL_KINDS
    assert "graphql_query" in _CODE_SYMBOL_KINDS
    assert "graphql_mutation" in _CODE_SYMBOL_KINDS

    # Proto kinds (proto_idx.py)
    assert "proto_message" in _CODE_SYMBOL_KINDS
    assert "proto_service" in _CODE_SYMBOL_KINDS
    assert "proto_enum" in _CODE_SYMBOL_KINDS

    # CSS kinds (css_idx.py)
    assert "css_class" in _CODE_SYMBOL_KINDS
    assert "css_keyframes" in _CODE_SYMBOL_KINDS

    # Makefile kinds (makefile_idx.py)
    assert "makefile_target" in _CODE_SYMBOL_KINDS
    assert "makefile_define" in _CODE_SYMBOL_KINDS


def test_window_langs_includes_new_file_types():
    """_WINDOW_LANGS includes SQL, GraphQL, Proto, CSS, and Makefile for window fallback."""
    from token_goat.embeddings import _WINDOW_LANGS  # noqa: PLC0415

    # Original languages preserved
    assert "typescript" in _WINDOW_LANGS
    assert "python" in _WINDOW_LANGS
    assert "go" in _WINDOW_LANGS

    # New language additions
    assert "sql" in _WINDOW_LANGS
    assert "graphql" in _WINDOW_LANGS
    assert "proto" in _WINDOW_LANGS
    assert "css" in _WINDOW_LANGS
    assert "makefile" in _WINDOW_LANGS


def test_extract_chunks_sql_file(tmp_path, tmp_data_dir, make_project):
    """extract_chunks_for_file extracts chunks from a SQL schema file."""
    from token_goat.parser import index_project  # noqa: PLC0415

    proj_root = tmp_path / "sql_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    sql_content = """\
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE posts (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    title TEXT NOT NULL,
    body TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE FUNCTION get_user_posts(user_id INTEGER)
RETURNS TABLE(title TEXT, created_at TIMESTAMPTZ) AS $$
    SELECT title, created_at FROM posts WHERE user_id = $1;
$$ LANGUAGE SQL;
"""
    (proj_root / "schema.sql").write_text(sql_content, encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    with db.open_project(proj.hash) as conn:
        chunks = extract_chunks_for_file(proj, conn, "schema.sql")

    assert len(chunks) >= 1, "expected at least one chunk from SQL schema file"
    kinds = {c.kind for c in chunks}
    # Should have section or sql_table / sql_function kinds
    assert kinds & {
        "section", "sql_table", "sql_function", "sql_view", "sql_trigger", "window",
    }, f"unexpected kinds: {kinds}"


def test_extract_chunks_graphql_file(tmp_path, tmp_data_dir, make_project):
    """extract_chunks_for_file extracts chunks from a GraphQL schema file."""
    from token_goat.parser import index_project  # noqa: PLC0415

    proj_root = tmp_path / "gql_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    gql_content = """\
type User {
  id: ID!
  email: String!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  body: String
  author: User!
}

type Query {
  user(id: ID!): User
  posts: [Post!]!
}

type Mutation {
  createPost(title: String!, body: String): Post!
}
"""
    (proj_root / "schema.graphql").write_text(gql_content, encoding="utf-8")

    proj = make_project(proj_root)
    index_project(proj, full=True)

    with db.open_project(proj.hash) as conn:
        chunks = extract_chunks_for_file(proj, conn, "schema.graphql")

    assert len(chunks) >= 1, "expected at least one chunk from GraphQL schema file"
    kinds = {c.kind for c in chunks}
    assert kinds & {
        "section", "graphql_type", "graphql_query", "graphql_mutation", "window",
    }, f"unexpected kinds: {kinds}"


def test_semantic_default_k_is_8():
    """semantic_search default k is 8, not 5."""
    import inspect  # noqa: PLC0415

    sig = inspect.signature(emb.semantic_search)
    assert sig.parameters["k"].default == 8


def test_cli_semantic_default_k_is_8(ts_project, monkeypatch):
    """CLI token-goat semantic default k returns up to 8 results."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    # Query without -k; the default should be 8 (not 5).
    # Use --max-distance 99 so the stub model's uniform distances don't filter all results.
    result = CliRunner().invoke(
        cli.app,
        ["semantic", "greet hello user service", "--max-distance", "99", "--full"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # Verify the CLI option default is 8 by inspecting the command params
    from typer.testing import CliRunner as _R  # noqa: F811, PLC0415 — re-import for clarity
    help_result = _R().invoke(cli.app, ["semantic", "--help"], catch_exceptions=False)
    assert "8" in help_result.output, "default k=8 should appear in --help output"


def test_cli_semantic_compact_output_includes_kind(ts_project, monkeypatch):
    """token-goat semantic compact output includes [kind] tag per result."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    result = CliRunner().invoke(
        cli.app,
        ["semantic", "greet hello", "-k", "3", "--max-distance", "99"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # Compact output format: "file:line [kind]  snippet"
    # Every non-empty result line should contain "[" and "]" for the kind bracket.
    result_lines = [
        ln for ln in result.output.splitlines()
        if ln.strip() and not ln.startswith("(")
    ]
    assert result_lines, f"expected result lines, got: {result.output!r}"
    for ln in result_lines:
        assert "[" in ln and "]" in ln, (
            f"compact output line missing [kind] bracket: {ln!r}"
        )


def test_cli_semantic_compact_output_first_line_snippet(ts_project, monkeypatch):
    """Compact output shows the first non-blank line of the chunk, not a flat slice."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from token_goat import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    # Pick an exact-match query so we control which chunk surfaces first
    with db.open_project(ts_project.hash) as conn:
        row = conn.execute(
            "SELECT text, file_rel, start_line FROM chunks LIMIT 1"
        ).fetchone()

    result = CliRunner().invoke(
        cli.app,
        ["semantic", row["text"], "-k", "1", "--max-distance", "99"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # The snippet in compact output should be the first non-blank line of the chunk,
    # not a newline-flattened slice.  Find the expected first line.
    expected_first = next(
        (ln.strip() for ln in row["text"].splitlines() if ln.strip()),
        "",
    )[:120]
    assert expected_first, "chunk text must have at least one non-blank line"
    assert expected_first in result.output, (
        f"expected first chunk line {expected_first!r} in output:\n{result.output}"
    )
