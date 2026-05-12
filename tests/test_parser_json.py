"""Tests for the JSON extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from cc_saver.languages.json_idx import extract

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "json_sample"
CONFIG_JSON = FIXTURE_DIR / "config.json"


@pytest.fixture
def small_json_source() -> bytes:
    return CONFIG_JSON.read_bytes()


def test_extract_returns_four_lists(small_json_source):
    symbols, refs, imports, sections = extract(small_json_source, "config.json")
    assert isinstance(symbols, list)
    assert isinstance(refs, list)
    assert isinstance(imports, list)
    assert isinstance(sections, list)


def test_small_json_not_indexed(small_json_source):
    # config.json is small (<50 KB), should not be indexed
    symbols, _, _, _ = extract(small_json_source, "config.json")
    assert len(symbols) == 0


def test_large_json_indexed(tmp_path):
    # Create a large JSON file (>50 KB)
    large_data = {
        f"key_{i}": f"value_{i}" * 100 for i in range(200)
    }
    import json
    json_str = json.dumps(large_data)
    assert len(json_str.encode()) > 50_000

    large_json_file = tmp_path / "large.json"
    large_json_file.write_text(json_str)

    symbols, _, _, _ = extract(large_json_file.read_bytes(), "large.json")
    assert len(symbols) > 0
    names = {s.name for s in symbols}
    assert any("key_" in name for name in names)


def test_large_json_array_indexed(tmp_path):
    # Create a large JSON array
    import json
    large_array = [{"id": i, "name": f"item_{i}" * 10} for i in range(2000)]
    json_str = json.dumps(large_array)
    assert len(json_str.encode()) > 50_000

    large_json_file = tmp_path / "array.json"
    large_json_file.write_text(json_str)

    symbols, _, _, _ = extract(large_json_file.read_bytes(), "array.json")
    assert len(symbols) > 0
    # Should have one array symbol
    array_symbols = [s for s in symbols if s.kind == "json_array"]
    assert len(array_symbols) == 1
    assert "2000" in array_symbols[0].name
