"""Tests for doc_compact: extractive compact builder, sidecar lifecycle, and hook integration."""
from __future__ import annotations

import hashlib
from pathlib import Path
from unittest.mock import MagicMock, patch

from token_goat import doc_compact

# ---------------------------------------------------------------------------
# build_extractive_compact
# ---------------------------------------------------------------------------

class TestBuildExtractiveCompact:
    def test_emits_headings(self):
        text = "# Title\n\nSome content here.\n\n## Section\n\nMore content.\n"
        result = doc_compact.build_extractive_compact(text)
        assert "# Title" in result
        assert "## Section" in result

    def test_extracts_first_n_sentences_per_section(self):
        text = "# H1\n\nLine 1.\nLine 2.\nLine 3.\n"
        result = doc_compact.build_extractive_compact(text, max_sentences=2)
        assert "Line 1." in result
        assert "Line 2." in result
        assert "Line 3." not in result

    def test_skips_yaml_frontmatter(self):
        text = "---\ntitle: Foo\ndate: 2024-01-01\n---\n\n# Heading\n\nReal content.\n"
        result = doc_compact.build_extractive_compact(text)
        assert "title: Foo" not in result
        assert "# Heading" in result
        assert "Real content." in result

    def test_includes_code_block_up_to_10_lines(self):
        lines = [f"line{i}" for i in range(15)]
        code_block = "```\n" + "\n".join(lines) + "\n```\n"
        text = "# Code\n\n" + code_block
        result = doc_compact.build_extractive_compact(text, max_sentences=5)
        assert "line0" in result
        # opening fence counts as one slot, so 9 content lines (0-8) fit in the limit
        assert "line8" in result
        assert "line9" not in result
        assert "line14" not in result

    def test_no_duplicate_blank_lines(self):
        text = "# A\n\n\n\n## B\n\n\n\nContent.\n"
        result = doc_compact.build_extractive_compact(text)
        assert "\n\n\n" not in result

    def test_empty_document(self):
        result = doc_compact.build_extractive_compact("")
        assert isinstance(result, str)

    def test_document_with_no_headings(self):
        text = "Just some plain text.\nNo headings at all.\n"
        result = doc_compact.build_extractive_compact(text)
        # Plain text before any heading is not collected
        assert isinstance(result, str)

    def test_result_ends_with_newline(self):
        text = "# H\n\nContent.\n"
        result = doc_compact.build_extractive_compact(text)
        assert result.endswith("\n")


# ---------------------------------------------------------------------------
# compact_path_for and find_compact_for_path
# ---------------------------------------------------------------------------

