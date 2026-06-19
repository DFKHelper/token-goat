"""Tests for the pack and budget commands."""
from __future__ import annotations

from pathlib import Path

import pytest

from token_goat.pack import (
    BudgetResult,
    collect_files,
    estimate_budget,
    format_budget_text,
    format_markdown,
    format_pack,
    format_plain,
    format_xml,
)

# ---------------------------------------------------------------------------
# Shared helpers / fixtures
# ---------------------------------------------------------------------------


def _w(root: Path, files: dict[str, str]) -> None:
    """Write a dict of {rel_path: content} files under root."""
    for rel, content in files.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding="utf-8")


@pytest.fixture
def one_py(tmp_path):
    """Single-file project: src/auth.py with a function."""
    _w(tmp_path, {"src/auth.py": "def login(): pass\n"})
    return collect_files(tmp_path, ["src/auth.py"])


@pytest.fixture
def two_py(tmp_path):
    """Two Python files: a.py (small) and b.py (large)."""
    _w(tmp_path, {"a.py": "a" * 400, "b.py": "b" * 800})
    return tmp_path


# ---------------------------------------------------------------------------
# collect_files
# ---------------------------------------------------------------------------


class TestCollectFiles:
    def test_collects_matched_files(self, tmp_path: Path) -> None:
        _w(tmp_path, {"src/a.py": "x\n", "src/b.py": "y\n", "src/c.ts": "z\n"})
        result = collect_files(tmp_path, ["src/*.py"])
        assert {f.rel_path for f in result.files} == {"src/a.py", "src/b.py"}

    def test_recursive_glob(self, tmp_path: Path) -> None:
        _w(tmp_path, {
            "src/auth/login.py": "pass\n",
            "src/auth/logout.py": "pass\n",
            "src/models.py": "pass\n",
        })
        assert len(collect_files(tmp_path, ["src/**/*.py"]).files) == 3

    def test_multiple_patterns(self, tmp_path: Path) -> None:
        _w(tmp_path, {"a.py": "x\n", "b.ts": "y\n", "c.md": "# z\n"})
        assert {f.rel_path for f in collect_files(tmp_path, ["*.py", "*.ts"]).files} == {"a.py", "b.ts"}

    def test_deduplicates_overlapping_patterns(self, tmp_path: Path) -> None:
        _w(tmp_path, {"a.py": "pass\n"})
        assert len(collect_files(tmp_path, ["*.py", "a.py"]).files) == 1

    def test_respects_ignore_patterns(self, tmp_path: Path) -> None:
        _w(tmp_path, {"src/main.py": "pass\n", "src/gen.py": "# autogen\n"})
        result = collect_files(tmp_path, ["src/*.py"], ignore_patterns=["src/gen.py"])
        assert len(result.files) == 1 and result.files[0].rel_path == "src/main.py"

    def test_skips_oversized_files(self, tmp_path: Path) -> None:
        _w(tmp_path, {"big.py": "x" * 100})
        result = collect_files(tmp_path, ["*.py"], max_file_bytes=50)
        assert result.files == [] and len(result.skipped) == 1 and "big.py" in result.skipped[0]

    def test_token_estimate(self, tmp_path: Path) -> None:
        _w(tmp_path, {"f.py": "a" * 400})
        assert collect_files(tmp_path, ["f.py"]).files[0].tokens == 100

    def test_total_tokens_summed(self, two_py: Path) -> None:
        result = collect_files(two_py, ["*.py"])
        assert result.total_tokens == 300

    def test_no_match_returns_empty(self, tmp_path: Path) -> None:
        result = collect_files(tmp_path, ["nonexistent/**"])
        assert result.files == [] and result.total_tokens == 0

    def test_skips_symlink_outside_root(self, tmp_path: Path) -> None:
        target = tmp_path.parent / "secret.txt"
        target.write_text("SECRET", encoding="utf-8")
        link = tmp_path / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            pytest.skip("symlink creation not available on this platform")
        result = collect_files(tmp_path, ["link.txt"])
        assert result.files == []
        assert any("symlink" in s for s in result.skipped)


# ---------------------------------------------------------------------------
# Formatters — share the one_py fixture
# ---------------------------------------------------------------------------


