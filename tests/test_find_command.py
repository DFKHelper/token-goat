"""Tests for the unified `token-goat find` command.

Covers:
- Exact match appears in the symbol section (first section)
- Semantic-only hit appears in the semantic section (second section)
- Deduplication: a hit already in the symbol section is suppressed from semantic
- JSON output shape and field names
- No-project fallback message
"""
from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_proj(hash_: str = "deadbeef") -> SimpleNamespace:
    return SimpleNamespace(hash=hash_, root="/fake/project")


def _make_sql_row(name: str, kind: str, file_rel: str, line: int, signature: str | None = None):
    """Build a fake sqlite3.Row-like object with dict-key access."""
    row = MagicMock(spec=sqlite3.Row)
    row.__getitem__ = lambda self, key: {
        "name": name,
        "kind": kind,
        "file_rel": file_rel,
        "line": line,
        "signature": signature,
    }[key]
    return row


def _make_semantic_hit(
    file_rel: str,
    start_line: int,
    end_line: int,
    kind: str = "function",
    distance: float = 0.3,
    text: str = "def foo(): pass",
):
    return SimpleNamespace(
        file_rel=file_rel,
        start_line=start_line,
        end_line=end_line,
        kind=kind,
        distance=distance,
        text=text,
    )


@contextmanager
def _fake_db(exact_rows=(), fuzzy_rows=()):
    """Context manager that yields a mock DB connection returning canned rows."""
    conn = MagicMock()
    # exact query (name = ?)
    # fuzzy query (name LIKE ?)
    conn.execute.side_effect = _make_execute_side_effect(exact_rows, fuzzy_rows)
    yield conn


def _make_execute_side_effect(exact_rows, fuzzy_rows):
    calls = []

    def side_effect(sql, params):
        result = MagicMock()
        if "name LIKE" in sql:
            result.fetchall.return_value = list(fuzzy_rows)
        else:
            result.fetchall.return_value = list(exact_rows)
        calls.append((sql, params))
        return result

    return side_effect


def _invoke_find(query: str, extra_args: list | None = None, *, proj=None, exact_rows=(), fuzzy_rows=(), sem_hits=()):
    """Invoke `token-goat find <query>` with mocked dependencies."""
    if proj is None:
        proj = _make_proj()

    @contextmanager
    def _ctx_mgr(hash_):  # noqa: ANN001, ANN202
        conn = MagicMock()
        conn.execute.side_effect = _make_execute_side_effect(exact_rows, fuzzy_rows)
        yield conn

    with (
        patch("token_goat.project.find_project", return_value=proj),
        patch("token_goat.read_commands.db.open_project", side_effect=_ctx_mgr),
        patch("token_goat.embeddings.semantic_search", return_value=list(sem_hits)),
        patch("token_goat.embeddings.DEFAULT_DISTANCE_THRESHOLD", 0.5),
    ):
        args = ["find", query] + (extra_args or [])
        return runner.invoke(cli.app, args)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestFindCommandSmoke:
    def test_no_project_shows_help(self):
        """When find_project returns None, a helpful message is printed."""
        with patch("token_goat.project.find_project", return_value=None):
            result = runner.invoke(cli.app, ["find", "anything"])
        assert result.exit_code == 0
        assert "indexed project" in result.stdout

    def test_help_includes_find(self):
        """`token-goat --help` lists the find command."""
        result = runner.invoke(cli.app, ["--help"])
        assert result.exit_code == 0
        assert "find" in result.stdout


class TestFindExactMatches:
    def test_exact_match_appears_in_symbol_section(self):
        """An exact name match must appear under 'Exact/fuzzy matches:' heading."""
        row = _make_sql_row("login", "function", "src/auth.py", 42)
        result = _invoke_find("login", exact_rows=[row])
        assert result.exit_code == 0, result.output
        lines = result.stdout.splitlines()
        # First non-blank line should be the symbol section heading
        non_blank = [ln for ln in lines if ln.strip()]
        assert non_blank[0] == "Exact/fuzzy matches:"
        # The symbol must appear in a following line
        body = result.stdout
        assert "src/auth.py:42" in body
        assert "login" in body

    def test_fuzzy_match_appears_when_no_exact(self):
        """A LIKE-match falls back to fuzzy section when name != query."""
        fuzzy = _make_sql_row("login_user", "function", "src/auth.py", 55)
        result = _invoke_find("login", fuzzy_rows=[fuzzy])
        assert result.exit_code == 0, result.output
        body = result.stdout
        assert "src/auth.py:55" in body
        assert "login_user" in body

    def test_symbol_section_limit_is_five(self):
        """Symbol section never shows more than 5 results."""
        rows = [_make_sql_row(f"func_{i}", "function", "src/mod.py", i * 10) for i in range(10)]
        result = _invoke_find("func", exact_rows=rows)
        assert result.exit_code == 0, result.output
        # Count lines under the heading
        lines = result.stdout.splitlines()
        symbol_lines = [ln for ln in lines if ln.startswith("  src/mod.py")]
        assert len(symbol_lines) <= 5


