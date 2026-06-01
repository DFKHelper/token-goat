"""Tests for `token-goat test-for` command and read_commands.test_for helper."""
from __future__ import annotations

import json
from pathlib import Path

import click.exceptions
import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_project_with_files(
    tmp_path: Path,
    tmp_data_dir: object,
    make_project: object,
    files: dict[str, str],
) -> tuple[Path, object]:
    """Create a minimal indexed project with the given files (rel_path -> content)."""
    from token_goat.parser import index_project

    proj_root = tmp_path / "tf_proj"
    proj_root.mkdir()
    (proj_root / ".git").mkdir()
    for rel, content in files.items():
        abs_path = proj_root / rel
        abs_path.parent.mkdir(parents=True, exist_ok=True)
        abs_path.write_text(content, encoding="utf-8")
    proj = make_project(proj_root)  # type: ignore[operator]
    index_project(proj, full=True)
    return proj_root, proj


# ---------------------------------------------------------------------------
# test_for() — text output
# ---------------------------------------------------------------------------


class TestTestForTextOutput:
    def test_finds_canonical_test_file(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """tests/test_{module}.py is found and its test functions are listed."""
        impl_content = "def load(): pass\ndef save(): pass\n"
        test_content = (
            "def test_load(): pass\n"
            "def test_save(): pass\n"
            "def test_roundtrip(): pass\n"
        )
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "src/mymod.py": impl_content,
                "tests/test_mymod.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("src/mymod.py")
        out = capsys.readouterr().out

        assert "tests/test_mymod.py" in out
        assert "3 tests" in out
        assert "test_load" in out
        assert "test_save" in out
        assert "test_roundtrip" in out

    def test_no_test_file_shows_helpful_message(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """When no test file exists a helpful message is printed (no exception)."""
        impl_content = "def compute(): pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {"src/orphan.py": impl_content},
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("src/orphan.py")
        out = capsys.readouterr().out

        assert "No test file found" in out
        assert "orphan" in out

    def test_test_file_with_no_test_functions(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """A test file containing no test_ functions shows 0 tests."""
        impl_content = "def something(): pass\n"
        test_content = "# placeholder\nclass Helper: pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "util.py": impl_content,
                "tests/test_util.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("util.py")
        out = capsys.readouterr().out

        assert "tests/test_util.py" in out
        assert "0 tests" in out

    def test_singular_noun_for_one_test(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """Output uses 'test' (not 'tests') when exactly one test function is found."""
        impl_content = "def run(): pass\n"
        test_content = "def test_run(): pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "runner.py": impl_content,
                "tests/test_runner.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("runner.py")
        out = capsys.readouterr().out

        assert "1 test:" in out
        assert "test_run" in out

    def test_inline_cap_ellipsis(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """When a test file has more than 10 test functions the output is truncated with '…'."""
        impl_content = "def thing(): pass\n"
        # 12 test functions — exceeds _TEST_FOR_INLINE_CAP (10)
        fns = "\n".join(f"def test_item_{i}(): pass" for i in range(12))
        test_content = fns + "\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "thing.py": impl_content,
                "tests/test_thing.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("thing.py")
        out = capsys.readouterr().out

        assert "12 tests" in out
        assert "…" in out


# ---------------------------------------------------------------------------
# test_for() — JSON output
# ---------------------------------------------------------------------------


class TestTestForJsonOutput:
    def test_json_structure_with_test_file(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--json returns expected keys and test list."""
        impl_content = "def alpha(): pass\n"
        test_content = "def test_alpha(): pass\ndef test_beta(): pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "alpha.py": impl_content,
                "tests/test_alpha.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("alpha.py", json_output=True)
        raw = capsys.readouterr().out
        data = json.loads(raw)

        assert "impl" in data
        assert "test_files" in data
        assert len(data["test_files"]) >= 1

        tf = data["test_files"][0]
        assert "path" in tf
        assert "test_count" in tf
        assert "tests" in tf
        assert isinstance(tf["tests"], list)
        assert "test_alpha" in tf["tests"]
        assert "test_beta" in tf["tests"]
        assert tf["test_count"] == 2

    def test_json_no_test_file(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """--json returns empty test_files list when no test file is found."""
        impl_content = "def ghost(): pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {"ghost.py": impl_content},
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("ghost.py", json_output=True)
        raw = capsys.readouterr().out
        data = json.loads(raw)

        assert data["test_files"] == []

    def test_json_impl_path_matches_resolved_rel(self, tmp_path, tmp_data_dir, make_project, capsys, monkeypatch):
        """'impl' field in JSON is the project-relative path, not the raw input."""
        impl_content = "def work(): pass\n"
        test_content = "def test_work(): pass\n"
        proj_root, _proj = _make_project_with_files(
            tmp_path,
            tmp_data_dir,
            make_project,
            {
                "src/worker.py": impl_content,
                "tests/test_worker.py": test_content,
            },
        )
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        test_for("worker.py", json_output=True)
        raw = capsys.readouterr().out
        data = json.loads(raw)

        # impl should be the relative path inside the project
        assert "worker" in data["impl"]


# ---------------------------------------------------------------------------
# test_for() — error cases
# ---------------------------------------------------------------------------


class TestTestForErrors:
    def test_nonexistent_file_exits_nonzero(self, tmp_path, tmp_data_dir, make_project, monkeypatch):
        """A file not found in any indexed project raises SystemExit(1)."""
        proj_root = tmp_path / "err_proj"
        proj_root.mkdir()
        (proj_root / ".git").mkdir()
        proj = make_project(proj_root)  # type: ignore[operator]
        from token_goat.parser import index_project
        index_project(proj, full=True)
        monkeypatch.chdir(proj_root)

        from token_goat.read_commands import test_for

        with pytest.raises((SystemExit, click.exceptions.Exit)):
            test_for("does_not_exist.py")
