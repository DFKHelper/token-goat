"""Tests for config.py — process-level mtime cache (item 1)."""
from __future__ import annotations


class TestConfigMtimeCache:
    """Item 1: config.load() uses a process-level mtime cache.

    Repeated calls within the same process pay only one os.stat instead of
    stat + read_text + tomllib.loads on every invocation.
    """

    def _reset_cache(self) -> None:
        """Clear the module-level cache between test cases."""
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

    def test_repeated_calls_return_same_object(self, tmp_path, monkeypatch):
        """Second call returns the cached Config object (identity check)."""
        self._reset_cache()
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        c1 = cfg_mod.load()
        c2 = cfg_mod.load()
        assert c1 is c2, "Second load() should return the cached Config object"

    def test_cache_miss_on_mtime_change(self, tmp_path, monkeypatch):
        """Writing the config file invalidates the cache (mtime changes)."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        c1 = cfg_mod.load()

        # Write a config file that changes a value
        config_file.write_text(
            '[compact_assist]\nmin_events = 7\n', encoding="utf-8"
        )
        # Ensure mtime differs (some filesystems have 1s resolution)
        import os
        new_mtime = config_file.stat().st_mtime + 1
        os.utime(config_file, (new_mtime, new_mtime))

        c2 = cfg_mod.load()
        assert c1 is not c2, "Config changed on disk — cache must be invalidated"
        assert c2.compact_assist.min_events == 7

    def test_absent_file_cached_too(self, tmp_path, monkeypatch):
        """Absent config file also produces a cached result (mtime == 0.0)."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "no_config.toml")
        self._reset_cache()

        c1 = cfg_mod.load()
        c2 = cfg_mod.load()
        assert c1 is c2

    def test_five_calls_use_single_parse(self, tmp_path, monkeypatch):
        """Five consecutive calls should all return the same cached object."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        self._reset_cache()

        results = [cfg_mod.load() for _ in range(5)]
        assert all(r is results[0] for r in results[1:])

    def test_save_invalidates_cache(self, tmp_path, monkeypatch):
        """config.save() must clear the cache so the next load() re-reads."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        c1 = cfg_mod.load()
        cfg_mod.save(c1)
        assert cfg_mod._config_mtime_cache is None, "save() must clear _config_mtime_cache"

    def test_cache_tuple_has_four_fields(self, tmp_path, monkeypatch):
        """Cache entry is (Config, mtime_float, env_fingerprint_str, monotonic_float)."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        self._reset_cache()

        cfg_mod.load()
        assert cfg_mod._config_mtime_cache is not None
        assert len(cfg_mod._config_mtime_cache) == 4
        cfg_obj, mtime_val, env_fp, mono_val = cfg_mod._config_mtime_cache
        assert isinstance(mtime_val, float)
        assert isinstance(env_fp, str)
        assert isinstance(mono_val, float)
        assert mono_val > 0


class TestConfigUnknownSectionWarning:
    """Unknown top-level TOML sections produce a warning (typo detection)."""

    def _reset_cache(self) -> None:
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

    def test_typo_section_emits_warning(self, tmp_path, monkeypatch, caplog):
        """A misspelt section name triggers a WARNING log entry."""
        import logging

        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        # Intentional typo: 'compact_assit' instead of 'compact_assist'
        config_file.write_text("[compact_assit]\nmin_events = 5\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg_mod.load()

        warning_messages = [r.message for r in caplog.records if r.levelno == logging.WARNING]
        assert any("compact_assit" in msg for msg in warning_messages), (
            f"Expected a warning mentioning 'compact_assit'; got: {warning_messages}"
        )

    def test_valid_sections_no_warning(self, tmp_path, monkeypatch, caplog):
        """All-valid config produces no unknown-section warnings."""
        import logging

        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[compact_assist]\nmin_events = 3\n[bash_compress]\nenabled = true\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg_mod.load()

        unknown_warnings = [
            r.message for r in caplog.records
            if r.levelno == logging.WARNING and "unknown config section" in r.message
        ]
        assert not unknown_warnings, f"Unexpected unknown-section warnings: {unknown_warnings}"

    def test_typo_does_not_crash_or_affect_other_sections(self, tmp_path, monkeypatch, caplog):
        """A typo in one section name does not prevent other sections from loading."""
        import logging

        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[compact_assit]\nmin_events = 99\n[compact_assist]\nmin_events = 7\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg = cfg_mod.load()

        # The correct section was still parsed
        assert cfg.compact_assist.min_events == 7
        # And a warning was emitted for the typo
        assert any("compact_assit" in r.message for r in caplog.records if r.levelno == logging.WARNING)


class TestWebFetchConfig:
    """Tests for WebFetch cache configuration (file-count and byte-cap eviction)."""

    def _reset_cache(self):
        """Reset the process-level config cache (used between tests)."""
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

    def test_webfetch_defaults(self):
        """WebFetchConfig has sensible defaults matching bash_cache."""
        from token_goat.config import WebFetchConfig
        wf = WebFetchConfig()
        assert wf.max_file_count == 4096
        assert wf.max_bytes == 32 * 1024 * 1024
        assert wf.allow == []
        assert wf.deny == []

    def test_webfetch_config_from_toml(self, tmp_path, monkeypatch):
        """WebFetch cache caps can be configured via TOML."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[webfetch]\nmax_file_count = 2048\nmax_bytes = 16777216\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_file_count == 2048
        assert cfg.webfetch.max_bytes == 16777216

    def test_webfetch_env_override_files(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WEB_CACHE_MAX_FILES env override takes precedence."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[webfetch]\nmax_file_count = 2048\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WEB_CACHE_MAX_FILES", "512")
        self._reset_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_file_count == 512

    def test_webfetch_env_override_bytes(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WEB_CACHE_MAX_BYTES env override takes precedence."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[webfetch]\nmax_bytes = 16777216\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WEB_CACHE_MAX_BYTES", "8388608")
        self._reset_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_bytes == 8388608
