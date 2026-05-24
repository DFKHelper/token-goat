"""Tests for Phase 11 items: config validate, doctor --crashes, bash-history --since,
doctor savings projection, clean-cache --images."""
from __future__ import annotations

import json
import time

from typer.testing import CliRunner

from token_goat.cli import app

runner = CliRunner()


# ---------------------------------------------------------------------------
# Item 8: config validate
# ---------------------------------------------------------------------------


def test_config_validate_no_file(monkeypatch, tmp_path):
    """When config file is absent, validate reports 'defaults in use' and exits 0."""
    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: tmp_path / "no-config.toml")
    result = runner.invoke(app, ["config", "validate"])
    assert result.exit_code == 0
    assert "defaults" in result.output.lower() or "not found" in result.output.lower()


def test_config_validate_clean_config(monkeypatch, tmp_path):
    """A config with only known keys exits 0 and says 'OK'."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[compact_assist]\nenabled = true\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate"])
    assert result.exit_code == 0
    assert "ok" in result.output.lower()


def test_config_validate_unknown_top_key(monkeypatch, tmp_path):
    """An unknown top-level key causes exit 1 and reports the unknown key."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[compac_assist]\nenabled = true\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate"])
    assert result.exit_code == 1
    assert "compac_assist" in result.output


def test_config_validate_did_you_mean_suggestion(monkeypatch, tmp_path):
    """A close-enough misspelling gets a 'did you mean' suggestion."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[compac_assist]\nenabled = true\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate"])
    # Should suggest compact_assist
    assert "compact_assist" in result.output


def test_config_validate_unknown_section_key(monkeypatch, tmp_path):
    """An unknown key inside a known section is reported."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[compact_assist]\nenaabled = true\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate"])
    assert result.exit_code == 1
    assert "enaabled" in result.output


def test_config_validate_json_output_clean(monkeypatch, tmp_path):
    """JSON output for a clean config returns ok:true."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[compact_assist]\nenabled = false\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert data["ok"] is True
    assert data["issues"] == []


def test_config_validate_json_output_unknown_key(monkeypatch, tmp_path):
    """JSON output for an unknown key returns ok:false with issues list."""
    cfg = tmp_path / "config.toml"
    cfg.write_text("[unknwon_section]\nfoo = 1\n", encoding="utf-8")

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "config_path", lambda: cfg)
    result = runner.invoke(app, ["config", "validate", "--json"])
    assert result.exit_code == 1
    data = json.loads(result.output)
    assert data["ok"] is False
    assert len(data["issues"]) >= 1


# ---------------------------------------------------------------------------
# Item 10: bash-history --since
# ---------------------------------------------------------------------------


def test_parse_since_duration_minutes():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("30m") == 1800.0


def test_parse_since_duration_hours():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("2h") == 7200.0


def test_parse_since_duration_days():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("1d") == 86400.0


def test_parse_since_duration_seconds():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("60s") == 60.0


def test_parse_since_duration_bare_int():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("120") == 120.0


def test_parse_since_duration_invalid():
    from token_goat.cli import _parse_since_duration
    assert _parse_since_duration("abc") is None
    assert _parse_since_duration("") is None


def test_bash_history_since_filters_old_entries(monkeypatch):
    """--since should exclude entries older than the duration."""
    now = time.time()
    # Two entries: one 10 minutes old, one 2 hours old
    recent_mtime = now - 600    # 10 min ago
    old_mtime = now - 7200      # 2 hours ago

    mock_entries = [
        {"output_id": "aaa", "size_bytes": 100, "mtime": recent_mtime},
        {"output_id": "bbb", "size_bytes": 200, "mtime": old_mtime},
    ]

    import token_goat.bash_cache as bc
    monkeypatch.setattr(bc, "list_outputs", lambda: mock_entries)
    monkeypatch.setattr(bc, "read_sidecar", lambda oid: None)

    result = runner.invoke(app, ["bash-history", "--since", "30m"])
    assert result.exit_code == 0
    assert "aaa" in result.output
    assert "bbb" not in result.output


def test_bash_history_since_invalid_value(monkeypatch):
    """--since with an invalid value exits with error code 2."""
    result = runner.invoke(app, ["bash-history", "--since", "notatime"])
    assert result.exit_code == 2


# ---------------------------------------------------------------------------
# Item 12: clean-cache --images
# ---------------------------------------------------------------------------


def test_clean_cache_no_flags_exits_error():
    """clean-cache with no flags should exit with error code 2."""
    result = runner.invoke(app, ["clean-cache"])
    assert result.exit_code == 2


def test_clean_cache_images_nonexistent_dir(monkeypatch, tmp_path):
    """clean-cache --images when cache dir does not exist reports 'skipped'."""
    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "image_cache_dir", lambda: tmp_path / "no-such-dir")
    result = runner.invoke(app, ["clean-cache", "--images"])
    assert result.exit_code == 0
    assert "skipped" in result.output.lower()


def test_clean_cache_images_calls_eviction(monkeypatch, tmp_path):
    """clean-cache --images delegates to evict_image_cache_if_over_limit."""
    # Create a real cache dir with some dummy files
    cache_dir = tmp_path / "images"
    cache_dir.mkdir()
    (cache_dir / "img1.webp").write_bytes(b"fake" * 100)

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "image_cache_dir", lambda: cache_dir)

    import token_goat.worker as _worker
    monkeypatch.setattr(_worker, "evict_image_cache_if_over_limit", lambda: (1024, 1))

    result = runner.invoke(app, ["clean-cache", "--images"])
    assert result.exit_code == 0
    # Should report eviction
    assert "evicted" in result.output.lower()


def test_clean_cache_images_json_output(monkeypatch, tmp_path):
    """clean-cache --images --json returns structured JSON."""
    cache_dir = tmp_path / "images"
    cache_dir.mkdir()
    (cache_dir / "img1.webp").write_bytes(b"x" * 500)

    from token_goat import paths as tg_paths
    monkeypatch.setattr(tg_paths, "image_cache_dir", lambda: cache_dir)

    import token_goat.worker as _worker
    monkeypatch.setattr(_worker, "evict_image_cache_if_over_limit", lambda: (500, 1))

    result = runner.invoke(app, ["clean-cache", "--images", "--json"])
    assert result.exit_code == 0
    data = json.loads(result.output)
    assert "images" in data
    assert data["images"]["status"] == "ok"
    assert data["images"]["freed_bytes"] == 500
