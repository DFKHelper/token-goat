"""Tests for tokenwise index --root, make_project_at, and cross-project file resolution."""
from __future__ import annotations

from pathlib import Path

import pytest

from tokenwise.project import canonicalize, make_project_at, project_hash

# ---------------------------------------------------------------------------
# make_project_at
# ---------------------------------------------------------------------------

class TestMakeProjectAt:
    def test_returns_project_with_manual_marker(self, tmp_path):
        proj = make_project_at(tmp_path)
        assert proj.marker == "manual"

    def test_hash_matches_canonical_path(self, tmp_path):
        proj = make_project_at(tmp_path)
        expected_hash = project_hash(canonicalize(tmp_path))
        assert proj.hash == expected_hash

    def test_root_is_canonical(self, tmp_path):
        proj = make_project_at(tmp_path)
        assert proj.root == canonicalize(tmp_path)

    def test_different_paths_produce_different_hashes(self, tmp_path):
        a = tmp_path / "a"
        b = tmp_path / "b"
        a.mkdir()
        b.mkdir()
        assert make_project_at(a).hash != make_project_at(b).hash

    def test_same_path_produces_same_hash(self, tmp_path):
        assert make_project_at(tmp_path).hash == make_project_at(tmp_path).hash

    def test_project_is_frozen(self, tmp_path):
        proj = make_project_at(tmp_path)
        import dataclasses  # noqa: PLC0415
        with pytest.raises(dataclasses.FrozenInstanceError):
            proj.marker = "changed"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# paths — Claude helpers
# ---------------------------------------------------------------------------

class TestClaudePaths:
    def test_claude_config_dir_is_home_dot_claude(self):
        from tokenwise import paths
        assert paths.claude_config_dir() == Path.home() / ".claude"

    def test_claude_skills_dir_is_under_claude(self):
        from tokenwise import paths
        assert paths.claude_skills_dir() == Path.home() / ".claude" / "skills"

    def test_claude_plugins_dir_is_under_claude(self):
        from tokenwise import paths
        assert paths.claude_plugins_dir() == Path.home() / ".claude" / "plugins"


# ---------------------------------------------------------------------------
# find_in_all_projects — requires indexed data in a tmp DB
# ---------------------------------------------------------------------------

class TestFindInAllProjects:
    def _make_md_file(self, root: Path, rel: str, content: str) -> Path:
        full = root / rel
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_text(content, encoding="utf-8")
        return full

    def test_returns_none_when_no_projects_indexed(self, tmp_data_dir):
        from tokenwise.read_replacement import find_in_all_projects
        assert find_in_all_projects("nonexistent.md") is None

    def test_finds_file_in_indexed_project(self, tmp_data_dir, tmp_path):
        from tokenwise.parser import index_project
        from tokenwise.read_replacement import find_in_all_projects

        skill_root = tmp_path / "skills"
        skill_root.mkdir()
        self._make_md_file(
            skill_root, "superman/SKILL.md",
            "# Superman\n\n## Plan Gate\n\nContent here.\n",
        )
        proj = make_project_at(skill_root)
        index_project(proj, full=True)

        result = find_in_all_projects("SKILL.md")
        assert result is not None
        found_proj, rel = result
        assert found_proj.hash == proj.hash
        assert "SKILL.md" in rel

    def test_finds_file_by_rel_path(self, tmp_data_dir, tmp_path):
        from tokenwise.parser import index_project
        from tokenwise.read_replacement import find_in_all_projects

        skill_root = tmp_path / "skills"
        skill_root.mkdir()
        self._make_md_file(
            skill_root, "ralph/SKILL.md",
            "# Ralph\n\n## Operating Protocol\n\nStuff.\n",
        )
        proj = make_project_at(skill_root)
        index_project(proj, full=True)

        result = find_in_all_projects("ralph/SKILL.md")
        assert result is not None
        _, rel = result
        assert rel == "ralph/SKILL.md"

    def test_returns_none_for_unknown_file(self, tmp_data_dir, tmp_path):
        from tokenwise.parser import index_project
        from tokenwise.read_replacement import find_in_all_projects

        skill_root = tmp_path / "skills"
        skill_root.mkdir()
        self._make_md_file(skill_root, "foo.md", "# Foo\n")
        proj = make_project_at(skill_root)
        index_project(proj, full=True)

        assert find_in_all_projects("does_not_exist.md") is None

    def test_searches_multiple_projects(self, tmp_data_dir, tmp_path):
        from tokenwise.parser import index_project
        from tokenwise.read_replacement import find_in_all_projects

        skills_root = tmp_path / "skills"
        skills_root.mkdir()
        plugins_root = tmp_path / "plugins"
        plugins_root.mkdir()

        self._make_md_file(skills_root, "tool.md", "# Tool Skill\n")
        self._make_md_file(plugins_root, "plugin.md", "# Plugin Docs\n")

        index_project(make_project_at(skills_root), full=True)
        index_project(make_project_at(plugins_root), full=True)

        assert find_in_all_projects("tool.md") is not None
        assert find_in_all_projects("plugin.md") is not None

    def test_returns_none_for_ambiguous_file_name(self, tmp_data_dir, tmp_path):
        from tokenwise.parser import index_project
        from tokenwise.read_replacement import find_in_all_projects

        skills_root = tmp_path / "skills"
        skills_root.mkdir()
        plugins_root = tmp_path / "plugins"
        plugins_root.mkdir()

        self._make_md_file(skills_root, "shared.md", "# One\n")
        self._make_md_file(plugins_root, "shared.md", "# Two\n")

        index_project(make_project_at(skills_root), full=True)
        index_project(make_project_at(plugins_root), full=True)

        assert find_in_all_projects("shared.md") is None

    def test_handles_corrupt_global_db_gracefully(self, tmp_data_dir, monkeypatch):
        from tokenwise import db as _db
        from tokenwise.read_replacement import find_in_all_projects

        def _boom(*a, **kw):
            raise RuntimeError("DB exploded")

        monkeypatch.setattr(_db, "open_global_readonly", _boom)
        # Should return None, not crash
        assert find_in_all_projects("anything.md") is None


