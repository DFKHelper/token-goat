"""Tests for config.py — process-level mtime cache (item 1)."""
from __future__ import annotations


def _reset_cfg_cache() -> None:
    """Clear the module-level config mtime cache between test cases."""
    import token_goat.config as cfg_mod

    cfg_mod._config_mtime_cache = None


class TestConfigMtimeCache:
    """Item 1: config.load() uses a process-level mtime cache.

    Repeated calls within the same process pay only one os.stat instead of
    stat + read_text + tomllib.loads on every invocation.
    """

    def test_repeated_calls_return_same_object(self, tmp_path, monkeypatch):
        """Second call returns the cached Config object (identity check)."""
        _reset_cfg_cache()
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
        _reset_cfg_cache()

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
        _reset_cfg_cache()

        c1 = cfg_mod.load()
        c2 = cfg_mod.load()
        assert c1 is c2

    def test_five_calls_use_single_parse(self, tmp_path, monkeypatch):
        """Five consecutive calls should all return the same cached object."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        _reset_cfg_cache()

        results = [cfg_mod.load() for _ in range(5)]
        assert all(r is results[0] for r in results[1:])

    def test_save_invalidates_cache(self, tmp_path, monkeypatch):
        """config.save() must clear the cache so the next load() re-reads."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        c1 = cfg_mod.load()
        cfg_mod.save(c1)
        assert cfg_mod._config_mtime_cache is None, "save() must clear _config_mtime_cache"

    def test_cache_tuple_has_four_fields(self, tmp_path, monkeypatch):
        """Cache entry is (Config, mtime_float, env_fingerprint_str, monotonic_float)."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        _reset_cfg_cache()

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

    def test_typo_section_emits_warning(self, tmp_path, monkeypatch, caplog):
        """A misspelt section name triggers a WARNING log entry."""
        import logging

        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        # Intentional typo: 'compact_assit' instead of 'compact_assist'
        config_file.write_text("[compact_assit]\nmin_events = 5\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

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
        _reset_cfg_cache()

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
        _reset_cfg_cache()

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            cfg = cfg_mod.load()

        # The correct section was still parsed
        assert cfg.compact_assist.min_events == 7
        # And a warning was emitted for the typo
        assert any("compact_assit" in r.message for r in caplog.records if r.levelno == logging.WARNING)


class TestWebFetchConfig:
    """Tests for WebFetch cache configuration (file-count and byte-cap eviction)."""

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
        _reset_cfg_cache()

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
        _reset_cfg_cache()

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
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_bytes == 8388608


class TestHintsConfigRoundTrip:
    """All HintsConfig fields must survive a load() → save() → load() round-trip.

    These tests guard against the bug where fields added to HintsConfig were
    not wired into the load() parser or save() serializer, silently discarding
    any user-configured values.
    """

    def test_verbose_until_seen_count_loads_from_toml(self, tmp_path, monkeypatch):
        """verbose_until_seen_count is read from [hints] in config.toml."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hints]\nverbose_until_seen_count = 7\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.hints.verbose_until_seen_count == 7

    def test_min_file_lines_for_hint_loads_from_toml(self, tmp_path, monkeypatch):
        """min_file_lines_for_hint is read from [hints] in config.toml."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hints]\nmin_file_lines_for_hint = 50\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.hints.min_file_lines_for_hint == 50

    def test_all_hints_fields_survive_save_load_roundtrip(self, tmp_path, monkeypatch):
        """Every HintsConfig field survives a save() → load() cycle."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        # Build a config with non-default values for all hints fields.
        cfg = cfg_mod.load()
        cfg.hints.suppress_after_ignored = 3
        cfg.hints.quiet_hours = "22:00-07:00"
        cfg.hints.json_sidecar = True
        cfg.hints.verbose_until_seen_count = 5
        cfg.hints.min_file_lines_for_hint = 30
        cfg.hints.bash_dedup_min_bytes = 500
        cfg.hints.web_dedup_min_bytes = 600
        cfg.hints.grep_dedup_min_matches = 10

        cfg_mod.save(cfg)
        _reset_cfg_cache()

        reloaded = cfg_mod.load()
        assert reloaded.hints.suppress_after_ignored == 3
        assert reloaded.hints.quiet_hours == "22:00-07:00"
        assert reloaded.hints.json_sidecar is True
        assert reloaded.hints.verbose_until_seen_count == 5
        assert reloaded.hints.min_file_lines_for_hint == 30
        assert reloaded.hints.bash_dedup_min_bytes == 500
        assert reloaded.hints.web_dedup_min_bytes == 600
        assert reloaded.hints.grep_dedup_min_matches == 10


