"""Tests for iter 7: mcp-output CLI command, mcp-history, and compact_mcp_result."""
from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest

from token_goat.mcp_cache import (
    compact_mcp_result,
    evict_old_entries,
    list_outputs,
    load_output,
    load_output_meta,
    read_sidecar,
    store_mcp_result,
)

# ---------------------------------------------------------------------------
# compact_mcp_result
# ---------------------------------------------------------------------------

class TestCompactMcpResult:
    def _issues_json(self, n: int = 10) -> str:
        items = [
            {"number": i, "title": f"Issue {i}", "state": "open",
             "html_url": f"https://github.com/org/repo/issues/{i}",
             "node_id": f"node_{i}", "user": {"login": "alice"}, "body": "x" * 200}
            for i in range(1, n + 1)
        ]
        return json.dumps(items)

    def _small_json(self) -> str:
        return json.dumps([{"id": 1, "name": "item"}])

    def test_small_result_returns_none(self) -> None:
        # Below inline_threshold — no compaction needed
        assert compact_mcp_result(self._small_json(), inline_threshold=2048) is None

    def test_flat_list_compacted(self) -> None:
        big = self._issues_json(15)
        assert len(big) > 2048
        result = compact_mcp_result(big, inline_threshold=2048)
        assert result is not None
        assert "15 item(s)" in result
        assert "compacted from" in result

    def test_compact_has_title_and_state(self) -> None:
        big = self._issues_json(10)
        result = compact_mcp_result(big, inline_threshold=2048)
        assert result is not None
        assert "title=" in result
        assert "state=" in result

    def test_compact_skips_node_id_and_html_url(self) -> None:
        big = self._issues_json(10)
        result = compact_mcp_result(big, inline_threshold=2048)
        assert result is not None
        assert "node_id" not in result
        assert "html_url" not in result

    def test_dict_with_list_value(self) -> None:
        data = {
            "total_count": 5,
            "items": [{"name": f"repo{i}", "stargazers_count": i * 10} for i in range(1, 6)],
        }
        big = json.dumps(data) * 3  # inflate to exceed threshold
        result = compact_mcp_result(big, inline_threshold=2048)
        # May not compact if not large enough — just check no crash
        assert result is None or "item(s)" in result

    def test_non_json_returns_none(self) -> None:
        big = "x" * 3000  # large but not JSON
        assert compact_mcp_result(big, inline_threshold=2048) is None

    def test_json_without_list_returns_none(self) -> None:
        big = json.dumps({"key": "value", "another": 42}) * 200
        assert compact_mcp_result(big, inline_threshold=2048) is None

    def test_compact_is_smaller_than_original(self) -> None:
        big = self._issues_json(20)
        result = compact_mcp_result(big, inline_threshold=2048)
        assert result is not None
        assert len(result.encode()) < len(big.encode()) * 0.85

    def test_items_numbered(self) -> None:
        big = self._issues_json(10)
        result = compact_mcp_result(big, inline_threshold=2048)
        assert result is not None
        assert "  1." in result
        assert " 10." in result

    def test_extra_scalars_shown_for_dict_result(self) -> None:
        data = {
            "total_count": 42,
            "items": [{"name": f"r{i}", "id": i} for i in range(20)],
        }
        big = json.dumps(data)
        result = compact_mcp_result(big, inline_threshold=100)
        if result is not None:
            assert "total_count" in result or "42" in result


# ---------------------------------------------------------------------------
# sidecar round-trip
# ---------------------------------------------------------------------------

class TestSidecar:
    def test_write_and_read_sidecar(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            output_id = store_mcp_result(
                "sess-s1", "hash-s1", '{"ok": true}', ts=1000.0,
                tool_name="mcp__github__list_issues",
                input_preview='{"owner": "foo"}',
            )
            assert output_id is not None
            meta = read_sidecar(output_id)
        assert meta is not None
        assert meta.tool_name == "mcp__github__list_issues"
        assert meta.input_preview == '{"owner": "foo"}'
        assert meta.result_bytes > 0
        assert meta.ts == pytest.approx(1000.0)

    def test_sidecar_not_written_when_no_tool_name(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            output_id = store_mcp_result("sess-s2", "hash-s2", "text", ts=1001.0)
            assert output_id is not None
            meta = read_sidecar(output_id)
        assert meta is None

    def test_read_sidecar_missing_returns_none(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            result = read_sidecar("nonexistent-id")
        assert result is None


# ---------------------------------------------------------------------------
# load_output / load_output_meta / list_outputs
# ---------------------------------------------------------------------------

class TestOutputHelpers:
    def test_load_output_is_alias(self, tmp_path: Any) -> None:
        text = '{"x": 1}'
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            oid = store_mcp_result("sess-o1", "hash-o1", text, ts=2000.0)
            assert oid is not None
            loaded = load_output(oid)
        assert loaded == text

    def test_load_output_meta_returns_size(self, tmp_path: Any) -> None:
        text = '{"y": 2}'
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            oid = store_mcp_result("sess-o2", "hash-o2", text, ts=2001.0)
            assert oid is not None
            meta = load_output_meta(oid)
        assert meta is not None
        assert meta["output_id"] == oid
        assert meta["size_bytes"] > 0

    def test_list_outputs_newest_first(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            store_mcp_result("sess-l1", "hash-l1", "a", ts=1.0)
            store_mcp_result("sess-l1", "hash-l2", "b", ts=2.0)
            store_mcp_result("sess-l1", "hash-l3", "c", ts=3.0)
            outputs = list_outputs()
        mtimes = [o["mtime"] for o in outputs]
        assert mtimes == sorted(mtimes, reverse=True)
        assert len(outputs) == 3


# ---------------------------------------------------------------------------
# evict_old_entries
# ---------------------------------------------------------------------------

class TestEvictOldEntries:
    def test_evict_removes_entries_over_limit(self, tmp_path: Any) -> None:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            for i in range(5):
                store_mcp_result("sess-e1", f"hash-e{i}", "data" * 100, ts=float(i))
            removed = evict_old_entries(max_total_bytes=1, max_file_count=1)
        assert removed > 0


# ---------------------------------------------------------------------------
# mcp-output CLI smoke tests
# ---------------------------------------------------------------------------

class TestMcpOutputCli:
    def _store(self, tmp_path: Any, text: str = '{"ok": 1}') -> str:
        with patch("token_goat.mcp_cache.get_cache_dir", return_value=tmp_path):
            oid = store_mcp_result("sess-cli", "hash-cli1", text, ts=5000.0)
        assert oid is not None
        return oid

    def test_mcp_output_command_registered(self) -> None:
        from typer.testing import CliRunner

        from token_goat.cli import app
        runner = CliRunner()
        result = runner.invoke(app, ["mcp-output", "--help"])
        assert result.exit_code == 0
        assert "cached MCP" in result.output.lower() or "mcp" in result.output.lower()

    def test_mcp_history_command_registered(self) -> None:
        from typer.testing import CliRunner

        from token_goat.cli import app
        runner = CliRunner()
        result = runner.invoke(app, ["mcp-history", "--help"])
        assert result.exit_code == 0