class TestFormatMarkdown:
    def test_manifest_header(self, one_py) -> None:
        out = format_markdown(one_py)
        assert "# Packed context" in out and "src/auth.py" in out and "~Tokens" in out

    def test_fenced_code_block(self, one_py) -> None:
        out = format_markdown(one_py)
        assert "```python" in out and "def login(): pass" in out

    def test_line_numbers(self, one_py) -> None:
        assert "1  " in format_markdown(one_py, line_numbers=True)

    def test_instruction(self, one_py) -> None:
        out = format_markdown(one_py, instruction="Fix all the things.")
        assert "Instructions" in out and "Fix all the things." in out


class TestFormatXml:
    def test_wraps_in_documents(self, one_py) -> None:
        out = format_xml(one_py)
        assert out.startswith("<documents>") and out.endswith("</documents>")

    def test_source_element(self, one_py) -> None:
        assert "<source>src/auth.py</source>" in format_xml(one_py)

    def test_escapes_special_chars(self, tmp_path: Path) -> None:
        _w(tmp_path, {"x.py": "x = a < b and c > d\n"})
        out = format_xml(collect_files(tmp_path, ["x.py"]))
        assert "&lt;" in out and "&gt;" in out

    def test_source_path_escaping(self, tmp_path: Path) -> None:
        p = tmp_path / "a&b.py"
        p.write_text("pass\n", encoding="utf-8")
        result = collect_files(tmp_path, ["a&b.py"])
        assert "<source>a&amp;b.py</source>" in format_xml(result)

    def test_instruction_document(self, one_py) -> None:
        out = format_xml(one_py, instruction="Do nothing.")
        assert "<source>instructions</source>" in out and "Do nothing." in out


class TestFormatPlain:
    def test_separator_and_summary(self, one_py) -> None:
        out = format_plain(one_py)
        assert "=" * 20 in out and "src/auth.py" in out and "1 file" in out


class TestFormatPack:
    def test_dispatches(self, one_py) -> None:
        assert "<documents>" in format_pack(one_py, "xml")
        assert "=" * 20 in format_pack(one_py, "plain")
        assert "# Packed context" in format_pack(one_py, "markdown")

    def test_unknown_style_raises(self, one_py) -> None:
        with pytest.raises(ValueError, match="Unknown style"):
            format_pack(one_py, "rst")


# ---------------------------------------------------------------------------
# estimate_budget / format_budget_text
# ---------------------------------------------------------------------------


class TestEstimateBudget:
    def test_sorted_by_tokens_desc(self, two_py: Path) -> None:
        entries = estimate_budget(two_py, ["*.py"]).entries
        assert len(entries) == 2
        assert entries[0].tokens >= entries[1].tokens and entries[0].rel_path == "b.py"

    def test_totals_accumulate(self, two_py: Path) -> None:
        r = estimate_budget(two_py, ["*.py"])
        assert r.total_tokens == sum(e.tokens for e in r.entries)

    def test_respects_ignore_patterns(self, tmp_path: Path) -> None:
        _w(tmp_path, {"src/keep.py": "pass\n", "src/skip.py": "pass\n"})
        result = estimate_budget(tmp_path, ["src/*.py"], ignore_patterns=["src/skip.py"])
        assert "src/skip.py" not in {e.rel_path for e in result.entries}

    def test_empty_when_no_match(self, tmp_path: Path) -> None:
        r = estimate_budget(tmp_path, ["nonexistent/**"])
        assert r.entries == [] and r.total_tokens == 0


class TestFormatBudgetText:
    def test_header_and_totals(self, tmp_path: Path) -> None:
        _w(tmp_path, {"a.py": "x = 1\n"})
        out = format_budget_text(estimate_budget(tmp_path, ["a.py"]))
        assert "~Tokens" in out and "Total" in out and "a.py" in out

    def test_no_files_message(self) -> None:
        assert format_budget_text(BudgetResult()) == "No files matched."

    def test_context_percentage(self, tmp_path: Path) -> None:
        _w(tmp_path, {"a.py": "x" * 4000})
        out = format_budget_text(estimate_budget(tmp_path, ["a.py"]), context_k=200)
        assert "%" in out and "200K" in out