class TestSkillPreservationRoundTrip:
    """orphan_sweep_enabled and orphan_age_secs must survive a save/load cycle."""

    def test_orphan_sweep_enabled_round_trips(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        cfg.skill_preservation.orphan_sweep_enabled = False
        cfg_mod.save(cfg)
        _reset_cfg_cache()

        assert cfg_mod.load().skill_preservation.orphan_sweep_enabled is False

    def test_orphan_age_secs_round_trips(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        cfg.skill_preservation.orphan_age_secs = 86400
        cfg_mod.save(cfg)
        _reset_cfg_cache()

        assert cfg_mod.load().skill_preservation.orphan_age_secs == 86400


class TestBashCacheConfig:
    """BashCompressConfig.cache_max_file_count and cache_max_bytes must load,
    save, and honour env-var overrides."""

    def test_defaults(self):
        from token_goat.config import BashCompressConfig
        bc = BashCompressConfig()
        assert bc.cache_max_file_count == 4096
        assert bc.cache_max_bytes == 16 * 1024 * 1024

    def test_cache_max_file_count_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[bash_compress]\ncache_max_file_count = 512\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_file_count == 512

    def test_cache_max_bytes_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[bash_compress]\ncache_max_bytes = 8388608\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_bytes == 8388608

    def test_env_override_max_files(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_BASH_CACHE_MAX_FILES overrides the TOML value."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[bash_compress]\ncache_max_file_count = 2048\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_BASH_CACHE_MAX_FILES", "256")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_file_count == 256

    def test_env_override_max_bytes(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_BASH_CACHE_MAX_BYTES overrides the TOML value."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[bash_compress]\ncache_max_bytes = 8388608\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_BASH_CACHE_MAX_BYTES", "4194304")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_bytes == 4194304

    def test_round_trip(self, tmp_path, monkeypatch):
        """cache_max_file_count and cache_max_bytes survive a save → load cycle."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        cfg.bash_compress.cache_max_file_count = 1024
        cfg.bash_compress.cache_max_bytes = 4 * 1024 * 1024
        cfg_mod.save(cfg)
        _reset_cfg_cache()

        reloaded = cfg_mod.load()
        assert reloaded.bash_compress.cache_max_file_count == 1024
        assert reloaded.bash_compress.cache_max_bytes == 4 * 1024 * 1024

    def test_env_override_max_files_out_of_range_ignored(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_BASH_CACHE_MAX_FILES=0 is out of range; default is preserved."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_BASH_CACHE_MAX_FILES", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_file_count == 4096  # default preserved

    def test_env_override_max_bytes_out_of_range_ignored(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_BASH_CACHE_MAX_BYTES=0 is out of range; default is preserved."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_BASH_CACHE_MAX_BYTES", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_max_bytes == 16 * 1024 * 1024  # default preserved


class TestWebFetchCacheConfig:
    """WebFetchConfig max_file_count and max_bytes: TOML validation and env-var range guards."""

    def test_webfetch_max_file_count_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[webfetch]\nmax_file_count = 128\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_file_count == 128

    def test_webfetch_max_bytes_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[webfetch]\nmax_bytes = 1048576\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_bytes == 1048576

    def test_webfetch_max_file_count_invalid_toml_falls_back_to_default(self, tmp_path, monkeypatch):
        """Non-integer TOML value falls back to the default (via _validated_int)."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text('[webfetch]\nmax_file_count = "lots"\n', encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_file_count == 4096  # default

    def test_webfetch_env_override_max_files_out_of_range_ignored(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WEB_CACHE_MAX_FILES=0 is out of range; default is preserved."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WEB_CACHE_MAX_FILES", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_file_count == 4096  # default preserved

    def test_webfetch_env_override_max_bytes_out_of_range_ignored(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WEB_CACHE_MAX_BYTES=0 is out of range; default is preserved."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_WEB_CACHE_MAX_BYTES", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.webfetch.max_bytes == 32 * 1024 * 1024  # default preserved


class TestEnvIntHelper:
    """Tests for the _env_int helper function (DRY consolidation)."""

    def test_env_int_unset_returns_default(self, monkeypatch):
        """When env var is unset, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.delenv("TOKEN_GOAT_TEST_VAR", raising=False)
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_empty_string_returns_default(self, monkeypatch):
        """When env var is empty string, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_whitespace_only_returns_default(self, monkeypatch):
        """When env var is whitespace-only, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "   \t  ")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_valid_value_in_range(self, monkeypatch):
        """When env var is a valid int in range, _env_int returns it."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "75")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 75

    def test_env_int_valid_value_at_lower_bound(self, monkeypatch):
        """When env var equals lo, _env_int returns it."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "0")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 0

    def test_env_int_valid_value_at_upper_bound(self, monkeypatch):
        """When env var equals hi, _env_int returns it."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "100")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 100

    def test_env_int_value_below_range_returns_default(self, monkeypatch):
        """When env var is below lo, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "-1")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_value_above_range_returns_default(self, monkeypatch):
        """When env var is above hi, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "101")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_non_numeric_value_returns_default(self, monkeypatch):
        """When env var is not numeric, _env_int returns the default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "not-a-number")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_float_string_rejected(self, monkeypatch):
        """When env var is a float string like '75.0' or '75.7', _env_int rejects it."""
        import token_goat.config as cfg_mod

        # int() rejects float strings, so _env_int falls back to default
        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "75.0")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_float_with_decimal_rejected(self, monkeypatch):
        """When env var is '75.7', _env_int rejects it and returns default."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "75.7")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42

    def test_env_int_with_whitespace_padding(self, monkeypatch):
        """When env var has leading/trailing whitespace, _env_int strips it."""
        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "  75  ")
        result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 75

    def test_env_int_logs_on_invalid(self, monkeypatch, caplog):
        """When env var is invalid, _env_int logs a warning."""
        import logging

        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "not-a-number")
        with caplog.at_level(logging.WARNING):
            result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42
        assert any("not an int" in record.message for record in caplog.records)


class TestSkillPreservationForwardCompat:
    """Forward-compatibility: unknown keys inside [skill_preservation] must be silently
    tolerated — no crash, known keys still take effect.

    This guards against future config additions breaking installs that have not yet
    been updated to understand the new keys.
    """

    def test_unknown_key_does_not_crash(self, tmp_path, monkeypatch):
        """A config file with an unknown key inside [skill_preservation] must load without error."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[skill_preservation]\n"
            "enabled = true\n"
            "future_key_not_yet_known = 999\n"
            "another_future_option = \"hello\"\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        # Must not raise.
        cfg = cfg_mod.load()
        # Known keys still load correctly.
        assert cfg.skill_preservation.enabled is True

    def test_known_keys_survive_alongside_unknown(self, tmp_path, monkeypatch):
        """Known keys in [skill_preservation] are correctly applied even when unknown
        keys are present in the same section."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text(
            "[skill_preservation]\n"
            "truncation_budget_tokens = 1200\n"
            "compress_bodies = false\n"
            "compress_min_bytes = 8192\n"
            "unknown_future_flag = true\n",
            encoding="utf-8",
        )
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.skill_preservation.truncation_budget_tokens == 1200
        assert cfg.skill_preservation.compress_bodies is False
        assert cfg.skill_preservation.compress_min_bytes == 8192

    def test_all_known_keys_round_trip(self, tmp_path, monkeypatch):
        """All six documented [skill_preservation] keys survive a TOML write + read cycle."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        cfg.skill_preservation.enabled = True
        cfg.skill_preservation.orphan_sweep_enabled = False
        cfg.skill_preservation.orphan_age_secs = 172800  # 2 days
        cfg.skill_preservation.truncation_budget_tokens = 600
        cfg.skill_preservation.compress_bodies = False
        cfg.skill_preservation.compress_min_bytes = 4096
        cfg_mod.save(cfg)
        _reset_cfg_cache()

        cfg2 = cfg_mod.load()
        assert cfg2.skill_preservation.enabled is True
        assert cfg2.skill_preservation.orphan_sweep_enabled is False
        assert cfg2.skill_preservation.orphan_age_secs == 172800
        assert cfg2.skill_preservation.truncation_budget_tokens == 600
        assert cfg2.skill_preservation.compress_bodies is False
        assert cfg2.skill_preservation.compress_min_bytes == 4096

    def test_env_int_logs_on_out_of_range(self, monkeypatch, caplog):
        """When env var is out of range, _env_int logs a warning."""
        import logging

        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "999")
        with caplog.at_level(logging.WARNING):
            result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 42
        assert any("out of range" in record.message for record in caplog.records)

    def test_env_int_logs_on_success(self, monkeypatch, caplog):
        """When env var is valid, _env_int logs an info message."""
        import logging

        import token_goat.config as cfg_mod

        monkeypatch.setenv("TOKEN_GOAT_TEST_VAR", "75")
        with caplog.at_level(logging.INFO):
            result = cfg_mod._env_int("TOKEN_GOAT_TEST_VAR", default=42, lo=0, hi=100, config_path="test.var")
        assert result == 75
        assert any("overridden by environment" in record.message for record in caplog.records)


# ---------------------------------------------------------------------------
# Sub-area E: config validation improvements
# ---------------------------------------------------------------------------

class TestValidatedIntListSortedAscending:
    """_validated_int_list must enforce sorted-ascending contract for backoff_thresholds."""

    def test_sorted_input_returned_unchanged(self):
        """A correctly sorted list is returned as-is."""
        from token_goat.config import _validated_int_list
        result = _validated_int_list([1, 3, 10, 30], [1, 3, 10, 30], "hints.backoff_thresholds")
        assert result == [1, 3, 10, 30]

    def test_unsorted_input_is_sorted_and_warns(self, caplog):
        """An out-of-order list is sorted and a warning is emitted."""
        import logging

        from token_goat.config import _validated_int_list

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            result = _validated_int_list([30, 1, 10, 3], [1, 3, 10, 30], "hints.backoff_thresholds")

        assert result == [1, 3, 10, 30], "unsorted list must be returned sorted"
        assert any("sorted" in record.message for record in caplog.records), (
            "a warning must be logged when input is not sorted ascending"
        )

    def test_duplicate_values_accepted_and_sorted(self):
        """Duplicate values are kept (membership check semantics) and sorted."""
        from token_goat.config import _validated_int_list
        result = _validated_int_list([10, 3, 3, 1], [1, 3, 10, 30], "hints.backoff_thresholds")
        assert result == sorted(result), "result must be in ascending order"

    def test_empty_list_accepted_without_warning(self, caplog):
        """Empty list disables the feature — no warning, no sort needed."""
        import logging

        from token_goat.config import _validated_int_list

        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            result = _validated_int_list([], [1, 3, 10, 30], "hints.backoff_thresholds")

        assert result == []
        assert not any("sorted" in record.message for record in caplog.records)

    def test_backoff_thresholds_loaded_from_toml_out_of_order(self, tmp_path, monkeypatch):
        """Config load corrects an out-of-order backoff_thresholds from TOML."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        (tmp_path / "config.toml").write_text(
            "[hints]\nbackoff_thresholds = [30, 10, 3, 1]\n", encoding="utf-8"
        )

        cfg = cfg_mod.load()
        assert cfg.hints.backoff_thresholds == [1, 3, 10, 30], (
            "out-of-order backoff_thresholds must be sorted on load"
        )
        cfg_mod._config_mtime_cache = None  # cleanup

    def test_max_manifest_chars_zero_is_valid(self, tmp_path, monkeypatch):
        """max_manifest_chars=0 is a valid value that disables the cap."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        (tmp_path / "config.toml").write_text(
            "[compact_assist]\nmax_manifest_chars = 0\n", encoding="utf-8"
        )

        cfg = cfg_mod.load()
        assert cfg.compact_assist.max_manifest_chars == 0
        cfg_mod._config_mtime_cache = None  # cleanup

    def test_cache_min_bytes_zero_is_valid(self, tmp_path, monkeypatch):
        """cache_min_bytes=0 means no minimum — all outputs are cacheable."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        (tmp_path / "config.toml").write_text(
            "[bash_compress]\ncache_min_bytes = 0\n", encoding="utf-8"
        )

        cfg = cfg_mod.load()
        assert cfg.bash_compress.cache_min_bytes == 0
        cfg_mod._config_mtime_cache = None  # cleanup


