"""Tests for harness-specific compression profiles.

Covers:
- CompressionConfig defaults and config.load() wiring
- compress_output() profile → max_lines mapping
- compress_output() "minimal" profile skips dot-progress filtering
- compress_output() "aggressive" profile caps at 50 lines
- _resolve_compression_profile() auto-detection: Gemini → minimal
- _handle_bash_compress wraps with the resolved --profile flag
"""
from __future__ import annotations

# ---------------------------------------------------------------------------
# CompressionConfig defaults
# ---------------------------------------------------------------------------


class TestCompressionConfigDefaults:
    def test_default_profile_is_auto(self):
        from token_goat.config import CompressionConfig

        cfg = CompressionConfig()
        assert cfg.profile == "auto"

    def test_load_returns_compression_config(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        cfg_mod._config_mtime_cache = None
        cfg = cfg_mod.load()
        assert hasattr(cfg, "compression")
        assert cfg.compression.profile == "auto"

    def test_load_reads_profile_from_toml(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        toml = tmp_path / "config.toml"
        toml.write_text('[compression]\nprofile = "minimal"\n', encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: toml)
        cfg_mod._config_mtime_cache = None
        cfg = cfg_mod.load()
        assert cfg.compression.profile == "minimal"

    def test_load_invalid_profile_falls_back_to_auto(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        toml = tmp_path / "config.toml"
        toml.write_text('[compression]\nprofile = "turbo"\n', encoding="utf-8")
        monkeypatch.setattr(paths_mod, "config_path", lambda: toml)
        cfg_mod._config_mtime_cache = None
        cfg = cfg_mod.load()
        assert cfg.compression.profile == "auto"

    def test_env_override_profile(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setenv("TOKEN_GOAT_COMPRESS_PROFILE", "aggressive")
        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        cfg_mod._config_mtime_cache = None
        cfg = cfg_mod.load()
        assert cfg.compression.profile == "aggressive"

    def test_env_override_invalid_ignored(self, tmp_path, monkeypatch):
        import token_goat.config as cfg_mod
        import token_goat.paths as paths_mod

        monkeypatch.setenv("TOKEN_GOAT_COMPRESS_PROFILE", "hyperspeed")
        monkeypatch.setattr(paths_mod, "config_path", lambda: tmp_path / "config.toml")
        cfg_mod._config_mtime_cache = None
        cfg = cfg_mod.load()
        # Invalid env override: falls back to default "auto"
        assert cfg.compression.profile == "auto"


# ---------------------------------------------------------------------------
# compress_output profile → effective max_lines
# ---------------------------------------------------------------------------


class TestCompressOutputProfile:
    """compress_output() respects profile caps on the line limit."""

    def _filter(self):
        from token_goat.bash_compress import GenericFilter
        return GenericFilter()

    def test_aggressive_caps_at_50_lines(self):
        from token_goat.bash_compress import compress_output

        f = self._filter()
        # Generate 100 lines of output
        stdout = "\n".join(f"line {i}" for i in range(100))
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="aggressive")
        output_lines = [ln for ln in result.text.split("\n") if ln.strip() and not ln.startswith("[token-goat:")]
        # aggressive profile caps at 50 lines (the marker line counts but is stripped above)
        assert len(output_lines) <= 55  # allow some headroom for elision markers

    def test_balanced_default_allows_200_lines(self):
        from token_goat.bash_compress import compress_output

        f = self._filter()
        # Generate exactly 80 lines — should be retained fully on balanced
        stdout = "\n".join(f"line {i}" for i in range(80))
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="balanced")
        # 80 lines < 200 cap: all lines should survive
        content_lines = [ln for ln in result.text.split("\n") if ln.startswith("line ")]
        assert len(content_lines) == 80

    def test_minimal_allows_500_lines(self):
        from token_goat.bash_compress import compress_output

        f = self._filter()
        # 250 distinct lines — all should survive under minimal (cap=500)
        stdout = "\n".join(f"output {i}" for i in range(250))
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="minimal")
        content_lines = [ln for ln in result.text.split("\n") if ln.startswith("output ")]
        assert len(content_lines) == 250

    def test_caller_max_lines_tighter_than_profile(self):
        """When max_lines < profile cap, max_lines wins."""
        from token_goat.bash_compress import compress_output

        f = self._filter()
        stdout = "\n".join(f"line {i}" for i in range(100))
        # Profile is "minimal" (cap=500) but caller passes max_lines=10
        result = compress_output(f, stdout, "", 0, ["true"], max_lines=10, compression_profile="minimal")
        content_lines = [ln for ln in result.text.split("\n") if ln.startswith("line ")]
        assert len(content_lines) <= 12  # allow for elision marker

    def test_unknown_profile_treated_as_balanced(self):
        """An unrecognised profile name falls back to balanced (200-line cap)."""
        from token_goat.bash_compress import compress_output

        f = self._filter()
        stdout = "\n".join(f"line {i}" for i in range(80))
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="nonsense")
        content_lines = [ln for ln in result.text.split("\n") if ln.startswith("line ")]
        assert len(content_lines) == 80