class TestFindSemanticSection:
    def test_semantic_hit_appears_in_semantic_section(self):
        """A semantic hit with no symbol match appears under 'Semantic matches:'."""
        hit = _make_semantic_hit("src/rate.py", 10, 20, text="def retry_with_backoff(): ...")
        result = _invoke_find("rate limit retry", sem_hits=[hit])
        assert result.exit_code == 0, result.output
        body = result.stdout
        assert "Semantic matches:" in body
        assert "src/rate.py:10" in body

    def test_semantic_section_absent_when_no_hits(self):
        """When semantic search returns no hits, section shows '(none)'."""
        result = _invoke_find("nothing_will_match")
        assert result.exit_code == 0, result.output
        assert "Semantic matches: (none)" in result.stdout

    def test_semantic_section_limit_is_five(self):
        """Semantic section never shows more than 5 results."""
        hits = [_make_semantic_hit(f"src/mod_{i}.py", i * 10, i * 10 + 5) for i in range(10)]
        result = _invoke_find("query", sem_hits=hits)
        assert result.exit_code == 0, result.output
        lines = result.stdout.splitlines()
        sem_lines = [ln for ln in lines if ln.startswith("  src/mod_")]
        assert len(sem_lines) <= 5


class TestFindDeduplication:
    def test_dedup_suppresses_semantic_hit_already_in_symbol_section(self):
        """When a semantic hit's (file, line) matches a symbol result, it must not appear twice."""
        # Symbol result at src/auth.py:42
        row = _make_sql_row("login", "function", "src/auth.py", 42)
        # Semantic hit at the same location
        sem = _make_semantic_hit("src/auth.py", 42, 60, text="def login(): ...")
        # A second semantic hit at a different location (should appear)
        sem2 = _make_semantic_hit("src/other.py", 1, 10, text="def other(): ...")

        result = _invoke_find("login", exact_rows=[row], sem_hits=[sem, sem2])
        assert result.exit_code == 0, result.output

        # "src/auth.py" must appear exactly once (in the symbol section)
        count = result.stdout.count("src/auth.py")
        assert count == 1, f"src/auth.py appeared {count} times — dedup failed:\n{result.stdout}"
        # The other file must appear in semantic section
        assert "src/other.py" in result.stdout


class TestFindJsonOutput:
    def test_json_output_structure(self):
        """--json output is valid JSON with query, symbol_matches, and semantic_matches keys."""
        row = _make_sql_row("process", "function", "src/worker.py", 100, "process(item)")
        hit = _make_semantic_hit("src/queue.py", 5, 15, text="queue processing logic")
        result = _invoke_find("process", extra_args=["--json"], exact_rows=[row], sem_hits=[hit])
        assert result.exit_code == 0, result.output
        data = json.loads(result.stdout)
        assert data["query"] == "process"
        assert isinstance(data["symbol_matches"], list)
        assert isinstance(data["semantic_matches"], list)

    def test_json_symbol_match_fields(self):
        """Each symbol match in JSON has file, line, kind, name fields."""
        row = _make_sql_row("process", "function", "src/worker.py", 100, "process(item)")
        result = _invoke_find("process", extra_args=["--json"], exact_rows=[row])
        data = json.loads(result.stdout)
        assert len(data["symbol_matches"]) >= 1
        sym = data["symbol_matches"][0]
        assert sym["file"] == "src/worker.py"
        assert sym["line"] == 100
        assert sym["kind"] == "function"
        assert sym["name"] == "process"

    def test_json_semantic_match_fields(self):
        """Each semantic match in JSON has file, start, end, kind, distance, preview fields."""
        hit = _make_semantic_hit("src/queue.py", 5, 15, distance=0.25, text="queue processing")
        result = _invoke_find("queue", extra_args=["--json"], sem_hits=[hit])
        data = json.loads(result.stdout)
        assert len(data["semantic_matches"]) >= 1
        sem = data["semantic_matches"][0]
        assert sem["file"] == "src/queue.py"
        assert sem["start"] == 5
        assert sem["end"] == 15
        assert "distance" in sem
        assert "preview" in sem

    def test_json_dedup_in_json_mode(self):
        """Dedup works in JSON mode: same (file, line) suppressed from semantic_matches."""
        row = _make_sql_row("login", "function", "src/auth.py", 42)
        sem_dup = _make_semantic_hit("src/auth.py", 42, 60, text="def login(): ...")
        sem_other = _make_semantic_hit("src/other.py", 1, 10, text="other code")

        result = _invoke_find("login", extra_args=["--json"], exact_rows=[row], sem_hits=[sem_dup, sem_other])
        data = json.loads(result.stdout)

        sem_files = [s["file"] for s in data["semantic_matches"]]
        assert "src/auth.py" not in sem_files, "Duplicate suppressed in symbol section leaked into semantic"
        assert "src/other.py" in sem_files
