"""Tests for the JSON extractor."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.languages.json_idx import extract

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
    # Should have one array summary symbol
    array_symbols = [s for s in symbols if s.kind == "json_array"]
    assert len(array_symbols) == 1
    assert "2000" in array_symbols[0].name


def test_large_minified_json_falls_back_to_permissive_regex(tmp_path):
    """Minified large JSON has no newlines; strict ``^``-anchored regex would
    return zero hits.  The permissive fallback must capture the keys.

    Regression for the case where ``json.loads`` fails on a huge minified blob
    (e.g., trailing garbage in an API dump) — the original fallback regex was
    anchored at column 0 with re.MULTILINE, which captures nothing when the
    entire file is on a single line.
    """
    import json

    # Build a large minified blob, then append garbage so json.loads fails.
    payload = {f"k{i}": i for i in range(6000)}
    minified = json.dumps(payload, separators=(",", ":"))
    minified += "<<<garbage>>>"  # forces JSONDecodeError
    assert "\n" not in minified
    assert len(minified.encode()) > 50_000

    f = tmp_path / "minified_bad.json"
    f.write_text(minified, encoding="utf-8")

    symbols, _, _, _ = extract(f.read_bytes(), "minified_bad.json")
    # Permissive fallback must extract at least some keys.
    assert len(symbols) > 0
    names = {s.name for s in symbols}
    assert "k0" in names
    # De-duplication: each key appears at most once even though the source
    # may contain repeating "id"-style tokens across millions of bytes.
    assert len(names) == len(symbols)


def test_large_json_nested_dict_emits_parent_child_symbols(tmp_path):
    """Top-level dict values that are also dicts contribute ``parent.child``
    nested-key symbols, up to the nested-budget cap.
    """
    import json

    # Two top-level keys, each a nested object.  Pad with filler to exceed
    # the 50 KB indexing threshold.
    payload = {
        "database": {"host": "localhost", "port": 5432, "name": "prod"},
        "auth": {"issuer": "https://idp.example", "audience": "api"},
        "filler": "x" * 60_000,
    }
    f = tmp_path / "config_nested.json"
    f.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    symbols, _, _, _ = extract(f.read_bytes(), "config_nested.json")
    names = {s.name for s in symbols}
    # Top-level keys present
    assert "database" in names
    assert "auth" in names
    # Nested children present
    assert "database.host" in names
    assert "database.port" in names
    assert "auth.issuer" in names
    # Nested kind is distinct from top-level
    kinds = {s.kind for s in symbols if "." in s.name}
    assert kinds == {"json_nested_key"}


def test_large_json_array_of_objects_peeks_element_keys(tmp_path):
    """Arrays whose first element is a dict get ``[].key`` schema symbols."""
    import json

    records = [{"id": i, "name": f"u{i}", "active": True, "score": i * 1.5}
               for i in range(2000)]
    f = tmp_path / "records.json"
    f.write_text(json.dumps(records), encoding="utf-8")

    symbols, _, _, _ = extract(f.read_bytes(), "records.json")
    names = {s.name for s in symbols}
    # Array summary still present
    assert any(s.kind == "json_array" for s in symbols)
    # First-element schema is exposed
    assert "[].id" in names
    assert "[].name" in names
    assert "[].active" in names
    assert "[].score" in names
    elem_kinds = {s.kind for s in symbols if s.name.startswith("[].")}
    assert elem_kinds == {"json_array_element_key"}


def test_large_json_array_of_primitives_no_element_keys(tmp_path):
    """Arrays of primitives should NOT trigger element-key peeking — only the
    summary symbol is emitted.
    """
    import json

    # An array of ~30K integers — well above the size gate but no schema to peek.
    data = list(range(30_000))
    f = tmp_path / "ints.json"
    f.write_text(json.dumps(data), encoding="utf-8")

    symbols, _, _, _ = extract(f.read_bytes(), "ints.json")
    assert len(symbols) == 1
    assert symbols[0].kind == "json_array"


def test_large_json_respects_max_symbols_budget(tmp_path):
    """Combined top-level + nested-key emission must never exceed _MAX_SYMBOLS."""
    import json

    from token_goat.languages.json_idx import _MAX_SYMBOLS

    # 300 top-level keys each with a nested dict.  Top-level alone would emit
    # 300 entries, well above the 200 cap; verify the cap holds.
    payload = {f"k{i}": {"sub_a": i, "sub_b": i * 2} for i in range(300)}
    f = tmp_path / "huge.json"
    f.write_text(json.dumps(payload), encoding="utf-8")

    symbols, _, _, _ = extract(f.read_bytes(), "huge.json")
    assert len(symbols) <= _MAX_SYMBOLS