class TestCompactPaths:
    def test_compact_path_for_is_deterministic(self, tmp_data_dir):
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            p1 = doc_compact.compact_path_for("/some/file.md", "projhash123")
            p2 = doc_compact.compact_path_for("/some/file.md", "projhash123")
        assert p1 == p2

    def test_compact_path_ends_with_compact_md(self, tmp_data_dir):
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            p = doc_compact.compact_path_for("/some/file.md", "projhash123")
        assert p.name.endswith(".compact.md")

    def test_different_files_yield_different_paths(self, tmp_data_dir):
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            p1 = doc_compact.compact_path_for("/some/file.md", "projhash123")
            p2 = doc_compact.compact_path_for("/other/file.md", "projhash123")
        assert p1 != p2

    def test_find_compact_for_path_returns_none_when_absent(self, tmp_data_dir):
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            result = doc_compact.find_compact_for_path("/nonexistent/file.md", "proj123")
        assert result is None

    def test_find_compact_for_path_returns_path_when_present(self, tmp_data_dir, tmp_path):
        src = tmp_path / "doc.md"
        src.write_text("# Doc\n\nContent.\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "proj123")
            cpath.parent.mkdir(parents=True, exist_ok=True)
            sha = hashlib.sha256(src.read_bytes()).hexdigest()
            cpath.write_text(
                f"<!-- token-goat doc-compact source-hash:{sha} source:doc.md -->\n# Doc\n\nContent.\n",
                encoding="utf-8",
            )
            result = doc_compact.find_compact_for_path(src, "proj123")
        assert result == cpath


# ---------------------------------------------------------------------------
# write_compact / read_compact_body / read_compact_header
# ---------------------------------------------------------------------------

class TestWriteReadCompact:
    def test_write_then_read_body_roundtrip(self, tmp_data_dir, tmp_path):
        src = tmp_path / "api.md"
        src.write_text("# API\n\nReference.\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "proj42")
            doc_compact.write_compact(cpath, src, "# API\n\nCompact body.\n", source_rel="api.md")
            body = doc_compact.read_compact_body(cpath)
        assert body is not None
        assert "Compact body." in body

    def test_header_contains_source_hash_and_path(self, tmp_data_dir, tmp_path):
        src = tmp_path / "ref.md"
        src.write_text("# Ref\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "projX")
            doc_compact.write_compact(cpath, src, "body\n", source_rel="ref.md")
            header = doc_compact.read_compact_header(cpath)
        assert header is not None
        stored_hash, source_rel = header
        assert stored_hash == hashlib.sha256(src.read_bytes()).hexdigest()
        assert source_rel == "ref.md"

    def test_read_compact_header_returns_none_for_bad_format(self, tmp_path):
        bad = tmp_path / "bad.compact.md"
        bad.write_text("not a valid header\nbody\n", encoding="utf-8")
        assert doc_compact.read_compact_header(bad) is None

    def test_read_compact_body_returns_none_for_missing_file(self, tmp_path):
        assert doc_compact.read_compact_body(tmp_path / "nope.compact.md") is None

    def test_read_compact_body_returns_none_for_header_only(self, tmp_data_dir, tmp_path):
        src = tmp_path / "empty.md"
        src.write_text("# H\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "proj0")
            doc_compact.write_compact(cpath, src, "", source_rel="empty.md")
            body = doc_compact.read_compact_body(cpath)
        assert body is None


# ---------------------------------------------------------------------------
# is_compact_fresh
# ---------------------------------------------------------------------------

class TestIsCompactFresh:
    def _write_fresh(self, src: Path, cpath: Path) -> None:
        sha = hashlib.sha256(src.read_bytes()).hexdigest()
        cpath.parent.mkdir(parents=True, exist_ok=True)
        cpath.write_text(
            f"<!-- token-goat doc-compact source-hash:{sha} source:{src.name} -->\n# H\n",
            encoding="utf-8",
        )

    def test_fresh_compact_returns_true(self, tmp_path):
        src = tmp_path / "doc.md"
        src.write_text("# Doc\n\nContent.\n", encoding="utf-8")
        cpath = tmp_path / "doc.compact.md"
        self._write_fresh(src, cpath)
        assert doc_compact.is_compact_fresh(cpath, src) is True

    def test_stale_after_source_change(self, tmp_path):
        src = tmp_path / "doc.md"
        src.write_text("# Doc\n\nOriginal.\n", encoding="utf-8")
        cpath = tmp_path / "doc.compact.md"
        self._write_fresh(src, cpath)
        src.write_text("# Doc\n\nModified.\n", encoding="utf-8")
        assert doc_compact.is_compact_fresh(cpath, src) is False

    def test_stale_marker_returns_false(self, tmp_path):
        src = tmp_path / "doc.md"
        src.write_text("# Doc\n", encoding="utf-8")
        cpath = tmp_path / "doc.compact.md"
        cpath.write_text(
            "<!-- token-goat doc-compact source-hash:STALE source:doc.md -->\nbody\n",
            encoding="utf-8",
        )
        assert doc_compact.is_compact_fresh(cpath, src) is False

    def test_missing_compact_returns_false(self, tmp_path):
        src = tmp_path / "doc.md"
        src.write_text("# Doc\n", encoding="utf-8")
        assert doc_compact.is_compact_fresh(tmp_path / "nope.compact.md", src) is False


# ---------------------------------------------------------------------------
# mark_compact_stale
# ---------------------------------------------------------------------------

class TestMarkCompactStale:
    def test_marks_stale(self, tmp_data_dir, tmp_path):
        src = tmp_path / "guide.md"
        src.write_text("# Guide\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "projS")
            doc_compact.write_compact(cpath, src, "body\n", source_rel="guide.md")
            assert doc_compact.is_compact_fresh(cpath, src) is True
            result = doc_compact.mark_compact_stale(cpath)
        assert result is True
        assert doc_compact.is_compact_fresh(cpath, src) is False
        header = doc_compact.read_compact_header(cpath)
        assert header is not None
        assert header[0] == "STALE"

    def test_already_stale_returns_false(self, tmp_path):
        cpath = tmp_path / "already.compact.md"
        cpath.write_text(
            "<!-- token-goat doc-compact source-hash:STALE source:x.md -->\nbody\n",
            encoding="utf-8",
        )
        assert doc_compact.mark_compact_stale(cpath) is False

    def test_missing_compact_returns_false(self, tmp_path):
        assert doc_compact.mark_compact_stale(tmp_path / "ghost.compact.md") is False

    def test_body_preserved_after_marking_stale(self, tmp_data_dir, tmp_path):
        src = tmp_path / "ref.md"
        src.write_text("# Ref\n", encoding="utf-8")
        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            cpath = doc_compact.compact_path_for(src, "projP")
            doc_compact.write_compact(cpath, src, "# Preserved body\n", source_rel="ref.md")
            doc_compact.mark_compact_stale(cpath)
            body = doc_compact.read_compact_body(cpath)
        assert body is not None
        assert "Preserved body" in body


# ---------------------------------------------------------------------------
# build_doc_compact_hint (hint layer)
# ---------------------------------------------------------------------------

class TestBuildDocCompactHint:
    def _make_large_md(self, path: Path, n_sections: int = 8, lines_per: int = 50) -> None:
        parts = []
        for i in range(n_sections):
            parts.append(f"## Section {i}\n\n")
            parts.append(("Word " * 20 + "\n") * lines_per)
        path.write_text("".join(parts), encoding="utf-8")

    def test_returns_none_for_small_file(self, tmp_data_dir, tmp_path):
        src = tmp_path / "tiny.md"
        src.write_text("# Hi\n\nSmall.\n", encoding="utf-8")
        from token_goat.hints import build_doc_compact_hint
        hint = build_doc_compact_hint(str(src), str(tmp_path))
        assert hint is None

    def test_returns_none_for_non_markdown(self, tmp_data_dir, tmp_path):
        src = tmp_path / "code.py"
        src.write_text("# big content\n" + "x = 1\n" * 2000, encoding="utf-8")
        from token_goat.hints import build_doc_compact_hint
        hint = build_doc_compact_hint(str(src), str(tmp_path))
        assert hint is None

    def test_returns_serve_sentinel_when_fresh_compact_exists(self, tmp_data_dir, tmp_path):
        src = tmp_path / "api.md"
        self._make_large_md(src)
        from token_goat.hints import DOC_COMPACT_SERVE_SENTINEL, build_doc_compact_hint

        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            proj_mock = MagicMock()
            proj_mock.hash = "testhash"
            proj_mock.root = tmp_path
            with patch("token_goat.hints.find_project", return_value=proj_mock):
                cpath = doc_compact.compact_path_for(src, "testhash")
                cpath.parent.mkdir(parents=True, exist_ok=True)
                sha = hashlib.sha256(src.read_bytes()).hexdigest()
                cpath.write_text(
                    f"<!-- token-goat doc-compact source-hash:{sha} source:api.md -->\n# API\n\nCompact.\n",
                    encoding="utf-8",
                )
                hint = build_doc_compact_hint(str(src), str(tmp_path))

        assert hint is not None
        hint_str = str(hint)
        assert hint_str.startswith(DOC_COMPACT_SERVE_SENTINEL)
        assert "Compact." in hint_str

    def test_returns_advisory_hint_for_stale_compact(self, tmp_data_dir, tmp_path):
        src = tmp_path / "guide.md"
        self._make_large_md(src)
        from token_goat.hints import DOC_COMPACT_SERVE_SENTINEL, build_doc_compact_hint

        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            proj_mock = MagicMock()
            proj_mock.hash = "testhash2"
            proj_mock.root = tmp_path
            with patch("token_goat.hints.find_project", return_value=proj_mock):
                cpath = doc_compact.compact_path_for(src, "testhash2")
                cpath.parent.mkdir(parents=True, exist_ok=True)
                cpath.write_text(
                    "<!-- token-goat doc-compact source-hash:STALE source:guide.md -->\nbody\n",
                    encoding="utf-8",
                )
                hint = build_doc_compact_hint(str(src), str(tmp_path))

        assert hint is not None
        hint_str = str(hint)
        assert not hint_str.startswith(DOC_COMPACT_SERVE_SENTINEL)
        assert "stale" in hint_str.lower() or "compact-doc" in hint_str.lower()

    def test_returns_none_when_config_disabled(self, tmp_data_dir, tmp_path):
        src = tmp_path / "api.md"
        self._make_large_md(src)
        from token_goat import config as _cfg
        from token_goat.hints import build_doc_compact_hint

        with patch.object(_cfg.HintsConfig, "stable_doc_compacts", new=False):
            hint = build_doc_compact_hint(str(src), str(tmp_path))
        assert hint is None


# ---------------------------------------------------------------------------
# _handle_doc_compact hook integration
# ---------------------------------------------------------------------------

class TestHandleDocCompact:
    def _make_large_md(self, path: Path, n_sections: int = 8, lines_per: int = 50) -> None:
        parts = []
        for i in range(n_sections):
            parts.append(f"## Section {i}\n\n")
            parts.append(("Word " * 20 + "\n") * lines_per)
        path.write_text("".join(parts), encoding="utf-8")

    def test_returns_none_for_small_file(self, tmp_data_dir, tmp_path):
        src = tmp_path / "small.md"
        src.write_text("# H\n\nSmall.\n", encoding="utf-8")
        from token_goat.hooks_read import _handle_doc_compact
        result = _handle_doc_compact(str(src), str(tmp_path), None)
        assert result is None

    def test_deny_redirect_for_fresh_compact(self, tmp_data_dir, tmp_path):
        src = tmp_path / "big.md"
        self._make_large_md(src)

        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            proj_mock = MagicMock()
            proj_mock.hash = "hooktest"
            proj_mock.root = tmp_path
            with patch("token_goat.hints.find_project", return_value=proj_mock):
                cpath = doc_compact.compact_path_for(src, "hooktest")
                cpath.parent.mkdir(parents=True, exist_ok=True)
                sha = hashlib.sha256(src.read_bytes()).hexdigest()
                cpath.write_text(
                    f"<!-- token-goat doc-compact source-hash:{sha} source:big.md -->\n# Compact\n\nBody.\n",
                    encoding="utf-8",
                )
                from token_goat.hooks_read import _handle_doc_compact
                result = _handle_doc_compact(str(src), str(tmp_path), None)

        assert result is not None
        # deny_redirect returns a dict with "stopReason" or the hook-specific deny format
        result_str = str(result)
        assert "Body." in result_str or "Compact" in result_str

    def test_non_deny_for_stale_compact(self, tmp_data_dir, tmp_path):
        src = tmp_path / "stale_big.md"
        self._make_large_md(src)

        with patch("token_goat.paths.data_dir", return_value=tmp_data_dir):
            proj_mock = MagicMock()
            proj_mock.hash = "hooktest2"
            proj_mock.root = tmp_path
            with patch("token_goat.hints.find_project", return_value=proj_mock):
                cpath = doc_compact.compact_path_for(src, "hooktest2")
                cpath.parent.mkdir(parents=True, exist_ok=True)
                cpath.write_text(
                    "<!-- token-goat doc-compact source-hash:STALE source:stale_big.md -->\nbody\n",
                    encoding="utf-8",
                )
                from token_goat.hooks_read import _handle_doc_compact
                result = _handle_doc_compact(str(src), str(tmp_path), None)

        # Advisory hint: returns a non-None response but NOT a deny_redirect
        assert result is not None
        result_dict = result if isinstance(result, dict) else {}
        # deny_redirect sets stopReason; advisory (pre_tool_use_with_context) does not
        assert "stopReason" not in result_dict
