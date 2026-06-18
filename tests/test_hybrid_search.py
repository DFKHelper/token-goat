"""Tests for BM25 keyword search and hybrid (RRF) search modes."""
from __future__ import annotations

import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from token_goat.embeddings import SearchHit, _rrf_fuse, bm25_search, hybrid_search

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_project(tmp_path: Path):
    """Build a minimal Project with a populated DB for FTS tests."""
    from token_goat.project import Project, canonicalize, project_hash

    root = tmp_path / "proj"
    root.mkdir()
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


def _seed_chunks(project_hash: str, rows: list[tuple[str, int, int, str, str]]) -> None:
    """Insert (file_rel, start_line, end_line, kind, text) rows into chunks + FTS."""
    import token_goat.db as db_mod

    with db_mod.open_project(project_hash) as conn:
        # File rows must exist before chunks due to FK constraint.
        for file_rel, *_ in rows:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at)"
                " VALUES (?, 'python', 100, 0.0, 'deadbeef', 0)",
                (file_rel,),
            )
        for file_rel, start_line, end_line, kind, text in rows:
            cur = conn.execute(
                "INSERT INTO chunks (file_rel, start_line, end_line, content_sha256, kind, text)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (file_rel, start_line, end_line, "deadbeef", kind, text),
            )
            chunk_id = cur.lastrowid
            try:
                conn.execute(
                    "INSERT INTO chunks_fts(rowid, text) VALUES(?,?)",
                    (chunk_id, text),
                )
            except sqlite3.OperationalError:
                pytest.skip("FTS5 not available in this SQLite build")


# ---------------------------------------------------------------------------
# bm25_search
# ---------------------------------------------------------------------------


class TestBm25Search:
    def test_returns_hits_for_exact_word(self, tmp_path):
        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [
            ("auth.py", 1, 10, "function", "def authenticate_user(token): pass"),
            ("models.py", 1, 5, "function", "class UserProfile: pass"),
        ])

        hits = bm25_search(proj, "authenticate")
        assert len(hits) >= 1
        assert any("auth.py" in h.file_rel for h in hits)

    def test_empty_query_returns_empty(self, tmp_path):
        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [("f.py", 1, 5, "function", "def foo(): pass")])

        assert bm25_search(proj, "") == []
        assert bm25_search(proj, "   ") == []

    def test_no_fts_flag_returns_empty(self, tmp_path):
        import token_goat.db as db_mod

        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [("f.py", 1, 5, "function", "def rate_limit(): pass")])

        with patch.object(db_mod, "fts_available", return_value=False):
            hits = bm25_search(proj, "rate_limit")
        assert hits == []

    def test_bad_fts5_query_returns_empty(self, tmp_path):
        """An FTS5 syntax error is caught and returns [] instead of raising."""
        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [("f.py", 1, 5, "function", "def foo(): pass")])

        # Unmatched double-quote is invalid FTS5 syntax.
        hits = bm25_search(proj, '"unclosed')
        assert isinstance(hits, list)

    def test_respects_k_limit(self, tmp_path):
        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [
            (f"file{i}.py", 1, 5, "function", f"def search_result_{i}(): return search_result_{i}")
            for i in range(10)
        ])

        hits = bm25_search(proj, "search_result", k=3)
        assert len(hits) <= 3

    def test_distance_field_is_non_positive(self, tmp_path):
        """BM25 scores are negative; distance should reflect that (smaller = better)."""
        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [
            ("a.py", 1, 5, "function", "def process_payment(amount): pass"),
        ])

        hits = bm25_search(proj, "process_payment")
        assert len(hits) >= 1
        assert hits[0].distance <= 0.0

    def test_fts_upgrade_path_populates_index(self, tmp_path):
        """bm25_search returns results after schema upgrade rebuilds the FTS index.

        Regression for: COUNT(*) on an FTS5 external-content table counts the
        content table, not the index — so the old count-based probe always found
        rows and skipped the rebuild on existing projects.
        """
        import token_goat.db as db_mod

        proj = _make_project(tmp_path)
        # Seed chunks bypassing FTS (simulates data inserted before FTS was added)
        with db_mod.open_project(proj.hash) as conn:
            conn.execute(
                "INSERT OR IGNORE INTO files (rel_path, language, size, mtime, content_sha256, indexed_at)"
                " VALUES ('upgrade.py', 'python', 100, 0.0, 'cafe', 0)"
            )
            conn.execute(
                "INSERT INTO chunks (file_rel, start_line, end_line, content_sha256, kind, text)"
                " VALUES ('upgrade.py', 1, 5, 'cafe', 'function', 'def upgrade_check(): return True')"
            )
            # Remove the initialization marker so next open runs the rebuild
            conn.execute("DELETE FROM meta WHERE key='fts_initialized'")

        # Re-open triggers _ensure_project_schema → rebuild runs → index is populated
        with db_mod.open_project(proj.hash):
            pass

        hits = bm25_search(proj, "upgrade_check")
        assert len(hits) >= 1, "FTS rebuild on schema upgrade must populate the index"


