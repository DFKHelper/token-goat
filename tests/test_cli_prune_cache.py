"""Tests for `token-goat prune-cache` command."""
from __future__ import annotations

import json
import time
from pathlib import Path

import pytest
from typer.testing import CliRunner

from token_goat import cli

runner = CliRunner()


def _create_cache_file(cache_dir: Path, name: str, size_bytes: int = 100, age_days: float = 10.0) -> Path:
    """Create a cache file with specified size and age."""
    cache_dir.mkdir(parents=True, exist_ok=True)
    f = cache_dir / name
    f.write_bytes(b"x" * size_bytes)
    old_mtime = time.time() - age_days * 86400
    import os
    os.utime(f, (old_mtime, old_mtime))
    return f


def test_prune_cache_dry_run_no_deletion(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test --dry-run flag doesn't delete anything."""
    bash_cache = tmp_path / "bash_outputs"
    bash_cache.mkdir()
    f = _create_cache_file(bash_cache, "test.txt", size_bytes=100, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache", "--dry-run"])
    assert result.exit_code == 0
    assert "would free" in result.stdout
    assert "Use without --dry-run to actually delete" in result.stdout
    assert f.exists(), "File should still exist after dry-run"


def test_prune_cache_removes_files(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache actually removes files when not dry-run."""
    bash_cache = tmp_path / "bash_outputs"
    web_cache = tmp_path / "web_outputs"
    bash_cache.mkdir()
    web_cache.mkdir()

    _create_cache_file(bash_cache, "test.txt", size_bytes=100, age_days=10)
    _create_cache_file(web_cache, "test.txt", size_bytes=200, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    assert "freed" in result.stdout
    assert "Total:" in result.stdout


def test_prune_cache_empty_caches_shows_zero(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache shows 0 MB freed when caches are empty."""
    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    # Empty caches should show skipped
    assert "skipped" in result.stdout or "no cleanup needed" in result.stdout


def test_prune_cache_json_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache --json output is valid JSON."""
    bash_cache = tmp_path / "bash_outputs"
    bash_cache.mkdir()
    _create_cache_file(bash_cache, "test.txt", size_bytes=100, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache", "--json"])
    assert result.exit_code == 0
    try:
        data = json.loads(result.stdout)
        assert "dry_run" in data
        assert "total_files_removed" in data
        assert "total_bytes_freed" in data
        assert "details" in data
        assert isinstance(data["details"], dict)
    except json.JSONDecodeError:
        pytest.fail(f"Output is not valid JSON: {result.stdout}")


def test_prune_cache_dry_run_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache --dry-run --json sets dry_run flag."""
    bash_cache = tmp_path / "bash_outputs"
    bash_cache.mkdir()
    _create_cache_file(bash_cache, "test.txt", size_bytes=100, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache", "--dry-run", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.stdout)
    assert data["dry_run"] is True


def test_prune_cache_removes_old_sessions(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache removes session files older than 7 days."""
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()

    old_session = _create_cache_file(sessions_dir, "old.json", size_bytes=50, age_days=10)
    recent_session = sessions_dir / "recent.json"
    recent_session.write_bytes(b"{}")
    recent_mtime = time.time() - 1 * 86400
    import os
    os.utime(recent_session, (recent_mtime, recent_mtime))

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: sessions_dir / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    assert not old_session.exists(), "Old session should be deleted"
    assert recent_session.exists(), "Recent session should remain"


def test_prune_cache_multiple_caches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache handles multiple cache directories at once."""
    bash_cache = tmp_path / "bash_outputs"
    web_cache = tmp_path / "web_outputs"
    skills_cache = tmp_path / "skills"

    bash_cache.mkdir()
    web_cache.mkdir()
    skills_cache.mkdir()

    _create_cache_file(bash_cache, "bash.txt", size_bytes=100, age_days=10)
    _create_cache_file(web_cache, "web.txt", size_bytes=200, age_days=10)
    _create_cache_file(skills_cache, "skill.txt", size_bytes=50, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    assert "bash_outputs" in result.stdout
    assert "web_outputs" in result.stdout
    assert "skills" in result.stdout
    assert "Total:" in result.stdout


def test_prune_cache_summary_format(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache summary output format."""
    bash_cache = tmp_path / "bash_outputs"
    bash_cache.mkdir()
    _create_cache_file(bash_cache, "test.txt", size_bytes=1024, age_days=10)

    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    assert "Total:" in result.stdout
    # Should have bytes count and file count
    assert any(c.isdigit() for c in result.stdout), "Output should contain numbers"


def test_prune_cache_nonexistent_dir_skipped(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Test prune-cache skips nonexistent cache directories gracefully."""
    monkeypatch.setattr("token_goat.paths.data_dir", lambda: tmp_path)
    monkeypatch.setattr("token_goat.paths.image_cache_dir", lambda: tmp_path / "nonexistent_images")
    monkeypatch.setattr("token_goat.paths.session_cache_path", lambda sid: tmp_path / "nonexistent_sessions" / f"{sid}.json")

    result = runner.invoke(cli.app, ["prune-cache"])
    assert result.exit_code == 0
    # Should handle gracefully, not crash
    assert "skipped" in result.stdout or "Total:" in result.stdout
