"""Tests for the [bash_compress] config section."""
from __future__ import annotations

import textwrap

import pytest

from token_goat import config


class TestBashCompressDefaults:
    def test_dataclass_defaults(self):
        bc = config.BashCompressConfig()
        assert bc.enabled is True
        assert bc.disabled_filters == []
        assert bc.max_lines == 1000
        assert bc.max_bytes == 64 * 1024
        assert bc.timeout_seconds == 600

    def test_load_no_toml(self, tmp_path, monkeypatch):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "missing.toml")
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        cfg = config.load()
        assert cfg.bash_compress.enabled is True
        assert cfg.bash_compress.disabled_filters == []


class TestBashCompressTomlOverrides:
    def _write(self, tmp_path, body: str, monkeypatch):
        from token_goat import paths
        p = tmp_path / "config.toml"
        p.write_text(textwrap.dedent(body), encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: p)
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        return p

    def test_disable_via_toml(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            enabled = false
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.enabled is False

    def test_disabled_filters_list(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            disabled_filters = ["pytest", "docker"]
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.disabled_filters == ["pytest", "docker"]

    def test_non_string_filter_entries_dropped(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            disabled_filters = ["git", 42, "npm"]
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.disabled_filters == ["git", "npm"]

    def test_max_lines_override(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            max_lines = 250
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.max_lines == 250

    def test_max_lines_clamped_to_valid_range(self, tmp_path, monkeypatch):
        # Below lo bound (50) → falls back to default.
        self._write(tmp_path, """
            [bash_compress]
            max_lines = 10
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.max_lines == 1000

    def test_max_bytes_override(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            max_bytes = 32768
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.max_bytes == 32768

    def test_timeout_override(self, tmp_path, monkeypatch):
        self._write(tmp_path, """
            [bash_compress]
            timeout_seconds = 30
            """, monkeypatch)
        cfg = config.load()
        assert cfg.bash_compress.timeout_seconds == 30


class TestBashCompressEnvOverride:
    @pytest.mark.parametrize("val", ["0", "false", "no", "off"])
    def test_env_var_disables(self, tmp_path, monkeypatch, val):
        from token_goat import paths
        monkeypatch.setattr(paths, "config_path", lambda: tmp_path / "missing.toml")
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", val)
        cfg = config.load()
        assert cfg.bash_compress.enabled is False

    def test_env_truthy_does_not_force_enable(self, tmp_path, monkeypatch):
        # Even with env set to "1", a TOML enabled=false must win.
        self._write_toml(tmp_path, monkeypatch, "[bash_compress]\nenabled = false\n")
        monkeypatch.setenv("TOKEN_GOAT_BASH_COMPRESS", "1")
        cfg = config.load()
        # Env only flips False; truthy values do not override TOML.
        assert cfg.bash_compress.enabled is False

    def _write_toml(self, tmp_path, monkeypatch, body):
        from token_goat import paths
        p = tmp_path / "config.toml"
        p.write_text(body, encoding="utf-8")
        monkeypatch.setattr(paths, "config_path", lambda: p)


class TestRoundTrip:
    def test_save_then_load_preserves_bash_compress(self, tmp_path, monkeypatch):
        from token_goat import paths
        p = tmp_path / "config.toml"
        monkeypatch.setattr(paths, "config_path", lambda: p)
        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)

        cfg = config.Config()
        cfg.bash_compress.disabled_filters = ["docker", "kubectl"]
        cfg.bash_compress.max_lines = 500
        cfg.bash_compress.timeout_seconds = 120
        config.save(cfg)

        reloaded = config.load()
        assert reloaded.bash_compress.disabled_filters == ["docker", "kubectl"]
        assert reloaded.bash_compress.max_lines == 500
        assert reloaded.bash_compress.timeout_seconds == 120
