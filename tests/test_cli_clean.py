"""Tests for `token-goat clean`."""
from __future__ import annotations

import os
import time
from pathlib import Path

from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()


def _fake_cache_dir(tmp_path: Path, name: str, *, file_count: int = 3, age_days: float = 10.0) -> Path:
    cache = tmp_path / name
    cache.mkdir(parents=True, exist_ok=True)
    old_mtime = time.time() - age_days * 86400
    for i in range(file_count):
        f = cache / f"file{i}.txt"
        f.write_text(f"content {i}")
        os.utime(f, (old_mtime, old_mtime))
    return cache


def test_clean_requires_at_least_one_flag():
    result = runner.invoke(cli.app, ["clean"])
    assert result.exit_code == 2


def test_clean_images_dry_run(tmp_data_dir, monkeypatch):
    cache = _fake_cache_dir(tmp_data_dir, "images", file_count=3, age_days=10)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: cache)

    result = runner.invoke(cli.app, ["clean", "--images", "--dry-run"])
    assert result.exit_code == 0
    assert "[dry run]" in result.stdout
    assert "3 file(s)" in result.stdout
    assert "images" in result.stdout
    # Files should still exist after dry run
    assert len(list(cache.iterdir())) == 3


def test_clean_images_deletes_files(tmp_data_dir, monkeypatch):
    cache = _fake_cache_dir(tmp_data_dir, "images", file_count=3, age_days=10)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: cache)

    result = runner.invoke(cli.app, ["clean", "--images"])
    assert result.exit_code == 0
    assert "[dry run]" not in result.stdout
    assert "3 file(s)" in result.stdout
    assert len(list(cache.iterdir())) == 0


def test_clean_bash_deletes_files(tmp_data_dir, monkeypatch):
    cache = _fake_cache_dir(tmp_data_dir, "bash_outputs", file_count=2, age_days=15)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--bash"])
    assert result.exit_code == 0
    assert "2 file(s)" in result.stdout
    assert "bash" in result.stdout
    assert len(list(cache.iterdir())) == 0


def test_clean_web_deletes_files(tmp_data_dir, monkeypatch):
    cache = _fake_cache_dir(tmp_data_dir, "web_outputs", file_count=4, age_days=20)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--web"])
    assert result.exit_code == 0
    assert "4 file(s)" in result.stdout
    assert "web" in result.stdout
    assert len(list(cache.iterdir())) == 0


def test_clean_sessions_deletes_old_files(tmp_data_dir, monkeypatch):
    sessions = _fake_cache_dir(tmp_data_dir, "sessions", file_count=2, age_days=10)
    # Rename files to have .json extension
    for f in list(sessions.iterdir()):
        new_path = f.with_suffix(".json")
        f.rename(new_path)
        old_mtime = time.time() - 10 * 86400
        os.utime(new_path, (old_mtime, old_mtime))

    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--sessions"])
    assert result.exit_code == 0
    assert "2 file(s)" in result.stdout
    assert "sessions" in result.stdout
    assert len(list(sessions.iterdir())) == 0


def test_clean_sessions_skips_recent_files(tmp_data_dir, monkeypatch):
    sessions = tmp_data_dir / "sessions"
    sessions.mkdir()
    # Create a recent file (1 day old)
    recent = sessions / "recent.json"
    recent.write_text("{}")
    recent_mtime = time.time() - 1 * 86400
    os.utime(recent, (recent_mtime, recent_mtime))

    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--sessions", "--older-than", "7"])
    assert result.exit_code == 0
    assert "nothing to remove" in result.stdout
    assert recent.exists()


def test_clean_all_flag(tmp_data_dir, monkeypatch):
    _fake_cache_dir(tmp_data_dir, "images", file_count=1, age_days=10)
    _fake_cache_dir(tmp_data_dir, "bash_outputs", file_count=1, age_days=10)
    _fake_cache_dir(tmp_data_dir, "web_outputs", file_count=1, age_days=10)
    sessions = tmp_data_dir / "sessions"
    sessions.mkdir()
    f = sessions / "s.json"
    f.write_text("{}")
    os.utime(f, (time.time() - 10 * 86400,) * 2)

    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--all"])
    assert result.exit_code == 0
    assert "images" in result.stdout
    assert "bash" in result.stdout
    assert "web" in result.stdout
    assert "sessions" in result.stdout


def test_clean_missing_dir_reports_skipped(tmp_data_dir, monkeypatch):
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "nonexistent")

    result = runner.invoke(cli.app, ["clean", "--images"])
    assert result.exit_code == 0
    assert "skipped" in result.stdout


def test_clean_older_than_respected(tmp_data_dir, monkeypatch):
    cache = tmp_data_dir / "bash_outputs"
    cache.mkdir()
    old = cache / "old.txt"
    old.write_text("old content")
    new = cache / "new.txt"
    new.write_text("new content")
    os.utime(old, (time.time() - 30 * 86400,) * 2)
    os.utime(new, (time.time() - 2 * 86400,) * 2)

    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_data_dir / "images")

    result = runner.invoke(cli.app, ["clean", "--bash", "--older-than", "7"])
    assert result.exit_code == 0
    assert "1 file(s)" in result.stdout
    assert not old.exists()
    assert new.exists()
