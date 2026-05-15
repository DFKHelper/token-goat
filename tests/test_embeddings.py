"""Tests for the embeddings module (Phase 8)."""
from __future__ import annotations

import hashlib
import math
import shutil
import sqlite3
import struct
from collections.abc import Sequence
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from tokenwise import db
from tokenwise import embeddings as emb
from tokenwise.embeddings import (
    EmbeddingsUnavailable,
    _check_vec_available,
    _pack_vec,
    extract_chunks_for_file,
    is_available,
)
from tokenwise.parser import index_project

FIXTURE_DIR = Path(__file__).parent / "fixtures"
TS_SAMPLE = FIXTURE_DIR / "ts_sample"


@pytest.fixture
def ts_project(tmp_path, tmp_data_dir, make_project):
    """Copy ts_sample fixture to tmp dir, index it, and return a Project."""
    proj_root = tmp_path / "ts_sample"
    shutil.copytree(TS_SAMPLE, proj_root)
    proj = make_project(proj_root)
    index_project(proj, full=True)
    return proj


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
    with db.open_project("test_hash_checkavail") as conn:
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
    """tokenwise semantic when no project detected exits 0 with helpful message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from tokenwise import cli  # noqa: PLC0415

    runner = CliRunner()
    with patch("tokenwise.project.find_project", return_value=None):
        result = runner.invoke(cli.app, ["semantic", "foo bar"], catch_exceptions=False)
    assert result.exit_code == 0
    assert "No project detected" in result.output


def test_cli_semantic_no_embeddings(ts_project, monkeypatch):
    """tokenwise semantic in a project with no embeddings exits 0 with helpful message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from tokenwise import cli  # noqa: PLC0415

    monkeypatch.chdir(ts_project.root)
    # Force embed_texts to raise so we exercise the EmbeddingsUnavailable path
    with patch.object(emb, "embed_texts", side_effect=EmbeddingsUnavailable("test")):
        runner = CliRunner()
        result = runner.invoke(cli.app, ["semantic", "test query"], catch_exceptions=False)
    assert result.exit_code == 0
    assert "Embeddings unavailable" in result.output


def test_cli_index_embeddings_no_project(tmp_data_dir):
    """tokenwise index --embeddings when no project detected exits 0 with message."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from tokenwise import cli  # noqa: PLC0415

    runner = CliRunner()
    with patch("tokenwise.project.find_project", return_value=None):
        result = runner.invoke(cli.app, ["index", "--embeddings"], catch_exceptions=False)
    assert result.exit_code == 0
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
    """`tokenwise semantic` returns results after a stub-model embedding build."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from tokenwise import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    result = CliRunner().invoke(
        cli.app, ["semantic", "user service greeting", "-k", "3"],
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
    """CLI tokenwise semantic returns results after embedding is built."""
    from typer.testing import CliRunner  # noqa: PLC0415

    from tokenwise import cli  # noqa: PLC0415

    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    monkeypatch.chdir(ts_project.root)
    runner = CliRunner()
    result = runner.invoke(
        cli.app,
        ["semantic", "hello name greeting", "-k", "3"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # Should print file:line-line (kind, d=...) format
    assert "index.ts" in result.output
    assert "d=" in result.output
