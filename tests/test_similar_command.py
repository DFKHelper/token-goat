"""Tests for `token-goat similar` — per-symbol semantic similarity.

Covers:
- Similar symbols found and formatted correctly
- Symbol not indexed returns a graceful message
- --json output shape and field names
- Query symbol excluded from its own results
- Bad target format returns an error
- No project returns a graceful message
- find_similar_symbols fail-soft (returns [] on exception)
"""
from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from token_goat import cli
from token_goat import embeddings as emb
from token_goat.embeddings import SimilarSymbolHit, find_similar_symbols

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _stub_embed(
    texts: Sequence[str], *, model_name: str = emb.DEFAULT_MODEL
) -> list[list[float]]:
    """Deterministic stand-in for embed_texts — no model download."""
    out: list[list[float]] = []
    for text in texts:
        digest = hashlib.sha256(text.encode("utf-8", errors="replace")).digest()
        raw = (digest * (emb.DEFAULT_DIM // len(digest) + 1))[: emb.DEFAULT_DIM]
        vec = [b / 255.0 - 0.5 for b in raw]
        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        out.append([x / norm for x in vec])
    return out


def _make_hit(
    file: str = "src/foo.py",
    name: str = "bar",
    kind: str = "function",
    similarity_score: float = 0.9,
) -> SimilarSymbolHit:
    return SimilarSymbolHit(file=file, name=name, kind=kind, similarity_score=similarity_score)


# ---------------------------------------------------------------------------
# Unit tests for find_similar_symbols fail-soft
# ---------------------------------------------------------------------------

def test_find_similar_symbols_returns_empty_on_exception():
    """find_similar_symbols is fail-soft: any exception yields []."""
    with patch("token_goat.embeddings.is_available", side_effect=RuntimeError("boom")):
        result = find_similar_symbols("fakehash", "src/foo.py", "bar")
    assert result == []


def test_find_similar_symbols_returns_empty_when_embeddings_unavailable():
    """find_similar_symbols returns [] when fastembed is not installed."""
    with patch("token_goat.embeddings.is_available", return_value=False):
        result = find_similar_symbols("fakehash", "src/foo.py", "bar")
    assert result == []


# ---------------------------------------------------------------------------
# Integration tests — real DB via ts_project fixture
# ---------------------------------------------------------------------------

def test_find_similar_symbols_with_indexed_project(ts_project, monkeypatch):
    """find_similar_symbols returns results after embeddings are indexed."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    from token_goat import db  # noqa: PLC0415

    # Find a real symbol in the project.
    with db.open_project(ts_project.hash) as conn:
        sym = conn.execute(
            "SELECT name, file_rel FROM symbols LIMIT 1"
        ).fetchone()

    assert sym is not None, "ts_project must have at least one indexed symbol"

    results = find_similar_symbols(
        ts_project.hash, sym["file_rel"], sym["name"], top_k=5
    )

    # The query symbol itself must NOT appear in results.
    assert all(
        not (h.file == sym["file_rel"] and h.name == sym["name"])
        for h in results
    ), "query symbol must be excluded from results"

    # All similarity scores in [0, 1].
    for h in results:
        assert 0.0 <= h.similarity_score <= 1.0
        assert h.file
        assert h.name
        assert h.kind


def test_find_similar_symbols_symbol_not_indexed(ts_project, monkeypatch):
    """find_similar_symbols returns [] for a symbol that doesn't exist."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)

    results = find_similar_symbols(
        ts_project.hash, "nonexistent.py", "phantom_symbol", top_k=5
    )
    assert results == []


# ---------------------------------------------------------------------------
# CLI tests — plain text output
# ---------------------------------------------------------------------------

def test_cli_similar_bad_format():
    """CLI `similar` without '::' prints an error and exits non-zero."""
    result = runner.invoke(cli.app, ["similar", "src/foo.py"], catch_exceptions=False)
    assert result.exit_code != 0
    assert "file::symbol" in result.output or "file::symbol" in (result.stderr or "")


def test_cli_similar_no_project(tmp_path, monkeypatch):
    """CLI `similar` outside an indexed project prints a helpful message."""
    monkeypatch.chdir(tmp_path)
    with patch("token_goat.read_commands.find_project", return_value=None):
        result = runner.invoke(
            cli.app, ["similar", "src/foo.py::bar"], catch_exceptions=False
        )
    assert result.exit_code == 0
    assert "indexed project" in result.output.lower() or "index" in result.output.lower()


def test_cli_similar_symbol_not_found(ts_project, monkeypatch):
    """CLI `similar` for an unknown symbol prints a graceful not-found message."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    result = runner.invoke(
        cli.app,
        ["similar", "nonexistent_file.py::phantom"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    assert "not found" in result.output.lower() or "index" in result.output.lower()


def test_cli_similar_returns_results(ts_project, monkeypatch):
    """CLI `similar` outputs 'X% similar' lines for a real indexed symbol."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    from token_goat import db  # noqa: PLC0415

    with db.open_project(ts_project.hash) as conn:
        sym = conn.execute(
            "SELECT name, file_rel FROM symbols LIMIT 1"
        ).fetchone()

    assert sym is not None

    result = runner.invoke(
        cli.app,
        ["similar", f"{sym['file_rel']}::{sym['name']}"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # Either results or a "no similar symbols" message is acceptable.
    # The key check: no crash and the query symbol itself is not in the output
    # as a result entry (it's in the target arg but not as a result line).
    if "% similar" in result.output:
        # Each result line must follow the format "file — name (kind) — N% similar"
        for line in result.output.splitlines():
            if "% similar" in line:
                assert "—" in line
                assert "%" in line


def test_cli_similar_self_excluded(ts_project, monkeypatch):
    """The query symbol itself does not appear in the results list."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    from token_goat import db  # noqa: PLC0415

    with db.open_project(ts_project.hash) as conn:
        sym = conn.execute(
            "SELECT name, file_rel FROM symbols LIMIT 1"
        ).fetchone()

    assert sym is not None

    result = runner.invoke(
        cli.app,
        ["similar", f"{sym['file_rel']}::{sym['name']}"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    # If results appear, ensure the exact "file — name (kind) — N% similar"
    # line for the query symbol itself is not present.
    for line in result.output.splitlines():
        # Use "name (" to avoid false positives from symbols whose name is a
        # prefix of another (e.g. "User" matching "UserId (type)").
        if "% similar" in line and f"{sym['name']} (" in line and sym["file_rel"] in line:
            # This would mean the query symbol was returned as a result
            pytest.fail(f"Query symbol appeared in its own similar results: {line!r}")


# ---------------------------------------------------------------------------
# CLI tests — JSON output
# ---------------------------------------------------------------------------

def test_cli_similar_json_shape(ts_project, monkeypatch):
    """CLI `similar --json` emits valid JSON with the expected shape."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    from token_goat import db  # noqa: PLC0415

    with db.open_project(ts_project.hash) as conn:
        sym = conn.execute(
            "SELECT name, file_rel FROM symbols LIMIT 1"
        ).fetchone()

    assert sym is not None

    result = runner.invoke(
        cli.app,
        ["similar", f"{sym['file_rel']}::{sym['name']}", "--json"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "query" in data
    assert "results" in data
    assert isinstance(data["results"], list)
    for item in data["results"]:
        assert "file" in item
        assert "name" in item
        assert "kind" in item
        assert "similarity_score" in item
        assert 0.0 <= item["similarity_score"] <= 1.0


def test_cli_similar_json_symbol_not_found(ts_project, monkeypatch):
    """CLI `similar --json` for unknown symbol emits JSON with 'error' key."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    result = runner.invoke(
        cli.app,
        ["similar", "nonexistent.py::phantom", "--json"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "error" in data
    assert data["results"] == []


def test_cli_similar_json_self_excluded(ts_project, monkeypatch):
    """CLI `similar --json` results never include the query symbol."""
    monkeypatch.setattr(emb, "embed_texts", _stub_embed)
    emb.index_project_embeddings(ts_project)
    monkeypatch.chdir(ts_project.root)

    from token_goat import db  # noqa: PLC0415

    with db.open_project(ts_project.hash) as conn:
        sym = conn.execute(
            "SELECT name, file_rel FROM symbols LIMIT 1"
        ).fetchone()

    assert sym is not None

    result = runner.invoke(
        cli.app,
        ["similar", f"{sym['file_rel']}::{sym['name']}", "--json"],
        catch_exceptions=False,
    )
    assert result.exit_code == 0
    data = json.loads(result.output)
    for item in data["results"]:
        assert not (
            item["file"] == sym["file_rel"] and item["name"] == sym["name"]
        ), "query symbol must not appear in its own results"
