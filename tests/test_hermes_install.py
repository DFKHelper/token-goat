"""Tests for Hermes Agent harness detection and install integration."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from token_goat.compact import detect_harness
from token_goat.install import detect_hermes, detect_installed_harnesses


class TestDetectHermes:
    def test_detect_by_home_dir(self, tmp_path, monkeypatch):
        hermes_dir = tmp_path / ".hermes"
        hermes_dir.mkdir()
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        with patch("shutil.which", return_value=None):
            assert detect_hermes() is True

    def test_detect_by_hermes_home_env(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes"))
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        assert detect_hermes() is True

    def test_detect_by_session_id_env(self, monkeypatch):
        monkeypatch.setenv("HERMES_SESSION_ID", "abc-123")
        monkeypatch.delenv("HERMES_HOME", raising=False)
        assert detect_hermes() is True

    def test_detect_by_binary(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        with patch("shutil.which", return_value="/usr/local/bin/hermes"):
            assert detect_hermes() is True

    def test_absent(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        with patch("shutil.which", return_value=None):
            assert detect_hermes() is False


class TestDetectInstalledHarnessesHermes:
    def test_hermes_in_result_when_detected(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        result = detect_installed_harnesses()
        assert "hermes" in result
        assert result["hermes"] is True

    def test_hermes_false_when_absent(self, tmp_path, monkeypatch):
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        with patch("shutil.which", return_value=None):
            result = detect_installed_harnesses()
        assert "hermes" in result
        assert result["hermes"] is False


class TestDetectHarnessRuntime:
    def test_hermes_session_id_returns_hermes(self, monkeypatch):
        monkeypatch.setenv("HERMES_SESSION_ID", "sess-xyz")
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        # Ensure ANTHROPIC_API_KEY doesn't mask the result
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert detect_harness() == "hermes"

    def test_hermes_home_returns_hermes(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HERMES_HOME", str(tmp_path))
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        assert detect_harness() == "hermes"

    def test_hermes_override_via_token_goat_var(self, monkeypatch):
        monkeypatch.setenv("TOKEN_GOAT_HARNESS_OVERRIDE", "hermes")
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.delenv("HERMES_HOME", raising=False)
        assert detect_harness() == "hermes"

    def test_claudecode_without_hermes_env(self, monkeypatch):
        monkeypatch.delenv("HERMES_SESSION_ID", raising=False)
        monkeypatch.delenv("HERMES_HOME", raising=False)
        monkeypatch.delenv("TOKEN_GOAT_HARNESS_OVERRIDE", raising=False)
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
        assert detect_harness() == "claudecode"
