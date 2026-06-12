"""Tests for notebook output stripping (notebook_compact.py and the pre_read hook)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from hook_helpers import assert_deny

from token_goat import hooks_read
from token_goat import notebook_compact as nb

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _nb(*, n_code: int = 2, output_size: int = 5000) -> dict:
    """Build a minimal notebook dict."""
    filler = "x" * output_size
    cells = []
    for i in range(n_code):
        cells.append({
            "cell_type": "code",
            "source": [f"print({i})"],
            "execution_count": i + 1,
            "outputs": [{"output_type": "stream", "text": [filler]}],
            "metadata": {},
        })
    return {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": cells}


def _md_cell(text: str = "# Title") -> dict:
    return {"cell_type": "markdown", "source": [text], "metadata": {}}


def _read_payload(path: Path, cwd: Path) -> dict:
    return {"session_id": "nb", "tool_name": "Read", "tool_input": {"file_path": str(path)}, "cwd": str(cwd)}


def _ctx(result: dict) -> str:
    return (result.get("hookSpecificOutput") or {}).get("additionalContext", "")


# ---------------------------------------------------------------------------
# strip_notebook unit tests
# ---------------------------------------------------------------------------

class TestStripNotebook:
    def test_code_cell_outputs_cleared(self):
        original = _nb(n_code=1, output_size=100)
        stripped = nb.strip_notebook(original)
        assert stripped["cells"][0]["outputs"] == []

    def test_code_cell_execution_count_nulled(self):
        original = _nb(n_code=1, output_size=100)
        stripped = nb.strip_notebook(original)
        assert stripped["cells"][0]["execution_count"] is None

    def test_code_cell_source_preserved(self):
        original = _nb(n_code=1, output_size=100)
        stripped = nb.strip_notebook(original)
        assert stripped["cells"][0]["source"] == ["print(0)"]

    def test_markdown_cell_untouched(self):
        original = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [_md_cell("# Hello")]}
        stripped = nb.strip_notebook(original)
        assert stripped["cells"][0] == _md_cell("# Hello")

    def test_original_not_mutated(self):
        original = _nb(n_code=1, output_size=100)
        nb.strip_notebook(original)
        assert original["cells"][0]["outputs"] != []

    def test_multiple_code_cells(self):
        original = _nb(n_code=3, output_size=100)
        stripped = nb.strip_notebook(original)
        for cell in stripped["cells"]:
            assert cell["outputs"] == []
            assert cell["execution_count"] is None

    def test_empty_cells_list(self):
        original = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": []}
        stripped = nb.strip_notebook(original)
        assert stripped["cells"] == []

    def test_notebook_level_metadata_preserved(self):
        meta = {"kernelspec": {"name": "python3"}}
        original = {"nbformat": 4, "nbformat_minor": 5, "metadata": meta, "cells": []}
        stripped = nb.strip_notebook(original)
        assert stripped["metadata"] == meta


# ---------------------------------------------------------------------------
# get_or_create_sidecar unit tests
# ---------------------------------------------------------------------------

class TestGetOrCreateSidecar:
    def test_creates_sidecar_for_new_content(self, tmp_path):
        raw = json.dumps(_nb(n_code=1, output_size=100)).encode()
        sidecar, created = nb.get_or_create_sidecar(raw, tmp_path)
        assert created is True
        assert sidecar.exists()

    def test_sidecar_contains_stripped_content(self, tmp_path):
        original = _nb(n_code=1, output_size=100)
        raw = json.dumps(original).encode()
        sidecar, _ = nb.get_or_create_sidecar(raw, tmp_path)
        result = json.loads(sidecar.read_bytes())
        assert result["cells"][0]["outputs"] == []

    def test_cache_hit_skips_rewrite(self, tmp_path):
        raw = json.dumps(_nb(n_code=1, output_size=100)).encode()
        sidecar1, created1 = nb.get_or_create_sidecar(raw, tmp_path)
        mtime_after_first = sidecar1.stat().st_mtime
        sidecar2, created2 = nb.get_or_create_sidecar(raw, tmp_path)
        assert created2 is False
        assert sidecar2 == sidecar1
        assert sidecar2.stat().st_mtime == mtime_after_first

    def test_different_content_different_sidecar(self, tmp_path):
        raw_a = json.dumps(_nb(n_code=1, output_size=100)).encode()
        raw_b = json.dumps(_nb(n_code=2, output_size=100)).encode()
        sidecar_a, _ = nb.get_or_create_sidecar(raw_a, tmp_path)
        sidecar_b, _ = nb.get_or_create_sidecar(raw_b, tmp_path)
        assert sidecar_a != sidecar_b

    def test_raises_for_invalid_json(self, tmp_path):
        with pytest.raises((ValueError, json.JSONDecodeError)):
            nb.get_or_create_sidecar(b"not json", tmp_path)

    def test_raises_for_non_notebook_json(self, tmp_path):
        with pytest.raises(ValueError, match="Not a notebook"):
            nb.get_or_create_sidecar(json.dumps({"foo": "bar"}).encode(), tmp_path)


# ---------------------------------------------------------------------------
# pre_read integration tests
# ---------------------------------------------------------------------------

class TestNotebookPreRead:
    def _write_nb(self, path: Path, n_code: int = 2, output_size: int = 8000) -> Path:
        nb_path = path / "analysis.ipynb"
        nb_path.write_bytes(json.dumps(_nb(n_code=n_code, output_size=output_size)).encode())
        return nb_path

    def test_denies_notebook_with_large_outputs(self, tmp_data_dir, tmp_path):
        f = self._write_nb(tmp_path, output_size=8000)
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert_deny(result)
        ctx = _ctx(result)
        assert "stripped" in ctx.lower() or "outputs" in ctx.lower()
        assert "stripped.ipynb" in ctx

    def test_deny_context_has_sidecar_path(self, tmp_data_dir, tmp_path):
        f = self._write_nb(tmp_path, output_size=8000)
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        assert_deny(result)
        assert "stripped.ipynb" in _ctx(result)

    def test_small_notebook_passes_through(self, tmp_data_dir, tmp_path):
        # Outputs so small stripping saves < NB_STRIP_MIN_SAVINGS
        nb_path = tmp_path / "tiny.ipynb"
        tiny = {"nbformat": 4, "nbformat_minor": 5, "metadata": {}, "cells": [
            {"cell_type": "code", "source": ["x=1"], "execution_count": 1,
             "outputs": [{"output_type": "stream", "text": ["1"]}], "metadata": {}}
        ]}
        nb_path.write_bytes(json.dumps(tiny).encode())
        result = hooks_read.pre_read(_read_payload(nb_path, tmp_path))
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"

    def test_non_notebook_file_passes_through(self, tmp_data_dir, tmp_path):
        f = tmp_path / "notes.md"
        f.write_bytes(b"# hello\n")
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"

    def test_windowed_read_exempt(self, tmp_data_dir, tmp_path):
        f = self._write_nb(tmp_path, output_size=8000)
        payload = {
            "session_id": "nb", "tool_name": "Read",
            "tool_input": {"file_path": str(f), "offset": 0},
            "cwd": str(tmp_path),
        }
        result = hooks_read.pre_read(payload)
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"

    def test_missing_notebook_passes_through(self, tmp_data_dir, tmp_path):
        f = tmp_path / "ghost.ipynb"
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"

    def test_fail_soft_on_corrupt_notebook(self, tmp_data_dir, tmp_path):
        f = tmp_path / "corrupt.ipynb"
        f.write_bytes(b"not json at all {{{")
        result = hooks_read.pre_read(_read_payload(f, tmp_path))
        decision = (result.get("hookSpecificOutput") or {}).get("permissionDecision")
        assert decision != "deny"