class TestValidatedNumeric:
    """_validated_numeric shared helper for int and float validation."""

    def _vi(self, val, default, lo, hi, name="test.field"):
        from token_goat.config import _validated_int
        return _validated_int(val, default, lo, hi, name)

    def _vf(self, val, default, lo, hi, name="test.field"):
        from token_goat.config import _validated_float
        return _validated_float(val, default, lo, hi, name)

    def test_int_valid_value(self) -> None:
        assert self._vi(5, 3, 0, 10) == 5

    def test_int_coerces_from_string(self) -> None:
        assert self._vi("7", 3, 0, 10) == 7

    def test_int_coerces_from_float(self) -> None:
        assert self._vi(4.9, 3, 0, 10) == 4

    def test_int_rejects_bool(self) -> None:
        assert self._vi(True, 3, 0, 10) == 3

    def test_int_rejects_out_of_range(self) -> None:
        assert self._vi(99, 3, 0, 10) == 3

    def test_int_rejects_non_numeric_string(self) -> None:
        assert self._vi("bad", 3, 0, 10) == 3

    def test_int_rejects_list(self) -> None:
        assert self._vi([1, 2], 3, 0, 10) == 3

    def test_float_valid_value(self) -> None:
        assert self._vf(1.5, 1.0, 0.0, 2.0) == 1.5

    def test_float_coerces_from_string(self) -> None:
        assert self._vf("0.8", 1.0, 0.0, 2.0) == 0.8

    def test_float_rejects_bool(self) -> None:
        assert self._vf(False, 1.0, 0.0, 2.0) == 1.0

    def test_float_rejects_out_of_range(self) -> None:
        assert self._vf(5.0, 1.0, 0.0, 2.0) == 1.0

    def test_float_boundary_values_accepted(self) -> None:
        assert self._vf(0.0, 1.0, 0.0, 2.0) == 0.0
        assert self._vf(2.0, 1.0, 0.0, 2.0) == 2.0


