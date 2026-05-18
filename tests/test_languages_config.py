"""Tests for the TOML / YAML / JSON section extractors."""
from __future__ import annotations

from token_goat.languages import json_idx, toml_idx, yaml_idx


class TestTomlExtractor:
    def test_simple_tables(self):
        src = b"""
[tool.ruff]
line-length = 100

[tool.ruff.format]
quote-style = "double"

[[some.array]]
key = 1
"""
        symbols, refs, imps, sections = toml_idx.extract(src, "pyproject.toml")
        assert refs == [] and imps == []
        headings = [s.heading for s in sections]
        assert "tool.ruff" in headings
        assert "tool.ruff.format" in headings
        assert "some.array" in headings
        # Sections have ascending start lines and non-overlapping end lines.
        for a, b in zip(sections, sections[1:], strict=False):
            assert a.line <= b.line
            assert a.end_line is not None and a.end_line < b.line or a.end_line == b.line - 1

    def test_no_headers_yields_empty(self):
        src = b'name = "thing"\nversion = "0.1"\n'
        _, _, _, sections = toml_idx.extract(src, "Cargo.toml")
        assert sections == []

    def test_malformed_brackets_ignored(self):
        src = b"[a]\nok = 1\n[bad\nnot = 'a section'\n"
        _, _, _, sections = toml_idx.extract(src, "x.toml")
        headings = [s.heading for s in sections]
        assert headings == ["a"]

    def test_quoted_table_name(self):
        src = b'["tool.ruff"]\nkey = "x"\n'
        _, _, _, sections = toml_idx.extract(src, "x.toml")
        assert any(s.heading == "tool.ruff" for s in sections)


class TestYamlExtractor:
    def test_top_level_keys_emitted(self):
        src = b"name: my-action\nruns:\n  using: composite\n  steps:\n    - run: echo\n"
        _, _, _, sections = yaml_idx.extract(src, "action.yml")
        headings = [s.heading for s in sections]
        assert "name" in headings
        assert "runs" in headings

    def test_nested_keys_emitted(self):
        src = b"spec:\n  replicas: 3\n  selector: foo\n  template:\n    metadata: x\n"
        _, _, _, sections = yaml_idx.extract(src, "deploy.yaml")
        headings = [s.heading for s in sections]
        assert "spec" in headings
        # Nested keys are emitted with parent.child dotted form.
        assert "spec.replicas" in headings
        assert "spec.selector" in headings

    def test_list_items_not_emitted_as_keys(self):
        src = b"items:\n  - one\n  - two\n  - three\n"
        _, _, _, sections = yaml_idx.extract(src, "list.yml")
        headings = [s.heading for s in sections]
        # Only "items" is a real key; the list dashes should not become keys.
        assert headings == ["items"]

    def test_multi_document_resets_state(self):
        src = b"a: 1\n---\nb: 2\n"
        _, _, _, sections = yaml_idx.extract(src, "multi.yml")
        headings = [s.heading for s in sections]
        assert "a" in headings
        assert "b" in headings


class TestJsonSections:
    def test_pretty_printed_json_emits_sections(self):
        src = b"""{
  "name": "my-pkg",
  "version": "1.0.0",
  "scripts": {
    "test": "vitest",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18"
  }
}
"""
        _, _, _, sections = json_idx.extract(src, "package.json")
        headings = [s.heading for s in sections]
        assert headings == ["name", "version", "scripts", "dependencies"]
        # End lines bound each section to the line before the next heading.
        scripts_sec = next(s for s in sections if s.heading == "scripts")
        deps_sec = next(s for s in sections if s.heading == "dependencies")
        assert scripts_sec.end_line is not None
        assert scripts_sec.end_line < deps_sec.line

    def test_minified_json_no_sections(self):
        src = b'{"name":"x","version":"1.0.0","deps":{"a":"b"}}'
        _, _, _, sections = json_idx.extract(src, "min.json")
        assert sections == []

    def test_nested_keys_not_in_sections(self):
        """The 'test' key inside 'scripts' must not become a top-level section."""
        src = b"""{
  "scripts": {
    "test": "vitest"
  }
}
"""
        _, _, _, sections = json_idx.extract(src, "p.json")
        headings = [s.heading for s in sections]
        # Only the top-level "scripts" key is a section; "test" (depth 2) is not.
        assert headings == ["scripts"]
