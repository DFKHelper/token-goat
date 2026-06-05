"""Tests for the test-only helpers in conftest.py.

Yes, tests for test helpers — make_git_repo is now used by 7+ sites
across test_compact and test_git_history, and a regression in the helper
would silently bend the meaning of every site that depends on it. Cover
the surface explicitly so the helper itself has a contract.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from conftest import make_fake_git_repo, make_git_repo


@pytest.mark.slow
class TestMakeGitRepo:
    """make_git_repo: minimal git repo for integration sites."""

    def test_creates_repo_with_default_branch(self, tmp_path: Path) -> None:
        repo = make_git_repo(tmp_path)
        assert (repo / ".git").is_dir(), "git init did not create .git directory"
        # No commits => HEAD reference exists but is unborn; just confirm the
        # repo exists and git can run inside it.
        result = subprocess.run(
            ["git", "status"],
            cwd=repo, capture_output=True, text=True, check=True, timeout=30,
        )
        assert "No commits yet" in result.stdout or "branch" in result.stdout.lower()

    def test_files_kwarg_seeds_one_commit(self, tmp_path: Path) -> None:
        repo = make_git_repo(
            tmp_path, "files-repo",
            files={"a.py": "x = 1\n", "sub/b.py": "y = 2\n"},
            commit_message="init two files",
        )
        # Both files are tracked.
        assert (repo / "a.py").read_text() == "x = 1\n"
        assert (repo / "sub" / "b.py").read_text() == "y = 2\n"
        # Exactly one commit, with the provided message.
        log = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=repo, capture_output=True, text=True, check=True, timeout=30,
        ).stdout.strip().splitlines()
        assert len(log) == 1
        assert "init two files" in log[0]

    def test_commits_kwarg_seeds_multi_commit_history(self, tmp_path: Path) -> None:
        repo = make_git_repo(
            tmp_path, "multi-repo",
            commits=[
                ({"a.py": "first"}, "first commit"),
                ({"b.py": "second"}, "second commit"),
                ({"a.py": "first-updated"}, "amend a"),
            ],
        )
        log = subprocess.run(
            ["git", "log", "--oneline"],
            cwd=repo, capture_output=True, text=True, check=True, timeout=30,
        ).stdout.strip().splitlines()
        assert len(log) == 3, f"expected 3 commits, got: {log}"
        # Newest commit is at the top.
        assert "amend a" in log[0]
        assert "second commit" in log[1]
        assert "first commit" in log[2]
        # a.py reflects the latest update; b.py is from the middle commit.
        assert (repo / "a.py").read_text() == "first-updated"
        assert (repo / "b.py").read_text() == "second"

    def test_init_branch_kwarg_pins_branch_name(self, tmp_path: Path) -> None:
        repo = make_git_repo(
            tmp_path, "branch-repo",
            init_branch="main",
            files={"hello.py": "1"},
        )
        branch = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=repo, capture_output=True, text=True, check=True, timeout=30,
        ).stdout.strip()
        assert branch == "main"


class TestMakeFakeGitRepo:
    """make_fake_git_repo: subprocess-free .git marker for project-detection tests."""

    def test_creates_git_directory(self, tmp_path: Path) -> None:
        repo = make_fake_git_repo(tmp_path)
        assert (repo / ".git").is_dir()

    def test_creates_head_file(self, tmp_path: Path) -> None:
        repo = make_fake_git_repo(tmp_path)
        head = (repo / ".git" / "HEAD").read_text(encoding="utf-8")
        assert head == "ref: refs/heads/main\n"

    def test_default_name_is_repo(self, tmp_path: Path) -> None:
        repo = make_fake_git_repo(tmp_path)
        assert repo.name == "repo"
        assert repo.parent == tmp_path

    def test_custom_name(self, tmp_path: Path) -> None:
        repo = make_fake_git_repo(tmp_path, "my-project")
        assert repo.name == "my-project"
        assert repo.is_dir()

    def test_multiple_repos_in_same_parent(self, tmp_path: Path) -> None:
        repo_a = make_fake_git_repo(tmp_path, "a")
        repo_b = make_fake_git_repo(tmp_path, "b")
        assert repo_a != repo_b
        assert (repo_a / ".git").is_dir()
        assert (repo_b / ".git").is_dir()

    def test_find_project_detects_it(self, tmp_path: Path) -> None:
        """project.find_project() must recognise a fake repo as a project root."""
        from token_goat.project import find_project

        repo = make_fake_git_repo(tmp_path)
        proj = find_project(repo)
        assert proj is not None
        assert proj.root == repo