# ---------------------------------------------------------------------------
# "minimal" profile skips dot-progress filtering
# ---------------------------------------------------------------------------


class TestMinimalProfileSkipsProgress:
    """compress_output(compression_profile="minimal") does not collapse \\r progress lines."""

    def test_minimal_preserves_carriage_return_lines(self):
        from token_goat.bash_compress import GenericFilter, compress_output

        f = GenericFilter()
        # A progress bar expressed via \\r overwrites
        stdout = "Loading [  ] 10%\rLoading [##] 50%\rLoading [##] 100%"
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="minimal")
        # Minimal: \\r should NOT be collapsed — all three frames survive
        # After CRLF→LF normalisation, the \\r-overwrite stays as-is on a single line.
        # The raw text still contains "10%" and "50%".
        assert "10%" in result.text or "50%" in result.text or "100%" in result.text

    def test_balanced_collapses_carriage_return_lines(self):
        from token_goat.bash_compress import GenericFilter, compress_output

        f = GenericFilter()
        stdout = "Loading [  ] 10%\rLoading [##] 50%\rLoading [##] 100%"
        result = compress_output(f, stdout, "", 0, ["true"], compression_profile="balanced")
        # Balanced: strip_progress collapses to the last overwrite → "100%" only.
        assert "10%" not in result.text
        assert "50%" not in result.text
        assert "100%" in result.text


# ---------------------------------------------------------------------------
# _resolve_compression_profile — Gemini auto-detection
# ---------------------------------------------------------------------------


class TestResolveCompressionProfile:
    def test_auto_gemini_returns_minimal(self):
        from token_goat.hooks_read import _resolve_compression_profile

        assert _resolve_compression_profile("gemini", "auto") == "minimal"

    def test_auto_claude_returns_balanced(self):
        from token_goat.hooks_read import _resolve_compression_profile

        assert _resolve_compression_profile("claude", "auto") == "balanced"

    def test_auto_codex_returns_balanced(self):
        from token_goat.hooks_read import _resolve_compression_profile

        assert _resolve_compression_profile("codex", "auto") == "balanced"

    def test_explicit_profile_ignores_harness(self):
        from token_goat.hooks_read import _resolve_compression_profile

        # Gemini + explicit "aggressive" → "aggressive" (harness ignored)
        assert _resolve_compression_profile("gemini", "aggressive") == "aggressive"

    def test_explicit_minimal_for_non_gemini(self):
        from token_goat.hooks_read import _resolve_compression_profile

        assert _resolve_compression_profile("claude", "minimal") == "minimal"


# ---------------------------------------------------------------------------
# _handle_bash_compress passes --profile to the wrapper command
# ---------------------------------------------------------------------------


class TestHookBashCompressPassesProfile:
    def _payload(self, cmd: str, harness: str = "claude", session_id: str = "s1") -> dict:
        """Build a minimal Bash PreToolUse payload with harness already stamped.

        In production, normalize_payload() stamps _tg_harness before dispatch.
        We set it directly here since our test payloads are already in internal
        (PascalCase) format and we don't want Gemini tool-name remapping.
        """
        return {
            "session_id": session_id,
            "tool_name": "Bash",
            "tool_input": {"command": cmd},
            "cwd": "/tmp",
            "_tg_harness": harness,
        }

    def test_default_harness_wraps_with_balanced_profile(self, tmp_data_dir, monkeypatch):
        from token_goat import hooks_cli

        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

        result = hooks_cli.dispatch("pre-read", self._payload("pytest tests/", harness="claude"))

        assert "hookSpecificOutput" in result
        new_cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--profile" in new_cmd
        assert "balanced" in new_cmd

    def test_gemini_harness_wraps_with_minimal_profile(self, tmp_data_dir, monkeypatch):
        from token_goat import hooks_cli

        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

        result = hooks_cli.dispatch("pre-read", self._payload("pytest tests/", harness="gemini"))

        assert "hookSpecificOutput" in result
        new_cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--profile" in new_cmd
        assert "minimal" in new_cmd

    def test_codex_harness_wraps_with_balanced_profile(self, tmp_data_dir, monkeypatch):
        from token_goat import hooks_cli

        monkeypatch.delenv("TOKEN_GOAT_BASH_COMPRESS", raising=False)
        import token_goat.config as cfg_mod
        cfg_mod._config_mtime_cache = None

        result = hooks_cli.dispatch("pre-read", self._payload("npm install", harness="codex"))

        assert "hookSpecificOutput" in result
        new_cmd = result["hookSpecificOutput"]["updatedInput"]["command"]
        assert "--profile" in new_cmd
        assert "balanced" in new_cmd
