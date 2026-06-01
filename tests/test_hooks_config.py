"""Tests for hooks configuration and adaptive watchdog timeout."""
from __future__ import annotations


class TestHooksConfig:
    """Tests for [hooks] configuration section, watchdog_ms, and adaptive timeout."""

    def _reset_hook_state(self) -> None:
        """Reset module-level hook watchdog state between tests."""
        import token_goat.hooks_common as hc_mod
        hc_mod._effective_watchdog_ms = 5000
        hc_mod._consecutive_timeouts = 0
        hc_mod._timeout_configured = False

    def _reset_config_cache(self) -> None:
        """Clear the config module-level cache."""
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

    def test_default_hooks_watchdog_is_5000(self, tmp_path, monkeypatch):
        """Default [hooks].watchdog_ms should be 5000."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        self._reset_config_cache()

        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 5000

    def test_config_toml_watchdog_setting(self, tmp_path, monkeypatch):
        """[hooks].watchdog_ms from TOML should override default."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 8000\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_config_cache()

        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 8000

    def test_env_var_overrides_config(self, tmp_path, monkeypatch):
        """TOKEN_GOAT_HOOK_WATCHDOG_MS env var should override TOML."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 8000\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "10000")
        self._reset_config_cache()

        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 10000

    def test_watchdog_out_of_range_uses_default(self, tmp_path, monkeypatch):
        """watchdog_ms out of range [100, 30000] should fallback to default 5000."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 50\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_config_cache()

        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 5000

    def test_watchdog_at_boundaries(self, tmp_path, monkeypatch):
        """watchdog_ms at min/max boundaries should be accepted."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        # Test floor boundary
        config_file = tmp_path / "config_min.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 100\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_config_cache()
        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 100

        # Test ceil boundary
        config_file = tmp_path / "config_max.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 30000\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_config_cache()
        cfg = cfg_mod.load()
        assert cfg.hooks.watchdog_ms == 30000

    def test_get_effective_watchdog_ms_returns_5000_default(self, monkeypatch):
        """get_effective_watchdog_ms() should return 5000 when no config exists."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/path/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        ms = hc_mod.get_effective_watchdog_ms()
        assert ms == 5000

    def test_get_effective_watchdog_loads_from_config(self, tmp_path, monkeypatch):
        """get_effective_watchdog_ms() should load config value on first call."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        config_file = tmp_path / "config.toml"
        config_file.write_text("[hooks]\nwatchdog_ms = 7500\n", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        self._reset_hook_state()
        self._reset_config_cache()

        ms = hc_mod.get_effective_watchdog_ms()
        assert ms == 7500

    def test_get_effective_watchdog_cached_after_first_call(self, monkeypatch):
        """Second call to get_effective_watchdog_ms() should return cached value."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        ms1 = hc_mod.get_effective_watchdog_ms()
        ms2 = hc_mod.get_effective_watchdog_ms()
        assert ms1 == ms2 == 5000

    def test_record_watchdog_timeout_doubles_timeout(self, monkeypatch):
        """record_watchdog_timeout() should double the effective timeout."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        # Start with baseline 5000
        ms1 = hc_mod.get_effective_watchdog_ms()
        assert ms1 == 5000

        # After timeout, should double to 10000
        hc_mod.record_watchdog_timeout()
        ms2 = hc_mod.get_effective_watchdog_ms()
        assert ms2 == 10000

    def test_timeout_doubles_multiple_times(self, monkeypatch):
        """Multiple consecutive timeouts should keep doubling (capped at 30s)."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        ms_initial = hc_mod.get_effective_watchdog_ms()
        assert ms_initial == 5000

        # First timeout: 5000 → 10000
        hc_mod.record_watchdog_timeout()
        assert hc_mod.get_effective_watchdog_ms() == 10000

        # Second timeout: 10000 → 20000
        hc_mod.record_watchdog_timeout()
        assert hc_mod.get_effective_watchdog_ms() == 20000

        # Third timeout: 20000 → 30000
        hc_mod.record_watchdog_timeout()
        assert hc_mod.get_effective_watchdog_ms() == 30000

        # Fourth timeout: already at cap, stays 30000
        hc_mod.record_watchdog_timeout()
        assert hc_mod.get_effective_watchdog_ms() == 30000

    def test_timeout_capped_at_30000(self, monkeypatch):
        """Timeout doubling should be capped at 30000 ms."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        hc_mod.get_effective_watchdog_ms()

        # Simulate multiple timeouts to exceed cap
        for _ in range(10):
            hc_mod.record_watchdog_timeout()

        ms = hc_mod.get_effective_watchdog_ms()
        assert ms == 30000, "Timeout should be capped at 30000"

    def test_env_var_override_not_affected_by_adaptive_timeout(self, tmp_path, monkeypatch):
        """ENV var override should establish the baseline for adaptive doubling."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        # Create an empty config file to ensure config loading works
        config_file = tmp_path / "config.toml"
        config_file.write_text("", encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: config_file)
        monkeypatch.setenv("TOKEN_GOAT_HOOK_WATCHDOG_MS", "15000")
        self._reset_hook_state()
        self._reset_config_cache()

        ms1 = hc_mod.get_effective_watchdog_ms()
        assert ms1 == 15000

        # After timeout, should double from the env-var baseline
        hc_mod.record_watchdog_timeout()
        ms2 = hc_mod.get_effective_watchdog_ms()
        assert ms2 == 30000  # 15000 * 2 = 30000 (at cap)

    def test_hooks_config_in_config_dataclass(self, tmp_path, monkeypatch):
        """Config dataclass should have hooks field."""
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        self._reset_config_cache()

        cfg = cfg_mod.load()
        assert hasattr(cfg, "hooks")
        assert isinstance(cfg.hooks, cfg_mod.HooksConfig)

    def test_consecutive_timeout_counter(self, monkeypatch):
        """Consecutive timeout counter should track timeout attempts."""
        import token_goat.hooks_common as hc_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: "/nonexistent/config.toml")
        self._reset_hook_state()
        self._reset_config_cache()

        hc_mod.get_effective_watchdog_ms()
        assert hc_mod._consecutive_timeouts == 0

        hc_mod.record_watchdog_timeout()
        assert hc_mod._consecutive_timeouts == 1

        hc_mod.record_watchdog_timeout()
        assert hc_mod._consecutive_timeouts == 2