# ---------------------------------------------------------------------------
# _rrf_fuse
# ---------------------------------------------------------------------------


class TestRrfFuse:
    def _hit(self, file_rel: str, start: int, distance: float = 0.5) -> SearchHit:
        return SearchHit(
            file_rel=file_rel, start_line=start, end_line=start + 5,
            kind="function", text="body", distance=distance,
        )

    def test_combines_disjoint_lists(self):
        vec = [self._hit("a.py", 1), self._hit("b.py", 10)]
        kw = [self._hit("c.py", 20), self._hit("d.py", 30)]
        fused = _rrf_fuse(vec, kw)
        file_rels = {h.file_rel for h in fused}
        assert file_rels == {"a.py", "b.py", "c.py", "d.py"}

    def test_deduplicates_shared_chunks(self):
        shared = self._hit("shared.py", 5)
        vec = [shared, self._hit("only_vec.py", 1)]
        kw = [shared, self._hit("only_kw.py", 1)]
        fused = _rrf_fuse(vec, kw)
        # shared.py must appear exactly once.
        shared_count = sum(1 for h in fused if h.file_rel == "shared.py")
        assert shared_count == 1

    def test_alpha_one_reduces_to_vector_order(self):
        """With alpha=1.0 only vector ranks contribute; top result comes from vector list."""
        vec = [self._hit("vec_top.py", 1), self._hit("vec_second.py", 10)]
        kw = [self._hit("kw_top.py", 1), self._hit("vec_top.py", 1)]
        fused = _rrf_fuse(vec, kw, alpha=1.0)
        assert fused[0].file_rel == "vec_top.py"

    def test_returns_sorted_by_rrf_score(self):
        """A hit appearing in both lists should rank above hits in only one list."""
        both = self._hit("both.py", 1)
        vec = [both, self._hit("vec_only.py", 10)]
        kw = [both, self._hit("kw_only.py", 10)]
        fused = _rrf_fuse(vec, kw, alpha=0.5)
        assert fused[0].file_rel == "both.py"

    def test_empty_inputs_return_empty(self):
        assert _rrf_fuse([], []) == []

    def test_distance_is_negative_rrf_score(self):
        """Fused hits carry negative RRF score as distance so smaller = better rank."""
        vec = [self._hit("a.py", 1)]
        kw = [self._hit("b.py", 1)]
        fused = _rrf_fuse(vec, kw, alpha=0.5)
        for h in fused:
            assert h.distance < 0


# ---------------------------------------------------------------------------
# hybrid_search
# ---------------------------------------------------------------------------


class TestHybridSearch:
    def test_falls_back_gracefully_when_embeddings_unavailable(self, tmp_path):
        """hybrid_search propagates EmbeddingsUnavailable from semantic_search."""
        from token_goat.embeddings import EmbeddingsUnavailable

        proj = _make_project(tmp_path)
        _seed_chunks(proj.hash, [("f.py", 1, 5, "function", "def tokenize(): pass")])

        with patch("token_goat.embeddings.semantic_search", side_effect=EmbeddingsUnavailable("test")), pytest.raises(EmbeddingsUnavailable):
            hybrid_search(proj, "tokenize")

    def test_returns_list_of_search_hits(self, tmp_path):
        """When both sources are mocked, hybrid_search returns SearchHit objects."""
        proj = _make_project(tmp_path)

        vec_hit = SearchHit(file_rel="a.py", start_line=1, end_line=5, kind="function", text="vec", distance=0.1)
        kw_hit = SearchHit(file_rel="b.py", start_line=1, end_line=5, kind="function", text="kw", distance=-2.0)

        with (
            patch("token_goat.embeddings.semantic_search", return_value=[vec_hit]),
            patch("token_goat.embeddings.bm25_search", return_value=[kw_hit]),
        ):
            hits = hybrid_search(proj, "something", k=4)

        assert all(isinstance(h, SearchHit) for h in hits)
        assert len(hits) <= 4
