"""Tests for `token-goat project list/exclude/prune` CLI commands."""
from __future__ import annotations

import time
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from token_goat.cli import app
from token_goat.worker import _is_blocked_root

runner = CliRunner()


def _seed_project(conn: object, hash_: str, root: str, *, file_count: int = 0) -> None:
    import sqlite3
    assert isinstance(conn, sqlite3.Connection)
    conn.execute(
        "INSERT OR REPLACE INTO projects (hash, root, marker, first_seen, last_seen, file_count, languages) "
        "VALUES (?, ?, 'manual', ?, ?, ?, '')",
        (hash_, root, int(time.time()), int(time.time()), file_count),
    )


# ---------------------------------------------------------------------------
# project list
# ---------------------------------------------------------------------------

def test_project_list_empty(tmp_data_dir: Path) -> None:
    result = runner.invoke(app, ["project", "list"])
    assert result.exit_code == 0
    assert "No projects tracked" in result.stdout


def test_project_list_shows_roots(tmp_data_dir: Path) -> None:
    from token_goat.db import open_global
    with open_global() as conn:
        _seed_project(conn, "a" * 40, "/home/user/proj-alpha", file_count=12)
        _seed_project(conn, "b" * 40, "/home/user/proj-beta", file_count=3)
    result = runner.invoke(app, ["project", "list"])
    assert result.exit_code == 0
    assert "proj-alpha" in result.stdout
    assert "proj-beta" in result.stdout
    assert "12 files" in result.stdout


def test_project_list_marks_excluded(tmp_data_dir: Path, tmp_path: Path) -> None:
    from token_goat.db import open_global
    root = tmp_path.as_posix()
    with open_global() as conn:
        _seed_project(conn, "c" * 40, root, file_count=0)
    fake_cfg = __import__("token_goat.config", fromlist=["Config"]).Config()
    fake_cfg.worker.blocked_roots = [root]
    with patch("token_goat.config.load", return_value=fake_cfg):
        result = runner.invoke(app, ["project", "list"])
    assert result.exit_code == 0
    assert "[excluded]" in result.stdout


# ---------------------------------------------------------------------------
# project exclude
# ---------------------------------------------------------------------------

def test_project_exclude_adds_to_config(tmp_data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tomllib

    from token_goat import paths  # noqa: I001
    cfg_path = paths.config_path()
    monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
    target = (tmp_path / "myproject").as_posix()
    result = runner.invoke(app, ["project", "exclude", target])
    assert result.exit_code == 0
    assert "Excluded" in result.stdout
    data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    assert target in data["worker"]["blocked_roots"]


def test_project_exclude_deduplicates(tmp_data_dir: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tomllib

    from token_goat import paths  # noqa: I001
    cfg_path = paths.config_path()
    monkeypatch.setattr(paths, "config_path", lambda: cfg_path)
    target = (tmp_path / "myproject").as_posix()
    runner.invoke(app, ["project", "exclude", target])
    result = runner.invoke(app, ["project", "exclude", target])
    assert result.exit_code == 0
    assert "Already excluded" in result.stdout
    data = tomllib.loads(cfg_path.read_text(encoding="utf-8"))
    assert data["worker"]["blocked_roots"].count(target) == 1


# ---------------------------------------------------------------------------
# project prune
# ---------------------------------------------------------------------------

def test_project_prune_removes_missing(tmp_data_dir: Path, tmp_path: Path) -> None:
    from token_goat.db import open_global
    existing = tmp_path / "real"
    existing.mkdir()
    with open_global() as conn:
        _seed_project(conn, "d" * 40, existing.as_posix())
        _seed_project(conn, "e" * 40, "/nonexistent/path/that/cannot/exist/12345")
    result = runner.invoke(app, ["project", "prune"])
    assert result.exit_code == 0
    assert "nonexistent" in result.stdout
    assert "real" not in result.stdout
    from token_goat.db import list_all_projects
    remaining = [p["root"] for p in list_all_projects()]
    assert existing.as_posix() in remaining
    assert "/nonexistent/path/that/cannot/exist/12345" not in remaining


def test_project_prune_dry_run_is_readonly(tmp_data_dir: Path, tmp_path: Path) -> None:
    from token_goat.db import list_all_projects, open_global
    with open_global() as conn:
        _seed_project(conn, "f" * 40, "/ghost/path/99999")
    result = runner.invoke(app, ["project", "prune", "--dry-run"])
    assert result.exit_code == 0
    assert "would remove" in result.stdout
    remaining = [p["root"] for p in list_all_projects()]
    assert "/ghost/path/99999" in remaining


def test_project_prune_nothing_to_prune(tmp_data_dir: Path, tmp_path: Path) -> None:
    from token_goat.db import open_global
    existing = tmp_path / "live"
    existing.mkdir()
    with open_global() as conn:
        _seed_project(conn, "aa" * 20, existing.as_posix())
    result = runner.invoke(app, ["project", "prune"])
    assert result.exit_code == 0
    assert "Nothing to prune" in result.stdout


# ---------------------------------------------------------------------------
# _is_blocked_root respects config
# ---------------------------------------------------------------------------

def test_is_blocked_root_respects_config() -> None:
    from token_goat import config as config_mod
    fake_cfg = config_mod.Config()
    fake_cfg.worker.blocked_roots = ["/home/user/problematic-project"]
    with patch.object(config_mod, "load", return_value=fake_cfg):
        assert _is_blocked_root("/home/user/problematic-project")
        assert _is_blocked_root("/HOME/USER/PROBLEMATIC-PROJECT")  # case-insensitive
        assert not _is_blocked_root("/home/user/other-project")


def test_is_blocked_root_hardcoded_still_works() -> None:
    assert _is_blocked_root("c:/windows/system32")
    assert _is_blocked_root("/some/path/node_modules/foo")
