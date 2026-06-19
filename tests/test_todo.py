"""Tests for the todo command — marker scanning across indexed project files."""
from __future__ import annotations

import pytest

from token_goat.todo import (
    TodoItem,
    find_todos,
    format_todos_json,
    format_todos_text,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def project(tmp_path_factory):
    """One project DB shared across all TestFindTodos tests.

    Using module scope eliminates per-test schema init overhead.
    Each test seeds files with unique names so they don't collide.
    Tests that need an empty result use the ``isolated_project`` fixture.
    """
    from token_goat.project import Project, canonicalize, project_hash

    root = tmp_path_factory.mktemp("todo_proj")
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


def seed(proj, files: dict[str, str]) -> None:
    """Write files to disk and register them in the project DB."""
    import token_goat.db as _db

    with _db.open_project(proj.hash) as conn:
        for rel, content in files.items():
            full = proj.root / rel
            full.parent.mkdir(parents=True, exist_ok=True)
            full.write_text(content, encoding="utf-8")
            conn.execute(
                "INSERT OR IGNORE INTO files"
                " (rel_path, language, size, mtime, content_sha256, indexed_at)"
                " VALUES (?, 'python', ?, 0.0, 'x', 0)",
                (rel, len(content)),
            )


@pytest.fixture
def isolated_project(tmp_path):
    """Separate single-use project for tests that assert on empty results."""
    from token_goat.project import Project, canonicalize, project_hash

    root = tmp_path / "iso"
    root.mkdir()
    canon = canonicalize(root)
    return Project(root=canon, hash=project_hash(canon), marker=".git")


# ---------------------------------------------------------------------------
# find_todos — shared project (module scope)
# ---------------------------------------------------------------------------


class TestFindTodos:
    def test_finds_todo_in_comment(self, project) -> None:
        seed(project, {"auth.py": "def login():\n    # TODO: add rate limiting\n    pass\n"})
        items = find_todos(project.hash, project.root)
        assert any(it.kind == "TODO" and "rate limiting" in it.text for it in items)

    def test_finds_fixme_in_inline_comment(self, project) -> None:
        seed(project, {"models.py": "x = 1  # FIXME: off-by-one error\n"})
        items = find_todos(project.hash, project.root)
        assert any(it.kind == "FIXME" and "off-by-one" in it.text for it in items)

    def test_accurate_line_numbers(self, project) -> None:
        seed(project, {"lineno.py": "line 1\nline 2\n# TODO: check line 3\nline 4\n"})
        items = find_todos(project.hash, project.root)
        assert any(it.line == 3 and it.file_rel == "lineno.py" for it in items)

    def test_kind_filter(self, project) -> None:
        seed(project, {"kinds.py": "# TODO: a\n# FIXME: b\n# HACK: c\n"})
        items = find_todos(project.hash, project.root, kinds=frozenset({"TODO"}))
        kinds = {it.kind for it in items if it.file_rel == "kinds.py"}
        assert kinds == {"TODO"}

    def test_multiple_files(self, project) -> None:
        seed(project, {"multi_a.py": "# TODO: in a\n", "multi_b.py": "# FIXME: in b\n"})
        items = find_todos(project.hash, project.root)
        files = {it.file_rel for it in items}
        assert "multi_a.py" in files
        assert "multi_b.py" in files

    def test_finds_xxx_and_hack(self, project) -> None:
        seed(project, {"xhack.py": "# XXX: risky\n# HACK: workaround\n"})
        items = find_todos(project.hash, project.root)
        kinds = {it.kind for it in items if it.file_rel == "xhack.py"}
        assert "XXX" in kinds
        assert "HACK" in kinds

    def test_case_insensitive_detection(self, project) -> None:
        seed(project, {"lower.py": "# todo: lowercase marker\n"})
        items = [it for it in find_todos(project.hash, project.root) if it.file_rel == "lower.py"]
        assert len(items) == 1
        assert items[0].kind == "TODO"

    # Tests below need isolation because they assert on empty or exact-count results.

    def test_does_not_match_marker_in_string_literal(self, isolated_project) -> None:
        seed(isolated_project, {"cli.py": 'help = "TODO,FIXME,HACK,XXX,NOTE"\n'})
        assert find_todos(isolated_project.hash, isolated_project.root) == []

    def test_empty_project_returns_empty(self, isolated_project) -> None:
        assert find_todos(isolated_project.hash, isolated_project.root) == []

    def test_no_duplicates_on_single_line(self, isolated_project) -> None:
        seed(isolated_project, {"once.py": "# TODO: only once\n"})
        items = find_todos(isolated_project.hash, isolated_project.root)
        assert len(items) == 1


# ---------------------------------------------------------------------------
# format_todos_text / format_todos_json — no I/O, pure unit
# ---------------------------------------------------------------------------


_SAMPLE_ITEMS = [
    TodoItem(file_rel="a.py", line=10, kind="TODO", text="fix auth"),
    TodoItem(file_rel="a.py", line=20, kind="FIXME", text="race cond"),
    TodoItem(file_rel="b.py", line=5, kind="HACK", text="workaround"),
]


class TestFormatTodosText:
    def test_grouped_by_file_default(self) -> None:
        out = format_todos_text(_SAMPLE_ITEMS, group_by="file")
        assert "a.py" in out and "b.py" in out
        assert "[TODO]" in out and "[FIXME]" in out
        assert "fix auth" in out

    def test_grouped_by_kind(self) -> None:
        out = format_todos_text(_SAMPLE_ITEMS, group_by="kind")
        assert "TODO (" in out and "FIXME (" in out and "HACK (" in out

    def test_grouped_by_kind_custom_marker_not_dropped(self) -> None:
        items = [TodoItem(file_rel="a.py", line=1, kind="CUSTOM", text="thing")]
        out = format_todos_text(items, group_by="kind")
        assert "CUSTOM" in out and "thing" in out

    def test_grouped_by_kind_standard_before_custom(self) -> None:
        items = [
            TodoItem(file_rel="a.py", line=1, kind="CUSTOM", text="x"),
            TodoItem(file_rel="a.py", line=2, kind="TODO", text="y"),
        ]
        out = format_todos_text(items, group_by="kind")
        assert out.index("TODO") < out.index("CUSTOM")

    def test_summary_line(self) -> None:
        out = format_todos_text(_SAMPLE_ITEMS)
        assert "3 items" in out and "2 files" in out

    def test_empty_returns_message(self) -> None:
        assert format_todos_text([]) == "No markers found."


class TestFormatTodosJson:
    def test_returns_valid_json_list(self) -> None:
        import json

        data = json.loads(format_todos_json([TodoItem("f.py", 1, "TODO", "fix")]))
        assert data == [{"file": "f.py", "line": 1, "kind": "TODO", "text": "fix"}]

    def test_empty_returns_empty_list(self) -> None:
        import json

        assert json.loads(format_todos_json([])) == []