# ---------------------------------------------------------------------------
# index --root CLI integration (via Typer test runner)
# ---------------------------------------------------------------------------

class TestIndexRootCli:
    def _make_skill_dir(self, base: Path) -> Path:
        skill_root = base / "skills"
        skill_root.mkdir()
        (skill_root / "superman").mkdir()
        (skill_root / "superman" / "SKILL.md").write_text(
            "# Superman\n\n## Plan Gate\n\nContent.\n", encoding="utf-8"
        )
        return skill_root

    def test_index_root_indexes_directory(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner

        from tokenwise.cli import app

        skill_root = self._make_skill_dir(tmp_path)
        runner = CliRunner()
        result = runner.invoke(app, ["index", "--root", str(skill_root), "--full"])
        assert result.exit_code == 0
        assert "Indexed" in result.output

    def test_index_root_bad_path_exits_2(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner

        from tokenwise.cli import app

        runner = CliRunner()
        result = runner.invoke(app, ["index", "--root", str(tmp_path / "nonexistent"), "--full"])
        assert result.exit_code == 2

    def test_index_skills_flag(self, tmp_data_dir, tmp_path, monkeypatch):
        from typer.testing import CliRunner

        from tokenwise import paths
        from tokenwise.cli import app

        skill_root = self._make_skill_dir(tmp_path)
        monkeypatch.setattr(paths, "claude_skills_dir", lambda: skill_root)

        runner = CliRunner()
        result = runner.invoke(app, ["index", "--skills", "--full"])
        assert result.exit_code == 0
        assert "Indexed" in result.output

    def test_index_skills_missing_dir_exits_1(self, tmp_data_dir, tmp_path, monkeypatch):
        from typer.testing import CliRunner

        from tokenwise import paths
        from tokenwise.cli import app

        monkeypatch.setattr(paths, "claude_skills_dir", lambda: tmp_path / "no_such_dir")

        runner = CliRunner()
        result = runner.invoke(app, ["index", "--skills"])
        assert result.exit_code == 1

    def test_index_plugins_flag(self, tmp_data_dir, tmp_path, monkeypatch):
        from typer.testing import CliRunner

        from tokenwise import paths
        from tokenwise.cli import app

        plugins_root = tmp_path / "plugins"
        plugins_root.mkdir()
        (plugins_root / "myplugin.md").write_text("# My Plugin\n", encoding="utf-8")
        monkeypatch.setattr(paths, "claude_plugins_dir", lambda: plugins_root)

        runner = CliRunner()
        result = runner.invoke(app, ["index", "--plugins", "--full"])
        assert result.exit_code == 0
        assert "Indexed" in result.output

    def test_indexed_file_findable_cross_project(self, tmp_data_dir, tmp_path):
        from typer.testing import CliRunner

        from tokenwise.cli import app
        from tokenwise.read_replacement import find_in_all_projects

        skill_root = self._make_skill_dir(tmp_path)
        runner = CliRunner()
        runner.invoke(app, ["index", "--root", str(skill_root), "--full"])

        result = find_in_all_projects("SKILL.md")
        assert result is not None