class TestConfigTypeValidationEndToEnd:
    """Type-validation tests via the full config.load() path.

    Exercises that wrong-type TOML values (e.g. ``auto_trigger_multiplier = "banana"``)
    fall back to the compiled default and do NOT crash, rather than propagating a
    bad value to callers.  These are end-to-end: the TOML is written to a temp
    file, ``config.load()`` parses it, and the resulting Config is checked.
    """

    def _load_from_toml(self, toml_text: str, tmp_path, monkeypatch):
        """Write *toml_text* to a temp config file, load it, return the Config."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        config_file = tmp_path / "config.toml"
        config_file.write_text(toml_text, encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        try:
            return cfg_mod.load()
        finally:
            cfg_mod._config_mtime_cache = None

    def test_auto_trigger_multiplier_string_falls_back_to_default(self, tmp_path, monkeypatch):
        """``auto_trigger_multiplier = "banana"`` must use default 2.0, not crash."""
        cfg = self._load_from_toml(
            '[compact_assist]\nauto_trigger_multiplier = "banana"\n',
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.auto_trigger_multiplier == 2.0

    def test_auto_trigger_multiplier_bool_falls_back_to_default(self, tmp_path, monkeypatch):
        """TOML booleans must be rejected for float fields; default 2.0 returned."""
        cfg = self._load_from_toml(
            "[compact_assist]\nauto_trigger_multiplier = true\n",
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.auto_trigger_multiplier == 2.0

    def test_auto_trigger_multiplier_out_of_range_falls_back_to_default(self, tmp_path, monkeypatch):
        """A value outside [1.0, 10.0] must use the default, not clamp silently."""
        cfg = self._load_from_toml(
            "[compact_assist]\nauto_trigger_multiplier = 99.9\n",
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.auto_trigger_multiplier == 2.0

    def test_min_events_string_falls_back_to_default(self, tmp_path, monkeypatch):
        """``min_events = "lots"`` must use default 3, not crash."""
        cfg = self._load_from_toml(
            '[compact_assist]\nmin_events = "lots"\n',
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.min_events == 3

    def test_max_manifest_tokens_bool_falls_back_to_default(self, tmp_path, monkeypatch):
        """Bool where int is expected must be rejected cleanly."""
        cfg = self._load_from_toml(
            "[compact_assist]\nmax_manifest_tokens = false\n",
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.max_manifest_tokens == 400

    def test_watchdog_ms_string_falls_back_to_default(self, tmp_path, monkeypatch):
        """``watchdog_ms = "fast"`` must use default 5000."""
        cfg = self._load_from_toml(
            '[hooks]\nwatchdog_ms = "fast"\n',
            tmp_path,
            monkeypatch,
        )
        assert cfg.hooks.watchdog_ms == 5000

    def test_enabled_int_coerced_to_bool(self, tmp_path, monkeypatch):
        """``enabled = 0`` (TOML integer) must coerce to False without a warning."""
        cfg = self._load_from_toml(
            "[compact_assist]\nenabled = 0\n",
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.enabled is False

    def test_enabled_string_falls_back_to_default(self, tmp_path, monkeypatch):
        """``enabled = "yes"`` (string, not TOML bool) must use default True."""
        cfg = self._load_from_toml(
            '[compact_assist]\nenabled = "yes"\n',
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.enabled is True

    def test_bad_type_values_log_warning(self, tmp_path, monkeypatch, caplog):
        """Wrong-type TOML values must emit a WARNING-level log entry."""
        import logging


        with caplog.at_level(logging.WARNING, logger="token_goat.config"):
            self._load_from_toml(
                '[compact_assist]\nauto_trigger_multiplier = "banana"\n',
                tmp_path,
                monkeypatch,
            )
        # At least one warning must mention the field name and the bad value.
        warns = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert any("auto_trigger_multiplier" in r.getMessage() for r in warns), (
            f"Expected a WARNING about 'auto_trigger_multiplier'; got: {[r.getMessage() for r in warns]}"
        )

    def test_valid_toml_overrides_are_applied(self, tmp_path, monkeypatch):
        """Well-typed TOML values are applied, not silently defaulted."""
        cfg = self._load_from_toml(
            "[compact_assist]\nmin_events = 7\nauto_trigger_multiplier = 3.5\n",
            tmp_path,
            monkeypatch,
        )
        assert cfg.compact_assist.min_events == 7
        assert cfg.compact_assist.auto_trigger_multiplier == 3.5


# ---------------------------------------------------------------------------
# WorkerConfig.max_pool_workers — config load, env override, ceiling
# ---------------------------------------------------------------------------


class TestWorkerMaxPoolWorkers:
    """worker.max_pool_workers is loaded from TOML, respects env override, and
    is hard-capped at WORKER_MAX_POOL_CEILING (8) regardless of the source."""

    def _load_from_toml(self, toml_text: str, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        cfg_mod._config_mtime_cache = None
        config_file = tmp_path / "config.toml"
        config_file.write_text(toml_text, encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        try:
            return cfg_mod.load()
        finally:
            cfg_mod._config_mtime_cache = None

    def test_default_is_four(self, tmp_path, monkeypatch):
        """Default max_pool_workers is 4 when no TOML or env override is present."""
        cfg = self._load_from_toml("", tmp_path, monkeypatch)
        assert cfg.worker.max_pool_workers == 4

    def test_toml_value_is_respected(self, tmp_path, monkeypatch):
        """A valid TOML value in [worker] is applied."""
        cfg = self._load_from_toml("[worker]\nmax_pool_workers = 2\n", tmp_path, monkeypatch)
        assert cfg.worker.max_pool_workers == 2

    def test_toml_value_above_ceiling_falls_back_to_default(self, tmp_path, monkeypatch):
        """A TOML value above WORKER_MAX_POOL_CEILING falls back to the default (4),
        not a silent clamp — _validated_int rejects out-of-range values."""
        import token_goat.config as cfg_mod

        ceiling = cfg_mod.WORKER_MAX_POOL_CEILING
        cfg = self._load_from_toml(
            f"[worker]\nmax_pool_workers = {ceiling + 10}\n", tmp_path, monkeypatch
        )
        # Out-of-range → _validated_int falls back to default=4
        assert cfg.worker.max_pool_workers == 4

    def test_env_override_applied(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_WORKER_MAX_POOL env var overrides the TOML value."""
        monkeypatch.setenv("TOKEN_GOAT_WORKER_MAX_POOL", "3")
        cfg = self._load_from_toml("", tmp_path, monkeypatch)
        assert cfg.worker.max_pool_workers == 3

    def test_env_override_out_of_range_uses_default(self, tmp_path, monkeypatch):
        """An env-var value above the ceiling uses the TOML/default value instead."""
        import token_goat.config as cfg_mod

        ceiling = cfg_mod.WORKER_MAX_POOL_CEILING
        monkeypatch.setenv("TOKEN_GOAT_WORKER_MAX_POOL", str(ceiling + 100))
        # No TOML override — default (4) should survive because the env value is out-of-range.
        cfg = self._load_from_toml("", tmp_path, monkeypatch)
        assert cfg.worker.max_pool_workers <= ceiling

    def test_ceiling_constant_is_eight(self):
        """The hard ceiling must be exactly 8 — change this test if the ceiling is intentionally raised."""
        import token_goat.config as cfg_mod

        assert cfg_mod.WORKER_MAX_POOL_CEILING == 8

    def test_save_roundtrip_preserves_max_pool_workers(self, tmp_path, monkeypatch):
        """save() then load() preserves max_pool_workers."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        cfg_mod._config_mtime_cache = None

        try:
            base = cfg_mod.load()
            base.worker.max_pool_workers = 2
            cfg_mod.save(base)

            cfg_mod._config_mtime_cache = None
            reloaded = cfg_mod.load()
            assert reloaded.worker.max_pool_workers == 2
        finally:
            cfg_mod._config_mtime_cache = None


class TestOverflowGuardConfig:
    """OverflowGuardConfig.enabled / max_tokens must load, save, and honour
    env-var overrides; the section must be recognised by the loader."""

    def test_defaults(self):
        from token_goat.config import OverflowGuardConfig
        og = OverflowGuardConfig()
        assert og.enabled is True
        assert og.max_tokens == 25000

    def test_section_is_known(self):
        """The loader recognises [overflow_guard] (not flagged as unknown)."""
        import token_goat.config as cfg_mod
        assert "overflow_guard" in cfg_mod._KNOWN_SECTIONS

    def test_enabled_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[overflow_guard]\nenabled = false\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.overflow_guard.enabled is False

    def test_max_tokens_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[overflow_guard]\nmax_tokens = 12000\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.overflow_guard.max_tokens == 12000

    def test_env_disable(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_OVERFLOW_GUARD=0 disables the guard regardless of TOML."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[overflow_guard]\nenabled = true\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_OVERFLOW_GUARD", "0")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.overflow_guard.enabled is False

    def test_env_max_tokens_override(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_OVERFLOW_MAX_TOKENS overrides the TOML value."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[overflow_guard]\nmax_tokens = 25000\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_OVERFLOW_MAX_TOKENS", "500")
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        assert cfg.overflow_guard.max_tokens == 500

    def test_round_trip(self, tmp_path, monkeypatch):
        """enabled and max_tokens survive a save → load cycle."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        _reset_cfg_cache()

        cfg = cfg_mod.load()
        cfg.overflow_guard.enabled = False
        cfg.overflow_guard.max_tokens = 1234
        cfg_mod.save(cfg)
        _reset_cfg_cache()

        reloaded = cfg_mod.load()
        assert reloaded.overflow_guard.enabled is False
        assert reloaded.overflow_guard.max_tokens == 1234
